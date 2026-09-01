/**
 * SendUserFile (Claude Code のファイル送信ツール) を Discord へ中継するための純粋ロジック。
 *
 * なぜ中継が要るか:
 *   SendUserFile はローカル harness にファイルを渡すだけで、Lictor 経由の
 *   リモート (Discord) にいる人には何も届かない。 ツール自体は成功を返すため
 *   「送ったつもりで届いていない」 が無言で起きる。 PostToolUse hook で捕捉し、
 *   Concordia chat の attachment_paths へ載せ替えることで、セッションの Discord
 *   チャンネルに実ファイルとして現れるようにする。
 *
 * なぜ channel が "system" なのか:
 *   Concordia egress は chitchat / consultation / 報告 を meta チャンネルへ強制送出する
 *   (discord/egress.ts の forceMeta)。 セッション自身のチャンネルへ届けたいので、
 *   強制対象外の "system" を使う。 送信先 ID は sidecar が刻印する。
 *
 * node-pty 等に依存しない純粋ロジックのみを置き、sidecar / hook から利用する。
 */

/** Concordia chat の attachment_paths 上限 (api/chat.ts の zod スキーマと同じ)。 */
export const MAX_RELAY_FILES = 10;

export interface SendFileRelayInput {
  files: string[];
  caption?: string;
}

/**
 * PostToolUse hook の payload から中継対象を取り出す。
 * SendUserFile 以外・files が空・型不一致は null (= 中継しない)。
 */
export function extractSendFileRelay(input: unknown): SendFileRelayInput | null {
  if (!input || typeof input !== "object") return null;
  const record = input as { tool_name?: unknown; tool_input?: unknown };
  if (record.tool_name !== "SendUserFile") return null;
  const toolInput = record.tool_input;
  if (!toolInput || typeof toolInput !== "object") return null;
  const { files, caption } = toolInput as { files?: unknown; caption?: unknown };
  if (!Array.isArray(files)) return null;
  const paths = files.filter(
    (file): file is string => typeof file === "string" && isAbsoluteFilePath(file),
  );
  if (paths.length === 0) return null;
  return {
    files: paths.slice(0, MAX_RELAY_FILES),
    ...(typeof caption === "string" && caption.length > 0 ? { caption } : {}),
  };
}

/** hook と sidecar の OS が異なる場合もあるため POSIX / drive を明示判定する。 */
function isAbsoluteFilePath(filePath: string): boolean {
  if (/[\\/]$/.test(filePath) || /(^|[\\/])\.\.([\\/]|$)/.test(filePath)) return false;
  return /^\/(?!\/)/.test(filePath) || /^[A-Za-z]:[\\/]/.test(filePath);
}

/**
 * Discord へ出す本文。 添付だけだと何のファイルか分からないので、caption か
 * ファイル名の一覧を必ず本文に持たせる (Concordia chat は text 必須)。
 */
export function buildSendFileText(relay: SendFileRelayInput): string {
  const names = relay.files.map((file) => baseName(file)).join(" / ");
  const body = relay.caption ? `${relay.caption}\n${names}` : names;
  return truncate(body, 2000);
}

/**
 * 添付が Concordia に拒否された (許可ルート外など) ときに、代わりに出す本文。
 * 無言で消えると 「送ったのに届かない」 が再発するため、理由とファイル名を残す。
 * 絶対パスはユーザー名やローカル構成を漏らすため Discord へは出さない。
 */
export function buildSendFileFallbackText(relay: SendFileRelayInput, reason: string): string {
  const head = relay.caption ? `${relay.caption}\n` : "";
  const list = relay.files.map((file) => baseName(file)).join("\n");
  const body = `${head}添付を Discord へ送れませんでした (${reason})。対象ファイル:\n${list}`;
  return truncate(body, 2000);
}

/** 外部サービスの応答本文や URL を Discord へ漏らさない公開用の失敗理由。 */
export function describeSendFileRelayFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = /\bHTTP\s+(\d{3})\b/i.exec(message)?.[1];
  return status ? `attachment relay failed (HTTP ${status})` : "attachment relay failed";
}

/** パス区切りは OS 混在 (Windows パスを POSIX 側で扱う) ため両方を見る。 */
function baseName(filePath: string): string {
  if (/[\\/]$/.test(filePath)) return "unnamed file";
  const name = filePath.split(/[\\/]/).filter(Boolean).at(-1);
  return name && !/^[A-Za-z]:$/.test(name) ? name : "unnamed file";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
