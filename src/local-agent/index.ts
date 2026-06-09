/**
 * ローカル LLM エージェントのエントリ。`lictor cli local-agent` から呼ばれ、
 * `lictor local` provider が pty で起動する (codex ガワの軽量代行)。
 * spec/local-llm-agent.md。
 */

import { loadLocalAgentConfig } from "./config.js";
import { runRepl } from "./repl.js";

export async function runLocalAgent(): Promise<void> {
  const cfg = loadLocalAgentConfig();
  await runRepl(cfg);
}
