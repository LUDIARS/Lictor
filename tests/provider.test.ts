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

test("submitInject(claude): 1 chunk で text + \\r を書く", () => {
  const writes: string[] = [];
  PROVIDERS.claude.submitInject((d) => writes.push(d), "hello");
  assert.deepEqual(writes, ["hello\r"]);
});

test("submitInject(gemini): claude と同じ単発書き", () => {
  const writes: string[] = [];
  PROVIDERS.gemini.submitInject((d) => writes.push(d), "hi");
  assert.deepEqual(writes, ["hi\r"]);
});

test("submitInject(codex): text 即時 + \\r が delay 後 (2 段)", async () => {
  process.env.LICTOR_CODEX_INJECT_DELAY_MS = "5";
  try {
    const writes: string[] = [];
    PROVIDERS.codex.submitInject((d) => writes.push(d), "hello");
    // 即時にテキストだけが入っている
    assert.deepEqual(writes, ["hello"]);
    // delay 経過後に \r が単体で追加される
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, ["hello", "\r"]);
  } finally {
    delete process.env.LICTOR_CODEX_INJECT_DELAY_MS;
  }
});

test("submitInject(codex): text 末尾の \\r/\\n は剥がして Enter 単体に分ける", async () => {
  process.env.LICTOR_CODEX_INJECT_DELAY_MS = "5";
  try {
    const writes: string[] = [];
    PROVIDERS.codex.submitInject((d) => writes.push(d), "hello\n");
    // 末尾 \n は剥がれて純粋な本文だけが流れる
    assert.deepEqual(writes, ["hello"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Enter は単独 chunk で届く
    assert.deepEqual(writes, ["hello", "\r"]);
  } finally {
    delete process.env.LICTOR_CODEX_INJECT_DELAY_MS;
  }
});

test("submitInject(codex): 複数行末尾の \\r\\n\\n も全部剥がす", async () => {
  process.env.LICTOR_CODEX_INJECT_DELAY_MS = "5";
  try {
    const writes: string[] = [];
    PROVIDERS.codex.submitInject((d) => writes.push(d), "line1\nline2\r\n\n");
    // 中間の \n は本文として保持、 末尾の連続改行のみ剥がす
    assert.deepEqual(writes, ["line1\nline2"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, ["line1\nline2", "\r"]);
  } finally {
    delete process.env.LICTOR_CODEX_INJECT_DELAY_MS;
  }
});

test("submitInject(codex): text が改行だけなら本文 write を skip して Enter のみ", async () => {
  process.env.LICTOR_CODEX_INJECT_DELAY_MS = "5";
  try {
    const writes: string[] = [];
    PROVIDERS.codex.submitInject((d) => writes.push(d), "\n");
    // 本文 0 byte は write しない
    assert.deepEqual(writes, []);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, ["\r"]);
  } finally {
    delete process.env.LICTOR_CODEX_INJECT_DELAY_MS;
  }
});
