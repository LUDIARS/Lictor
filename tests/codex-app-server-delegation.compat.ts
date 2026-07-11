import {
  closeCodexAppServerSession,
  runCodexDelegationTurn,
  startCodexAppServerSession,
} from "../src/codex-app-server-session.js";
import { PROVIDERS, resolveBinary } from "../src/provider.js";
import { LICTOR_VERSION } from "../src/version.js";
import type { TranscriptFrameSink } from "../src/transcript-sink.js";

const frameKinds: string[] = [];
let seq = 0;
const sink: TranscriptFrameSink = {
  post: async (kind) => {
    frameKinds.push(kind);
    return { seq: seq++, persisted: true };
  },
  flush: async () => undefined,
};

const session = await startCodexAppServerSession({
  binary: resolveBinary(PROVIDERS.codex),
  cwd: process.cwd(),
  env: process.env,
  sink,
  lictorVersion: LICTOR_VERSION,
});
try {
  await runCodexDelegationTurn(session, {
    cwd: process.cwd(),
    prompt: "Reply with exactly OK. Do not call tools.",
    turnTimeoutMs: 120_000,
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    threadId: session.identity.threadId,
    authType: session.identity.authType,
    planType: session.identity.planType,
    frameKinds,
  }) + "\n");
} finally {
  await closeCodexAppServerSession(session).catch(() => session.client.terminate());
}
