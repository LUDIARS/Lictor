/**
 * Keep the root TypeScript build aligned with a source checkout before Lictor
 * imports its long-running CLI. Published dist-only packages are accepted as-is;
 * a checkout containing src/ must never silently execute an older ignored dist/.
 *
 * @implements SETUP-ROOT-BUILD-FRESHNESS (spec/setup/setup.md)
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newestMtime } from "./build-vendored-deps.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A dist-only published package has no local source freshness contract. */
export function isRootBuildFresh(root = repoRoot) {
  const sourceDir = join(root, "src");
  const entry = join(root, "dist", "cli.js");
  if (!existsSync(sourceDir)) return existsSync(entry);
  if (!existsSync(entry)) return false;
  return newestMtime(sourceDir) <= statSync(entry).mtimeMs;
}

/**
 * Build once when a source checkout is newer than dist/. Returns true only when
 * this invocation performed the build. The injectable builder keeps the policy
 * deterministic without spawning a compiler in its unit tests.
 */
export function ensureRootBuildFresh(root = repoRoot, { build = buildRootPackage } = {}) {
  if (isRootBuildFresh(root)) return false;
  if (!existsSync(join(root, "src"))) {
    throw new Error("[lictor] dist/cli.js is missing from a dist-only installation");
  }

  process.stderr.write("[lictor] root dist is stale; rebuilding before startup ...\n");
  build(root);
  if (!isRootBuildFresh(root)) {
    throw new Error("[lictor] root build completed but dist/cli.js is still stale");
  }
  return true;
}

export function buildRootPackage(root) {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    throw new Error("[lictor] root dist is stale and local TypeScript is unavailable; run npm install");
  }
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw new Error("[lictor] failed to start the root TypeScript build", { cause: result.error });
  }
  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(`[lictor] root TypeScript build failed (${reason})`);
  }
}
