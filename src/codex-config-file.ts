import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** codex の config.toml を読む (CODEX_HOME 優先)。 無い・読めないときは null。 */
export function readCodexConfigText(env: NodeJS.ProcessEnv): string | null {
  const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  try {
    return readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return null;
  }
}
