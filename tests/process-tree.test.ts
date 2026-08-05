import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  killWindowsProcessTree,
  terminateProcessTree,
} from "../src/process-tree.js";

test("Windows tree termination runs taskkill for the wrapped CLI pid", async () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const child = new EventEmitter() as ChildProcess;
  child.kill = () => true;
  const spawnProcess = ((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }) as unknown as typeof spawn;

  await killWindowsProcessTree(1234, { spawnProcess });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "taskkill");
  assert.deepEqual(calls[0]?.args, ["/F", "/T", "/PID", "1234"]);
  assert.deepEqual(calls[0]?.options, {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
});

test("Windows tree termination does not call the direct fallback after success", async () => {
  let directKills = 0;

  await terminateProcessTree(1234, {
    platform: "win32",
    killWindowsTree: async () => undefined,
    terminateDirect: () => {
      directKills++;
    },
  });

  assert.equal(directKills, 0);
});

test("Windows tree termination uses direct kill and preserves taskkill failure", async () => {
  let directKills = 0;

  await assert.rejects(
    terminateProcessTree(1234, {
      platform: "win32",
      killWindowsTree: async () => {
        throw new Error("taskkill failed");
      },
      terminateDirect: () => {
        directKills++;
      },
    }),
    /taskkill failed/,
  );
  assert.equal(directKills, 1);
});

test("non-Windows termination keeps the node-pty direct kill path", async () => {
  let directKills = 0;

  await terminateProcessTree(1234, {
    platform: "linux",
    terminateDirect: () => {
      directKills++;
    },
  });

  assert.equal(directKills, 1);
});

test("process tree termination rejects invalid pids before side effects", async () => {
  let directKills = 0;

  await assert.rejects(
    terminateProcessTree(0, {
      platform: "win32",
      terminateDirect: () => {
        directKills++;
      },
    }),
    /invalid process id/,
  );
  assert.equal(directKills, 0);
});
