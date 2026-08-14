import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("permission-hook records the observation without writing a decision", { timeout: 10_000 }, async () => {
  let resolveBody!: (body: string) => void;
  let bodyTimer!: NodeJS.Timeout;
  const receivedBody = new Promise<string>((resolve, reject) => {
    bodyTimer = setTimeout(() => reject(new Error("permission-hook did not POST an observation")), 5_000);
    resolveBody = (body) => {
      clearTimeout(bodyTimer);
      resolve(body);
    };
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"deferred":true}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    const address = server.address() as AddressInfo;
    child = spawn(process.execPath, ["--import", "tsx", CLI_PATH, "cli", "permission-hook"], {
      env: { ...process.env, LICTOR_PORT: String(address.port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }));

    const [exitCode] = (await once(child, "close")) as [number];
    const body = JSON.parse(await receivedBody) as { tool_name?: unknown; tool_input?: unknown };

    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
    assert.equal(body.tool_name, "Bash");
    assert.deepEqual(body.tool_input, { command: "git status" });
  } finally {
    clearTimeout(bodyTimer);
    if (child?.exitCode === null) child.kill();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("permission-hook exits successfully for an invalid sidecar port", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, "cli", "permission-hook"], {
    env: { ...process.env, LICTOR_PORT: "70000" },
    input: JSON.stringify({ tool_name: "Bash" }),
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
