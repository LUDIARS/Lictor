/**
 * SessionStart hook へ transcript state directory の正本を渡すための内部 CLI 引数。
 *
 * hook command は shell 経由で実行されるため、path を直接 quote しない。UTF-8 の
 * base64url にすると空白・backslash・shell metacharacter を含む Windows path でも
 * 引数が一語に保たれる。
 */

const STATE_DIR_ARG = "--state-dir-b64";
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function encodeSessionStateDirArgument(stateDir: string): string {
  const encoded = Buffer.from(stateDir, "utf8").toString("base64url");
  return `${STATE_DIR_ARG} ${encoded}`;
}

export function decodeSessionStateDirArgument(args: readonly string[]): string | null {
  const index = args.indexOf(STATE_DIR_ARG);
  if (index < 0) return null;
  const encoded = args[index + 1] ?? "";
  if (!encoded || !BASE64URL_RE.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  return decoded || null;
}
