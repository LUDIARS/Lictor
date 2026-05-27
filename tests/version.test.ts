import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LICTOR_NAME, LICTOR_VERSION } from "../src/version.js";

test("LICTOR_VERSION matches package.json", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  assert.equal(LICTOR_VERSION, pkg.version);
});

test("LICTOR_VERSION is non-empty semver-ish", () => {
  assert.notEqual(LICTOR_VERSION, "");
  // Loose semver check — major.minor.patch with optional prerelease/build.
  assert.match(LICTOR_VERSION, /^\d+\.\d+\.\d+([-+].*)?$/);
});

test("LICTOR_NAME is 'lictor'", () => {
  assert.equal(LICTOR_NAME, "lictor");
});
