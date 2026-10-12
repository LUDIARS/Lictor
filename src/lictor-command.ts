// Claude の hook から Lictor 自身を呼ぶときのコマンド前置き。
//
// hook は Claude が shell (Windows では Git Bash) で実行する。 素の `lictor` は PATH に
// lictor が通っている PC でしか動かない。 Lictor を `node …/bin/lictor.mjs` で起動する拠点
// (MELPOT 2026-10-12: Concordia の内部エージェントとして起動) では SessionStart hook が
// `lictor: command not found` (exit 127) で黙って失敗し、 transcript の束縛が書かれず、
// 返答が Concordia にも Discord にも一切届かなかった。
//
// いま動いている node と、 このビルドの bin/lictor.mjs を絶対パスで指す。 bin が見つからない
// (ソースを直接実行しているテスト等) ときだけ従来の `lictor` に戻す。

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** shell に渡すパス: 区切りを `/` にそろえて二重引用符で囲む (空白を含む Program Files 等に耐える)。 */
export function quoteForHookShell(path: string): string {
  return `"${path.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

/** node と bin/lictor.mjs の絶対パスからコマンド前置きを作る。 bin が無ければ `lictor`。 */
export function buildLictorCommand(nodePath: string, binPath: string | null): string {
  if (!binPath || !nodePath) return "lictor";
  return `${quoteForHookShell(nodePath)} ${quoteForHookShell(binPath)}`;
}

/** このビルド (dist/ または src/) から見た bin/lictor.mjs。 無ければ null。 */
export function resolveLictorBin(moduleUrl: string = import.meta.url): string | null {
  try {
    const bin = fileURLToPath(new URL("../bin/lictor.mjs", moduleUrl));
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** 実行中の Lictor を hook から呼ぶコマンド前置き。 */
export function currentLictorCommand(): string {
  return buildLictorCommand(process.execPath, resolveLictorBin());
}
