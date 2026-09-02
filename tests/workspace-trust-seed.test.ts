import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectMcpServerNames,
  normalizeProjectKey,
  seedWorkspaceTrust,
  shouldSeedWorkspaceTrust,
} from "../src/workspace-trust-seed.js";

// claude 2.1.x の trust picker は既定が「No, exit」で、画面キーの自動承認は
// 取りこぼし = 即終了になる。spawn 前の ~/.claude.json 事前登録が本線。

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lictor-trust-seed-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("shouldSeedWorkspaceTrust: enrollment 付き detached Claude spawn だけを許可する", () => {
  const eligible = {
    hasRegisteredConcordiaSession: true,
    hasSpawnCredential: true,
    isInputTTY: false,
    providerName: "claude",
  };
  assert.equal(shouldSeedWorkspaceTrust(eligible), true);
  assert.equal(shouldSeedWorkspaceTrust({ ...eligible, hasRegisteredConcordiaSession: false }), false);
  assert.equal(shouldSeedWorkspaceTrust({ ...eligible, hasSpawnCredential: false }), false);
  assert.equal(shouldSeedWorkspaceTrust({ ...eligible, isInputTTY: true }), false);
  assert.equal(shouldSeedWorkspaceTrust({ ...eligible, providerName: "codex" }), false);
});

test("seedWorkspaceTrust: trust を焼き、未承認の上位 project MCP は無効化する", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const projectDir = join(root, "Ars", "September");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(root, "Ars", ".mcp.json"), JSON.stringify({
      mcpServers: { excubitor: {} },
    }));
    const claudeJson = join(root, ".claude.json");
    writeFileSync(claudeJson, JSON.stringify({ projects: {} }));

    const result = seedWorkspaceTrust({ cwd: projectDir, claudeJsonPath: claudeJson });
    assert.ok(result);
    assert.equal(result.trustGranted, true);
    assert.equal(result.disabledServerCount, 1);

    const saved = JSON.parse(readFileSync(claudeJson, "utf8"));
    const entry = saved.projects[normalizeProjectKey(projectDir)];
    assert.equal(entry.hasTrustDialogAccepted, true);
    assert.deepEqual(entry.disabledMcpjsonServers, ["excubitor"]);
  } finally {
    cleanup();
  }
});

test("seedWorkspaceTrust: 既存 entry と人間が判断済みの MCP 設定を尊重する", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const projectDir = join(root, "Proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({
      mcpServers: { alpha: {}, beta: {}, gamma: {} },
    }));
    const claudeJson = join(root, ".claude.json");
    const backslashKey = normalizeProjectKey(projectDir).replace(/\//g, "\\");
    writeFileSync(claudeJson, JSON.stringify({
      projects: {
        [backslashKey]: {
          hasTrustDialogAccepted: false,
          enabledMcpjsonServers: ["alpha"],
          disabledMcpjsonServers: ["beta"],
          keepMe: 1,
        },
      },
    }));

    const result = seedWorkspaceTrust({ cwd: projectDir, claudeJsonPath: claudeJson });
    assert.ok(result);
    assert.equal(result.disabledServerCount, 1);

    const saved = JSON.parse(readFileSync(claudeJson, "utf8"));
    const keys = Object.keys(saved.projects);
    assert.equal(keys.length, 1, "表記ゆれの別 entry を増やさない");
    const entry = saved.projects[backslashKey];
    assert.equal(entry.hasTrustDialogAccepted, true);
    assert.deepEqual(entry.enabledMcpjsonServers, ["alpha"]);
    assert.deepEqual(entry.disabledMcpjsonServers, ["beta", "gamma"]);
    assert.equal(entry.keepMe, 1, "既存フィールドを壊さない");
  } finally {
    cleanup();
  }
});

test("seedWorkspaceTrust: claude.json が無い / 壊れている環境では何もしない", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const projectDir = join(root, "Proj");
    mkdirSync(projectDir, { recursive: true });
    assert.equal(
      seedWorkspaceTrust({ cwd: projectDir, claudeJsonPath: join(root, "missing.json") }),
      null,
    );
    const broken = join(root, "broken.json");
    writeFileSync(broken, "{not json");
    assert.equal(seedWorkspaceTrust({ cwd: projectDir, claudeJsonPath: broken }), null);
    assert.equal(readFileSync(broken, "utf8"), "{not json", "壊れたファイルを上書きしない");
  } finally {
    cleanup();
  }
});

test("seedWorkspaceTrust: projects / entry の型が壊れている設定は上書きしない", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const projectDir = join(root, "Proj");
    mkdirSync(projectDir, { recursive: true });
    const claudeJson = join(root, ".claude.json");
    for (const projects of [[], "invalid"]) {
      const original = JSON.stringify({ projects });
      writeFileSync(claudeJson, original);
      assert.equal(seedWorkspaceTrust({ cwd: projectDir, claudeJsonPath: claudeJson }), null);
      assert.equal(readFileSync(claudeJson, "utf8"), original);
    }

    const projectKey = normalizeProjectKey(projectDir);
    const original = JSON.stringify({ projects: { [projectKey]: null } });
    writeFileSync(claudeJson, original);
    assert.equal(seedWorkspaceTrust({ cwd: projectDir, claudeJsonPath: claudeJson }), null);
    assert.equal(readFileSync(claudeJson, "utf8"), original);

    const malformedList = JSON.stringify({
      projects: { [projectKey]: { enabledMcpjsonServers: ["valid", 1] } },
    });
    writeFileSync(claudeJson, malformedList);
    assert.equal(seedWorkspaceTrust({ cwd: projectDir, claudeJsonPath: claudeJson }), null);
    assert.equal(readFileSync(claudeJson, "utf8"), malformedList);
  } finally {
    cleanup();
  }
});

test("seedWorkspaceTrust: 変更が無ければ書き込まない (冪等)", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const projectDir = join(root, "Proj");
    mkdirSync(projectDir, { recursive: true });
    const claudeJson = join(root, ".claude.json");
    writeFileSync(claudeJson, JSON.stringify({
      projects: { [normalizeProjectKey(projectDir)]: { hasTrustDialogAccepted: true } },
    }));
    let writes = 0;
    const fsApi = {
      existsSync,
      readFileSync,
      writeFileSync: ((...args: Parameters<typeof writeFileSync>) => {
        writes += 1;
        return writeFileSync(...args);
      }) as typeof writeFileSync,
    };
    const result = seedWorkspaceTrust({ cwd: projectDir, claudeJsonPath: claudeJson, fsApi });
    assert.ok(result);
    assert.equal(writes, 0);
  } finally {
    cleanup();
  }
});

test("collectMcpServerNames: cwd と上位ディレクトリの .mcp.json を両方拾う", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const projectDir = join(root, "a", "b");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(root, "a", ".mcp.json"), JSON.stringify({ mcpServers: { upper: {} } }));
    writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { lower: {} } }));
    assert.deepEqual(collectMcpServerNames(projectDir), ["lower", "upper"]);
  } finally {
    cleanup();
  }
});

test("collectMcpServerNames: mcpServers が object でない設定は無視する", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: ["not-a-server-name"] }));
    assert.deepEqual(collectMcpServerNames(root), []);
  } finally {
    cleanup();
  }
});
