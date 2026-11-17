import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeProjectKey } from "../src/claude-json.js";
import {
  isSessionDirKey,
  releaseSessionDirTrust,
  seedSessionDirTrust,
} from "../src/session-dir-trust.js";
import { SkillInjector } from "../src/skill-injector.js";

// claude は --add-dir のフォルダごとに projects[<key>].hasTrustDialogAccepted を完全一致で見る。
// セッション用フォルダは毎回新しいので、起動前に登録しないと毎回 trust picker が出る。
// テストは一時フォルダ内の .claude.json だけを使い、本物の ~/.claude.json には触れない。

interface Fixture {
  home: string;
  sessionsRoot: string;
  claudeJson: string;
  cleanup: () => void;
}

function makeFixture(projects: Record<string, unknown> = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), "lictor-session-dir-trust-"));
  const sessionsRoot = join(home, ".claude", "lictor", "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  const claudeJson = join(home, ".claude.json");
  writeFileSync(claudeJson, JSON.stringify({ numStartups: 3, projects }));
  return { home, sessionsRoot, claudeJson, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function makeSessionDir(fx: Fixture, id: string): string {
  const dir = join(fx.sessionsRoot, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readProjects(fx: Fixture): Record<string, { hasTrustDialogAccepted?: boolean }> {
  return JSON.parse(readFileSync(fx.claudeJson, "utf8")).projects;
}

test("isSessionDirKey: sessions 直下 1 階層だけを対象にする", () => {
  const root = join(tmpdir(), "h", ".claude", "lictor", "sessions");
  const rootKey = normalizeProjectKey(root);
  assert.equal(isSessionDirKey(`${rootKey}/lictor-abc`, root), true);
  assert.equal(isSessionDirKey(`${rootKey}/lictor-abc/`, root), true);
  assert.equal(isSessionDirKey(rootKey, root), false);
  assert.equal(isSessionDirKey(`${rootKey}/lictor-abc/.claude`, root), false);
  assert.equal(isSessionDirKey(`${rootKey}-other/lictor-abc`, root), false);
  assert.equal(isSessionDirKey(normalizeProjectKey(join(tmpdir(), "h")), root), false);
});

test("seedSessionDirTrust: セッション用フォルダを trust 済みで登録し、他の設定は保つ", () => {
  const fx = makeFixture({ "E:/Document/Ars": { hasTrustDialogAccepted: true, allowedTools: ["x"] } });
  try {
    const dir = makeSessionDir(fx, "lictor-1111");
    const result = seedSessionDirTrust({ sessionDir: dir, sessionsRoot: fx.sessionsRoot, claudeJsonPath: fx.claudeJson });
    assert.deepEqual(result, { trustGranted: true, prunedCount: 0 });

    const saved = JSON.parse(readFileSync(fx.claudeJson, "utf8"));
    assert.equal(saved.numStartups, 3);
    assert.equal(saved.projects[normalizeProjectKey(dir)].hasTrustDialogAccepted, true);
    assert.deepEqual(saved.projects["E:/Document/Ars"], { hasTrustDialogAccepted: true, allowedTools: ["x"] });
  } finally {
    fx.cleanup();
  }
});

test("seedSessionDirTrust: sessions 直下でないフォルダは登録しない", () => {
  const fx = makeFixture();
  try {
    const outside = join(fx.home, "work");
    mkdirSync(outside, { recursive: true });
    const nested = join(makeSessionDir(fx, "lictor-2222"), ".claude");
    mkdirSync(nested, { recursive: true });
    for (const sessionDir of [outside, nested, fx.sessionsRoot]) {
      assert.equal(seedSessionDirTrust({ sessionDir, sessionsRoot: fx.sessionsRoot, claudeJsonPath: fx.claudeJson }), null);
    }
    assert.deepEqual(readProjects(fx), {});
  } finally {
    fx.cleanup();
  }
});

test("seedSessionDirTrust: 消えたセッションの登録だけを掃除し、実行中と sessions 外は残す", () => {
  const fx = makeFixture();
  try {
    const rootKey = normalizeProjectKey(fx.sessionsRoot);
    const running = makeSessionDir(fx, "lictor-running");
    const outsideKey = normalizeProjectKey(join(fx.home, "gone-project"));
    writeFileSync(fx.claudeJson, JSON.stringify({
      projects: {
        [`${rootKey}/lictor-gone-a`]: { hasTrustDialogAccepted: true },
        [`${rootKey}/lictor-gone-b`]: { hasTrustDialogAccepted: true },
        [normalizeProjectKey(running)]: { hasTrustDialogAccepted: true },
        // sessions 外は実フォルダが無くても人間の登録なので触らない。
        [outsideKey]: { hasTrustDialogAccepted: true },
      },
    }));

    const dir = makeSessionDir(fx, "lictor-new");
    const result = seedSessionDirTrust({ sessionDir: dir, sessionsRoot: fx.sessionsRoot, claudeJsonPath: fx.claudeJson });
    assert.deepEqual(result, { trustGranted: true, prunedCount: 2 });

    const projects = readProjects(fx);
    assert.deepEqual(Object.keys(projects).sort(), [
      normalizeProjectKey(dir),
      normalizeProjectKey(running),
      outsideKey,
    ].sort());
  } finally {
    fx.cleanup();
  }
});

test("seedSessionDirTrust: 変更が無ければ書き込まない (冪等)", () => {
  const fx = makeFixture();
  try {
    const dir = makeSessionDir(fx, "lictor-3333");
    const opts = { sessionDir: dir, sessionsRoot: fx.sessionsRoot, claudeJsonPath: fx.claudeJson };
    seedSessionDirTrust(opts);
    const before = readFileSync(fx.claudeJson, "utf8");
    let writes = 0;
    const fsApi = {
      existsSync: (p: string) => { try { statSync(p); return true; } catch { return false; } },
      readFileSync: ((p: string, enc: BufferEncoding) => readFileSync(p, enc)) as typeof readFileSync,
      writeFileSync: (() => { writes += 1; }) as unknown as typeof writeFileSync,
    };
    assert.deepEqual(seedSessionDirTrust({ ...opts, fsApi }), { trustGranted: true, prunedCount: 0 });
    assert.equal(writes, 0);
    assert.equal(readFileSync(fx.claudeJson, "utf8"), before);
  } finally {
    fx.cleanup();
  }
});

test("seedSessionDirTrust: claude.json が無い / 壊れている / 形が想定外なら書かない", () => {
  const fx = makeFixture();
  try {
    const dir = makeSessionDir(fx, "lictor-4444");
    const opts = { sessionDir: dir, sessionsRoot: fx.sessionsRoot, claudeJsonPath: fx.claudeJson };

    rmSync(fx.claudeJson);
    assert.equal(seedSessionDirTrust(opts), null);

    for (const broken of [
      "{not json",
      "[]",
      JSON.stringify({ projects: [] }),
      JSON.stringify({ projects: { [normalizeProjectKey(dir)]: "oops" } }),
    ]) {
      writeFileSync(fx.claudeJson, broken);
      assert.equal(seedSessionDirTrust(opts), null);
      assert.equal(readFileSync(fx.claudeJson, "utf8"), broken);
    }
  } finally {
    fx.cleanup();
  }
});

test("seedSessionDirTrust: Windows の表記ゆれ (\\ と大小文字) は既存 key を使う", { skip: process.platform !== "win32" }, () => {
  const fx = makeFixture();
  try {
    const dir = makeSessionDir(fx, "lictor-5555");
    const variant = dir.replace(/\//g, "\\").toUpperCase();
    writeFileSync(fx.claudeJson, JSON.stringify({ projects: { [variant]: { hasTrustDialogAccepted: false } } }));
    seedSessionDirTrust({ sessionDir: dir, sessionsRoot: fx.sessionsRoot, claudeJsonPath: fx.claudeJson });
    const projects = readProjects(fx);
    assert.deepEqual(Object.keys(projects), [variant]);
    assert.equal(projects[variant].hasTrustDialogAccepted, true);
  } finally {
    fx.cleanup();
  }
});

test("releaseSessionDirTrust: フォルダの片付け後に自分の登録を外し、他は残す", () => {
  const fx = makeFixture({ "E:/Document/Ars": { hasTrustDialogAccepted: true } });
  try {
    const injector = new SkillInjector("lictor-6666", "claude-add-dir", { homeRoot: fx.home });
    assert.equal(injector.sessionsRoot, fx.sessionsRoot);
    const other = makeSessionDir(fx, "lictor-other");
    const opts = { sessionDir: injector.sessionDir, sessionsRoot: injector.sessionsRoot, claudeJsonPath: fx.claudeJson };
    seedSessionDirTrust(opts);
    seedSessionDirTrust({ ...opts, sessionDir: other });
    assert.equal(readProjects(fx)[normalizeProjectKey(injector.sessionDir)].hasTrustDialogAccepted, true);

    injector.cleanup();
    assert.deepEqual(releaseSessionDirTrust(opts), { removed: true, prunedCount: 0 });
    assert.deepEqual(Object.keys(readProjects(fx)).sort(), ["E:/Document/Ars", normalizeProjectKey(other)].sort());

    // 2 回目は何も消すものが無い。
    assert.deepEqual(releaseSessionDirTrust(opts), { removed: false, prunedCount: 0 });
  } finally {
    fx.cleanup();
  }
});

test("releaseSessionDirTrust: sessions 外のパスと壊れた設定には触れない", () => {
  const fx = makeFixture({ "E:/Document/Ars": { hasTrustDialogAccepted: true } });
  try {
    const before = readFileSync(fx.claudeJson, "utf8");
    assert.equal(releaseSessionDirTrust({
      sessionDir: "E:/Document/Ars",
      sessionsRoot: fx.sessionsRoot,
      claudeJsonPath: fx.claudeJson,
    }), null);
    assert.equal(readFileSync(fx.claudeJson, "utf8"), before);

    writeFileSync(fx.claudeJson, "{broken");
    assert.equal(releaseSessionDirTrust({
      sessionDir: join(fx.sessionsRoot, "lictor-7777"),
      sessionsRoot: fx.sessionsRoot,
      claudeJsonPath: fx.claudeJson,
    }), null);
    assert.equal(readFileSync(fx.claudeJson, "utf8"), "{broken");
  } finally {
    fx.cleanup();
  }
});
