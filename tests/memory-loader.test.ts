import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cwdToProjectKey,
  findRepoMemories,
  renderMemoryDigest,
  repoLeafFromCwd,
} from "../src/memory-loader.js";

test("cwdToProjectKey encodes Windows path", () => {
  assert.equal(cwdToProjectKey("E:\\Document\\Ars"), "E--Document-Ars");
});

test("cwdToProjectKey encodes POSIX path", () => {
  assert.equal(cwdToProjectKey("/home/user/proj"), "-home-user-proj");
});

test("repoLeafFromCwd handles trailing slashes", () => {
  assert.equal(repoLeafFromCwd("E:\\Document\\Ars\\Lictor"), "Lictor");
  assert.equal(repoLeafFromCwd("/home/user/proj"), "proj");
});

test("findRepoMemories scores by filename + body", () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-mem-"));
  writeFileSync(join(dir, "MEMORY.md"), "index — skip me");
  writeFileSync(join(dir, "project_cernere.md"), "Cernere auth notes. Cernere is great.");
  writeFileSync(join(dir, "feedback_unrelated.md"), "no mention");
  writeFileSync(
    join(dir, "feedback_misc.md"),
    "talks about cernere once and other stuff",
  );

  const out = findRepoMemories(dir, "Cernere", 5);
  assert.equal(out.length, 2);
  // project_cernere.md wins (filename match + body matches)
  assert.equal(out[0].filename, "project_cernere.md");
  assert.equal(out[1].filename, "feedback_misc.md");

  rmSync(dir, { recursive: true, force: true });
});

test("findRepoMemories returns empty for missing dir", () => {
  const out = findRepoMemories(join(tmpdir(), "nope-" + Date.now()), "X", 3);
  assert.deepEqual(out, []);
});

test("renderMemoryDigest caps total bytes", () => {
  const big = "x".repeat(4 * 1024);
  const matches = [
    { filename: "a.md", body: big, score: 9 },
    { filename: "b.md", body: big, score: 8 },
    { filename: "c.md", body: big, score: 7 },
    { filename: "d.md", body: big, score: 6 },
  ];
  const digest = renderMemoryDigest(matches, 8 * 1024);
  assert.ok(Buffer.byteLength(digest, "utf8") <= 8 * 1024 + 200);
  assert.ok(digest.includes("more matches omitted"));
});

test("renderMemoryDigest returns empty string when no matches", () => {
  assert.equal(renderMemoryDigest([]), "");
});
