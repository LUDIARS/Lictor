import { spawn } from "node:child_process";

const TASKKILL_TIMEOUT_MS = 30_000;

export interface WindowsTreeKillOptions {
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
}

export interface ProcessTreeTerminationOptions {
  platform?: NodeJS.Platform;
  killWindowsTree?: (pid: number) => Promise<void>;
  terminateDirect: () => void;
}

/**
 * Terminate one Windows process tree without blocking Lictor's event loop.
 *
 * @implements SPEC-SESSION-PROCESS-TREE
 */
export function killWindowsProcessTree(
  pid: number,
  options: WindowsTreeKillOptions = {},
): Promise<void> {
  assertProcessId(pid);
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? TASKKILL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      "taskkill",
      ["/F", "/T", "/PID", String(pid)],
      {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      },
    );
    let settled = false;
    // @implements SPEC-SESSION-PROCESS-TREE
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // taskkill may have exited between the timeout and the fallback kill.
      }
      finish(new Error(`taskkill timed out after ${timeoutMs}ms for pid ${pid}`));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`taskkill exited with code ${code ?? "null"} for pid ${pid}`));
    });
  });
}

/**
 * Terminate the wrapped CLI and its descendants on Windows.
 *
 * node-pty's Windows kill can stop only the cmd/ConPTY launcher. taskkill /T
 * owns the normal tree cleanup; the direct kill is retained as an observable
 * degraded fallback so Concordia's reaper can handle any remaining orphan.
 *
 * @implements SPEC-SESSION-PROCESS-TREE
 */
export async function terminateProcessTree(
  pid: number,
  options: ProcessTreeTerminationOptions,
): Promise<void> {
  assertProcessId(pid);
  if ((options.platform ?? process.platform) !== "win32") {
    options.terminateDirect();
    return;
  }

  try {
    await (options.killWindowsTree ?? killWindowsProcessTree)(pid);
  } catch (error) {
    try {
      options.terminateDirect();
    } catch (fallbackError) {
      throw new AggregateError(
        [error, fallbackError],
        `process tree and direct termination both failed for pid ${pid}`,
      );
    }
    throw error;
  }
}

/** @implements SPEC-SESSION-PROCESS-TREE */
function assertProcessId(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`invalid process id: ${pid}`);
  }
}
