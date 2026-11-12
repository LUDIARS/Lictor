import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClient } from "../src/client.js";

function fixture(t: TestContext, bytes: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "lictor-chat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "private report.txt");
  writeFileSync(path, bytes);
  return path;
}

async function invoke(t: TestContext, args: string[], status = 200) {
  const previousPort = process.env.LICTOR_PORT;
  process.env.LICTOR_PORT = "12345";
  t.after(() => {
    if (previousPort === undefined) delete process.env.LICTOR_PORT;
    else process.env.LICTOR_PORT = previousPort;
  });
  const requests: Array<{ options: http.RequestOptions; body: string }> = [];
  let stderr = "";
  let stdout = "";
  let exitCode: number | undefined;
  const exited = new Error("mock exit");
  const stdoutWrite = process.stdout.write;
  t.mock.method(process, "exit", (code: number) => { exitCode = code; throw exited; });
  t.mock.method(process.stderr, "write", (chunk: string) => { stderr += chunk; return true; });
  t.mock.method(process.stdout, "write", function (chunk: string | Uint8Array, ...args: unknown[]) {
    // Node's test runner uses stdout for its binary IPC protocol; the CLI writes text.
    if (typeof chunk === "string") stdout += chunk;
    else return Reflect.apply(stdoutWrite, process.stdout, [chunk, ...args]);
    return true;
  });
  t.mock.method(http, "request", (options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    let body = "";
    return new Writable({
      write(chunk, _encoding, done) { body += chunk.toString(); done(); },
      final(done) {
        requests.push({ options, body });
        const res = Object.assign(new PassThrough(), { statusCode: status });
        callback(res as unknown as http.IncomingMessage);
        res.end('{"ok":true}');
        done();
      },
    });
  });
  let failure: unknown;
  try {
    await runClient(["chat", ...args]);
  } catch (error) {
    if (error !== exited) failure = error;
  }
  return { requests, stderr, stdout, exitCode, failure };
}

for (const bom of [false, true]) {
  test(`chat file preserves Japanese, CRLF, quotes and whitespace (BOM=${bom})`, async (t) => {
    const text = '  日本語 "報告"\r\n次の行\\path\n🙂\uFEFF末尾  \n';
    const path = fixture(t, (bom ? "\uFEFF" : "") + text);
    const result = await invoke(t, ["team", "--text-file", path]);
    assert.equal(result.failure, undefined);
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, undefined);
    assert.equal(result.stdout, '{"ok":true}\n');
    assert.equal(result.requests.length, 1);
    const [{ options, body }] = result.requests;
    assert.equal(options.hostname, "127.0.0.1");
    assert.equal(options.path, "/v1/chat");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(body), { channel: "team", text });
    assert.equal((options.headers as Record<string, unknown>)["content-length"], Buffer.byteLength(body));
  });
}

test("chat positional input retains space joining", async (t) => {
  const result = await invoke(t, ["team", "日本語", '"report"', "次の行\n本文"]);
  assert.equal(result.failure, undefined);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(JSON.parse(result.requests[0].body), { channel: "team", text: '日本語 "report" 次の行\n本文' });
});

test("chat removes exactly one leading BOM", async (t) => {
  const path = fixture(t, "\uFEFF\uFEFF本文");
  const result = await invoke(t, ["team", "--text-file", path]);
  assert.equal(result.failure, undefined);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(JSON.parse(result.requests[0].body), { channel: "team", text: "\uFEFF本文" });
});

const invalidArguments = [
  [], ["team"], ["team", "--text-file"], ["--text-file", "private-path"],
  ["team", "--text-file", ""], ["team", "--text-file=private-path"],
  ["team", "private-body", "--text-file", "private-path"],
  ["team", "--text-file", "private-path", "private-body"],
  ["team", "--text-file", "--text-file"],
  ["team", "--text-file", "private-path", "--text-file", "other-path"],
];
for (const [index, args] of invalidArguments.entries()) {
  test(`chat rejects invalid file arguments before HTTP (${index})`, async (t) => {
    const result = await invoke(t, args);
    assert.equal(result.failure, undefined);
    assert.equal(result.exitCode, 2);
    assert.equal(result.requests.length, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "lictor cli chat: invalid_arguments\n" +
      "usage: lictor cli chat <channel> <text...> | <channel> --text-file <path>\n");
  });
}

for (const [name, bytes, code] of [
  ["empty", Buffer.alloc(0), "empty_text"],
  ["whitespace", Buffer.from(" \r\n\t　"), "empty_text"],
  ["BOM only", Buffer.from("\uFEFF"), "empty_text"],
  ["BOM whitespace", Buffer.from("\uFEFF\n "), "empty_text"],
  ["invalid continuation", Buffer.from([0xc3, 0x28]), "invalid_utf8"],
  ["truncated", Buffer.from([0xe3, 0x81]), "invalid_utf8"],
  ["overlong", Buffer.from([0xc0, 0xaf]), "invalid_utf8"],
  ["UTF-16", Buffer.from([0xff, 0xfe, 0x41, 0]), "invalid_utf8"],
] as const) {
  test(`chat refuses ${name} without disclosing input or sending`, async (t) => {
    const path = fixture(t, bytes);
    const result = await invoke(t, ["team", "--text-file", path]);
    assert.equal(result.failure, undefined);
    assert.equal(result.exitCode, 2);
    assert.equal(result.requests.length, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `lictor cli chat: ${code}\n` +
      "usage: lictor cli chat <channel> <text...> | <channel> --text-file <path>\n");
    assert.ok(!result.stderr.includes(path));
  });
}

test("chat rejects missing file with a fixed path-free error", async (t) => {
  const path = fixture(t, "private-body") + ".missing";
  const result = await invoke(t, ["team", "--text-file", path]);
  assert.equal(result.failure, undefined);
  assert.equal(result.exitCode, 2);
  assert.equal(result.requests.length, 0);
  assert.match(result.stderr, /^lictor cli chat: file_read_failed\nusage:/);
  assert.ok(!result.stderr.includes(path));
  assert.ok(!result.stderr.includes("private-body"));
});

test("chat does not retry a rejected sidecar POST", async (t) => {
  const path = fixture(t, "日本語の報告");
  const result = await invoke(t, ["team", "--text-file", path], 503);
  assert.equal(result.requests.length, 1);
  assert.match(String(result.failure), /HTTP 503/);
});
