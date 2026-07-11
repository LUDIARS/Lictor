import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAppServerClient, CodexAppServerError } from "../src/codex-app-server-client.js";

interface FakeChild {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  written: Array<Record<string, unknown>>;
}

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: Array<Record<string, unknown>> = [];
  let input = "";
  let exited = false;
  stdin.on("data", (chunk) => {
    input += String(chunk);
    const lines = input.split("\n");
    input = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) written.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const emitExit = () => {
    if (exited) return;
    exited = true;
    emitter.emit("exit", 0, null);
  };
  stdin.on("finish", () => queueMicrotask(emitExit));
  Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      queueMicrotask(emitExit);
      return true;
    },
  });
  return { child: emitter as ChildProcessWithoutNullStreams, stdout, written };
}

test("CodexAppServerClient handles partial JSONL and interleaved notifications", async () => {
  const fake = createFakeChild();
  const client = new CodexAppServerClient(fake.child, { requestTimeoutMs: 1_000 });
  const notifications: string[] = [];
  client.onNotification((notification) => notifications.push(notification.method));
  const resultPromise = client.request("account/read", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.written[0].method, "account/read");

  fake.stdout.write('{"method":"account/updated","params":{}}\n{"id":1,"res');
  fake.stdout.write('ult":{"requiresOpenaiAuth":false}}\r\n');
  assert.deepEqual(await resultPromise, { requiresOpenaiAuth: false });
  assert.deepEqual(notifications, ["account/updated"]);
  await client.close();
});

test("CodexAppServerClient safely declines command approval by default", async () => {
  const fake = createFakeChild();
  const client = new CodexAppServerClient(fake.child);
  fake.stdout.write(JSON.stringify({
    id: 99,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a" },
  }) + "\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.written[0], { id: 99, result: { decision: "decline" } });
  await client.close();
});

test("CodexAppServerClient fails pending requests on malformed JSONL", async () => {
  const fake = createFakeChild();
  const client = new CodexAppServerClient(fake.child, { requestTimeoutMs: 1_000 });
  const pending = client.request("thread/start", {});
  fake.stdout.write("{not-json}\n");
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexAppServerError &&
      error.code === "codex_app_server_protocol_error",
  );
  client.terminate();
});

test("CodexAppServerClient treats duplicate response ids as protocol failure", async () => {
  const fake = createFakeChild();
  const client = new CodexAppServerClient(fake.child, { requestTimeoutMs: 1_000 });
  const pending = client.request("thread/start", {});
  fake.stdout.write('{"id":1,"result":{}}\n');
  await pending;
  fake.stdout.write('{"id":1,"result":{}}\n');
  const next = client.request("account/read", {});
  await assert.rejects(
    next,
    (error: unknown) => error instanceof CodexAppServerError &&
      error.code === "codex_app_server_protocol_error",
  );
  client.terminate();
});

test("CodexAppServerClient rejects notification waiters when closed", async () => {
  const fake = createFakeChild();
  const client = new CodexAppServerClient(fake.child, { requestTimeoutMs: 60_000 });
  const pending = client.waitForNotification("thread/started");
  await client.close();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CodexAppServerError &&
      error.code === "codex_app_server_closed",
  );
  await assert.rejects(
    client.waitForNotification("thread/started"),
    (error: unknown) => error instanceof CodexAppServerError &&
      error.code === "codex_app_server_closed",
  );
});
