import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:0ee25d6c */
import augurContract_e3b49989 from './contracts/chat-input.contract.js'; /* augur-inject:contract-predicate:20f97556 */

export type ChatInputError = "invalid_arguments" | "file_read_failed" | "invalid_utf8" | "empty_text";
type ChatText = { text: string } | { error: ChatInputError };
export type ChatInput = { channel: string; text: string } | { error: ChatInputError };

/** Strict UTF-8; remove one leading BOM and preserve all remaining characters. */
export function decodeChatText(bytes: Uint8Array): ChatText {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // Decoder errors may retain input details; expose only a fixed code.
    return { error: "invalid_utf8" };
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  return text.trim() ? { text } : { error: "empty_text" };
}
// @ts-expect-error augur-inject
decodeChatText = contract(decodeChatText, { ...augurContract_e3b49989, contractId: 'C-2', mode: 'observe', sample: 1, where: 'src/chat-input.ts:11', rule: 'contract-wrap', id: 'e3b49989' }); /* augur-inject:contract-wrap:e3b49989 */

/** Resolve only the CLI input; delivery and authorization remain in the sidecar. */
export function resolveChatInput(args: string[]): ChatInput {
  const [channel, ...body] = args;
  if (!channel || channel.startsWith("--text-file")) return { error: "invalid_arguments" };
  const hasFileOption = body.some((arg) => arg === "--text-file" || arg.startsWith("--text-file="));
  if (!hasFileOption) {
    const text = body.join(" ");
    return text ? { channel, text } : { error: "invalid_arguments" };
  }
  if (body.length !== 2 || body[0] !== "--text-file" || !body[1] || body[1].startsWith("--")) {
    return { error: "invalid_arguments" };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(body[1]);
  } catch {
    // Do not expose OS errors: they contain the source path.
    return { error: "file_read_failed" };
  }
  const result = decodeChatText(bytes);
  return "error" in result ? result : { channel, text: result.text };
}
