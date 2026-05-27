import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Lictor の package.json から `version` を 1 度だけ読んで公開する。
 * `--version` / `lictor cli version` / `GET /v1/version` / Concordia 登録 etc
 * の単一情報源にする。
 *
 * src/ から実行 (tsx) でも dist/ から実行でも、 package.json は常に
 * `<repo>/package.json` (= `import.meta.url` の 1 つ上のディレクトリ) にある。
 * 読み取り失敗時は "0.0.0-unknown" を返してプロセスを落とさない (CLI で
 * --version を投げただけで死ぬのは不便なので)。
 */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0-unknown";
}

export const LICTOR_VERSION = readVersion();
export const LICTOR_NAME = "lictor";
