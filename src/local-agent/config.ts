/**
 * ローカル LLM エージェントの設定。env から読む (Lictor は wrap 経由で
 * LICTOR_SESSION_ID 等を export 済)。仕様は spec/local-llm-agent.md。
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface LocalAgentConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
  system: string;
  /** 想定文脈窓 (compaction の基準サイズ、トークン)。 */
  contextTokens: number;
  /** contextTokens のこの割合を超えたら compaction。 */
  compactRatio: number;
  /** compaction 時に末尾から残す turn 数。 */
  keepRecent: number;
  /** hook 定義 JSON の path。 */
  hooksPath: string;
  /** transcript JSONL の置き場 dir。 */
  sessionsDir: string;
  /** セッション ID (transcript ファイル名 + hook payload)。 */
  sessionId: string;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function ratio(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
}

/** 既定の transcript 置き場。 */
export function defaultSessionsDir(): string {
  return join(homedir(), ".lictor", "local-sessions");
}

export function loadLocalAgentConfig(env: NodeJS.ProcessEnv = process.env): LocalAgentConfig {
  const sessionsDir = env.LICTOR_LOCAL_SESSIONS_DIR?.trim() || defaultSessionsDir();
  const sessionId =
    env.LICTOR_SESSION_ID?.trim() ||
    `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  // persona があれば system に前置 (wrap が LICTOR_PERSONA_NAME を export)。
  const personaName = env.LICTOR_PERSONA_NAME?.trim();
  const baseSystem = env.LICTOR_LOCAL_SYSTEM?.trim() ?? "";
  const system = personaName
    ? `あなたは「${personaName}」というローカル AI アシスタントです。${baseSystem ? "\n" + baseSystem : ""}`
    : baseSystem;

  return {
    baseUrl: (env.LICTOR_LOCAL_BASE_URL?.trim() || "http://127.0.0.1:11434/v1").replace(/\/+$/, ""),
    model: env.LICTOR_LOCAL_MODEL?.trim() || "gemma4:12b",
    apiKey: env.LICTOR_LOCAL_API_KEY?.trim() || "",
    maxTokens: num("LICTOR_LOCAL_MAX_TOKENS", 4096),
    timeoutMs: num("LICTOR_LOCAL_TIMEOUT_MS", 300_000),
    system,
    contextTokens: num("LICTOR_LOCAL_CONTEXT_TOKENS", 131_072),
    compactRatio: ratio("LICTOR_LOCAL_COMPACT_RATIO", 0.75),
    keepRecent: num("LICTOR_LOCAL_KEEP_RECENT", 6),
    hooksPath: env.LICTOR_LOCAL_HOOKS?.trim() || join(homedir(), ".lictor", "local-hooks.json"),
    sessionsDir,
    sessionId,
  };
}
