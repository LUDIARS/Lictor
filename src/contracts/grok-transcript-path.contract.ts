import { homedir } from "node:os";
import { resolve } from "node:path";

export default {
  post(result: string, cwd: string, uuid: string, env: NodeJS.ProcessEnv = process.env): true | string {
    const home = env.GROK_HOME?.trim() || resolve(homedir(), ".grok");
    const expected = resolve(home, "sessions", encodeURIComponent(resolve(cwd)), uuid, "updates.jsonl");
    return result === expected || "Grok transcript path differs from its session storage layout";
  },
};
