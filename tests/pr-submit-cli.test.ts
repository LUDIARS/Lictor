import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cwd = fileURLToPath(new URL("../", import.meta.url));

async function submit(listener: RequestListener) {
  const server = createServer(listener);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        "--import", "tsx", "src/cli.ts", "cli", "pr", "submit",
        "--repo", cwd, "--branch", "feat/example",
      ], { cwd, env: { ...process.env, LICTOR_PORT: String(address.port) }, timeout: 15_000 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const { code, stdout, stderr } = error as { code: unknown; stdout: string; stderr: string };
      return { code, stdout, stderr };
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("pr submit keeps stdout and exit status for accepted and clearly rejected submissions", async () => {
  const accepted = '{"submitted":true,"pullRequest":{"id":"pr-1"}}';
  const rejected = '{"submitted":false,"reason":"no_commits"}';
  const httpRejection = '{"error":"Concordia not registered for this session"}';
  for (const [status, body, expected] of [
    [200, accepted, { code: 0, stdout: accepted + "\n", stderr: "" }],
    [200, rejected, { code: 0, stdout: rejected + "\n", stderr: "" }],
    [503, httpRejection, { code: 1, stdout: "", stderr: `lictor: HTTP 503: ${httpRejection}\n` }],
  ] as const) {
    assert.deepEqual(await submit((_req, res) => res.writeHead(status).end(body)), expected);
  }
});

test("pr submit diagnoses lost replies, with one POST and no automatic lookups", async () => {
  const incomplete: RequestListener = (req, res) => {
    res.writeHead(200, { "Content-Length": 100 });
    res.write('{"submitted":');
    setImmediate(() => req.socket.destroy());
  };
  const upstreamTimeout = JSON.stringify({
    submitted: false, reason: "error", detail: "Revisor /v1/local-prs timed out after 15000ms",
  });
  for (const respond of [
    (req => req.socket.destroy()) as RequestListener,
    incomplete,
    ((_req, res) => res.writeHead(502).end('{"error":"pr_submission_result_unknown"}')) as RequestListener,
    ((_req, res) => res.writeHead(200).end(upstreamTimeout)) as RequestListener,
  ]) {
    const requests: string[] = [];
    const result = await submit((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      req.resume();
      req.on("end", () => respond(req, res));
    });
    assert.deepEqual(requests, ["POST /v1/pr/submit"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /result unknown.*Do not resubmit.*GET \/v1\/prs\/revisor.*headRef/);
    assert.ok(result.stderr.includes(JSON.stringify(cwd)));
    assert.ok(result.stderr.includes('"feat/example"'));
    assert.doesNotMatch(result.stderr, /timed out after 15000ms/);
  }
});
