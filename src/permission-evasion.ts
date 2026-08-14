/**
 * settings.json の prefix 規則を素通りしうる形の検出 (監査用)。
 *
 * `Bash(git:*)` のような prefix 規則は先頭一致でしか見ないので、
 * `bash -c "git ... ; rm ..."` のようにシェルを一段挟むと、 規則の意図と
 * 実行内容がずれる。 ここではその「ずれうる形」 に印を付けるだけで、
 * 実行を止めたり許可判断を変えたりはしない (判断は Claude 側の正本)。
 */

export interface EvasionFlag {
  code: string;
  /** 監査ログを読む人向けの一行説明 (日本語)。 */
  note: string;
}

interface EvasionRule {
  code: string;
  note: string;
  pattern: RegExp;
}

const RULES: EvasionRule[] = [
  { code: "shell-wrapper", note: "シェルを一段挟むため prefix 規則の対象がずれる", pattern: /(^|\s)(bash|sh|zsh|cmd(\.exe)?|powershell(\.exe)?|pwsh)\s+(-c|\/c|-Command)\b/i },
  { code: "chained", note: "複数コマンドの連結 — 後段が規則に載っていない可能性がある", pattern: /(&&|\|\||;|\s\|\s)/ },
  { code: "substitution", note: "コマンド置換で実行内容が静的に読めない", pattern: /\$\(|`/ },
  { code: "eval", note: "eval / xargs 経由の間接実行", pattern: /(^|\s)(eval|xargs)\b/ },
  { code: "env-prefix", note: "環境変数代入が先頭にあり prefix 一致が外れる", pattern: /^\s*[A-Za-z_][A-Za-z0-9_]*=/ },
  { code: "path-qualified", note: "パス修飾された実行ファイル — コマンド名の規則に当たらない", pattern: /(^|\s)(\.{1,2}\/|[A-Za-z]:[\\/])\S*(node|npm|npx|python|git)\b/i },
];

/** Bash 相当のコマンド文字列から迂回フラグを列挙する。 */
export function detectEvasion(command: unknown): EvasionFlag[] {
  if (typeof command !== "string" || command.trim() === "") return [];
  const flags: EvasionFlag[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(command)) flags.push({ code: rule.code, note: rule.note });
  }
  return flags;
}
