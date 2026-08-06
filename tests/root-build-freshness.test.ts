import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs startup script, no type declarations.
import { ensureRootBuildFresh, isRootBuildFresh } from "../scripts/ensure-root-build.mjs";

function touch(path: string, contents: string, epochSeconds: number): void {
  writeFileSync(path, contents);
  utimesSync(path, epochSeconds, epochSeconds);
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "lictor-root-build-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("root source newer than dist is not fresh", () => {
  withRoot((root) => {
    touch(join(root, "dist", "cli.js"), "export {};", 1_000);
    touch(join(root, "src", "cli.ts"), "export {};", 2_000);
    assert.equal(isRootBuildFresh(root), false);
  });
});

test("stale root build is refreshed before startup", () => {
  withRoot((root) => {
    touch(join(root, "dist", "cli.js"), "export {};", 1_000);
    touch(join(root, "src", "cli.ts"), "export {};", 2_000);
    const built = ensureRootBuildFresh(root, {
      build: (target: string) => touch(join(target, "dist", "cli.js"), "export {};", 3_000),
    });
    assert.equal(built, true);
    assert.equal(isRootBuildFresh(root), true);
  });
});

test("fresh root build is left untouched", () => {
  withRoot((root) => {
    touch(join(root, "src", "cli.ts"), "export {};", 1_000);
    touch(join(root, "dist", "cli.js"), "export {};", 2_000);
    let buildCalls = 0;
    const built = ensureRootBuildFresh(root, { build: () => { buildCalls += 1; } });
    assert.equal(built, false);
    assert.equal(buildCalls, 0);
  });
});
