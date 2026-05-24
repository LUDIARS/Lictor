import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillInjector } from "../src/skill-injector.js";
import { newTaskState, relayTask, seedTaskProtocolSkill } from "../src/task-relay.js";

test("newTaskState is empty", () => {
  const s = newTaskState();
  assert.equal(s.branch, null);
  assert.equal(s.desc, null);
  assert.equal(s.updatedAt, null);
});

test("relayTask: branch change updates state + skill", async () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-task-"));
  const injector = new SkillInjector("s", "claude-add-dir", { homeRoot: root });
  const next = await relayTask({
    client: null,
    sessionId: null,
    injector,
    state: newTaskState(),
    branch: "feat/x",
    source: "auto",
  });
  assert.equal(next.branch, "feat/x");
  assert.equal(next.desc, null);
  assert.notEqual(next.updatedAt, null);

  const md = readFileSync(join(injector.skillsDir, "lictor-current-task", "SKILL.md"), "utf8");
  assert.match(md, /branch: `feat\/x`/);
  assert.match(md, /none set/);

  injector.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("relayTask: desc-only update keeps branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-task-"));
  const injector = new SkillInjector("s", "claude-add-dir", { homeRoot: root });
  const s1 = await relayTask({
    client: null,
    sessionId: null,
    injector,
    state: newTaskState(),
    branch: "feat/x",
    source: "auto",
  });
  const s2 = await relayTask({
    client: null,
    sessionId: null,
    injector,
    state: s1,
    desc: "fix login bug",
    source: "explicit",
  });
  assert.equal(s2.branch, "feat/x");
  assert.equal(s2.desc, "fix login bug");

  injector.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("relayTask: no-change returns same state", async () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-task-"));
  const injector = new SkillInjector("s", "claude-add-dir", { homeRoot: root });
  const initial = { branch: "feat/x", desc: "fix bug", updatedAt: "2026-01-01T00:00:00Z" };
  const same = await relayTask({
    client: null,
    sessionId: null,
    injector,
    state: initial,
    source: "auto",
  });
  assert.strictEqual(same, initial);
  injector.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("seedTaskProtocolSkill writes a usable instruction skill", () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-task-"));
  const injector = new SkillInjector("s", "claude-add-dir", { homeRoot: root });
  seedTaskProtocolSkill(injector);
  const md = readFileSync(join(injector.skillsDir, "lictor-task-protocol", "SKILL.md"), "utf8");
  assert.match(md, /^---\nname: lictor-task-protocol\n/);
  assert.match(md, /lictor cli task set/);
  assert.match(md, /60 seconds/);
  injector.cleanup();
  rmSync(root, { recursive: true, force: true });
});
