import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  agyDefaultInstallPaths, encodeGrokCwd, getProvider, grokDefaultInstallPaths, grokHomeRoot,
  grokPinnedTranscriptFile, grokTranscriptDir, isOnPath, PROVIDERS, resolveBinary,
} from "../src/provider.js";
import { resolveGrokTranscriptPin } from "../src/grok-transcript-pin.js";

test("PROVIDERS registers claude with claude-add-dir skill strategy", () => {
  const p = PROVIDERS.claude;
  assert.equal(p.name, "claude");
  assert.equal(p.binary, "claude");
  assert.equal(p.skillStrategy, "claude-add-dir");
  assert.equal(p.supportsSkills, true);
  assert.equal(p.concordiaProvider, "claude-code");
});

test("PROVIDERS disables Codex skill injection because user scope is shared", () => {
  const p = PROVIDERS.codex;
  assert.equal(p.name, "codex");
  assert.equal(p.binary, "codex");
  assert.equal(p.skillStrategy, "none");
  assert.equal(p.supportsSkills, false);
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
  assert.equal(getProvider("agy")?.binary, "agy");
  assert.equal(getProvider("grok"), PROVIDERS.grok);
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

// 2026-10-03: Concordia の相談は専用の設定フォルダ (CLAUDE_CONFIG_DIR / CODEX_HOME) で claude / codex を起動する。
// ~/.claude / ~/.codex 固定だと transcript を見つけられず Discord への中継が止まる。
test("transcript の設定フォルダは CLAUDE_CONFIG_DIR / CODEX_HOME に従い、 無ければホーム直下", async () => {
  const { claudeConfigRoot, codexHomeRoot } = await import("../src/provider.js");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  assert.equal(claudeConfigRoot({ CLAUDE_CONFIG_DIR: "E:/Document/Consult/.claude-config" }), "E:/Document/Consult/.claude-config");
  assert.equal(codexHomeRoot({ CODEX_HOME: "E:/Document/Consult/.codex-home" }), "E:/Document/Consult/.codex-home");
  assert.equal(claudeConfigRoot({}), join(homedir(), ".claude"));
  assert.equal(codexHomeRoot({ CODEX_HOME: "  " }), join(homedir(), ".codex"));
});

// ─── agy (Antigravity CLI) ─────────────────────────────────────────────

test("PROVIDERS registers agy (Antigravity CLI) with no skill injection", () => {
  const p = PROVIDERS.agy;
  assert.equal(p.name, "agy");
  assert.equal(p.binary, "agy");
  assert.equal(p.binaryEnvVar, "LICTOR_AGY_BIN");
  assert.equal(p.skillStrategy, "none");
  assert.equal(p.supportsSkills, false);
  assert.equal(p.concordiaProvider, "antigravity-cli");
  assert.equal(p.displayName, "Antigravity CLI");
  assert.equal(p.transcriptDir("/tmp/x"), null);
  assert.equal(p.extractSessionId("anything"), null);
  assert.equal(p.supportsSessionPin, false);
});

test("submitInject(agy): gemini と同じ単発書き", () => {
  const writes: string[] = [];
  PROVIDERS.agy.submitInject((d) => writes.push(d), "hi");
  assert.deepEqual(writes, ["hi\r"]);
});

test("gemini は agy 追加後も残る", () => {
  assert.equal(PROVIDERS.gemini.concordiaProvider, "gemini-cli");
});

const AGY_EXE = "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe";
const winEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  Path: "C:\\Windows\\System32;C:\\tools",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ...extra,
});
const existsIn = (paths: string[]) => (p: string) => paths.includes(p);

test("agyDefaultInstallPaths: win32 は %LOCALAPPDATA%/agy/bin/agy.exe", () => {
  assert.deepEqual(agyDefaultInstallPaths(winEnv(), "win32"), [AGY_EXE]);
});

test("agyDefaultInstallPaths: LOCALAPPDATA 未設定 / 非 win32 は候補なし", () => {
  assert.deepEqual(agyDefaultInstallPaths({}, "win32"), []);
  assert.deepEqual(agyDefaultInstallPaths(winEnv(), "linux"), []);
});

test("isOnPath: Windows は Path 大小揺れと PATHEXT を吸収する", () => {
  const exists = existsIn(["C:\\tools\\agy.EXE"]);
  assert.equal(isOnPath("agy", winEnv(), exists, "win32"), true);
  assert.equal(isOnPath("agy", winEnv({ Path: "C:\\Windows\\System32" }), exists, "win32"), false);
});

test("isOnPath: POSIX は PATH を : で区切り拡張子なしで探す", () => {
  const exists = existsIn(["/opt/bin/agy"]);
  assert.equal(isOnPath("agy", { PATH: "/usr/bin:/opt/bin" }, exists, "linux"), true);
  assert.equal(isOnPath("agy", { PATH: "/usr/bin" }, exists, "linux"), false);
});

test("resolveBinary(agy): env 上書きが PATH・既定位置より優先", () => {
  const bin = resolveBinary(PROVIDERS.agy, winEnv({ LICTOR_AGY_BIN: " D:\\agy\\agy.exe " }), {
    exists: () => true,
    platform: "win32",
  });
  assert.equal(bin, "D:\\agy\\agy.exe");
});

test("resolveBinary(agy): PATH 上にあれば binary 名のまま (既定位置が実在しても)", () => {
  const bin = resolveBinary(PROVIDERS.agy, winEnv(), {
    exists: existsIn(["C:\\tools\\agy.EXE", AGY_EXE]),
    platform: "win32",
  });
  assert.equal(bin, "agy");
});

test("resolveBinary(agy): PATH に無く既定位置が実在すれば絶対パス", () => {
  const bin = resolveBinary(PROVIDERS.agy, winEnv(), { exists: existsIn([AGY_EXE]), platform: "win32" });
  assert.equal(bin, AGY_EXE);
});

test("resolveBinary(agy): どこにも無ければ binary 名に戻す", () => {
  const bin = resolveBinary(PROVIDERS.agy, winEnv(), { exists: () => false, platform: "win32" });
  assert.equal(bin, "agy");
});

test("PROVIDERS registers Grok CLI with native skill discovery and two-step inject", () => {
  const grok = PROVIDERS.grok;
  assert.equal(grok.name, "grok");
  assert.equal(grok.binary, "grok");
  assert.equal(grok.binaryEnvVar, "LICTOR_GROK_BIN");
  assert.equal(grok.defaultInstallPaths, grokDefaultInstallPaths);
  assert.equal(grok.skillStrategy, "none");
  assert.equal(grok.supportsSkills, false);
  assert.equal(grok.concordiaProvider, "grok-cli");
  assert.equal(grok.displayName, "Grok CLI");
  assert.equal(grok.submitInject, PROVIDERS.codex.submitInject);
  assert.equal(grok.transcriptDir, grokTranscriptDir);
  assert.equal(grok.extractSessionId("anything"), null);
  assert.equal(grok.supportsSessionPin, true);
  assert.equal(grok.pinnedTranscriptFile, grokPinnedTranscriptFile);
});

const grokSessionId = "96a8a47c-0184-433f-ab6b-5e53153a7633";

test("Grok transcript paths honor GROK_HOME and encode the absolute native cwd", () => {
  const cwd = join("repo space", "folder#1");
  const env = { GROK_HOME: resolve("custom grok") };
  const encoded = encodeURIComponent(resolve(cwd));
  assert.equal(encodeGrokCwd(cwd), encoded);
  assert.equal(grokHomeRoot({}), join(homedir(), ".grok"));
  assert.equal(grokHomeRoot({ GROK_HOME: "  " }), join(homedir(), ".grok"));
  assert.equal(grokTranscriptDir(cwd, env), join(env.GROK_HOME, "sessions", encoded));
  assert.equal(grokPinnedTranscriptFile(cwd, grokSessionId, env),
    join(env.GROK_HOME, "sessions", encoded, grokSessionId, "updates.jsonl"));
  assert.equal(PROVIDERS.grok.extractSessionId(grokSessionId), grokSessionId);
  assert.equal(PROVIDERS.grok.extractSessionId(`other-${grokSessionId}`), null);
});

test("Grok adds a session ID only for new sessions and pins explicit IDs", () => {
  const cwd = resolve("repo");
  const env = { GROK_HOME: resolve("grok-home") };
  const path = grokPinnedTranscriptFile(cwd, grokSessionId, env);
  const avoidGeneratingId = () => assert.fail("should not generate a session ID");
  const grok = PROVIDERS.grok;
  assert.deepEqual(resolveGrokTranscriptPin(grok, [], cwd, env, () => grokSessionId),
    { args: ["--session-id", grokSessionId], path });
  assert.deepEqual(resolveGrokTranscriptPin(grok, ["--", "--resume"], cwd, env, () => grokSessionId),
    { args: ["--session-id", grokSessionId], path });
  for (const args of [["-s", grokSessionId], ["--session-id", grokSessionId], [`--session-id=${grokSessionId}`]]) {
    assert.deepEqual(resolveGrokTranscriptPin(grok, args, cwd, env, avoidGeneratingId), { args: [], path });
  }
  for (const args of [["-r"], ["--resume"], ["--resume=last"], ["-c"], ["--continue"],
    ["--fork-session"], ["--session-id"], ["-s", `../${grokSessionId}`]]) {
    assert.equal(resolveGrokTranscriptPin(grok, args, cwd, env, avoidGeneratingId), null);
  }
  assert.equal(resolveGrokTranscriptPin(PROVIDERS.claude, [], cwd, env, avoidGeneratingId), null);
});

const grokPlatforms = [
  {
    platform: "win32",
    env: winEnv({ USERPROFILE: "C:\\Users\\u" }),
    onPath: "C:\\tools\\grok.EXE",
    installed: "C:\\Users\\u\\.grok\\bin\\grok.exe",
    override: "D:\\custom\\grok.exe",
  },
  {
    platform: "linux",
    env: { HOME: "/home/u", PATH: "/usr/bin:/opt/bin" },
    onPath: "/opt/bin/grok",
    installed: "/home/u/.grok/bin/grok",
    override: "/custom/grok",
  },
] as const;

for (const { platform, env, onPath, installed, override } of grokPlatforms) {
  test(`resolveBinary(grok): override, PATH, and default install path on ${platform}`, () => {
    const grok = PROVIDERS.grok;
    const both = { exists: existsIn([onPath, installed]), platform };
    assert.equal(resolveBinary(grok, { ...env, LICTOR_GROK_BIN: ` ${override} ` }, both), override);
    assert.equal(resolveBinary(grok, env, both), "grok");
    assert.equal(resolveBinary(grok, env, { exists: existsIn([installed]), platform }), installed);
    assert.equal(resolveBinary(grok, env, { exists: () => false, platform }), "grok");
  });
}

test("grokDefaultInstallPaths: no candidate without the platform's home variable", () => {
  assert.deepEqual(grokDefaultInstallPaths({ HOME: "/home/u", USERPROFILE: " " }, "win32"), []);
  assert.deepEqual(grokDefaultInstallPaths({ USERPROFILE: "C:\\Users\\u", HOME: " " }, "linux"), []);
});

test("resolveBinary: defaultInstallPaths を持たない provider は実在確認を呼ばない", () => {
  let called = false;
  const bin = resolveBinary(PROVIDERS.gemini, winEnv(), {
    exists: () => { called = true; return true; },
    platform: "win32",
  });
  assert.equal(bin, "gemini");
  assert.equal(called, false);
});
