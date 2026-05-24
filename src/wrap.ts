import { spawn } from "node:child_process";
import { startSidecar } from "./sidecar.js";
import { gatherMeta } from "./meta.js";
import { resetTitle } from "./osc.js";

export async function runWrapped(args: string[]): Promise<void> {
  const meta = gatherMeta();
  const sidecar = await startSidecar(meta);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LICTOR_PORT: String(sidecar.port),
    LICTOR_PID: String(process.pid),
    LICTOR_SESSION_START: meta.start_iso,
  };

  // claude is typically a JS shim on PATH. On Windows it's claude.cmd.
  // shell:true lets the shell resolve the .cmd/.exe extension.
  const useShell = process.platform === "win32";
  const claudeCmd = "claude";

  const child = spawn(claudeCmd, args, {
    stdio: "inherit",
    env,
    shell: useShell,
  });

  let childExited = false;
  child.on("exit", (code, signal) => {
    childExited = true;
    sidecar.close();
    // Best-effort: clear OSC title so the next prompt isn't left with a
    // stale lictor-set title.
    resetTitle();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    process.stderr.write(`lictor: failed to spawn claude: ${err.message}\n`);
    sidecar.close();
    process.exit(127);
  });

  // Forward common signals so Ctrl-C etc behave normally.
  const forward = (sig: NodeJS.Signals) => () => {
    if (!childExited) child.kill(sig);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  if (process.platform !== "win32") {
    process.on("SIGHUP", forward("SIGHUP"));
  }
}
