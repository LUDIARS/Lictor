/**
 * Tail the wrapped agent's session JSONL and relay each line to Concordia
 * as a `transcript-frame`. Lets a remote viewer (Concordia Web UI) see what
 * the wrapped session is doing without parsing the TUI output.
 *
 * Provider 別の discovery / parser:
 *
 *  - Claude Code: `~/.claude/projects/<cwdEncoded>/<uuid>.jsonl`
 *  - OpenAI Codex CLI: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl`
 *
 * Provider config が `transcriptDir` を `null` で返す場合 (e.g. Gemini) は
 * transcript-tail は no-op で起動する (frame は流れない).
 *
 * Polling vs fs.watch: Windows fs.watch fires inconsistently on append-only
 * files (sometimes only on rename / close), so we use a 500ms poll loop to
 * detect size changes. The poll is cheap because we're only stat()-ing one
 * file. Cheap enough that on cleanup we just clearInterval.
 *
 * Backpressure: POST to Concordia is fire-and-forget. If Concordia is
 * unreachable, the frame is dropped — there is no in-process queue. The
 * Web UI re-reads the JSONL via session detail GETs if it wants history.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import type { ProviderConfig } from "./provider.js";
import { readClaudeTranscriptPath } from "./active-repos.js";
import {
  detectAnsweredQuestionIds,
  detectAskUserQuestion,
  detectExitPlanMode,
  postPendingQuestion,
  postResolveQuestion,
  providerSupportsAskUserQuestion,
} from "./ask-question-relay.js";
import { parseAskMarkerText } from "./ask-marker.js";
import { stripAskBlock } from "./ask-json.js";
import type { TranscriptFrameSink } from "./transcript-sink.js";

const POLL_INTERVAL_MS = 500;
const POST_TIMEOUT_MS = 2000;
const MAX_DISCOVERY_DEPTH = 4; // Codex の YYYY/MM/DD/ をカバーするため再帰段数を確保
// stale claim (wrapper クラッシュ残骸) の判定閾値。 active な wrapper は poll (500ms)
// 毎に refreshClaim で mtime を打ち直すので、 5 分無更新 = 所有者は生きていない。
// 旧値 1h は「クラッシュ後の再起動が同じ JSONL を 1 時間掴めず中継不能」 かつ
// 「候補枯渇で誤掴みフォールバックを誘発」 する副作用が大きかった。 env override 可。
const STALE_CLAIM_MS = ((): number => {
  const v = Number(process.env.LICTOR_STALE_CLAIM_MS ?? "");
  return Number.isFinite(v) && v > 0 ? v : 5 * 60 * 1000;
})();

// relay スタール検知 watchdog の猶予。 セッションが active なのにこの時間を超えて
// frame を 1 つも送れない (= 束縛先が見失われた / ローテートで死んだファイルを掴み続け
// ている) とき、 transcript を取り直して re-pin する (/clear 不要の自動復帰)。 取り直し
// 方式は hook 権威の有無で分かれる (recoverRelay):
//   - hook 権威あり (claude): 権威 transcript_path のみへ束縛し直す。 mtime 推測はしない。
//   - hook 権威なし (codex 等): claim ガード付き mtime discover で生 transcript を掴む。
// Concordia の再起動連打等で maybeRebind が phantom パスへ束縛して停止する既知のスタール
// (本番実害 2026-06-30) への自己修復。 同時に、 mtime 復帰が共有 projects/<cwd> で別セッション
// の JSONL を誤掴みする crosstalk (本番実害 2026-06-30) を hook 権威ありでは構造的に排除する。
// env override 可。
const STALL_RECOVERY_MS = ((): number => {
  const v = Number(process.env.LICTOR_TRANSCRIPT_STALL_RECOVERY_MS ?? "30000");
  return Number.isFinite(v) && v >= 0 ? v : 30000;
})();

// hook 権威 (lictorTranscriptStatePath) が設定済なのに transcript を束縛できないまま
// 経過したとき、 中継を黙って止めず大きく表面化するための猶予 (ms)。 SessionStart hook は
// 起動直後に発火するので通常は 1s 未満で解決する。 これを超えても解決しなければ「hook が
// phantom path を報告した / claude が transcript を永続化していない」 等の異常とみなし、
// stderr + Concordia event で可視化する (無言フォールバック禁止)。 env override 可。
const TRANSCRIPT_RESOLVE_GRACE_MS = ((): number => {
  const v = Number(process.env.LICTOR_TRANSCRIPT_RESOLVE_GRACE_MS ?? "20000");
  return Number.isFinite(v) && v >= 0 ? v : 20000;
})();

// 別セッション誤投稿 (= 2 wrapper が同じ jsonl を tail) の原因特定用ログ.
// 既定 ON。 安定確認後に撤去 PR で消す (verbose-logging-bootstrap)。CONCORDIA→Discord
// で「別 channel に混在」 が出たらこのログで「同一 path を 2 owner が claim」 を確認する。
const CLAIM_DEBUG = process.env.LICTOR_DEBUG_TRANSCRIPT !== "0";
function claimDbg(msg: string): void {
  if (!CLAIM_DEBUG) return;
  try { process.stderr.write(`[verbose-transcript] ${msg}\n`); } catch { /* best-effort */ }
}

/**
 * JSONL の先頭行 (最大 maxBytes) を読む。 provider の transcriptMetaAccepts に
 * 渡すメタ判定専用で、 読めなければ null (判定不能 = フィルタ側の扱いに委ねる)。
 *
 * maxBytes は codex の session_meta 行が base_instructions を丸ごと含んで
 * 数十 KB になるため 256 KiB。 旧上限 8 KiB では先頭行が途中で切れて JSON.parse
 * が失敗し、 originator 施錠モードが「自分の rollout」 を拒否して中継が全停止した
 * (2026-07-13 実害: 実測 17 KB の session_meta)。 cap 内に改行が見つからない
 * 場合は途切れた JSON を返さず null (判定不能) にする。
 */
export function readTranscriptFirstLine(path: string, maxBytes = 262_144): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    if (n <= 0) return null;
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    if (nl >= 0) return text.slice(0, nl);
    // cap いっぱいまで読んで改行なし = 行が途切れている (書きかけ or 巨大行)。
    // 壊れた JSON を返すと strict フィルタが誤判定するので「読めない」扱いにする。
    return n === maxBytes ? null : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/** claim file の mtime を now に更新し stale 化を防ぐ (active 中は剥がされない). best-effort. */
export function refreshClaim(claimPath: string): void {
  try {
    const t = Date.now() / 1000;
    utimesSync(claimPath, t, t);
  } catch { /* best-effort — 削除済等 */ }
}

export interface TranscriptTailHandle {
  stop: () => void;
  /**
   * Session JSONL を discover 済の場合に session UUID を返す.
   * provider.extractSessionId に従って filename から抽出.
   * 未発見なら null. active-repos watcher 等、 SID 単位で書き出される
   * 補助ファイルを引きたいモジュールが参照する.
   */
  getSessionUuid: () => string | null;
  /** Backward-compat alias for getSessionUuid (sidecar context が古い名前で参照する). */
  getClaudeSessionId: () => string | null;
  /** discover + claim 済の transcript JSONL の絶対パス. 未発見なら null. */
  getTranscriptPath: () => string | null;
  /**
   * 直近 `limit` 行を読み出して返す pull API (`GET /v1/transcript` の実体).
   * transcript-tail は通常 Concordia へ frame を push するだけなので、 ローカルから
   * 「今このセッションは何をしているか」 を引きたい呼び出し元 (delegation 監視等) の
   * ための読み出し口. raw=false なら lineToFrame 済の slim frame、 raw=true なら
   * パース済の生 JSONL オブジェクトを返す.
   */
  readRecent: (limit: number, opts?: { raw?: boolean }) => TranscriptReadResult;
  /**
   * 束縛中の transcript を強制的に取り直して re-pin する (手動 /v1/repin の実体)。
   * /clear なしで relay スタールを復帰させる: 現束縛 (死んだ/誤った JSONL) の claim を
   * 解放し、 claim ガード付き mtime discover で自分の最新 transcript を掴み直す。
   * 戻り値は新たに束縛したパス (取り直せなければ ok=false + 現状パス)。
   */
  forceRediscover: () => { ok: boolean; path: string | null };
}

/** `readRecent` / `readRecentFromFile` の戻り値. */
export interface TranscriptReadResult {
  /** 読み出した JSONL の絶対パス. transcript 未発見なら null. */
  path: string | null;
  /** transcript が discover 済で読めたか. */
  available: boolean;
  /** ファイル中の非空行の総数 (tail 前の母数). */
  total_lines: number;
  /** 実際に返した要素数 (frames or lines の length). */
  returned: number;
  /** raw=false のとき: lineToFrame 済の slim frame 配列 (古い順). */
  frames?: Frame[];
  /** raw=true のとき: パース済の生 JSONL オブジェクト配列 (古い順). */
  lines?: unknown[];
}

export interface TranscriptTailOptions {
  cwd: string;
  sessionId: string;
  concordiaBaseUrl: string;
  provider: ProviderConfig;
  /**
   * App Server bootstrap で確定済みの Codex thread id。指定時は初回から exact match のみを
   * 許可し、mtime による候補選択へ降りない。
   */
  expectedCodexThreadId?: string | null;
  /**
   * Lictor が spawn した codex の session_meta.originator に焼いたマーカー
   * (CODEX_INTERNAL_ORIGINATOR_OVERRIDE の値)。 指定時は originator 完全一致の
   * rollout 以外を候補から構造的に排除する (初回束縛の mtime 推測を廃し、
   * 同 cwd の別 codex セッション rollout を掴む crosstalk を塞ぐ)。
   */
  expectedCodexOriginator?: string | null;
  /** App Server binding frame と seq 空間を共有する ordered sink。 */
  transcriptSink?: TranscriptFrameSink | null;
  /** ordered sink の永続失敗を wrap へ伝える。 */
  onRelayError?: (error: Error) => void;
  /**
   * Called with the AskUserQuestion `tool_use` id when a picker is detected
   * opening in the transcript. wrap.ts wires this to {@link PendingQuestionGate}
   * so ordinary pty injects are held while the picker waits for an answer.
   * Optional — omitted by harnesses that don't gate injects.
   */
  onQuestionOpen?: (id: string) => void;
  /**
   * Called with a `tool_result.tool_use_id` when one is observed. The gate
   * resolves only ids it has open, so passing every tool_result id is safe.
   */
  onQuestionResolved?: (id: string) => void;
  /**
   * ask マーカー検出を有効にするか (= ステアリング注入済の provider セッション)。
   * 有効なら assistant テキスト中の ```ask ブロックを pending-question に流す。
   */
  askMarkerEnabled?: boolean;
  /**
   * ask マーカー由来の pending-question が Concordia に登録され question_id が
   * 返ったとき呼ぶ。wrap.ts はこの id を「テキスト回答で返す」集合に記録する。
   */
  onAskMarkerPosted?: (questionId: number) => void;
  /**
   * AskUserQuestion (組み込み picker) が Concordia に pending-question として登録され
   * question_id が返ったとき呼ぶ。wrap.ts はこの id を「picker キーストローク回答」集合に
   * 記録し、Concordia 独自起源の質問 (どちらにも属さない) との三分岐を実現する。
   */
  onPickerQuestionRegistered?: (questionId: number) => void;
  /**
   * transcript に user メッセージ (端末でのローカル返信) が現れたとき呼ぶ。
   * 開いている ask マーカー質問をローカル解決扱いにして Discord ボタンを失効させる。
   * askMarkerEnabled のときのみ発火する (ask マーカー専用)。
   */
  onUserReply?: () => void;
  /**
   * transcript に user ロールのメッセージフレームが現れるたびに呼ぶ汎用シグナル
   * (askMarkerEnabled に依らず常時発火)。 submit-watchdog が「注入テキストが実際に
   * submit されて LLM ターンが始まったか」 を判定するのに使う。
   */
  onUserMessage?: () => void;
  /**
   * 「現在の Claude transcript JSONL 実パス」 追跡ファイルの絶対パス
   * (`<stateDir>/claude-transcript-<lictorId>.txt`、 SessionStart hook が書く)。
   *
   * これは「どの JSONL を tail すべきか」 の **権威ソース**。 指定があり poll ごとに
   * このファイルが claude の実 transcript_path を報告していれば、 現在束縛中の JSONL と
   * 変わったとき (= 起動直後の確定 / `/clear` 等でローテート) 新しい実パスへ束縛し直して
   * 中継を継続する。 `--session-id` で渡した uuid と実ファイル名が一致しなくても、 hook が
   * 実パスを報告するので正しく掴める (mtime 推測を一切しないので crosstalk が起きない)。
   * null/未指定なら hook 由来の束縛更新はしない (従来の computed pin / mtime discover)。
   */
  lictorTranscriptStatePath?: string | null;
  /**
   * spawn 時に `--session-id <uuid>` で固定した transcript JSONL の **計算上の** 絶対パス
   * (`<cwdKey>/<uuid>.jsonl`)。
   *
   * 指定があると mtime ベースの discover を **完全にバイパス** し、 このパスだけを
   * claim/tail する。 uuid は wrapper が発番した一意値なので、 同 cwd で別 wrapper が
   * 並走していても・先に非 Lictor の同 provider を起動していても・context 要約で別
   * session に jsonl がローテートしても、 自分以外の transcript を誤って掴む (= 投稿が
   * 1 つズレて別チャンネルに出る crosstalk) ことが構造的に起きない。
   *
   * これは SessionStart hook が実 transcript_path ({@link lictorTranscriptStatePath}) を
   * 報告するまでの **起動直後ブリッジ** として働く。 ファイル名が一致する通常ケースでは
   * これだけで中継が即始まり、 一致しないケースでも hook 報告後に正しい実パスへ束縛が
   * 差し替わる。 null/未指定なら mtime discover に委譲する (pin 非対応 provider /
   * resume 系 flag 指定時)。
   */
  pinnedTranscriptPath?: string | null;
  /**
   * hook 権威が設定済なのに猶予 (TRANSCRIPT_RESOLVE_GRACE_MS) を超えても transcript を
   * 束縛できず中継不能になったとき、 1 度だけ呼ぶ。 wrap.ts はこれを Concordia 経由の
   * 「Lictor システムメッセージ」 として Discord セッションチャンネルへ投稿する配線に使う
   * (= 中継が黙って止まったのをユーザが Discord 上で気付ける)。 detail は人間可読の説明。
   */
  /**
   * 「このセッションで実際にターンが始まったか (ユーザ発話 / リモート注入があったか)」 を返す。
   * claude は **初回メッセージを受けてから** transcript JSONL を書く (SessionStart 時点では
   * 未生成) ため、 無操作のアイドルセッションでは transcript が無いのが正常。 fail-loud は
   * これが true のときだけ発火させ、 「まだ誰も話しかけていないだけ」 を中継不能と誤検知して
   * Discord に誤投稿するのを防ぐ。 未指定なら常に true 扱い (従来動作)。
   */
  isSessionActive?: () => boolean;
}

export function startTranscriptTail(opts: TranscriptTailOptions): TranscriptTailHandle {
  const dir = opts.provider.transcriptDir(opts.cwd);
  let jsonlPath: string | null = null;
  // 現在 tail 対象として束縛している実 transcript JSONL パス. 起動時は opts 由来の
  // computed pin (`<uuid>.jsonl`、 非 pin provider では null)。 SessionStart hook が
  // 実 transcript_path を報告したら maybeRebind がそちらへ差し替える (権威ソース)。
  // `/clear` 等でローテートしても hook 再報告で追従する。
  let pinnedPath: string | null = opts.pinnedTranscriptPath ?? null;
  let claimPath: string | null = null;
  let offset = 0;
  let seq = 0;
  let pending = "";
  let stopped = false;
  // hook 権威が設定済なのに猶予内に transcript を束縛できなかったとき、 1 度だけ
  // fail-loud 警告を出すためのフラグ (沈黙死禁止)。
  let relayUnresolvedWarned = false;
  const startedAt = Date.now();
  // watchdog: 最後に「束縛できた / 新バイトを読めた」 時刻。 これが STALL_RECOVERY_MS
  // 以上更新されず、 かつ session active なら relay スタールとみなして取り直す。
  let lastProgressAt = Date.now();
  // codex (pin 不可 + hook 権威なし) の session_id 施錠キー。 初回束縛で
  // session_meta.session_id を読んで記録し、 以後この id を持つ rollout 以外には
  // 一切紐づけない (鉄のルール: mtime 推測での再束縛を排し crosstalk を構造排除)。
  //
  // ローカルLLM/Ollama 系 (usesFilenameSessionLock): transcript ファイル名の末尾 UUID が
  // Lictor の session id なので、 自分の session id から施錠キーを **事前施錠** する。
  // これで discoverCodex は初回から filename UUID 完全一致の 1 ファイルだけを束縛し、
  // 同一 sessions dir に別セッションの JSONL が並んでも exact bind する (mtime 推測ゼロ)。
  // UUID が抽出できなければ null のままにし、 従来の初回束縛にフォールバックする。
  let boundSessionId: string | null = opts.expectedCodexThreadId?.trim() || null;
  if (!boundSessionId && opts.provider.usesFilenameSessionLock) {
    boundSessionId = opts.provider.extractSessionId(opts.sessionId);
  }
  // 施錠キーで一度でも実 transcript を束縛できたか。 事前施錠 (usesFilenameSessionLock)
  // では起動直後 runner がまだファイルを書いておらず「施錠キー一致 0 件」 が正常なので、
  // 一度も束縛していない間は fail-loud せず静かに待つ (束縛後に喪失したときだけ鳴らす)。
  let hasBoundOnce = false;
  // 束縛を拒否 (同 cwd 並走で曖昧 / 施錠喪失) したとき、 中継が黙って止まらないよう
  // fail-loud する。 bind 成功でリセットし、 次の異常でまた 1 度鳴らせる。
  let codexFailLoudWarned = false;
  // AskUserQuestion の tool_use id → Concordia の question_id。picker がローカル回答で
  // 解決した（tool_result 検知）とき、Concordia に resolve 通知して古いボタンを失効させる。
  const questionIdByToolUse = new Map<string, number>();
  // AskUserQuestion tool は Claude Code 専用. Codex / Gemini provider のときは
  // 検知を回避して JSON.parse の二度手間を避ける (= lineToFrame だけ走らせる).
  const askUserQuestionEnabled = providerSupportsAskUserQuestion(opts.provider);

  const sendFrame = async (kind: string, payload: unknown): Promise<void> => {
    try {
      if (opts.transcriptSink) {
        await opts.transcriptSink.post(kind, payload);
        return;
      }
      await postFrame(opts.concordiaBaseUrl, opts.sessionId, seq++, kind, payload);
    } catch (error) {
      opts.onRelayError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };

  // provider.transcriptDir が null を返す provider (Gemini 等) は no-op handle.
  if (!dir) {
    return {
      stop: () => {
        stopped = true;
      },
      getSessionUuid: () => null,
      getClaudeSessionId: () => null,
      getTranscriptPath: () => null,
      readRecent: (limit, opts) => readRecentFromFile(null, limit, opts?.raw ?? false),
      forceRediscover: () => ({ ok: false, path: null }),
    };
  }

  // provider の先頭行メタ判定 (codex: cwd 一致 + `codex exec` rollout 除外)。
  // フィルタ未定義 provider / 先頭行が読めない・形式不明の場合は許可し、 従来どおり
  // claim ガードに委ねる (fail-open)。 claim より先に判定して、 別セッションの
  // ファイルへ claim を置いてしまう副作用ごと避ける。
  const expectedOriginator = opts.expectedCodexOriginator?.trim() || null;
  const candidateAccepted = (path: string, st?: Stats): boolean => {
    const accepts = opts.provider.transcriptMetaAccepts;
    if (!accepts) return true;
    const first = readTranscriptFirstLine(path);
    // originator 施錠モードでは先頭行が読めない候補を掴まない (fail-open すると
    // mtime 推測束縛が復活する)。 自分の rollout の書きかけは次回 poll で読める。
    if (first === null) return !expectedOriginator;
    if (accepts(first, { cwd: opts.cwd, startedAtMs: startedAt, mtimeMs: st?.mtimeMs, expectedOriginator })) return true;
    claimDbg(`candidate rejected by meta filter path=${path} owner=${opts.sessionId}`);
    return false;
  };

  // codex 束縛を拒否したときの fail-loud (沈黙死禁止)。 曖昧 (同 cwd 並走) /
  // 施錠喪失で「掴まない」 判断をしたことを stderr に 1 度出す。 まだ発話されていない
  // アイドルは正常なので鳴らさない。
  const warnCodexFailLoud = (detail: string): void => {
    if (codexFailLoudWarned) return;
    if (opts.isSessionActive && !opts.isSessionActive()) return;
    codexFailLoudWarned = true;
    try {
      process.stderr.write(`lictor: codex transcript relay held — ${detail}\n`);
    } catch { /* best-effort */ }
  };

  // 束縛先パスを差し替える共通処理 (offset/pending を初期化し watchdog grace をリセット)。
  const bindPath = (path: string): void => {
    jsonlPath = path;
    offset = 0;
    pending = "";
    lastProgressAt = Date.now();
  };

  const sessionIdFromTranscriptPath = (path: string): string | null => {
    const slash = path.lastIndexOf("/");
    const back = path.lastIndexOf("\\");
    let base = path.slice(Math.max(slash, back) + 1);
    if (base.endsWith(".jsonl")) base = base.slice(0, -".jsonl".length);
    return opts.provider.extractSessionId(base);
  };

  // codex (pin 不可 + hook 権威なし) の discover。 候補は cwd/exec/head-ts で絞り、
  // session_meta の session_id を優先、無ければ rollout filename の UUID を施錠キーにする。
  //
  //   - 未施錠 (初回): 候補 1 件なら束縛。複数候補なら spawn 直後の mtime 最新を採る。
  //     最新 mtime が同点なら曖昧として fail-loud し、推測束縛しない。
  //   - 施錠済: 施錠キー一致の rollout だけを対象にする。 一致 0 件なら束縛喪失として
  //     fail-loud し、 別 session_id へは降りない。
  const discoverCodex = (): string | null => {
    type C = { path: string; sessionId: string | null; fileSessionId: string | null; mtime: number };
    const candidates: C[] = [];
    walkJsonl(dir, MAX_DISCOVERY_DEPTH, (p, st) => {
      // 過去セッションの継承を防ぐ recency 下限。候補が複数なら mtime で最新を選ぶ。
      if (st.mtimeMs < startedAt - 5_000) return;
      if (!candidateAccepted(p, st)) return; // cwd / exec / head-ts
      const first = readTranscriptFirstLine(p);
      const metaSid = first ? opts.provider.transcriptMetaSessionId?.(first) ?? null : null;
      const fileSid = sessionIdFromTranscriptPath(p);
      const sid = metaSid ?? fileSid;
      candidates.push({ path: p, sessionId: sid, fileSessionId: fileSid, mtime: st.mtimeMs });
    });

    if (boundSessionId) {
      const matches = candidates
        .filter((c) => c.sessionId === boundSessionId || c.fileSessionId === boundSessionId)
        .sort((a, b) => b.mtime - a.mtime);
      if (matches.length === 0) {
        // 一度でも束縛できていれば「喪失」 として fail-loud。 事前施錠で未束縛のまま
        // (runner がまだ書いていない) なら正常な待機なので黙って待つ。
        if (hasBoundOnce) {
          warnCodexFailLoud(`bound session_id=${boundSessionId} rollout not found; relay held (no mtime fallback)`);
        }
        return null;
      }
      const best = matches[0].path;
      if (best === jsonlPath) return best; // 既に束縛中 (claim 保持済)
      const cp = tryClaimJsonl(best, STALE_CLAIM_MS, opts.sessionId);
      if (!cp) return null;
      if (claimPath) { try { unlinkSync(claimPath); } catch { /* best-effort */ } }
      claimPath = cp;
      hasBoundOnce = true;
      codexFailLoudWarned = false; // 束縛できた: 次に喪失したらまた 1 度鳴らせる
      return best;
    }

    const decision = decideCodexInitialBind(candidates.map((c) => ({
      path: c.path,
      sessionId: c.sessionId,
      mtimeMs: c.mtime,
    })));
    if (decision.action === "wait") return null;
    if (decision.action === "ambiguous") {
      warnCodexFailLoud(
        `${decision.paths.length} concurrent codex rollouts in this cwd; refusing to bind ` +
          `(crosstalk guard, no guess). paths=${decision.paths.join(", ")}`,
      );
      return null;
    }
    const cp = tryClaimJsonl(decision.path, STALE_CLAIM_MS, opts.sessionId);
    if (!cp) return null;
    claimPath = cp;
    boundSessionId = decision.sessionId;
    hasBoundOnce = true;
    codexFailLoudWarned = false; // 束縛できた: 次の異常でまた fail-loud できるよう解除
    claimDbg(`codex bound session_id=${boundSessionId} path=${decision.path} owner=${opts.sessionId}`);
    return decision.path;
  };

  // 同 cwd で複数 lictor wrapper が並走するとき、 mtime 最新だけで pick すると
  // 全 wrapper が同じ jsonl を読んで「他セッションの transcript を自分の session_id
  // で Concordia に送る」 race を起こす. 結果として AI 応答が別 channel に混在する.
  //
  // 各 jsonl に sidecar の `<path>.lictor-claim` を atomic create (`wx`) で配置し、
  // 取れた wrapper だけがその jsonl を tail する. 取れなかった候補は次点を試す.
  // 自分の jsonl がまだ作成されていない場合は null で抜けて、 次回 poll で再 discover.
  const discover = (): string | null => {
    // 束縛先 (pinnedPath) が決まっている場合は mtime 推測を一切せず、 その path のみ。
    // pinnedPath は (a) wrapper が発番した一意 uuid の computed pin、 または
    // (b) SessionStart hook が報告した実 transcript_path (maybeRebind が差し替え済) の
    // どちらか。 いずれも自分のセッション固有のファイルなので、 別セッションの JSONL を
    // 誤掴みする crosstalk が構造的に起きない。 stale-claim 剥がし等の共通ロジックを
    // 通すため tryClaimJsonl は経由する。
    if (pinnedPath) {
      if (existsSync(pinnedPath)) {
        const cp = tryClaimJsonl(pinnedPath, STALE_CLAIM_MS, opts.sessionId);
        if (cp) {
          claimPath = cp;
          claimDbg(`pinned transcript claimed path=${pinnedPath} owner=${opts.sessionId}`);
          return pinnedPath;
        }
        return null; // 一意 uuid / 実パスのため通常起き得ない; 万一 claim 済なら次 poll で再試行
      }
      // pinned path がまだ現れない。 mtime 推測にフォールバックすると別セッションの JSONL を
      // 誤掴みして crosstalk が再発するため、 ここでは待つだけ。 computed pin のファイル名が
      // 実体と不一致でも、 SessionStart hook が実 transcript_path を報告し次第 maybeRebind が
      // 正しい実パスへ束縛を差し替えるので中継不能には陥らない。
      return null;
    }
    // pinnedPath が null = まだ束縛先が確定していない。
    // hook 権威 (lictorTranscriptStatePath) が設定済 (claude) なら、 maybeRebind が hook の
    // 実 transcript_path を束縛するまで待つ。 mtime 推測は crosstalk 源なので一切しない。
    if (opts.lictorTranscriptStatePath) return null;
    // hook 権威なし & pin 不可 (codex 等): session_id 施錠で discover する。
    if (!existsSync(dir)) return null;
    return discoverCodex();
  };

  // SessionStart hook (起動 / `/clear` / resume / compact で発火) が報告する実
  // transcript_path を権威ソースとして、 tail 対象の束縛先を最新に保つ。 これにより:
  //   - `--session-id` uuid と実ファイル名が不一致でも実ファイルを掴める (中継不能の解消)
  //   - `/clear` で別 JSONL にローテートしても新ファイルへ追従する
  //   - mtime 推測を一切しないので別セッションの JSONL を誤掴みしない (crosstalk 構造排除)
  const maybeRebind = (): void => {
    if (!opts.lictorTranscriptStatePath) return; // hook 由来の権威更新なし (従来動作)
    const want = readClaudeTranscriptPath(opts.lictorTranscriptStatePath);
    if (!want) return; // SessionStart hook 未発火 — 起動直後は computed pin で橋渡し
    if (want === pinnedPath) return; // 変化なし
    // 報告パスがまだ実在しないなら束縛を差し替えない。 旧実装は phantom / 生成前パスへ
    // 無条件に rebind して jsonlPath=null のまま discover が掴めず中継が黙って停止した
    // (本番実害 2026-06-30)。 実在するまでは現束縛 (旧 JSONL) を tail し続け、 ファイルが
    // 現れた瞬間に乗り換える。 これで /clear ローテートの取りこぼしも無くなる。
    if (!existsSync(want)) {
      claimDbg(`rebind deferred: reported transcript_path not yet present want=${want}`);
      return;
    }
    claimDbg(`rebind: authoritative transcript_path ${pinnedPath ?? "?"} -> ${want}`);
    // 旧 JSONL の claim を解放し (computed pin の誤ファイル or ローテート前の死ファイル)、
    // 新ファイルを次の discover で掴む。
    if (claimPath) {
      try {
        unlinkSync(claimPath);
      } catch {
        /* best-effort */
      }
      claimPath = null;
    }
    pinnedPath = want;
    jsonlPath = null;
    offset = 0;
    pending = "";
    // seq は連続維持 (Concordia 側の frame 順序を壊さない)。
  };

  // hook 権威が設定済なのに猶予を過ぎても transcript を束縛できないとき、 1 度だけ
  // 大きく表面化する (沈黙死禁止: feedback_no_silent_fallback)。 「claude が transcript を
  // 実ファイルとして永続化しない / hook が phantom path を報告する」 等の異常を、 中継が
  // 黙って止まったまま放置せず stderr + Concordia event で可視化する。 hook 権威なし
  // provider (codex/gemini) は対象外 (mtime discover に正当に委ねるため)。
  const warnIfRelayUnresolved = (): void => {
    if (relayUnresolvedWarned) return;
    if (!opts.lictorTranscriptStatePath) return;
    if (Date.now() - startedAt < TRANSCRIPT_RESOLVE_GRACE_MS) return;
    // claude は **初回ターンを受けてから** transcript JSONL を書く (SessionStart 時点では
    // 未生成) ため、 無操作のアイドルセッションでは未生成が正常。 実際にターンが始まった
    // (submit/inject があった) ときだけ警告し、 「まだ誰も話しかけていないだけ」 を中継不能と
    // 誤検知しない。
    if (opts.isSessionActive && !opts.isSessionActive()) return;
    relayUnresolvedWarned = true;
    const reported = readClaudeTranscriptPath(opts.lictorTranscriptStatePath);
    const missing = reported ? !existsSync(reported) : false;
    // 端末 (Lictor の stderr) にだけ 1 度出す (no-silent-fallback の最小担保)。 Discord へは
    // 出さない (壊れたセッションに毎回ノイズを撒かない)。
    try {
      process.stderr.write(
        `lictor: transcript unresolved ${Math.round((Date.now() - startedAt) / 1000)}s after first turn; ` +
          `relay inactive. hook transcript_path=${reported ?? "(none)"}${missing ? " [missing]" : ""}\n`,
      );
    } catch { /* best-effort */ }
  };

  // stall 復帰 / 手動 repin のディスパッチャ。 どちらの経路も mtime 推測での
  // 別セッション誤掴みを構造的に排除している (鉄のルール: 束縛キーは権威パス or session_id)。
  //
  //   - hook 権威あり (claude): 権威 transcript_path を真として束縛し直す (recoverByAuthority)。
  //     mtime 推測は **絶対にしない**。 共有 projects/<cwd> で複数セッションが同居しても、
  //     権威パスは「このセッションの実ファイル」 を一意に指すので誤掴みが起きない。
  //
  //   - hook 権威なし + session_id 読取り可 (codex): session_id 施錠のまま同一 id の
  //     rollout を取り直す (recoverCodexLocked)。 別 session_id へは絶対に降りない。
  //   - pin のみ (hook 無し claude / メタ無し provider): pin へ束縛し直すだけ
  //     (recoverByPin)。 いずれの経路も mtime 推測での誤掴みが構造的に起きない。
  const recoverRelay = (force = false): { ok: boolean; path: string | null } => {
    if (opts.lictorTranscriptStatePath) return recoverByAuthority();
    // codex (session_meta 施錠) と ローカルLLM (filename 施錠) はどちらも施錠キーで
    // discoverCodex を取り直す。 別 session へは降りない (crosstalk 構造排除)。
    if (opts.provider.transcriptMetaSessionId || opts.provider.usesFilenameSessionLock) {
      return recoverCodexLocked();
    }
    return recoverByPin();
  };

  // hook 権威ありの stall 復帰: 権威 transcript_path (SessionStart hook が書く実パス) を
  // 読み直し、 実在し現束縛と異なればそこへ re-pin する。 mtime には一切降りない。
  //   - 権威が未報告 / 実在しない: 「別セッションの JSONL を掴む」 より 「束縛しない」 を選ぶ。
  //     hook が実在パスを報告し次第 maybeRebind / discover が拾うので中継不能には陥らない。
  //   - 権威 == 現束縛: 既に正しいファイル。 中継側で直す対象は無い (stall は Concordia 不達
  //     等の外的要因)。 watchdog の連打を避けるため進捗時刻だけ進めて抜ける。
  const recoverByAuthority = (): { ok: boolean; path: string | null } => {
    const statePath = opts.lictorTranscriptStatePath;
    if (!statePath) return { ok: false, path: jsonlPath };
    const want = readClaudeTranscriptPath(statePath);
    if (!want || !existsSync(want)) return { ok: false, path: jsonlPath };
    if (want === jsonlPath) {
      lastProgressAt = Date.now();
      return { ok: false, path: jsonlPath };
    }
    const cp = tryClaimJsonl(want, STALE_CLAIM_MS, opts.sessionId);
    if (!cp) return { ok: false, path: jsonlPath };
    if (claimPath) { try { unlinkSync(claimPath); } catch { /* best-effort */ } }
    claimPath = cp;
    pinnedPath = want; // 以後の権威。 hook が別の実在パスを報告すれば maybeRebind が更に追従。
    jsonlPath = want;
    offset = 0;
    pending = "";
    lastProgressAt = Date.now();
    claimDbg(`stall-recovery (authority) rebind to ${want} owner=${opts.sessionId}`);
    return { ok: true, path: want };
  };

  // codex の stall 復帰 / 手動 repin: session_id 施錠のまま同一 id の rollout を
  // discoverCodex で取り直すだけ。 mtime 推測で別 session_id を掴む経路は持たない
  // (crosstalk 構造排除)。 施錠済で同一 id が見つかればそこへ束縛し直し、 見つからなければ
  // discoverCodex 内で fail-loud する (別 id へは降りない)。 未施錠なら初回束縛を再試行する。
  const recoverCodexLocked = (): { ok: boolean; path: string | null } => {
    if (!dir || !existsSync(dir)) return { ok: false, path: jsonlPath };
    const found = discoverCodex();
    if (found && found !== jsonlPath) {
      bindPath(found);
      claimDbg(`codex stall-recovery rebind to ${found} owner=${opts.sessionId}`);
      return { ok: true, path: found };
    }
    return { ok: false, path: jsonlPath };
  };

  // pin のみ (hook 権威なし claude / メタ無し provider) の stall 復帰 / 手動 repin。
  // 束縛先は起動時の pin で確定しているので、 mtime 推測は一切せず pin が実在すれば
  // そこへ束縛し直すだけ (別 JSONL を推測で掴まない = crosstalk なし)。 pin が現束縛と
  // 同じなら何もしない (stall は外的要因)。
  const recoverByPin = (): { ok: boolean; path: string | null } => {
    if (!pinnedPath || !existsSync(pinnedPath)) return { ok: false, path: jsonlPath };
    if (pinnedPath === jsonlPath) {
      lastProgressAt = Date.now();
      return { ok: false, path: jsonlPath };
    }
    const cp = tryClaimJsonl(pinnedPath, STALE_CLAIM_MS, opts.sessionId);
    if (!cp) return { ok: false, path: jsonlPath };
    if (claimPath) { try { unlinkSync(claimPath); } catch { /* best-effort */ } }
    claimPath = cp;
    bindPath(pinnedPath);
    claimDbg(`stall-recovery (pin) rebind to ${pinnedPath} owner=${opts.sessionId}`);
    return { ok: true, path: pinnedPath };
  };

  // poll から呼ぶ自動 watchdog: session active かつ STALL_RECOVERY_MS 進捗ゼロなら再束縛。
  // 経路は recoverRelay が hook 権威の有無で分岐する (claude は権威パスのみ、 mtime は使わない)。
  const maybeRecover = (): void => {
    const active = opts.isSessionActive ? opts.isSessionActive() : true;
    if (!active) return; // まだ誰も話しかけていないアイドルは正常 (transcript 未生成)。
    if (Date.now() - lastProgressAt < STALL_RECOVERY_MS) return;
    recoverRelay(false);
  };

  const pollOnce = async (): Promise<void> => {
    if (stopped) return;
    maybeRebind();
    if (!jsonlPath) {
      jsonlPath = discover();
      if (!jsonlPath) {
        warnIfRelayUnresolved();
        maybeRecover(); // active なら取り直す (claude=権威パス / codex=同一 session_id のみ)。
        return;
      }
      offset = 0;
      lastProgressAt = Date.now();
    }
    // active 中は claim の mtime を更新し続け、 stale (1h) 判定で他 wrapper に
    // 剥がされて「同じ jsonl を 2 wrapper が tail → 別 channel 誤投稿」 になるのを防ぐ。
    if (claimPath) refreshClaim(claimPath);
    let size: number;
    try {
      size = statSync(jsonlPath).size;
    } catch {
      return; // file went away
    }
    if (size <= offset) {
      // 束縛済だが伸びていない。 単なるアイドルなら正常だが、 active なのに長時間ゼロ進捗なら
      // ローテートで死んだファイルを掴み続けている可能性 → watchdog で生 transcript を取り直す。
      maybeRecover();
      return;
    }
    let chunk: Buffer;
    try {
      const fd = readFileSync(jsonlPath); // small per-poll; OK in v1
      chunk = fd.subarray(offset, size) as Buffer;
    } catch {
      return;
    }
    offset = size;
    lastProgressAt = Date.now(); // 新バイトを読めた = relay 生存。 watchdog の grace をリセット。
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      // AskUserQuestion / ExitPlanMode tool_use を見つけたら、 transcript.frame の正規ルートとは別に
      // Concordia の pending-question API に直接通知する. これで Discord 側 (bot.routeEvent)
      // の question.posted listener が embed + button を session channel に出せるようになる.
      // questions[] が複数ある場合は **全部** 一気に流す (一括投稿).
      if (askUserQuestionEnabled) {
        const pqs = detectAskUserQuestion(line).concat(detectExitPlanMode(line));
        for (const pq of pqs) {
          // question_id を控えて tool_use id と紐付ける（後で local-resolve 通知に使う）。
          // 登録成功後に onPickerQuestionRegistered を呼び、wrap.ts が「picker 既知 qid」
          // 集合に追加できるようにする（Concordia 起源の質問との三分岐判定に使う）。
          void postPendingQuestion(opts.concordiaBaseUrl, opts.sessionId, pq).then((qid) => {
            if (qid != null && pq.id) questionIdByToolUse.set(pq.id, qid);
            if (qid != null) opts.onPickerQuestionRegistered?.(qid);
          });
          opts.onQuestionOpen?.(pq.id);
        }
        // A picker resolving (locally OR remotely) writes a tool_result whose
        // tool_use_id matches the question — that is what releases the gate.
        for (const id of detectAnsweredQuestionIds(line)) {
          opts.onQuestionResolved?.(id);
          const qid = questionIdByToolUse.get(id);
          if (qid != null) {
            questionIdByToolUse.delete(id);
            void postResolveQuestion(opts.concordiaBaseUrl, opts.sessionId, qid);
          }
        }
      }
      const frame = lineToFrame(line);
      if (!frame) continue;
      // user ロールのメッセージが出た = 端末入力 or 注入テキストが submit されて
      // LLM ターンが始まった汎用シグナル。 submit-watchdog の武装解除に使う
      // (askMarkerEnabled に依らず常時発火)。
      if (frame.kind === "text" && (frame.payload as { role?: unknown }).role === "user") {
        opts.onUserMessage?.();
      }
      // ask マーカー: assistant テキスト中の ```ask ブロックを pending-question へ。
      // provider 非依存 — lineToFrame が Claude/Codex の assistant テキストを正規化済。
      //
      // 「説明テキストを先に / 質問カード (raw JSON) を最後に分割送信」 する:
      //   1. ask ブロックを除いた説明テキストを text frame として **先に await 送信**
      //   2. そのあとで pending-question (質問カード) を送る
      // これで Discord 側の「カードが説明より先に出る」順序逆転と、説明メッセージへの
      // raw JSON 二重表示を解消する。元フレーム (raw JSON 入り) は再送しない。
      // user テキストはローカル返信とみなし、開いている marker 質問を resolve させる。
      if (opts.askMarkerEnabled && frame.kind === "text") {
        const p = frame.payload as { role?: unknown; text?: unknown };
        if (p.role === "assistant" && typeof p.text === "string") {
          const marker = parseAskMarkerText(p.text);
          if (marker) {
            // 1. 説明テキスト (ask ブロック除去済) を先に送る。中身が空なら省略。
            const stripped = stripAskBlock(p.text);
            if (stripped) {
              await sendFrame("text", {
                ...(frame.payload as object),
                text: stripped,
              });
            }
            // 2. 質問カードを最後に送る (説明の後に届くよう await 後に投稿)。
            const qid = await postPendingQuestion(opts.concordiaBaseUrl, opts.sessionId, {
              id: "",
              question: marker.question,
              options: marker.options,
              multiSelect: marker.multiSelect,
            });
            if (qid != null) opts.onAskMarkerPosted?.(qid);
            continue; // raw JSON を含む元フレームは送らない (分割済み)
          }
        } else if (p.role === "user" && typeof p.text === "string") {
          opts.onUserReply?.();
        }
      }
      void sendFrame(frame.kind, frame.payload).catch(() => undefined);
    }
  };

  const timer = setInterval(() => {
    void pollOnce().catch(() => {});
  }, POLL_INTERVAL_MS);
  timer.unref?.();

  const getSessionUuid = (): string | null => {
    // codex は施錠済 session_meta.session_id が最も権威ある id。 それ以外 (claude 等) は
    // 従来どおり束縛中ファイル名から抽出する。
    if (boundSessionId) return boundSessionId;
    if (!jsonlPath) return null;
    return sessionIdFromTranscriptPath(jsonlPath);
  };

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (claimPath) {
        try { unlinkSync(claimPath); } catch { /* best-effort */ }
        claimPath = null;
      }
    },
    getSessionUuid,
    getClaudeSessionId: getSessionUuid,
    getTranscriptPath: () => jsonlPath,
    readRecent: (limit, opts) => readRecentFromFile(jsonlPath, limit, opts?.raw ?? false),
    forceRediscover: () => recoverRelay(true),
  };
}

/** codex 初回束縛の候補 (path と、 session_meta session_id / filename UUID 由来の施錠キー)。 */
export interface CodexBindCandidate {
  path: string;
  sessionId: string | null;
  mtimeMs?: number;
}

/** {@link decideCodexInitialBind} の判定結果。 */
export type CodexBindDecision =
  | { action: "bind"; path: string; sessionId: string }
  | { action: "wait" }
  | { action: "ambiguous"; paths: string[] };

/**
 * codex の初回束縛の決定 (純関数, test 対象)。 accepts フィルタ (cwd/exec/head-ts) を
 * 通過済の候補から、 session_id / filename UUID を束縛キーとして決める:
 *
 *   - 施錠キーが読める候補が 0 件 → `wait`。
 *   - ちょうど 1 件 → `bind`。
 *   - 2 件以上 → mtime が一意に最新の候補を `bind`。同点 / mtime 不明なら `ambiguous`。
 *
 * 施錠キーが読めない候補 (メタ未書き込み / filename 規約外) は束縛キーを持たないため、
 * 判定母集団から除外する (施錠できないファイルには紐づけない)。
 */
export function decideCodexInitialBind(candidates: CodexBindCandidate[]): CodexBindDecision {
  const withId = candidates.filter(
    (c): c is { path: string; sessionId: string; mtimeMs?: number } =>
      typeof c.sessionId === "string" && c.sessionId.length > 0,
  );
  if (withId.length === 0) return { action: "wait" };
  if (withId.length === 1) return { action: "bind", path: withId[0].path, sessionId: withId[0].sessionId };
  const byMtime = withId
    .filter((c): c is { path: string; sessionId: string; mtimeMs: number } =>
      typeof c.mtimeMs === "number" && Number.isFinite(c.mtimeMs),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (byMtime.length === withId.length && byMtime[0].mtimeMs > byMtime[1].mtimeMs) {
    return { action: "bind", path: byMtime[0].path, sessionId: byMtime[0].sessionId };
  }
  return { action: "ambiguous", paths: withId.map((c) => c.path) };
}

/**
 * 指定 JSONL の末尾 `limit` 行を読んで `TranscriptReadResult` を組み立てる純関数.
 * push 専用だった transcript-tail に「ローカルから直近を引く」 読み出し口を与える.
 *
 * - `jsonlPath` が null (transcript 未 discover) なら available:false で即返す.
 * - 非空行だけを母数にし、 末尾 `limit` 行を古い順で返す.
 * - raw=false: 各行を `lineToFrame` で slim frame 化 (parse 不能行は捨てる).
 * - raw=true : 各行を `JSON.parse` した生オブジェクト (parse 不能行は捨てる).
 *
 * 副作用は readFileSync 1 回のみ。 sidecar の `GET /v1/transcript` から呼ばれる.
 */
export function readRecentFromFile(
  jsonlPath: string | null,
  limit: number,
  raw: boolean,
): TranscriptReadResult {
  if (!jsonlPath) {
    return { path: null, available: false, total_lines: 0, returned: 0 };
  }
  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf8");
  } catch {
    // claim 済だが読めない (削除/権限) — available:false で path だけ返す.
    return { path: jsonlPath, available: false, total_lines: 0, returned: 0 };
  }
  const allLines = content.split("\n").filter((l) => l.trim().length > 0);
  const want = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const take = Math.min(want, allLines.length);
  const slice = take > 0 ? allLines.slice(allLines.length - take) : [];

  if (raw) {
    const lines: unknown[] = [];
    for (const l of slice) {
      try { lines.push(JSON.parse(l)); } catch { /* skip malformed */ }
    }
    return { path: jsonlPath, available: true, total_lines: allLines.length, returned: lines.length, lines };
  }
  const frames: Frame[] = [];
  for (const l of slice) {
    const f = lineToFrame(l);
    if (f) frames.push(f);
  }
  return { path: jsonlPath, available: true, total_lines: allLines.length, returned: frames.length, frames };
}

/**
 * 1 つの jsonl について `<path>.lictor-claim` を atomic create で取りに行く.
 * 取れたら claim path を返す. 既に他 wrapper が claim 済 or race で取れなかった
 * 場合は null. STALE_CLAIM_MS (既定 5 分) 以上 mtime 更新の無い stale claim は
 * wrapper crash 残骸とみなして剥がす (active な所有者は poll 毎に refreshClaim で
 * mtime を打ち直しているため誤って剥がれない).
 *
 * 純関数なので unit test で複数 wrapper の race を simulation できる.
 */
export function tryClaimJsonl(
  jsonlPath: string,
  staleMs: number = STALE_CLAIM_MS,
  ownerId = "",
): string | null {
  const cp = `${jsonlPath}.lictor-claim`;
  try {
    const cst = statSync(cp);
    if (Date.now() - cst.mtimeMs > staleMs) {
      // stale claim を剥がす前に旧所有者を控えてログる (誤投稿が再発した際の追跡用)。
      let staleOwner = "";
      try { staleOwner = readFileSync(cp, "utf8").trim(); } catch { /* best-effort */ }
      try { unlinkSync(cp); } catch { /* race; 別 wrapper が同時に剥がした */ }
      claimDbg(`stale claim removed path=${jsonlPath} staleOwner=${staleOwner || "?"} ageMs=${Math.round(Date.now() - cst.mtimeMs)} by=${ownerId || "?"}`);
    } else {
      return null; // active claim, owned by someone else
    }
  } catch {
    // no claim file
  }
  try {
    const fd = openSync(cp, "wx");
    try { writeSync(fd, ownerId); } catch { /* owner 記録は best-effort */ }
    closeSync(fd);
    claimDbg(`claim acquired path=${jsonlPath} owner=${ownerId || "?"}`);
    return cp;
  } catch {
    return null;
  }
}

/**
 * 再帰的に .jsonl を探す helper. depth で打ち止め (無限再帰防止).
 * mtime コールバックでフィルタ + 候補ピック.
 */
function walkJsonl(
  root: string,
  depth: number,
  visit: (path: string, st: Stats) => void,
): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) walkJsonl(full, depth - 1, visit);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const st: Stats = statSync(full);
      visit(full, st);
    } catch {
      // file vanished between readdir + stat — ignore
    }
  }
}

interface Frame { kind: string; payload: unknown }

/**
 * Convert one JSONL line into the slim envelope Concordia broadcasts.
 *
 * Claude Code 形式と OpenAI Codex CLI 形式を両方サポート:
 *  - Claude : `{type:"user"|"assistant", message:{role,content:[...]}, uuid}`
 *           : `{type:"summary"|"system"|...}`
 *  - Codex  : `{timestamp, type:"response_item", payload:{type:"message", role, content:[{type:"input_text"|"output_text", text}]}}`
 *           : `{timestamp, type:"event_msg", payload:{type:"user_message"|"agent_message", message}}`
 *           : `{timestamp, type:"session_meta"|"turn_context", payload:{...}}`
 *
 * 未知の type は最後に `raw` frame として落とす.
 */
export function lineToFrame(line: string): Frame | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;

  // ─── Lictor ローカル LLM エージェント形式 ──────────────────────────────
  // local-agent (`lictor cli local-agent`) の独自 JSONL は {ts, role, content}
  // で `type` を持たない。 role+content の string ペアで判定し text/system frame 化する。
  // (compaction 等 role を持たない行は下の type 分岐へ素通りし最終的に raw になる)
  if (
    msg.type === undefined &&
    typeof msg.role === "string" &&
    typeof msg.content === "string"
  ) {
    if (msg.role === "assistant" || msg.role === "user") {
      return { kind: "text", payload: { role: msg.role, text: msg.content.slice(0, 4000) } };
    }
    return { kind: "system", payload: { text: msg.content.slice(0, 4000) } };
  }

  const type = typeof msg.type === "string" ? msg.type : "unknown";

  // Claude per-message uuid — used by PR-F as a fork anchor.
  const claudeUuid = typeof msg.uuid === "string" ? msg.uuid : null;

  // ─── Claude Code 形式 ────────────────────────────────────────────────
  if (type === "user" || type === "assistant") {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          return { kind: "text", payload: { role: type, text: part.text, claude_uuid: claudeUuid } };
        }
        if (part?.type === "tool_use") {
          return {
            kind: "tool-use",
            payload: { role: type, name: part.name, input_preview: previewJson(part.input) },
          };
        }
        if (part?.type === "tool_result") {
          if (Array.isArray(part.content)) {
            for (const c of part.content) {
              if (
                c?.type === "image" &&
                c?.source?.type === "base64" &&
                typeof c?.source?.data === "string" &&
                c.source.data.length > 0
              ) {
                return {
                  kind: "image",
                  payload: { media_type: c.source.media_type ?? "image/png", data: c.source.data },
                };
              }
            }
          }
          return {
            kind: "tool-result",
            payload: {
              tool_use_id: part.tool_use_id,
              is_error: part.is_error === true,
              preview: previewJson(part.content),
            },
          };
        }
        if (part?.type === "thinking" && typeof part.thinking === "string") {
          return { kind: "thinking", payload: { role: type, preview: part.thinking.slice(0, 400) } };
        }
      }
    } else if (typeof content === "string") {
      return { kind: "text", payload: { role: type, text: content } };
    }
    return null;
  }

  if (type === "summary") {
    return { kind: "summary", payload: { text: String(msg.summary ?? "").slice(0, 400) } };
  }

  if (type === "system") {
    return { kind: "system", payload: { text: String(msg.text ?? msg.content ?? "").slice(0, 400) } };
  }

  // ─── Codex CLI 形式 ─────────────────────────────────────────────────
  // event_msg.user_message / agent_message は agent 内部処理を経た「ユーザ
  // 視点のメッセージ」 なので、 これを優先的に text frame 化する.
  if (type === "event_msg" && msg.payload && typeof msg.payload === "object") {
    const p: any = msg.payload;
    const pType = typeof p.type === "string" ? p.type : "";
    if (pType === "user_message" && typeof p.message === "string") {
      return { kind: "text", payload: { role: "user", text: p.message.slice(0, 4000) } };
    }
    if (pType === "agent_message" && typeof p.message === "string") {
      const phase = typeof p.phase === "string" ? p.phase : undefined;
      return {
        kind: "text",
        payload: { role: "assistant", text: p.message.slice(0, 4000), ...(phase ? { phase } : {}) },
      };
    }
    // task_started, tool_call, etc. は raw 扱い (将来必要なら拡張).
  }

  // response_item は SDK レベルの 生 message. event_msg と二重に流すと
  // Web UI で重複するが、 system/developer メッセージ等は event_msg に乗らない
  // ので、 重複は許容して両方流す方が情報量が多い.
  if (type === "response_item" && msg.payload && typeof msg.payload === "object") {
    const p: any = msg.payload;
    const pType = typeof p.type === "string" ? p.type : "";
    if (pType === "message") {
      const role = normalizeCodexRole(p.role);
      if (role) {
        const text = extractCodexMessageText(p.content);
        if (text) {
          const phase = typeof p.phase === "string" ? p.phase : undefined;
          return {
            kind: "text",
            payload: { role, text: text.slice(0, 4000), ...(phase ? { phase } : {}) },
          };
        }
      }
    }
    if (pType === "reasoning") {
      // reasoning は encrypted_content しか持たない場合がある.
      // summary 配列に preview があれば優先、 無ければ「reasoning」 のみ.
      const summary = Array.isArray(p.summary) ? p.summary : [];
      const previewParts: string[] = [];
      for (const s of summary) {
        if (typeof s === "string") previewParts.push(s);
        else if (typeof s?.text === "string") previewParts.push(s.text);
      }
      const preview = previewParts.join(" ").slice(0, 400);
      return { kind: "thinking", payload: { role: "assistant", preview: preview || "(encrypted)" } };
    }
  }

  return { kind: "raw", payload: { type, keys: Object.keys(msg).slice(0, 8) } };
}

/**
 * Codex の `payload.role` を Concordia の text frame role に正規化.
 * `developer` / `system` は assistant 扱いから外して raw に落とすため null を返す.
 */
function normalizeCodexRole(role: unknown): "user" | "assistant" | null {
  if (typeof role !== "string") return null;
  const r = role.toLowerCase();
  if (r === "user") return "user";
  if (r === "assistant") return "assistant";
  return null;
}

/**
 * Codex message の content 配列から表示用テキストを抽出.
 *
 *  - `[{type:"input_text",  text}]` — user message
 *  - `[{type:"output_text", text}]` — assistant message
 *  - `[{type:"text",        text}]` — provider 共通保険
 *  - `["..."]` — 文字列直挿し (まずあり得ないが念のため)
 */
function extractCodexMessageText(content: unknown): string | null {
  if (typeof content === "string" && content.trim()) return content;
  if (!Array.isArray(content)) return null;
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === "string" && part.trim()) {
      out.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const t = (part as any).type;
      const text = (part as any).text;
      if (typeof text !== "string" || !text.trim()) continue;
      if (t === "input_text" || t === "output_text" || t === "text") out.push(text);
    }
  }
  return out.length > 0 ? out.join("\n") : null;
}

function previewJson(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 200);
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return "[unserializable]";
  }
}

async function postFrame(
  baseUrl: string,
  sessionId: string,
  seq: number,
  kind: string,
  payload: unknown,
): Promise<void> {
  const url = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/transcript-frame`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq, kind, payload }),
      signal: ctrl.signal,
    });
  } catch {
    // best-effort
  } finally {
    clearTimeout(timer);
  }
}
