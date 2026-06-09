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
 *  - `codex-user-agents`: write to `~/.agents/skills/lictor-<sessionId>-<name>/SKILL.md`.
 *    Codex walks `$HOME/.agents/skills/` at startup (user scope) and
 *    hot-reloads SKILL.md edits, so no spawn arg is needed. The
 *    `lictor-<sessionId>-` prefix namespaces our writes so they can't
 *    collide with the user's own skills, and cleanup deletes them by
 *    prefix on session exit.
 *
 *  - `none`: provider has no SKILL.md discovery mechanism. seedSkills /
 *    /v1/skill endpoints become no-ops.
 */
export type SkillStrategy = "claude-add-dir" | "codex-user-agents" | "none";

export interface ProviderConfig {
  /** Identifier used in CLI: `lictor <name> [args...]`. */
  name: string;
  /** Binary to spawn. Resolved via PATH (with shell:true on Windows for .cmd). */
  binary: string;
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
    // Codex Agent Skills (documented at developers.openai.com/codex/skills):
    // `.agents/skills/<name>/SKILL.md`. Repo / user / admin / system scopes.
    // We use the user scope (~/.agents/skills/) with a per-session prefix
    // so writes are auto-discovered without polluting the user's repo.
    skillStrategy: "codex-user-agents",
    supportsSkills: true,
    concordiaProvider: "codex-cli",
    displayName: "OpenAI Codex",
    submitInject: submitInjectTwoStep,
    transcriptDir: codexTranscriptDir,
    extractSessionId: extractUuid,
    // codex は rollout filename を CLI 側が自動採番し session-id 固定 flag が
    // 無いため pin 不可。 従来どおり mtime discover に委譲する。
    supportsSessionPin: false,
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
  "gemma4-12": {
    // ローカル LLM エージェント (既定モデル gemma4:12b)。外部 CLI ではなく lictor
    // 自身を pty で再起動し、隠しサブコマンド `lictor cli local-agent` (= Ollama を
    // 文脈保持で叩く軽量 REPL) を起動する。codex ガワの軽量代行。spec/local-llm-agent.md。
    // 旧名 `local` は getProvider のエイリアスで引き続き起動可。
    name: "gemma4-12",
    binary: "lictor",
    spawnArgs: ["cli", "local-agent"],
    // 会話ログ・compaction・hook は REPL 自身が持つ。Lictor の SKILL 注入は使わない。
    skillStrategy: "none",
    supportsSkills: false,
    concordiaProvider: "local-llm",
    displayName: "Local LLM (Ollama)",
    submitInject: submitInjectSingleWrite,
    // 本エージェントは独自 JSONL (~/.lictor/local-sessions/<sessionId>.jsonl) に
    // {ts, role, content} 形式で書く。 transcript-tail がこの dir を mtime discover
    // で tail し、 lineToFrame の local 分岐で text frame 化して Concordia に中継する
    // (= REPL の応答が Web/Discord に出る)。 local-agent の sessionId は
    // LICTOR_SESSION_ID (= Concordia session id) なので衝突せず discover できる。
    transcriptDir: () => join(homedir(), ".lictor", "local-sessions"),
    // ファイル名は `<lictor-uuid>.jsonl`。 末尾 UUID を共通正規表現で抽出する。
    extractSessionId: extractUuid,
    supportsSessionPin: false,
  },
};

// 旧 provider 名 → 現行キーのエイリアス。後方互換のためだけに引く。
const PROVIDER_ALIASES: Record<string, string> = {
  local: "gemma4-12",
};

export function getProvider(name: string): ProviderConfig | null {
  return PROVIDERS[name] ?? PROVIDERS[PROVIDER_ALIASES[name] ?? ""] ?? null;
}
