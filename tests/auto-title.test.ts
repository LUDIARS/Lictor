import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAutoTitle } from "../src/auto-title.js";
import type { RepoStat } from "../src/stat.js";

const baseStat: RepoStat = {
  repo_path: "E:/Document/Ars/Cernere",
  branch: "feat/auth-fix",
  dirty: false,
  staged_count: 0,
  unstaged_count: 0,
  untracked_count: 0,
  unpushed_count: 0,
  last_commit: null,
  upstream: "origin/feat/auth-fix",
  gathered_at: "2026-05-24T00:00:00Z",
};

test("auto title: persona + repo leaf + branch", () => {
  const out = buildAutoTitle({
    persona: { name: "境野 詰" },
    roleLabel: "テスト魂 / 境野 詰",
    stat: baseStat,
    cwd: baseStat.repo_path,
  });
  assert.equal(out, "[テスト魂 / 境野 詰] Cernere · feat/auth-fix");
});

test("auto title: dirty + unpushed marks", () => {
  const out = buildAutoTitle({
    persona: null,
    roleLabel: null,
    stat: { ...baseStat, dirty: true, unpushed_count: 3 },
    cwd: baseStat.repo_path,
  });
  assert.equal(out, "Cernere · feat/auth-fix ●↑3");
});

test("auto title: cwd fallback when stat is null", () => {
  const out = buildAutoTitle({
    persona: null,
    roleLabel: null,
    stat: null,
    cwd: "E:/Document/Ars/Lictor",
  });
  assert.equal(out, "Lictor");
});

test("auto title: persona role only", () => {
  const out = buildAutoTitle({
    persona: { role: "designer" },
    roleLabel: null,
    stat: baseStat,
    cwd: baseStat.repo_path,
  });
  assert.equal(out, "[designer] Cernere · feat/auth-fix");
});

test("auto title: empty everything yields empty string", () => {
  const out = buildAutoTitle({ persona: null, roleLabel: null, stat: null, cwd: "" });
  assert.equal(out, "");
});

test("auto title: long role label is clipped", () => {
  const long = "とても長いロール名 / 長い名前さん 山田太郎右衛門";
  const out = buildAutoTitle({
    persona: null,
    roleLabel: long,
    stat: baseStat,
    cwd: baseStat.repo_path,
  });
  // 24-char clip, last char replaced by "…"
  assert.match(out, /^\[.{1,24}\] Cernere · feat\/auth-fix$/);
  assert.ok(out.includes("…"));
});

test("auto title: HEAD branch is suppressed", () => {
  const out = buildAutoTitle({
    persona: null,
    roleLabel: null,
    stat: { ...baseStat, branch: "HEAD" },
    cwd: baseStat.repo_path,
  });
  assert.equal(out, "Cernere");
});
