#!/usr/bin/env node
/**
 * Lictor エントリ。 `dist/cli.js` を読むだけ … に加えて、 vendored 依存が
 * 未ビルドだった場合の自己修復を持つ。
 *
 * なぜここに置くか: vendored な `file:` 依存 (現状は `lib/vestigium`) の dist が
 * 無いと、 それを静的に import する経路は起動時に必ず落ちる。 そして npm のライフ
 * サイクルフックでは救えない — npm は file: 依存の reify (依存側 `prepare` の実行を含む)
 * を **ルートの preinstall/postinstall より先に** 完了させるため、 親側のどの
 * フックも「install の前に vendored 依存をビルドする」 用途には間に合わない
 * (2026-08-01 実測で確認)。
 *
 * 一方、 lictor への入口はこのファイル 1 点に収束する。 hook (`lictor cli ...`)
 * も wrapper 起動も必ずここを通るので、 ここで直せば全経路が救われる。
 *
 * 直前の実障害では、 この失敗が SessionStart hook を黙って殺し、 transcript の
 * 束縛が書かれず、 利用者から見える症状は 「Discord に返事が返らない」 だけだった。
 * 原因から遠い場所にしか出ない以上、 気づける形にするより自動で直すほうが速い。
 *
 * ただし Vestigium 自体はもうこの経路に来ない。 v0.7.0 以降 `src/vestigium.ts` が
 * dynamic import で縮退を吸収するため、 dist 欠落は ERR_MODULE_NOT_FOUND として
 * ここまで浮上せず、 観測が静かに落ちるだけになる (spec/setup/setup.md
 * §SETUP-VESTIGIUM-OPTIONAL)。 この自己修復は 「静的に import される vendored 依存」
 * 一般に対する保険として残す。 復旧は `npm run setup` が正道。
 *
 * @implements SETUP-VENDORED-BUILD (spec/setup/setup.md)
 */

const CLI = "../dist/cli.js";

try {
  await import(CLI);
} catch (error) {
  if (!isMissingVendoredDependency(error)) fail(error); // fail() は process.exit する
  console.error("[lictor] vendored 依存が未ビルドです。 ビルドして再試行します ...");
  await repairVendoredDependencies(error);
  // 再試行は 1 回だけ。 ここでも落ちるならビルドでは直らない。
  // query を付けて別 URL にするのは ESM ローダのモジュールマップ対策 —
  // 一度 link に失敗した URL は失敗したまま記憶されうるので、 素の再 import
  // だとビルドが成功しても同じ ERR_MODULE_NOT_FOUND が返る。
  try {
    await import(`${CLI}?vendored-repair=1`);
  } catch (retryError) {
    fail(retryError);
  }
}

/**
 * vendored 依存 (`@ludiars/*`) の解決失敗か。
 *
 * `dist/` 未生成と、 単に `npm run build` を忘れた場合 (= `dist/cli.js` 自体が
 * 無い) は原因も対処も違う。 後者をビルド対象と誤認しないよう `@ludiars` を
 * 含むものだけ自己修復に回す。
 *
 * scope 名の後ろを区切り文字で縛らないのは、 Node が報告するパスが OS 依存
 * だから — Windows では `@ludiars\vestigium\dist\index.js` と backslash で来る。
 * `@ludiars/` で照合すると Windows でだけ自己修復が発動しない (実測で判明)。
 */
function isMissingVendoredDependency(error) {
  return error?.code === "ERR_MODULE_NOT_FOUND"
    && typeof error.message === "string"
    && error.message.includes("@ludiars");
}

async function repairVendoredDependencies(originalError) {
  try {
    const { VENDORED_PACKAGES, buildVendoredPackage } =
      await import("../scripts/build-vendored-deps.mjs");
    // force: 解決に失敗している以上 dist は当てにならない。 mtime 比較で
    // 「ビルド済み」 と誤判定して何もせず再試行するのが最悪の分岐なので潰す。
    for (const packageDir of VENDORED_PACKAGES) {
      buildVendoredPackage(packageDir, { force: true });
    }
  } catch (buildError) {
    console.error("[lictor] vendored 依存のビルドに失敗しました:", buildError.message);
    console.error("[lictor] 手動で: git submodule update --init && npm install --include=dev");
    fail(originalError);
  }
}

function fail(error) {
  console.error("[lictor] failed to load CLI:", error.message);
  console.error("[lictor] did you run `npm run build`? for dev use `npm run dev -- ...`");
  process.exit(1);
}
