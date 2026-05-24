import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SKILL_BYTES, renderSkillMd, sanitizeSkillName, SkillInjector } from "../src/skill-injector.js";

test("sanitizeSkillName accepts kebab-case", () => {
  assert.equal(sanitizeSkillName("lictor-persona"), "lictor-persona");
  assert.equal(sanitizeSkillName("Foo"), "foo");
  assert.equal(sanitizeSkillName("  abc  "), "abc");
});

test("sanitizeSkillName rejects invalid names", () => {
  assert.equal(sanitizeSkillName("../etc/passwd"), null);
  assert.equal(sanitizeSkillName("with space"), null);
  assert.equal(sanitizeSkillName("9starts-with-digit"), null);
  assert.equal(sanitizeSkillName(""), null);
  assert.equal(sanitizeSkillName("a".repeat(100)), null);
});

test("SkillInjector [claude-add-dir]: writes, lists, deletes, cleans up", () => {
  const home = mkdtempSync(join(tmpdir(), "lictor-test-"));
  const inj = new SkillInjector("session-x", "claude-add-dir", { homeRoot: home });
  assert.ok(existsSync(inj.skillsDir));
  assert.equal(inj.skillsDir, join(home, ".claude", "lictor", "sessions", "session-x", ".claude", "skills"));

  inj.writeSkill("hello", renderSkillMd({ name: "hello", description: "greet", body: "hi" }));
  inj.writeSkill("world", renderSkillMd({ name: "world", description: "bye", body: "ok" }));
  assert.deepEqual(inj.list(), ["hello", "world"]);

  const file = readFileSync(join(inj.skillsDir, "hello", "SKILL.md"), "utf8");
  assert.match(file, /^---\nname: hello\ndescription: greet\n---\n/);

  assert.equal(inj.deleteSkill("hello"), true);
  assert.deepEqual(inj.list(), ["world"]);

  inj.cleanup();
  assert.equal(existsSync(inj.sessionDir), false);
  rmSync(home, { recursive: true, force: true });
});

test("SkillInjector [codex-user-agents]: writes with prefix, cleanup leaves user's own skills alone", () => {
  const home = mkdtempSync(join(tmpdir(), "lictor-test-"));
  const inj = new SkillInjector("sess-Y", "codex-user-agents", { homeRoot: home });
  assert.equal(inj.skillsDir, join(home, ".agents", "skills"));

  inj.writeSkill("persona", "x");
  inj.writeSkill("memory", "y");

  // On disk, names are prefixed.
  const onDisk = readdirSync(inj.skillsDir).sort();
  assert.deepEqual(onDisk, ["lictor-sess-Y-memory", "lictor-sess-Y-persona"]);

  // list() strips the prefix.
  assert.deepEqual(inj.list(), ["memory", "persona"]);

  // A non-lictor skill in the same dir should survive cleanup.
  const userSkillPath = join(inj.skillsDir, "user-own-skill");
  mkdirSync(userSkillPath, { recursive: true });
  writeFileSync(join(userSkillPath, "SKILL.md"), "user's skill");

  inj.cleanup();

  // Lictor's prefixed dirs gone, user's own skill untouched.
  const after = readdirSync(inj.skillsDir).sort();
  assert.deepEqual(after, ["user-own-skill"]);

  rmSync(home, { recursive: true, force: true });
});

test("SkillInjector [codex-user-agents]: deleteSkill targets the prefixed dir", () => {
  const home = mkdtempSync(join(tmpdir(), "lictor-test-"));
  const inj = new SkillInjector("sZ", "codex-user-agents", { homeRoot: home });
  inj.writeSkill("foo", "x");
  assert.equal(inj.deleteSkill("foo"), true);
  assert.deepEqual(inj.list(), []);
  rmSync(home, { recursive: true, force: true });
});

test("SkillInjector rejects oversize content", () => {
  const home = mkdtempSync(join(tmpdir(), "lictor-test-"));
  const inj = new SkillInjector("session-y", "claude-add-dir", { homeRoot: home });
  const big = "a".repeat(MAX_SKILL_BYTES + 1);
  assert.throws(() => inj.writeSkill("big", big), /exceeds/);
  inj.cleanup();
  rmSync(home, { recursive: true, force: true });
});

test("SkillInjector throws when constructed with 'none' strategy", () => {
  assert.throws(() => new SkillInjector("x", "none"), /should not be constructed/);
});

test("renderSkillMd flattens multiline description", () => {
  const md = renderSkillMd({
    name: "x",
    description: "line1\nline2\r\nline3",
    body: "  body  \n",
  });
  assert.match(md, /^---\nname: x\ndescription: line1 line2 line3\n---\n/);
  assert.match(md, /\nbody\n$/);
});
