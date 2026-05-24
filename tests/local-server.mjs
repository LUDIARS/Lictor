// Local dev server: brings up the Lictor sidecar without spawning a real
// claude. ptyWriter is replaced with a stdout logger so you can POST to
// /v1/rename (and any other endpoint) and see what bytes WOULD have hit
// claude's TUI input.
//
// Run:
//   npx tsx tests/local-server.mjs
//
// Then in another terminal:
//   curl http://127.0.0.1:<port>/v1/health
//   curl -X POST -H 'content-type: application/json' \
//        -d '{"text":"[Li] manual test"}' http://127.0.0.1:<port>/v1/rename
//
// Or use the bundled CLI (set LICTOR_PORT first):
//   LICTOR_PORT=<port> npx tsx src/cli.ts cli rename "[Li] manual test"

import { startSidecar } from "../src/sidecar.ts";
import { gatherBaseMeta } from "../src/meta.ts";
import { SkillInjector } from "../src/skill-injector.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const meta = gatherBaseMeta();
const tmpRoot = mkdtempSync(join(tmpdir(), "lictor-localserver-"));
const injector = new SkillInjector("session-localserver", tmpRoot);

const ptyLog = [];
const ctx = {
  meta,
  titleState: { manualOverride: null },
  concordia: null,
  sessionId: null,
  roleLabel: null,
  injector,
  ptyWriter: (data) => {
    ptyLog.push({ ts: new Date().toISOString(), bytes: data });
    process.stdout.write(`[ptyWriter] ${JSON.stringify(data)}\n`);
  },
};

const sidecar = await startSidecar(ctx);
const port = sidecar.port;

process.stdout.write(`lictor local-server up on http://127.0.0.1:${port}\n`);
process.stdout.write(`  health   : GET  /v1/health\n`);
process.stdout.write(`  meta     : GET  /v1/meta\n`);
process.stdout.write(`  title    : POST /v1/title       {text}\n`);
process.stdout.write(`  rename   : POST /v1/rename      {text}   (logs to ptyWriter; no real claude)\n`);
process.stdout.write(`  skill    : GET/POST /v1/skill\n`);
process.stdout.write(`Concordia-dependent endpoints (chat / event / conflicts) will 503.\n`);
process.stdout.write(`Set LICTOR_PORT=${port} in another terminal to use the cli, e.g.\n`);
process.stdout.write(`  LICTOR_PORT=${port} npx tsx src/cli.ts cli rename "[Li] test"\n`);
process.stdout.write(`Ctrl-C to stop.\n`);

const shutdown = () => {
  process.stdout.write(`\n[shutdown] received ${ptyLog.length} ptyWriter call(s); cleaning up.\n`);
  sidecar.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
