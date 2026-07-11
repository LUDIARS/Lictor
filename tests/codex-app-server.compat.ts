import * as pty from "node-pty";
import { startCodexAppServerSession } from "../src/codex-app-server-session.js";
import { PROVIDERS, resolveBinary } from "../src/provider.js";
import { LICTOR_VERSION } from "../src/version.js";
import type { TranscriptFrameSink } from "../src/transcript-sink.js";

const sink: TranscriptFrameSink = {
  post: async (_kind, _payload) => ({ seq: 0, persisted: true }),
  flush: async () => undefined,
};

const binary = resolveBinary(PROVIDERS.codex);
const session = await startCodexAppServerSession({
  binary,
  cwd: process.cwd(),
  env: process.env,
  sink,
  lictorVersion: LICTOR_VERSION,
});
await session.client.close();

const isWindows = process.platform === "win32";
const file = isWindows ? process.env.ComSpec ?? "cmd.exe" : binary;
const args = isWindows
  ? ["/d", "/s", "/c", binary, "resume", session.identity.threadId]
  : ["resume", session.identity.threadId];
const child = pty.spawn(file, args, {
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
  cols: 80,
  rows: 24,
  name: process.env.TERM ?? "xterm-256color",
});

await new Promise<void>((resolve, reject) => {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    reject(new Error("codex resume did not produce TUI output within 15 seconds"));
  }, 15_000);
  child.onData((data) => {
    if (settled || data.length === 0) return;
    settled = true;
    clearTimeout(timer);
    child.kill();
    resolve();
  });
  child.onExit(({ exitCode }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error(`codex resume exited before TUI output (exit=${exitCode})`));
  });
});

process.stdout.write(JSON.stringify({
  ok: true,
  threadId: session.identity.threadId,
  sessionId: session.identity.sessionId,
  authType: session.identity.authType,
  planType: session.identity.planType,
}) + "\n");

// ConPTY can retain an internal handle briefly after node-pty reports the
// child as killed. This is an explicit one-shot compatibility probe, so do
// not let that implementation detail keep CI alive after the assertion.
process.exit(0);
