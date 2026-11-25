import { posix, win32 } from "node:path";

export default {
  post(result: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): true | string {
    const windows = platform === "win32";
    const home = (windows ? env.USERPROFILE : env.HOME)?.trim();
    if (!home) {
      return result.length === 0 || "Grok install path requires a home directory";
    }
    const expected = windows
      ? win32.join(home, ".grok", "bin", "grok.exe")
      : posix.join(home, ".grok", "bin", "grok");
    return (result.length === 1 && result[0] === expected) || "Grok install path does not match the platform";
  },
};
