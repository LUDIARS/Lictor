/**
 * vendored 依存 (`lib/vestigium`) をビルドする。 呼ばれるのは 2 経路 —
 * `npm run setup` (手動) と `bin/lictor.mjs` の自己修復。 npm の
 * postinstall には **載せていない** (下記の通りフックでは間に合わない)。
 *
 * なぜ必要か: `@ludiars/vestigium` は `file:./lib/vestigium` 依存なので、
 * npm は node_modules に **symlink を張るだけ** でビルドはしない。 submodule を
 * checkout しただけの状態は `dist/` が無く、 `main` が指す `dist/index.js` を
 * 解決できないため `lictor cli` が起動時に全滅する。
 *
 * その影響は遠い場所に出る。 SessionStart hook (`lictor cli session-id-hook`) が
 * transcript の束縛を書けなくなり、 tail 対象が無いまま session が動き、 症状は
 * 「Discord に返事が返らない」 という形でしか観測できない (2026-08-01 実障害)。
 * 検知が難しい以上、 起動のたびに機械的に潰すのが唯一まともな統制になる。
 *
 * @implements SETUP-VENDORED-BUILD (spec/setup/setup.md)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** ビルド対象の vendored 依存。 増えたらここに足す。 */
export const VENDORED_PACKAGES = [join(repoRoot, "lib", "vestigium")];

// import 時に副作用を起こさない (helper を tests から直接叩けるようにするため)。
if (isMainModule()) {
  for (const packageDir of VENDORED_PACKAGES) {
    buildVendoredPackage(packageDir);
  }
}

/**
 * `node scripts/build-vendored-deps.mjs` として直接起動されたか。
 * ここを誤って false 側に倒すと `npm run setup` が黙って何もしなくなる —
 * まさにこのスクリプトが潰したい失敗モードなので、 Windows の
 * ドライブレター / 大文字小文字ゆれまで吸収して比較する。
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  const normalize = (path) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url));
}

export function buildVendoredPackage(packageDir, { force = false } = {}) {
  const label = `lib/${packageDir.split(/[\\/]/).pop()}`;

  if (!existsSync(join(packageDir, "package.json"))) {
    // submodule 未取得。 ここでは直せないので指示だけ出して先へ進む
    // (install 自体を失敗させると submodule 取得前の clone で詰む)。
    warn(`${label} が見つかりません。 \`git submodule update --init\` を実行してください。`);
    return;
  }

  if (!shouldBuild(packageDir, { force })) return;

  console.log(`[lictor] building ${label} ...`);
  runNpm(["install", "--include=dev", "--no-audit", "--no-fund"], packageDir, label);
  runNpm(["run", "build"], packageDir, label);
}

/**
 * ビルドを回すべきか。 `force` は入口 (bin/lictor.mjs) の自己修復用 —
 * そこに来た時点で dist は解決できないと分かっているので、 mtime 比較で
 * skip すると 「ビルドしたと言って何もせず同じエラーで落ちる」 に化ける。
 */
export function shouldBuild(packageDir, { force = false } = {}) {
  return force || !isUpToDate(packageDir);
}

/** `dist/index.js` が全 `src` ファイルより新しければビルド済みとみなす。 */
export function isUpToDate(packageDir) {
  const entry = join(packageDir, "dist", "index.js");
  if (!existsSync(entry)) return false;
  const builtAt = statSync(entry).mtimeMs;
  return newestMtime(join(packageDir, "src")) <= builtAt;
}

export function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(child) : statSync(child).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function runNpm(args, cwd, label) {
  const result = spawnSync(npmCommand(), args, {
    cwd,
    stdio: "inherit",
    // Windows の npm は `npm.cmd` (バッチ) なので shell 経由でしか起動できない
    // (Node 20.12+ / 22 は shell:false での .cmd 起動を EINVAL で弾く)。
    // 渡す引数はすべてこのファイル内のリテラルなので shell 展開の危険は無い。
    shell: process.platform === "win32",
    // 親シェルが NODE_ENV=production だと devDependencies (typescript) が落ちて
    // tsc が見つからない。 vendored ビルドは常に dev 前提で回す。
    env: { ...process.env, NODE_ENV: "development" },
  });
  if (result.error) {
    throw new Error(`[lictor] ${label}: npm ${args.join(" ")} を起動できません`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(`[lictor] ${label}: npm ${args.join(" ")} failed (${reason})`);
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function warn(message) {
  process.stderr.write(`[lictor] warning: ${message}\n`);
}
