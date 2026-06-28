import { test } from "node:test";
import assert from "node:assert/strict";
import { getProvider, PROVIDERS, resolveBinary } from "../src/provider.js";

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

// ─── resolveBinary: famulus 等の外部 CLI を env で差し替える ──────────────

test("PROVIDERS.gemma4-12 declares LICTOR_FAMULUS_BIN as its binary override", () => {
  const p = PROVIDERS["gemma4-12"];
  assert.equal(p.binary, "famulus");
  assert.equal(p.binaryEnvVar, "LICTOR_FAMULUS_BIN");
  // 旧名 `local` も同じ provider に解決する。
  assert.equal(getProvider("local")?.binaryEnvVar, "LICTOR_FAMULUS_BIN");
});

test("resolveBinary: env が設定済なら binary を上書きする", () => {
  const bin = resolveBinary(PROVIDERS["gemma4-12"], {
    LICTOR_FAMULUS_BIN: "C:\\tools\\famulus.cmd",
  });
  assert.equal(bin, "C:\\tools\\famulus.cmd");
});

test("resolveBinary: env 未設定なら既定 binary のまま", () => {
  assert.equal(resolveBinary(PROVIDERS["gemma4-12"], {}), "famulus");
});

test("resolveBinary: 空白のみの override は無視して既定にフォールバック", () => {
  assert.equal(
    resolveBinary(PROVIDERS["gemma4-12"], { LICTOR_FAMULUS_BIN: "   " }),
    "famulus",
  );
  // 値は trim される。
  assert.equal(
    resolveBinary(PROVIDERS["gemma4-12"], { LICTOR_FAMULUS_BIN: "  fam  " }),
    "fam",
  );
});

test("resolveBinary: binaryEnvVar を持たない provider は env を無視する", () => {
  // claude は override スロットを持たないので env があっても binary 固定。
  assert.equal(PROVIDERS.claude.binaryEnvVar, undefined);
  assert.equal(
    resolveBinary(PROVIDERS.claude, { LICTOR_FAMULUS_BIN: "nope" }),
    "claude",
  );
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

test("submitInject(claude): 複数行は本文 → delay 後に \\r (2 段)", async () => {
  process.env.LICTOR_INJECT_ENTER_DELAY_MS = "5";
  try {
    const writes: string[] = [];
    PROVIDERS.claude.submitInject((d) => writes.push(d), "line1\nline2");
    // 本文 (改行込み) が即時、 \r はまだ来ない
    assert.deepEqual(writes, ["line1\nline2"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, ["line1\nline2", "\r"]);
  } finally {
    delete process.env.LICTOR_INJECT_ENTER_DELAY_MS;
  }
});

test("submitInject(claude): 単行 + 末尾改行のみは単行扱い (1 chunk)", () => {
  const writes: string[] = [];
  PROVIDERS.claude.submitInject((d) => writes.push(d), "only-one-line\n");
  // 末尾改行だけなら本文に改行を含まない単行とみなし、 即時 1 chunk
  assert.deepEqual(writes, ["only-one-line\n\r"]);
});

test("submitInject(gemini): 複数行も claude と同じ delay 2 段", async () => {
  process.env.LICTOR_INJECT_ENTER_DELAY_MS = "5";
  try {
    const writes: string[] = [];
    PROVIDERS.gemini.submitInject((d) => writes.push(d), "a\nb\nc");
    assert.deepEqual(writes, ["a\nb\nc"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, ["a\nb\nc", "\r"]);
  } finally {
    delete process.env.LICTOR_INJECT_ENTER_DELAY_MS;
  }
});

test("submitInject(codex): 複数行は codex delay と enter delay の大きい方を使う", async () => {
  // codex delay=5ms, enter delay=40ms → 40ms 側が採用される。 20ms 時点では
  // まだ \r が来ておらず、 60ms 時点で来ていることで「大きい方」 を確認する。
  process.env.LICTOR_CODEX_INJECT_DELAY_MS = "5";
  process.env.LICTOR_INJECT_ENTER_DELAY_MS = "40";
  try {
    const writes: string[] = [];
    PROVIDERS.codex.submitInject((d) => writes.push(d), "x\ny");
    assert.deepEqual(writes, ["x\ny"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(writes, ["x\ny"]); // codex の 5ms では送られていない
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(writes, ["x\ny", "\r"]);
  } finally {
    delete process.env.LICTOR_CODEX_INJECT_DELAY_MS;
    delete process.env.LICTOR_INJECT_ENTER_DELAY_MS;
  }
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
  // 本文が複数行なので enter delay は max(codex, enter). テストでは両方小さくする.
  process.env.LICTOR_INJECT_ENTER_DELAY_MS = "5";
  try {
    const writes: string[] = [];
    PROVIDERS.codex.submitInject((d) => writes.push(d), "line1\nline2\r\n\n");
    // 中間の \n は本文として保持、 末尾の連続改行のみ剥がす
    assert.deepEqual(writes, ["line1\nline2"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, ["line1\nline2", "\r"]);
  } finally {
    delete process.env.LICTOR_CODEX_INJECT_DELAY_MS;
    delete process.env.LICTOR_INJECT_ENTER_DELAY_MS;
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

test("submitInject(codex): write throw を握って Enter は投機的に続行する", async () => {
  process.env.LICTOR_CODEX_INJECT_DELAY_MS = "5";
  try {
    const writes: string[] = [];
    let bodyThrew = false;
    PROVIDERS.codex.submitInject((d) => {
      if (!bodyThrew) {
        bodyThrew = true;
        throw new Error("pty closed");
      }
      writes.push(d);
    }, "hello");
    // 本文 write は throw したが、 Enter scheduling は止まらない
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, ["\r"]);
  } finally {
    delete process.env.LICTOR_CODEX_INJECT_DELAY_MS;
  }
});

test("submitInject(codex): Enter write throw も swallow して未捕捉例外を出さない", async () => {
  process.env.LICTOR_CODEX_INJECT_DELAY_MS = "5";
  try {
    // 全 write を throw させる. setTimeout 内で握り潰されること、
    // 呼び出し側に例外伝播しないことを assert.
    let caught: unknown = null;
    const orig = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.once("uncaughtException", (e) => { caught = e; });
    PROVIDERS.codex.submitInject(() => {
      throw new Error("pty closed");
    }, "hello");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(caught, null);
    process.removeAllListeners("uncaughtException");
    for (const l of orig) process.on("uncaughtException", l);
  } finally {
    delete process.env.LICTOR_CODEX_INJECT_DELAY_MS;
  }
});

// ─── transcriptDir / extractSessionId resolvers ───────────────────────

test("PROVIDERS.claude.transcriptDir resolves under ~/.claude/projects/", () => {
  const dir = PROVIDERS.claude.transcriptDir("/tmp/some-repo");
  assert.ok(dir !== null);
  assert.match(dir!, /[\\/]\.claude[\\/]projects[\\/]/);
});

test("PROVIDERS.codex.transcriptDir resolves under ~/.codex/sessions/", () => {
  const dir = PROVIDERS.codex.transcriptDir("/tmp/whatever");
  assert.ok(dir !== null);
  assert.match(dir!, /[\\/]\.codex[\\/]sessions$/);
});

test("PROVIDERS.gemini.transcriptDir returns null (no transcript support)", () => {
  assert.equal(PROVIDERS.gemini.transcriptDir("/tmp/x"), null);
});

test("PROVIDERS.claude.extractSessionId pulls UUID from <uuid>.jsonl basename", () => {
  // basename は jsonl 拡張子を除いたもの
  assert.equal(
    PROVIDERS.claude.extractSessionId("5d8f3a65-6129-4227-9bca-0b99db2742f2"),
    "5d8f3a65-6129-4227-9bca-0b99db2742f2",
  );
});

test("PROVIDERS.codex.extractSessionId pulls trailing UUID from rollout filename", () => {
  assert.equal(
    PROVIDERS.codex.extractSessionId("rollout-2026-05-27T06-43-18-019e663d-fb9a-7cd3-84fa-bc6648387ae9"),
    "019e663d-fb9a-7cd3-84fa-bc6648387ae9",
  );
});

test("PROVIDERS.*.extractSessionId returns null for non-matching names", () => {
  assert.equal(PROVIDERS.claude.extractSessionId("not-a-uuid"), null);
  assert.equal(PROVIDERS.codex.extractSessionId("rollout-without-uuid"), null);
  assert.equal(PROVIDERS.gemini.extractSessionId("anything"), null);
});
