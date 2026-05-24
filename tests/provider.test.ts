import { test } from "node:test";
import assert from "node:assert/strict";
import { getProvider, PROVIDERS } from "../src/provider.js";

test("PROVIDERS registers claude with claude-add-dir skill strategy", () => {
  const p = PROVIDERS.claude;
  assert.equal(p.name, "claude");
  assert.equal(p.binary, "claude");
  assert.equal(p.skillStrategy, "claude-add-dir");
  assert.equal(p.supportsSkills, true);
  assert.equal(p.concordiaProvider, "claude-code");
});

test("PROVIDERS registers codex with codex-user-agents skill strategy", () => {
  const p = PROVIDERS.codex;
  assert.equal(p.name, "codex");
  assert.equal(p.binary, "codex");
  assert.equal(p.skillStrategy, "codex-user-agents");
  assert.equal(p.supportsSkills, true);
  assert.equal(p.concordiaProvider, "codex-cli");
});

test("PROVIDERS registers gemini with no skill discovery (none strategy)", () => {
  const p = PROVIDERS.gemini;
  assert.equal(p.name, "gemini");
  assert.equal(p.binary, "gemini");
  assert.equal(p.skillStrategy, "none");
  assert.equal(p.supportsSkills, false);
  assert.equal(p.concordiaProvider, "gemini-cli");
});

test("getProvider: known names resolve", () => {
  assert.equal(getProvider("claude")?.binary, "claude");
  assert.equal(getProvider("codex")?.binary, "codex");
  assert.equal(getProvider("gemini")?.binary, "gemini");
});

test("getProvider: unknown returns null", () => {
  assert.equal(getProvider("gpt-cli"), null);
  assert.equal(getProvider(""), null);
});
