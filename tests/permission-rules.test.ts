import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPermissionLayers,
  matchPermissionRule,
  ruleMatches,
  splitCommandSegments,
  type PermissionRuleLayer,
} from "../src/permission-rules.js";
import { detectEvasion } from "../src/permission-evasion.js";
import { summarizeAudit, groupKey, parseAuditLines } from "../src/permission-audit-report.js";

function layer(overrides: Partial<PermissionRuleLayer>): PermissionRuleLayer {
  return { source: "test", allow: [], deny: [], ask: [], ...overrides };
}

test("ruleMatches: Bash の prefix 規則", () => {
  assert.equal(ruleMatches("Bash(git:*)", "Bash", { command: "git status" }), true);
  assert.equal(ruleMatches("Bash(git:*)", "Bash", { command: "gitk" }), false);
  assert.equal(ruleMatches("Bash(git:*)", "Bash", { command: "git" }), true);
  // ツールが違えば当たらない。
  assert.equal(ruleMatches("Bash(git:*)", "Write", { command: "git status" }), false);
  // specifier 無しはツール全体。
  assert.equal(ruleMatches("Bash", "Bash", { command: "anything" }), true);
});

test("ruleMatches: 連結コマンドは全区間が当たったときだけ当たる", () => {
  assert.equal(ruleMatches("Bash(git:*)", "Bash", { command: "git add . && git commit -m x" }), true);
  // 後段が規則外 — allow 済みとは言えない。
  assert.equal(ruleMatches("Bash(git:*)", "Bash", { command: "git add . && rm -rf build" }), false);
  assert.deepEqual(splitCommandSegments("a && b ; c | d"), ["a", "b", "c", "d"]);
});

test("ruleMatches: ファイル系はパス指定で当たる", () => {
  assert.equal(ruleMatches("Write(src/**)", "Write", { file_path: "src/a/b.ts" }), true);
  assert.equal(ruleMatches("Write(src/**)", "Write", { file_path: "tests/a.ts" }), false);
  assert.equal(ruleMatches("Read(//E:/tmp)", "Read", { file_path: "E:/tmp/x.txt" }), true);
});

test("matchPermissionRule: deny > ask > allow", () => {
  const layers = [
    layer({ allow: ["Bash(gh:*)"], deny: ["Bash(gh pr merge:*)"], ask: ["Bash(gh pr create:*)"] }),
  ];
  assert.equal(matchPermissionRule(layers, "Bash", { command: "gh pr list" })?.effect, "allow");
  assert.equal(matchPermissionRule(layers, "Bash", { command: "gh pr merge 1" })?.effect, "deny");
  assert.equal(matchPermissionRule(layers, "Bash", { command: "gh pr create" })?.effect, "ask");
  // どの規則にも載っていない = null (設定漏れ候補として監査に残る)。
  assert.equal(matchPermissionRule(layers, "Bash", { command: "curl example.com" }), null);
});

test("loadPermissionLayers: cwd から上位の .claude/settings*.json を集める", () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-rules-"));
  const deep = join(root, "repo", "src");
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(join(root, "repo", ".claude"), { recursive: true });
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }));
  writeFileSync(
    join(root, "repo", ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
  );
  try {
    const layers = loadPermissionLayers(deep, join(root, "no-home"));
    assert.equal(layers.length, 2);
    // 近い層が先。
    assert.ok(layers[0].source.includes("settings.local.json"));
    assert.equal(matchPermissionRule(layers, "Bash", { command: "rm -rf x" })?.effect, "deny");
    assert.equal(matchPermissionRule(layers, "Bash", { command: "git status" })?.effect, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectEvasion: prefix 規則を素通りしうる形に印を付ける", () => {
  assert.deepEqual(detectEvasion("git status").map((f) => f.code), []);
  const wrapped = detectEvasion('bash -c "git status; rm -rf build"').map((f) => f.code);
  assert.ok(wrapped.includes("shell-wrapper"));
  assert.ok(wrapped.includes("chained"));
  assert.ok(detectEvasion("echo $(whoami)").map((f) => f.code).includes("substitution"));
  assert.ok(detectEvasion("FOO=1 npm test").map((f) => f.code).includes("env-prefix"));
});

test("summarizeAudit: 規則に当たらないまま自動で通ったものを数える", () => {
  const raw = [
    { tool: "Bash", summary: "curl example.com", outcome: "auto-allowed", rule: null, evasion: [] },
    { tool: "Bash", summary: "curl other.com", outcome: "auto-allowed", rule: null, evasion: [] },
    {
      tool: "Bash",
      summary: "git status",
      outcome: "auto-allowed",
      rule: { effect: "allow", rule: "Bash(git:*)", source: "s" },
      evasion: [],
    },
    { tool: "Bash", summary: "bash -c x", outcome: "prompted", rule: null, evasion: ["shell-wrapper"] },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  const summary = summarizeAudit(parseAuditLines(raw));
  assert.equal(summary.total, 4);
  assert.equal(summary.autoAllowed, 3);
  assert.equal(summary.prompted, 1);
  assert.equal(summary.unruled.length, 1);
  // 引数違いは同じコマンドとして数える (漏れ候補は「何が何回通ったか」で読む)。
  assert.equal(summary.unruled[0].key, "curl");
  assert.equal(summary.unruled[0].count, 2);
  assert.equal(groupKey({ tool: "Bash", summary: "git status" } as never), "git status");
  assert.equal(summary.evasive.length, 1);
  assert.equal(groupKey({ tool: "Write", summary: "src/a.ts" } as never), "Write");
});
