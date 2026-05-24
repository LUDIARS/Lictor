// Smoke test: bring up the sidecar in-process (no Concordia), exercise each
// endpoint including proxies (which must 503 when Concordia is absent).
import { startSidecar } from "../src/sidecar.ts";
import { gatherBaseMeta } from "../src/meta.ts";
import { SkillInjector } from "../src/skill-injector.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const meta = gatherBaseMeta();
meta.provider = "claude";
const tmpRoot = mkdtempSync(join(tmpdir(), "lictor-smoke-"));
const injector = new SkillInjector("session-smoke", "claude-add-dir", { homeRoot: tmpRoot });
const ptyLog = [];
const ctx = {
  meta,
  titleState: { manualOverride: null },
  concordia: null,
  sessionId: null,
  roleLabel: null,
  injector,
  ptyWriter: (data) => ptyLog.push(data),
  notifyState: { mark: null, expiresAt: null },
  conflictState: { count: 0, titleMark: null },
  taskState: { branch: null, desc: null, updatedAt: null },
  pendingPermissions: new Map(),
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

async function del(p) {
  const r = await fetch(base + p, { method: "DELETE" });
  return { status: r.status, body: await r.text() };
}

const out = {
  health: await get("/v1/health"),
  meta: await get("/v1/meta"),
  sessionInfo: await get("/v1/concordia/session"),
  titleOk: await post("/v1/title", { text: "[Li] smoke v0.2" }),
  titleAuto: await post("/v1/title/auto"),
  rename: await post("/v1/rename", { text: "[Li] smoke rename" }),
  renameSanitized: await post("/v1/rename", { text: "/clear" }),
  renameEmpty: await post("/v1/rename", { text: "\x00\x07" }),
  chatNoConcordia: await post("/v1/chat", { channel: "team", text: "hi" }),
  eventNoConcordia: await post("/v1/event", { kind: "test" }),
  conflictsNoConcordia: await get("/v1/conflicts?repo=E:/x"),
  skillEmpty: await get("/v1/skill"),
  skillWrite: await post("/v1/skill", {
    name: "smoke-test",
    content: "---\nname: smoke-test\ndescription: hi\n---\n\nbody\n",
  }),
  skillList: await get("/v1/skill"),
  skillBadName: await post("/v1/skill", { name: "Bad Name", content: "x" }),
  skillDelete: await del("/v1/skill/smoke-test"),
  taskInitial: await get("/v1/lictor/task"),
  taskSetBranch: await post("/v1/lictor/task", { branch: "feat/smoke" }),
  taskSetDesc: await post("/v1/lictor/task", { desc: "smoke smoke" }),
  taskAfter: await get("/v1/lictor/task"),
  taskEmpty: await post("/v1/lictor/task", {}),
  state: await get("/v1/lictor/state"),
  slashClear: await post("/v1/slash", { cmd: "clear" }),
  slashRename: await post("/v1/slash", { cmd: "rename", args: "[Li] via slash" }),
  slashBad: await post("/v1/slash", { cmd: "Bad Cmd" }),
  keys: await post("/v1/keys", { data: "hello\r" }),
  keysStripCtrlC: await post("/v1/keys", { data: "abc\x03def\r" }),
  keysEmpty: await post("/v1/keys", { data: "\x00\x01" }),
  answer3: await post("/v1/answer", { choice: 3 }),
  answerBad: await post("/v1/answer", { choice: 0 }),
  notFound: await get("/v1/nope"),
};
console.log(JSON.stringify(out, null, 2));
console.log("ptyWriter received:", ptyLog);
sidecar.close();
rmSync(tmpRoot, { recursive: true, force: true });
