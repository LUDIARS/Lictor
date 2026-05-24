import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("SkillInjector writes, lists, deletes, cleans up", () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-test-"));
  const inj = new SkillInjector("session-x", root);
  assert.ok(existsSync(inj.skillsDir));

  inj.writeSkill("hello", renderSkillMd({ name: "hello", description: "greet", body: "hi" }));
  inj.writeSkill("world", renderSkillMd({ name: "world", description: "bye", body: "ok" }));

  const list = inj.list();
  assert.deepEqual(list, ["hello", "world"]);

  const file = readFileSync(join(inj.skillsDir, "hello", "SKILL.md"), "utf8");
  assert.match(file, /^---\nname: hello\ndescription: greet\n---\n/);
  assert.match(file, /\nhi\n/);

  assert.equal(inj.deleteSkill("hello"), true);
  assert.deepEqual(inj.list(), ["world"]);

  inj.cleanup();
  assert.equal(existsSync(inj.sessionDir), false);

  rmSync(root, { recursive: true, force: true });
});

test("SkillInjector rejects oversize content", () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-test-"));
  const inj = new SkillInjector("session-y", root);
  const big = "a".repeat(MAX_SKILL_BYTES + 1);
  assert.throws(() => inj.writeSkill("big", big), /exceeds/);
  inj.cleanup();
  rmSync(root, { recursive: true, force: true });
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
