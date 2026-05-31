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
 *      provider.submitInject 経由で「1 回だけ」 paste + submit する scheduler を返す
 *
 * これが無いと委託先 (Codex 等) は空のプロンプトで起動し、 ユーザが手で
 * `cat <prompt_file>` を貼る必要があった (2026-05-31 調査で判明した欠落配線)。
 */

import { readFileSync } from "node:fs";

/** spawn 先に渡る prompt file path の env 名。Concordia delegation/service.ts と対。 */
export const DELEGATION_PROMPT_ENV = "CONCORDIA_DELEGATION_PROMPT_FILE";

/** prompt 本文の最大バイト数。委託 prompt は大きめなので 512 KiB まで許容。 */
const MAX_PROMPT_BYTES = 512 * 1024;

/** 初回 onData 後、 inject するまでの既定待ち時間 (ms)。TUI の起動描画を待つ。 */
const DEFAULT_INJECT_DELAY_MS = 2500;

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

export interface DelegationInjector {
  /** wrapped CLI の pty から最初の出力が来たら呼ぶ。高々 1 回 inject を arm する。 */
  notifyData(): void;
  /** 既に submit 済みか (テスト/診断用)。 */
  injected(): boolean;
}

export interface DelegationInjectorDeps {
  /** 読み込み済み prompt。 */
  prompt: LoadedDelegationPrompt;
  /** 本文を pty へ submit する関数 (= (t) => provider.submitInject(ptyWriter, t))。 */
  submit: (text: string) => void;
  /** 初回 onData 後の待ち時間 (ms)。 */
  delayMs: number;
  /** タイマ実装の差し替え (テスト用)。既定は global setTimeout。 */
  setTimeoutFn?: (cb: () => void, ms: number) => void;
}

/**
 * 「初回 onData が来たら delayMs 後に 1 回だけ submit する」 を管理する scheduler。
 * `notifyData()` を onData ハンドラから毎回呼んでよい (arm は 1 回限り)。
 */
export function createDelegationInjector(deps: DelegationInjectorDeps): DelegationInjector {
  const setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => {
    const t = setTimeout(cb, ms);
    t.unref?.();
  });
  let armed = false;
  let done = false;
  return {
    notifyData() {
      if (armed || done) return;
      armed = true;
      setTimeoutFn(() => {
        if (done) return;
        done = true;
        try {
          deps.submit(deps.prompt.text);
        } catch {
          // pty may be closing; inject is best-effort.
        }
      }, deps.delayMs);
    },
    injected: () => done,
  };
}
