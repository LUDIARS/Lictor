/**
 * 委託 prompt の auto-inject.
 *
 * Concordia の `/v1/delegation/invoke` が spawn する lictor-wrapped セッションには
 * env `CONCORDIA_DELEGATION_PROMPT_FILE = <prompt md path>` が渡される
 * (Concordia `src/delegation/service.ts` → `spawner.ts` が env をマージ)。
 *
 * このモジュールは:
 *   1. その env が指す prompt file を読み、 端末注入用にサニタイズする (pure)
 *   2. wrapped CLI の TUI が入力受付可能になった頃合い (= 初回 onData + 遅延) で
 *      provider.submitInject 経由で paste + submit し、到達確認まで再送する scheduler を返す
 *
 * これが無いと委託先 (Codex 等) は空のプロンプトで起動し、 ユーザが手で
 * `cat <prompt_file>` を貼る必要があった (2026-05-31 調査で判明した欠落配線)。
 */

import { readFileSync } from "node:fs";

/** spawn 先に渡る prompt file path の env 名。Concordia delegation/service.ts と対。 */
export const DELEGATION_PROMPT_ENV = "CONCORDIA_DELEGATION_PROMPT_FILE";

/**
 * spawn 先に渡る delegation 識別 env 名。Concordia `delegation/service.ts` の spawn env と対。
 * これらを session 登録 metadata に載せると、Concordia 側 (`lifecycle.ts` →
 * `claimChildSession`) が run と子セッションを **決定的に** 紐付けられる (cwd 一致頼みの
 * in-memory 照合はプロセス再起動や同一 cwd 並行 spawn で外れる)。この配線が無いと
 * `child_session_id` が焼かれず、親からの `/v1/delegation/runs/:id/inject` は 409
 * (`child_session_not_claimed`) になり、外注リストにも子セッションが紐付かない。
 */
export const DELEGATION_RUN_ID_ENV = "CONCORDIA_DELEGATION_RUN_ID";
export const DELEGATION_CALL_NAME_ENV = "CONCORDIA_DELEGATION_CALL_NAME";
export const DELEGATION_PARENT_SESSION_ENV = "CONCORDIA_DELEGATION_PARENT_SESSION_ID";

/**
 * delegation spawn 由来の env から、session 登録 metadata に載せる delegation 識別子を組む。
 * spawn でなければ空オブジェクト。Concordia が受け取る metadata キー名 (`delegation_run_id`
 * 等) に揃える。値は trim して空なら落とす (undefined を metadata に残さない)。
 */
export function delegationSessionMetadata(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const meta: Record<string, string> = {};
  const runId = env[DELEGATION_RUN_ID_ENV]?.trim();
  const callName = env[DELEGATION_CALL_NAME_ENV]?.trim();
  const parent = env[DELEGATION_PARENT_SESSION_ENV]?.trim();
  if (runId) meta.delegation_run_id = runId;
  if (callName) meta.delegation_call_name = callName;
  if (parent) meta.delegation_parent_session_id = parent;
  return meta;
}

/** prompt 本文の最大バイト数。委託 prompt は大きめなので 512 KiB まで許容。 */
const MAX_PROMPT_BYTES = 512 * 1024;

/** 初回 onData 後、 inject するまでの既定待ち時間 (ms)。TUI の起動描画を待つ。 */
const DEFAULT_INJECT_DELAY_MS = 2500;

/**
 * submit 後、 「本当に届いたか」 を transcript の user フレームで確認するまでの既定待ち時間 (ms)。
 * 経過しても届いていなければ本文ごと paste し直す。
 */
const DEFAULT_INJECT_VERIFY_MS = 45_000;

/** 本文 paste の最大試行回数 (初回 + 再送)。 */
const DEFAULT_INJECT_MAX_ATTEMPTS = 3;

/** Node.js の setTimeout がオーバーフローせず扱える最大遅延。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 設定ミスで長時間 prompt を送り続けないための最大試行回数。 */
const MAX_INJECT_ATTEMPTS = 10;

/**
 * 再送前に入力欄を空にするキー (Ctrl+U = kill-line)。 paste は届いたが Enter だけ
 * 落ちていた場合に本文が二重に積まれるのを防ぐ。 submit-watchdog が Enter を
 * 押し続けている経路と競合しても、 空の入力欄に Enter は無害。
 */
const CLEAR_INPUT_KEY = String.fromCharCode(0x15);

/** env から prompt file path を取る。未設定/空白なら null。 */
export function delegationPromptPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const p = env[DELEGATION_PROMPT_ENV]?.trim();
  return p ? p : null;
}

/**
 * TUI ready 後の inject 待ち時間 (ms)。env override 可
 * (`LICTOR_DELEGATION_INJECT_DELAY_MS`)。負値/非数は既定にフォールバック。
 */
export function delegationInjectDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.LICTOR_DELEGATION_INJECT_DELAY_MS ?? String(DEFAULT_INJECT_DELAY_MS));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_INJECT_DELAY_MS;
}

/**
 * 委託 prompt 本文のサニタイズ。pty へ生バイトを流す前提なので、 端末を壊す/
 * ANSI 操作を許す C0 制御文字 (ESC=0x1B 含む) を除去する。本文の改行は \n に
 * 統一し (\r は submitInject 側が Enter として扱うため本文からは持たせない)、
 * tab は残す。末尾空白を trim し、 過大な本文は UTF-8 安全に cap する。
 */
export function sanitizeDelegationPrompt(raw: string): string {
  // 1) ANSI CSI エスケープシーケンス (ESC [ ... 終端文字) を丸ごと除去。
  //    ESC バイトだけ落とすと `[31m` 等の本体が文字列に残ってしまうため先に処理。
  // eslint-disable-next-line no-control-regex -- ESC を意図的に対象にしている
  const noAnsi = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const noCr = noAnsi.replace(/\r\n?/g, "\n");
  // 2) 残った C0 制御文字 (\t, \n を除く) と DEL、 単独 ESC を除去。
  // eslint-disable-next-line no-control-regex -- C0/DEL を意図的に対象にしている
  const cleaned = noCr.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  const trimmed = cleaned.replace(/\s+$/u, "");
  if (Buffer.byteLength(trimmed, "utf8") <= MAX_PROMPT_BYTES) return trimmed;
  return Buffer.from(trimmed, "utf8").subarray(0, MAX_PROMPT_BYTES).toString("utf8");
}

export interface LoadedDelegationPrompt {
  /** 読んだ prompt file の path (ログ用)。 */
  path: string;
  /** サニタイズ済み本文。 */
  text: string;
}

/**
 * env が指す prompt file を読み、 サニタイズして返す。best-effort:
 *   - env 未設定 → null
 *   - 読めない / 空 → null (委託 inject は利便機能なので失敗してもセッションは続行)
 * `readFile` は注入可能 (テスト用)。
 */
export function loadDelegationPrompt(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): LoadedDelegationPrompt | null {
  const path = delegationPromptPath(env);
  if (!path) return null;
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return null;
  }
  const text = sanitizeDelegationPrompt(raw);
  return text ? { path, text } : null;
}

function boundedInteger(
  raw: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * verify 待ち時間 (ms)。env override 可 (`LICTOR_DELEGATION_INJECT_VERIFY_MS`)。
 * 0 で verify 無効 (従来どおり 1 回 paste して終わり)。
 */
export function delegationInjectVerifyMs(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(
    env.LICTOR_DELEGATION_INJECT_VERIFY_MS,
    DEFAULT_INJECT_VERIFY_MS,
    0,
    MAX_TIMER_DELAY_MS,
  );
}

/** paste の最大試行回数 (1〜10)。env override 可 (`LICTOR_DELEGATION_INJECT_MAX_ATTEMPTS`)。 */
export function delegationInjectMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(
    env.LICTOR_DELEGATION_INJECT_MAX_ATTEMPTS,
    DEFAULT_INJECT_MAX_ATTEMPTS,
    1,
    MAX_INJECT_ATTEMPTS,
  );
}

export interface DelegationInjector {
  /** wrapped CLI の pty から最初の出力が来たら呼ぶ。高々 1 回 inject を arm する。 */
  notifyData(): void;
  /** transcript に user フレームが出た = 本文が届いてターンが始まった。再送を止める。 */
  noteUserMessage(): void;
  /** 既に submit 済みか (テスト/診断用)。 */
  injected(): boolean;
  /** 本文の到達が確認できたか (テスト/診断用)。 */
  accepted(): boolean;
  /** これまでの paste 回数 (テスト/診断用)。 */
  attempts(): number;
}

export interface DelegationInjectorDeps {
  /** 読み込み済み prompt。 */
  prompt: LoadedDelegationPrompt;
  /** 本文を pty へ submit する関数 (= (t) => provider.submitInject(ptyWriter, t))。 */
  submit: (text: string) => void;
  /** 初回 onData 後の待ち時間 (ms)。 */
  delayMs: number;
  /**
   * submit 後、 到達確認を待つ時間 (ms)。 0 以下で再送を行わない。
   * 省略時は再送しない (呼び出し側が明示的に有効化する)。
   */
  verifyMs?: number;
  /** paste の最大試行回数 (初回を含む)。既定 1 = 再送なし。 */
  maxAttempts?: number;
  /** 再送直前に入力欄を空にする関数 (= (d) => ptyWriter(d))。省略時は何もしない。 */
  clearInput?: (data: string) => void;
  /** 診断ログ (best-effort)。 */
  log?: (message: string) => void;
  /** タイマ実装の差し替え (テスト用)。既定は global setTimeout。 */
  setTimeoutFn?: (cb: () => void, ms: number) => void;
}

/**
 * 「初回 onData が来たら delayMs 後に submit し、 届いたことを確認できるまで送り直す」
 * scheduler。 `notifyData()` は onData ハンドラから毎回呼んでよい (arm は 1 回限り)。
 *
 * **なぜ再送が要るか**: submit は TUI の入力欄へ paste + Enter を流し込むだけで、
 * 受け取られたかを知らない。 TUI がまだ入力を受け付けていない時点で流すと本文ごと
 * 落ち、 セッションは「起動しただけ・入力欄は空」 のまま止まる。 従来の保険
 * (`submit-watchdog`) は Enter を押し直すだけなので、 **本文が消えた場合は永久に
 * 復旧しない**。到達の観測点は transcript の user フレーム = `noteUserMessage()`。
 *
 * @implements SPEC-DELEGATION-LEGACY-RETRY
 */
export function createDelegationInjector(deps: DelegationInjectorDeps): DelegationInjector {
  const setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => {
    const t = setTimeout(cb, ms);
    t.unref?.();
  });
  const verifyMs = boundedInteger(deps.verifyMs, 0, 0, MAX_TIMER_DELAY_MS);
  const maxAttempts = boundedInteger(deps.maxAttempts, 1, 1, MAX_INJECT_ATTEMPTS);
  let armed = false;
  let done = false;
  let accepted = false;
  let attempts = 0;

  function paste(): void {
    if (accepted) return;
    // 2 回目以降は入力欄を空にしてから貼り直す。 paste は届いたが Enter だけ
    // 落ちていた場合に本文が二重に積まれるのを防ぐ。
    if (attempts > 0) {
      try {
        deps.clearInput?.(CLEAR_INPUT_KEY);
      } catch {
        // pty may be closing; clearing is best-effort.
      }
    }
    attempts += 1;
    done = true;
    try {
      deps.submit(deps.prompt.text);
    } catch {
      // pty may be closing; inject is best-effort.
    }
    if (!(verifyMs > 0) || attempts >= maxAttempts) return;
    setTimeoutFn(() => {
      if (accepted) return;
      try {
        deps.log?.(
          `delegation inject: no user turn ${verifyMs}ms after attempt ${attempts}; re-sending the prompt`,
        );
      } catch {
        // diagnostics must not prevent a best-effort retry.
      }
      paste();
    }, verifyMs);
  }

  function notifyData(): void {
    if (armed || done) return;
    armed = true;
    setTimeoutFn(() => {
      if (done) return;
      paste();
    }, deps.delayMs);
  }

  function noteUserMessage(): void {
    // A transcript tail can surface an earlier/manual user frame before the
    // delayed first attempt. Only a frame observed after paste can acknowledge it.
    if (attempts > 0) accepted = true;
  }

  return {
    notifyData,
    noteUserMessage,
    injected: () => done,
    accepted: () => accepted,
    attempts: () => attempts,
  };
}
