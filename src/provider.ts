/**
 * Provider abstraction — what binary to spawn, what features it supports.
 * Lictor v0.5 generalizes the wrapper from claude-only to any TUI agent
 * CLI that speaks a pty (currently: Claude Code, OpenAI Codex CLI).
 *
 * Feature flags are conservative: if a CLI doesn't support a mechanism
 * (e.g. Gemini has no SKILL.md discovery), the corresponding lictor feature
 * downgrades to a no-op rather than breaking.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { cwdToProjectKey } from "./memory-loader.js";

/**
 * How lictor delivers SKILL.md files to the wrapped CLI.
 *
 *  - `claude-add-dir`: write to `<sessionDir>/.claude/skills/<name>/SKILL.md`
 *    and pass `--add-dir <sessionDir>` to claude so it picks them up at scan.
 *    Session-scoped; cleanup removes the whole sessionDir.
 *
 *  - `none`: Lictor does not write skills for the provider. This is used for
 *    Codex because its user-scope `.agents/skills` directory is shared by all
 *    sessions and cannot provide per-session isolation.
 */
export type SkillStrategy = "claude-add-dir" | "none";

export interface ProviderConfig {
  /** Identifier used in CLI: `lictor <name> [args...]`. */
  name: string;
  /** Binary to spawn. Resolved via PATH (with shell:true on Windows for .cmd). */
  binary: string;
  /**
   * 任意。 設定されていれば、 この環境変数の値で {@link binary} を上書きする
   * (空文字・未設定なら {@link binary} のまま)。 binary が PATH 上に無い /
   * 別名でインストールされている環境向けに、 spawn 先を差し替える唯一のスロット。
   *
   * 例: `gemma4-12` は別リポ Famulus (`@ludiars/famulus`) の `famulus` CLI を
   * 起動するが、 これは Lictor の依存ではなく各マシンに別途入る。 PATH に居ない /
   * フルパス指定したい場合に `LICTOR_FAMULUS_BIN` で所在を渡す。 解決は
   * {@link resolveBinary} に集約する (wrap が spawn 前に必ず通す)。
   */
  binaryEnvVar?: string;
  /**
   * binary に対して **ユーザ args の前に** 必ず差し込む固定 args。
   * `local` provider が `binary = "lictor"` を自分自身 (`lictor cli local-agent`)
   * として再起動するために使う。未指定なら何も差さない (claude/codex/gemini)。
   */
  spawnArgs?: string[];
  /**
   * Strategy for delivering SKILL.md files to the wrapped CLI. See
   * {@link SkillStrategy} for layout details. `none` disables skill
   * injection entirely for the provider.
   */
  skillStrategy: SkillStrategy;
  /**
   * Derived convenience: true iff `skillStrategy !== "none"`. Drives both
   * `seedSkills` invocation AND the sidecar `/v1/skill` behavior.
   */
  supportsSkills: boolean;
  /**
   * Value sent to Concordia POST /v1/sessions `provider` field.
   * Concordia distinguishes "claude-code" vs "codex-cli" for its dashboard.
   */
  concordiaProvider: string;
  /** Human-readable, used in startup banners + auto-title fallback. */
  displayName: string;
  /**
   * Concordia の session.inject 受信時に wrapped CLI へ「テキスト + submit キー」
   * をどう pty に書くかを provider 別に切り替えるための関数.
   *
   *  - claude: text と \r をまとめて 1 write — pty 上で 1 行の入力 + Enter として
   *    認識される (現行動作).
   *  - codex:  text と \r を分けて、 さらに微小 delay を挟む. codex CLI
   *    (crossterm + ratatui) は 1 chunk に text + \r があると \r を「入力 buffer
   *    への改行」として食ってしまい submit されないため.
   *
   * 引数の `write` は ptyWriter (= node-pty IPty.write). 戻り値は async でも
   * sync でもよい (呼び出し側は await しない fire-and-forget).
   */
  submitInject: (write: (data: string) => void, text: string) => void;
  /**
   * Transcript JSONL を discover するためのディレクトリを返す.
   *
   *  - claude : `~/.claude/projects/<cwdKey>/` (Claude が cwd 単位で session
   *             jsonl を吐く場所)
   *  - codex  : `~/.codex/sessions/` (Codex は YYYY/MM/DD のサブツリーに
   *             `rollout-<ISO>-<uuid>.jsonl` を吐くので、 transcript-tail 側で
   *             サブディレクトリも含めて再帰スキャンする)
   *  - gemini : `null` (transcript ファイルが安定形式で吐かれないため未対応.
   *             transcript-tail は no-op)
   *
   * 戻り値 `null` で transcript-tail が起動しない. ディレクトリが存在しない
   * 場合は呼び出し側で `existsSync` チェックされる前提で、 resolver は
   * 「あるべき path」 を返すだけで実在確認はしない.
   */
  transcriptDir: (cwd: string) => string | null;
  /**
   * `<sessionDir>/<filename.jsonl>` の `<filename>` 部分から session UUID を
   * 抽出する関数. provider 別の filename 規約に対応する.
   *
   *  - claude : `<uuid>.jsonl` → そのまま
   *  - codex  : `rollout-<ISO>-<uuid>.jsonl` → 末尾の UUID 部分のみ
   *
   * 抽出に失敗した場合 (= 規約と合わない filename) は null. active-repos
   * watcher が session ID 単位で state ファイルを引くのに使う。
   */
  extractSessionId: (basenameWithoutExt: string) => string | null;
  /**
   * spawn 時に session-id を固定できる provider か。true なら wrap.ts が
   * uuid を発番して {@link sessionPinArgs} を spawn 引数に足し、その uuid の
   * transcript ファイル ({@link pinnedTranscriptFile}) だけを claim する。
   *
   * これにより transcript-tail の mtime 推測 discover を完全に回避できる。
   * 別 wrapper の並走・非 Lictor で先行起動した同 provider・context 要約に
   * よる session ローテートがあっても「Discord セッション ↔ jsonl ↔ channel」
   * の取り違え (= 投稿が 1 つズレる crosstalk) が原理的に起きなくなる。
   *
   * false の provider (codex / gemini) は従来どおり mtime discover に委譲する。
   */
  supportsSessionPin: boolean;
  /**
   * 固定 uuid を spawn 引数に変換する (claude: `["--session-id", uuid]`)。
   * {@link supportsSessionPin} が true のとき必須。
   */
  sessionPinArgs?: (uuid: string) => string[];
  /**
   * 固定 uuid に対応する transcript JSONL の絶対パスを返す。
   * {@link supportsSessionPin} が true のとき必須。dir が解決できなければ null。
   */
  pinnedTranscriptFile?: (cwd: string, uuid: string) => string | null;
  /**
   * mtime discover の候補 JSONL が「このセッションのものでありうるか」 を
   * 先頭行メタデータで判定する任意フィルタ ({@link supportsSessionPin} が
   * false の provider 向け)。
   *
   * codex は transcript を cwd 別に分けず ~/.codex/sessions/ に全セッション
   * (別リポの対話ウインドウ・Concordia delegation の `codex exec` rollout 含む)
   * を吐くため、 mtime + claim だけでは別セッションの JSONL を誤掴みして
   * 「無関係なメッセージが別 channel / 別セッションに混線する」 crosstalk が
   * 起きる。 先頭行 session_meta の cwd / source で候補自体を絞り、 誤掴みの
   * 母集団を構造的に減らす。
   *
   * 戻り値: true = 候補として許可 / false = 除外。 判定不能 (メタ行なし・
   * parse 不能・未知フォーマット) は true を返して従来どおり claim ガードに
   * 委ねる (新しい CLI バージョンでメタ形式が変わっても中継が止まらない)。
   */
  transcriptMetaAccepts?: (firstLine: string, ctx: { cwd: string; startedAtMs?: number; mtimeMs?: number; expectedOriginator?: string | null }) => boolean;

  /**
   * 先頭メタ行から provider ネイティブの session id を読む ({@link supportsSessionPin}
   * が false の provider 向け)。 codex は `--session-id` 相当の pin フラグを持たないため、
   * transcript-tail は初回束縛でこの session id を読んで **施錠** し、 以後この id を持つ
   * rollout 以外には一切紐づけない。 これで mtime 推測による別セッション JSONL の誤掴み
   * (= 別 channel に発話が混在する crosstalk) を構造的に排除する。 読めなければ null。
   */
  transcriptMetaSessionId?: (firstLine: string) => string | null;

  /**
   * 先頭メタ行からそのセッションの開始時刻 (epoch ms) を読む。 定義されている
   * provider は候補フィルタ (head-ts) で「wrapper 起動より前の別セッション」 を除外する
   * のに使う。 読めなければ null。
   */
  transcriptMetaStartedAt?: (firstLine: string) => number | null;

  /**
   * transcript **ファイル名の末尾 UUID が Lictor の session id** である
   * ローカルLLM/Ollama 系 provider を示す (Famulus 等が LICTOR_SESSION_ID を
   * そのまま `<sessionId>.jsonl` に使う前提)。
   *
   * true のとき transcript-tail は起動時に自分の session id ({@link extractSessionId}
   * で正規化) を施錠キーとして **事前施錠** し、 discoverCodex の施錠済み分岐で
   * filename UUID が完全一致する 1 ファイルだけを束縛する。 codex と違い
   * session_meta を読まずに済み、 mtime 推測もしないので、 同一 sessions dir に
   * 別セッションの JSONL が並んでいても自分のファイルだけを exact bind する
   * (crosstalk 構造排除)。 stall 復帰も同じ施錠キーで取り直す。
   *
   * session id から UUID が抽出できない場合は事前施錠せず、 従来の discoverCodex
   * 初回束縛 (候補 UUID で決める) に安全フォールバックする。
   */
  usesFilenameSessionLock?: boolean;
}

/**
 * パス比較用の正規化。 Windows の `\` / `/` 揺れとドライブ大文字小文字揺れを
 * 吸収する (codex は session_meta.cwd を `E:\\...` 形式で書くが、 Lictor の
 * opts.cwd は `E:/...` 形式のことがある)。 大文字小文字は Windows FS が
 * case-insensitive なので全体を lower で比較する。
 */
export function normalizePathForCompare(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Codex rollout JSONL の先頭行 (`type: "session_meta"`) を読んで、 この
 * セッションの候補たりうるかを判定する ({@link ProviderConfig.transcriptMetaAccepts})。
 *
 *  - `payload.source === "exec"` / `originator === "codex_exec"`: ヘッドレス
 *    実行 (Concordia delegation 等) の rollout。 対話ウインドウの transcript
 *    ではないので除外。
 *  - `payload.cwd` が自分の cwd と不一致: 別リポ / 別ディレクトリのウインドウ。
 *    除外。
 *  - `payload.timestamp` が wrapper 起動より HEAD_TS_GRACE_MS 以上古い: 自分より
 *    前から生きている別セッションの会話。 除外 (Lictor が spawn する codex は常に
 *    新規会話なので、 自分の rollout の開始時刻が wrapper 起動より古いことはない)。
 *    スリープ復帰などで全 claim が同時に stale 化した際、 隣の長寿セッションの
 *    ファイルを奪う経路をここで構造的に塞ぐ。 LICTOR_CODEX_HEAD_TS_FILTER=0 で無効化可
 *    (codex を手動 resume でラップする等の特殊運用向け escape hatch)。
 *  - メタが読めない / 形式不明: 許可 (claim ガードに委ねる fail-open)。
 */
const HEAD_TS_GRACE_MS = 60_000;

export function codexTranscriptMetaAccepts(
  firstLine: string,
  ctx: { cwd: string; startedAtMs?: number; mtimeMs?: number; expectedOriginator?: string | null },
): boolean {
  // originator 施錠モード: Lictor が spawn した codex は
  // CODEX_INTERNAL_ORIGINATOR_OVERRIDE で session_meta.originator に自分の
  // マーカーを焼く (2026-07-13 実測で 0.144.1 が尊重することを確認)。 期待値が
  // 与えられたら **完全一致以外は全部拒否** し、 メタが読めない候補も掴まない
  // (fail-open すると初回束縛の mtime 推測が復活し、 同 cwd の別 codex
  // セッションを掴む crosstalk が再発するため。 2026-07-13 実害)。
  const strict = typeof ctx.expectedOriginator === "string" && ctx.expectedOriginator.length > 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return !strict;
  }
  if (typeof parsed !== "object" || parsed === null) return !strict;
  const rec = parsed as Record<string, unknown>;
  if (rec.type !== "session_meta") return !strict;
  const payload = rec.payload;
  if (typeof payload !== "object" || payload === null) return !strict;
  const p = payload as Record<string, unknown>;
  const source = typeof p.source === "string" ? p.source : "";
  const originator = typeof p.originator === "string" ? p.originator : "";
  if (strict && originator !== ctx.expectedOriginator) return false;
  if (source === "exec" || originator === "codex_exec") return false;
  if (typeof p.cwd === "string" && p.cwd.length > 0) {
    if (normalizePathForCompare(p.cwd) !== normalizePathForCompare(ctx.cwd)) return false;
  }
  if (
    typeof ctx.startedAtMs === "number" &&
    process.env.LICTOR_CODEX_HEAD_TS_FILTER !== "0"
  ) {
    const headTs = codexTranscriptMetaStartedAt(firstLine);
    const freshMtime =
      typeof ctx.mtimeMs === "number" &&
      Number.isFinite(ctx.mtimeMs) &&
      ctx.mtimeMs >= ctx.startedAtMs - HEAD_TS_GRACE_MS;
    if (headTs !== null && headTs < ctx.startedAtMs - HEAD_TS_GRACE_MS && !freshMtime) return false;
  }
  return true;
}

/**
 * Codex rollout 先頭行の session_meta から会話開始時刻を epoch ms で返す。
 * timestamp は payload 側 (正) とトップレベル (rollout 形式によってはこちら) の
 * 両方がありうるので payload 優先で読む。 読めなければ null。
 */
export function codexTranscriptMetaStartedAt(firstLine: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.type !== "session_meta") return null;
  const payload = typeof rec.payload === "object" && rec.payload !== null
    ? (rec.payload as Record<string, unknown>)
    : null;
  const ts = typeof payload?.timestamp === "string" && payload.timestamp
    ? payload.timestamp
    : typeof rec.timestamp === "string" && rec.timestamp
      ? rec.timestamp
      : null;
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Codex rollout 先頭行の `session_meta` から provider ネイティブの session id を返す。
 * transcript-tail の「session_id 施錠」 の唯一の束縛キー。 payload / トップレベルの
 * どちらに載る形式でも読めるよう両方を見る。 session_meta 以外の行 / parse 不能 /
 * id 欠落なら null (= 施錠キー無し → 束縛不能)。
 */
export function codexTranscriptMetaSessionId(firstLine: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.type !== "session_meta") return null;
  const payload = typeof rec.payload === "object" && rec.payload !== null
    ? (rec.payload as Record<string, unknown>)
    : null;
  for (const value of [
    payload?.session_id,
    payload?.sessionId,
    payload?.conversation_id,
    payload?.conversationId,
    payload?.thread_id,
    payload?.threadId,
    payload?.id,
    rec.session_id,
    rec.sessionId,
    rec.conversation_id,
    rec.conversationId,
    rec.thread_id,
    rec.threadId,
    rec.id,
  ]) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * 複数行 inject 時の Enter 遅延 (ms). 既定 500.
 *
 * Web/Discord から複数行の会話を inject すると、 TUI が複数行ペーストを処理し
 * きる前に Enter (\r) が届き、 submit されない (or 途中で確定する) ことがある.
 * 本文を書いてから少し待って \r を送ることで「ペースト完了 → 改めて Enter」 を
 * 確実にする. env override 可 (LICTOR_INJECT_ENTER_DELAY_MS).
 */
function multilineEnterDelayMs(): number {
  const v = Number(process.env.LICTOR_INJECT_ENTER_DELAY_MS ?? "500");
  return Number.isFinite(v) && v >= 0 ? v : 500;
}

function isMultiline(text: string): boolean {
  // 末尾の改行だけ (= 単行 + trailing newline) は単行扱い. 本文中に改行があるか.
  return /[\r\n]/.test(text.replace(/[\r\n]+$/, ""));
}

/**
 * 本文を書いてから delayMs 後に \r (Enter) を送る 2 段書き.
 * 末尾の \r/\n は本文から剥がしてから書く (trailing newline が input buffer に
 * リテラル改行として残り、 続く \r を改行継続として食われるのを防ぐ).
 */
function submitDelayedEnter(write: (data: string) => void, text: string, delayMs: number): void {
  const body = text.replace(/[\r\n]+$/, "");
  if (body) {
    try { write(body); } catch { /* pty may be closing; Enter は投機的に続行する */ }
  }
  const timer = setTimeout(() => {
    try { write("\r"); } catch { /* swallow: pty closed before timer fired */ }
  }, delayMs);
  timer.unref?.();
}

/**
 * 既定の単発書き戦略. text + \r を 1 chunk で pty に流す.
 * Claude Code / Gemini CLI 等、 「最終文字が \r なら Enter として認識する」 系の
 * TUI 向け.
 *
 * ただし本文が複数行の場合は submitDelayedEnter にフォールバックし、 本文 →
 * (既定 500ms) → \r の 2 段で送る. 複数行ペーストが確定しきる前に Enter が
 * 届いて submit されない事象を防ぐ.
 */
function submitInjectSingleWrite(write: (data: string) => void, text: string): void {
  if (isMultiline(text)) {
    submitDelayedEnter(write, text, multilineEnterDelayMs());
    return;
  }
  write(text + "\r");
}

/**
 * Codex CLI 向け 2 段書き. text を流し → CODEX_INJECT_DELAY_MS だけ待ち →
 * \r だけを流す. crossterm の event loop が text 入力イベントと Enter キー
 * イベントを別物として認識してくれるよう間を空ける. delay は env override 可
 * (LICTOR_CODEX_INJECT_DELAY_MS, default 30).
 *
 * 末尾の \r/\n は本文から剥がしてから書く. text 部に trailing newline が
 * 残っていると codex 側の input buffer が「リテラル改行」 として吸収し、
 * 続く \r を新規 Enter キーではなく改行の継続として扱って submit され
 * ない事例があったため (2026-05-26 報告). 単独の \r を Enter として
 * 明示するのがこの分割の主目的.
 */
function submitInjectTwoStep(write: (data: string) => void, text: string): void {
  const delay = Number(process.env.LICTOR_CODEX_INJECT_DELAY_MS ?? "30");
  const base = Number.isFinite(delay) && delay >= 0 ? delay : 30;
  // 複数行 inject は単行用 codex delay (30ms) では足りず submit されないことが
  // あるため、 multilineEnterDelayMs (既定 500ms) と比べて大きい方を使う.
  const ms = isMultiline(text) ? Math.max(base, multilineEnterDelayMs()) : base;
  submitDelayedEnter(write, text, ms);
}

// Claude / Codex の transcript dir resolver.
function claudeTranscriptDir(cwd: string): string | null {
  return join(homedir(), ".claude", "projects", cwdToProjectKey(cwd));
}
function codexTranscriptDir(_cwd: string): string | null {
  // Codex は cwd 別に分けず、 grobal な ~/.codex/sessions/YYYY/MM/DD/ に出す.
  // discover 側で start 時刻フィルタ + cwd 一致フィルタで該当 jsonl を選ぶ.
  return join(homedir(), ".codex", "sessions");
}

// claude の transcript filename は `<uuid>.jsonl`、 codex は
// `rollout-<ISO>-<uuid>.jsonl`. 末尾 UUID を抽出する正規表現は両者共通で
// `[0-9a-fA-F-]{36}` を取る. (codex は v7 UUID なので 36 文字固定.)
const UUID_TAIL = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
function extractUuid(basename: string): string | null {
  const m = basename.match(UUID_TAIL);
  return m ? m[1] : null;
}

/**
 * ローカルLLM/Ollama 系 provider を作る共通ファクトリ。 runner (Famulus 等) は
 * `<sessionsDir>/<LICTOR_SESSION_ID>.jsonl` に `{ts, role, content}` 形式の JSONL を
 * 追記する前提で、 次を共通化する:
 *
 *  - SKILL 注入なし / session pin flag なし (runner 側が会話ログ・compaction を持つ)。
 *  - transcript は {@link usesFilenameSessionLock} で filename UUID を施錠キーにして
 *    exact bind (mtime 推測なし = crosstalk 構造排除)。
 *  - Concordia 上の種別は `local-llm`、 inject は単行 write。
 *
 * `lineToFrame` の `{role, content}` 分岐が地の文を text/system frame に正規化するので、
 * ここで作った provider は追加のパーサ無しでそのまま Web/Discord へ中継される。
 * 別の Ollama 系 runner を足すときはこのファクトリを 1 回呼ぶだけでよい。
 */
export function makeLocalLlmProvider(opts: {
  name: string;
  binary: string;
  displayName: string;
  sessionsDir: (cwd: string) => string;
  binaryEnvVar?: string;
  spawnArgs?: string[];
}): ProviderConfig {
  return {
    name: opts.name,
    binary: opts.binary,
    binaryEnvVar: opts.binaryEnvVar,
    spawnArgs: opts.spawnArgs,
    skillStrategy: "none",
    supportsSkills: false,
    concordiaProvider: "local-llm",
    displayName: opts.displayName,
    submitInject: submitInjectSingleWrite,
    transcriptDir: opts.sessionsDir,
    // ファイル名は `<lictor-session-id>.jsonl`。 末尾 UUID を共通正規表現で抽出する。
    extractSessionId: extractUuid,
    supportsSessionPin: false,
    // 自分の session id を施錠キーにして自分の 1 ファイルだけを束縛する。
    usesFilenameSessionLock: true,
  };
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    name: "claude",
    binary: "claude",
    skillStrategy: "claude-add-dir",
    supportsSkills: true,
    concordiaProvider: "claude-code",
    displayName: "Claude Code",
    submitInject: submitInjectSingleWrite,
    transcriptDir: claudeTranscriptDir,
    extractSessionId: extractUuid,
    // claude CLI は `--session-id <uuid>` で session を固定でき、 jsonl は
    // `<uuid>.jsonl` に確定で書かれる。 これを使って取り違えを構造的に潰す。
    supportsSessionPin: true,
    sessionPinArgs: (uuid) => ["--session-id", uuid],
    pinnedTranscriptFile: (cwd, uuid) => {
      const dir = claudeTranscriptDir(cwd);
      return dir ? join(dir, `${uuid}.jsonl`) : null;
    },
  },
  codex: {
    name: "codex",
    binary: "codex",
    // Codex scans user-scope skills globally. Lictor session skills must not be
    // written there because every concurrent session would discover them.
    skillStrategy: "none",
    supportsSkills: false,
    concordiaProvider: "codex-cli",
    displayName: "OpenAI Codex",
    submitInject: submitInjectTwoStep,
    transcriptDir: codexTranscriptDir,
    extractSessionId: extractUuid,
    // codex は rollout filename を CLI 側が自動採番し session-id 固定 flag が
    // 無いため事前 pin 不可。 transcript-tail は初回に session_meta.session_id を
    // 読んで施錠し、 以後その id の rollout だけを tail する (mtime 推測の排除)。
    supportsSessionPin: false,
    // 全セッション共有の ~/.codex/sessions/ から自分の候補を絞る先頭行フィルタ
    // (cwd 一致 + `codex exec` rollout 除外 + head-ts)。 初回束縛の母集団を絞る。
    transcriptMetaAccepts: codexTranscriptMetaAccepts,
    // 施錠キー。 これが読めない候補は「束縛不能」 として初回束縛から除外する。
    transcriptMetaSessionId: codexTranscriptMetaSessionId,
    transcriptMetaStartedAt: codexTranscriptMetaStartedAt,
  },
  gemini: {
    name: "gemini",
    binary: "gemini",
    // Gemini CLI には現在 SKILL.md 相当の discovery 機構が無いので skill 注入は no-op.
    // pty / 端末タイトル / Concordia register / chat 経路 / transcript-tail などの
    // provider-agnostic 機能はそのまま動く.
    skillStrategy: "none",
    supportsSkills: false,
    concordiaProvider: "gemini-cli",
    displayName: "Gemini CLI",
    submitInject: submitInjectSingleWrite,
    transcriptDir: () => null,
    extractSessionId: () => null,
    // transcript ファイル自体が安定形式で吐かれないため pin 不可 (tail 自体 no-op)。
    supportsSessionPin: false,
  },
  // ローカル LLM エージェント (既定モデル gemma4:12b)。実体は別リポ Famulus
  // (@ludiars/famulus、ローカル LLM スポナー) の `famulus run` を pty で起動する。
  // 旧 `lictor cli local-agent` 内蔵実装からの載せ替え (2026-06-10)。Famulus は
  // 任意タスクからも再利用される共通スポナー。旧名 `local` は getProvider の
  // エイリアスで引き続き起動可。
  //
  // Famulus は独自 JSONL (~/.famulus/sessions/<sessionId>.jsonl) に {ts, role, content}
  // 形式で書く。 sessionId は LICTOR_SESSION_ID (= Concordia session id) を読む
  // (Lictor が wrap で env export 済) ので、 Lictor は自分の session id を施錠キーにして
  // 自分の 1 ファイルだけを exact bind できる (usesFilenameSessionLock)。 lineToFrame の
  // local 分岐が {role, content} を text/system frame 化して Web/Discord に中継する。
  //
  // Famulus は Lictor の依存ではなく各マシンに別途入る外部 CLI。 PATH に居ない /
  // 別所に入れた場合は `LICTOR_FAMULUS_BIN` で spawn 先を差し替える (PATH fallback)。
  "gemma4-12": makeLocalLlmProvider({
    name: "gemma4-12",
    binary: "famulus",
    binaryEnvVar: "LICTOR_FAMULUS_BIN",
    spawnArgs: ["run"],
    displayName: "Local LLM (Famulus / Ollama)",
    sessionsDir: () => join(homedir(), ".famulus", "sessions"),
  }),
};

// 旧 provider 名 → 現行キーのエイリアス。後方互換のためだけに引く。
const PROVIDER_ALIASES: Record<string, string> = {
  local: "gemma4-12",
};

export function getProvider(name: string): ProviderConfig | null {
  return PROVIDERS[name] ?? PROVIDERS[PROVIDER_ALIASES[name] ?? ""] ?? null;
}

/**
 * spawn する実バイナリを解決する。 provider が {@link ProviderConfig.binaryEnvVar}
 * を持ち、 その env が非空に設定されていれば trim した値で {@link ProviderConfig.binary}
 * を上書きする。 未設定 / 空白のみなら既定の binary をそのまま返す。
 *
 * wrap が pty.spawn の直前に必ず通すことで、 「famulus が PATH に居ない」 等の
 * 環境差を一箇所で吸収する。 純粋関数 (env を引数で受ける) なのでテスト可能。
 */
export function resolveBinary(
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = provider.binaryEnvVar;
  if (key) {
    const override = (env[key] ?? "").trim();
    if (override) return override;
  }
  return provider.binary;
}
