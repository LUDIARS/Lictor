// Smoke test: bring up the sidecar in-process (no Concordia), exercise each
// endpoint including proxies (which must 503 when Concordia is absent).
import { startSidecar } from "../src/sidecar.ts";
import { gatherBaseMeta } from "../src/meta.ts";

const meta = gatherBaseMeta();
const ctx = {
  meta,
  titleState: { manualOverride: null },
  concordia: null,
  sessionId: null,
  roleLabel: null,
};
const sidecar = await startSidecar(ctx);
const base = `http://127.0.0.1:${sidecar.port}`;
console.log("sidecar:", sidecar.port);

async function get(p) {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.text() };
}
async function post(p, body) {
  const r = await fetch(base + p, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.text() };
}

const out = {
  health: await get("/v1/health"),
  meta: await get("/v1/meta"),
  sessionInfo: await get("/v1/concordia/session"),
  titleOk: await post("/v1/title", { text: "[Li] smoke v0.1" }),
  titleAuto: await post("/v1/title/auto"),
  chatNoConcordia: await post("/v1/chat", { channel: "team", text: "hi" }),
  eventNoConcordia: await post("/v1/event", { kind: "test" }),
  conflictsNoConcordia: await get("/v1/conflicts?repo=E:/x"),
  notFound: await get("/v1/nope"),
};
console.log(JSON.stringify(out, null, 2));
sidecar.close();
