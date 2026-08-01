import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs build script, no type declarations.
import { isUpToDate, newestMtime, shouldBuild } from "../scripts/build-vendored-deps.mjs";

/** mtime を秒精度で固定する (ファイル生成順に依存しないため)。 */
function touch(path: string, contents: string, epochSeconds: number): void {
  writeFileSync(path, contents);
  utimesSync(path, epochSeconds, epochSeconds);
}

function withPackageDir(fn: (packageDir: string) => void): void {
  const packageDir = mkdtempSync(join(tmpdir(), "lictor-vendored-"));
  try {
    mkdirSync(join(packageDir, "src", "nested"), { recursive: true });
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    fn(packageDir);
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }
}

test("isUpToDate is false when dist/index.js is missing", () => {
  withPackageDir((packageDir) => {
    touch(join(packageDir, "src", "index.ts"), "export {};", 1_000);
    assert.equal(isUpToDate(packageDir), false);
  });
});

test("isUpToDate is true when dist is newer than every src file", () => {
  withPackageDir((packageDir) => {
    touch(join(packageDir, "src", "index.ts"), "export {};", 1_000);
    touch(join(packageDir, "src", "nested", "a.ts"), "export {};", 1_500);
    touch(join(packageDir, "dist", "index.js"), "export {};", 2_000);
    assert.equal(isUpToDate(packageDir), true);
  });
});

test("isUpToDate is false when a nested src file is newer than dist", () => {
  withPackageDir((packageDir) => {
    touch(join(packageDir, "src", "index.ts"), "export {};", 1_000);
    touch(join(packageDir, "dist", "index.js"), "export {};", 2_000);
    // 深い階層の編集も検知できないと 「dist が古いまま」 の再発を招く。
    touch(join(packageDir, "src", "nested", "a.ts"), "export {};", 3_000);
    assert.equal(isUpToDate(packageDir), false);
  });
});

test("shouldBuild skips an up-to-date package unless force is set", () => {
  withPackageDir((packageDir) => {
    touch(join(packageDir, "src", "index.ts"), "export {};", 1_000);
    touch(join(packageDir, "dist", "index.js"), "export {};", 2_000);
    assert.equal(shouldBuild(packageDir), false);
    // 自己修復経路は dist を信用できない。 ここが true でないと
    // 「ビルドしたと言いながら何もせず同じエラーで落ちる」 に戻る。
    assert.equal(shouldBuild(packageDir, { force: true }), true);
  });
});

test("newestMtime returns 0 for a missing directory", () => {
  withPackageDir((packageDir) => {
    assert.equal(newestMtime(join(packageDir, "does-not-exist")), 0);
  });
});

test("importing the script does not build anything", async () => {
  // top-level 副作用があると test 実行だけで npm install が走ってしまう。
  const mod = await import("../scripts/build-vendored-deps.mjs");
  assert.equal(typeof mod.buildVendoredPackage, "function");
});
