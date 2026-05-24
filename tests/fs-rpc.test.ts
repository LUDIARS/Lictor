import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSafe, fsRead, fsList, fsGrep } from "../src/fs-rpc.js";

function setupCwd(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "lictor-fs-"));
  mkdirSync(join(cwd, "sub"));
  writeFileSync(join(cwd, "hello.txt"), "hi\nworld\n");
  writeFileSync(join(cwd, "sub/inner.txt"), "needle\n");
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("resolveSafe accepts relative path inside cwd", () => {
  const { cwd, cleanup } = setupCwd();
  try {
    const out = resolveSafe(cwd, "sub/inner.txt");
    assert.equal(typeof out, "string");
  } finally { cleanup(); }
});

test("resolveSafe rejects parent escape", () => {
  const { cwd, cleanup } = setupCwd();
  try {
    const out = resolveSafe(cwd, "../outside");
    assert.ok(typeof out === "object" && "error" in out, "expected error");
  } finally { cleanup(); }
});

test("resolveSafe rejects absolute paths", () => {
  const { cwd, cleanup } = setupCwd();
  try {
    const out = resolveSafe(cwd, "/etc/passwd");
    assert.ok(typeof out === "object" && "error" in out);
  } finally { cleanup(); }
});

test("resolveSafe rejects null byte", () => {
  const { cwd, cleanup } = setupCwd();
  try {
    const out = resolveSafe(cwd, "evil\x00name");
    assert.ok(typeof out === "object" && "error" in out);
  } finally { cleanup(); }
});

test("fsRead returns content + bytes", () => {
  const { cwd, cleanup } = setupCwd();
  try {
    const out = fsRead(cwd, "hello.txt");
    if ("error" in out) throw new Error(out.error);
    assert.equal(out.content, "hi\nworld\n");
    assert.equal(out.bytes, 9);
    assert.equal(out.truncated, false);
  } finally { cleanup(); }
});

test("fsList dirs first then files, alphabetical", () => {
  const { cwd, cleanup } = setupCwd();
  try {
    const out = fsList(cwd, ".");
    if ("error" in out) throw new Error(out.error);
    const names = out.entries.map((e) => e.name);
    // sub (dir) before hello.txt (file)
    assert.deepEqual(names, ["sub", "hello.txt"]);
    assert.equal(out.entries[0].is_dir, true);
    assert.equal(out.entries[1].is_dir, false);
  } finally { cleanup(); }
});

test("fsGrep finds matches and reports file count", () => {
  const { cwd, cleanup } = setupCwd();
  try {
    const out = fsGrep(cwd, "needle");
    if ("error" in out) throw new Error(out.error);
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0].file.replace(/\\/g, "/"), "sub/inner.txt");
    assert.equal(out.hits[0].line, 1);
    assert.ok(out.files_scanned >= 2);
  } finally { cleanup(); }
});

test("fsGrep rejects invalid regex", () => {
  const { cwd, cleanup } = setupCwd();
  try {
    const out = fsGrep(cwd, "[unclosed");
    assert.ok("error" in out);
  } finally { cleanup(); }
});

test("fsGrep skips node_modules / .git", () => {
  const { cwd, cleanup } = setupCwd();
  try {
    mkdirSync(join(cwd, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(cwd, "node_modules/pkg/index.js"), "needle\n");
    const out = fsGrep(cwd, "needle");
    if ("error" in out) throw new Error(out.error);
    // only sub/inner.txt match — node_modules skipped
    assert.equal(out.hits.length, 1);
  } finally { cleanup(); }
});
