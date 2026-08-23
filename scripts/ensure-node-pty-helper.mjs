import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * npm の install-script policy / --ignore-scripts で node-pty の chmod が走らないと、
 * macOS では native addon 自体を読めても spawn-helper の実行が EACCES になり、
 * 利用側には情報量のない `posix_spawnp failed` だけが返る。
 */
export function ensureNodePtySpawnHelperExecutable({
  platform = process.platform,
  arch = process.arch,
  root = repoRoot,
} = {}) {
  if (platform !== "darwin") return false;
  const helper = join(
    root,
    "node_modules",
    "node-pty",
    "prebuilds",
    `darwin-${arch}`,
    "spawn-helper",
  );
  if (!existsSync(helper)) return false;
  const mode = statSync(helper).mode;
  if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
  return true;
}
