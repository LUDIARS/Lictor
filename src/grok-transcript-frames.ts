import type { Frame } from "./transcript-tail.js";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:54012fe0 */
import augurContract_f6a5d608 from './contracts/grok-transcript-frames.contract.js'; /* augur-inject:contract-predicate:f4e8d9cc */

interface GrokUpdate {
  sessionUpdate?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  title?: unknown;
  rawInput?: unknown;
  status?: unknown;
  _meta?: { "x.ai/tool"?: { name?: unknown } };
}

export function grokUpdateToFrames(params: unknown, previewJson: (value: unknown) => string): Frame[] {
  const update = (params as { update?: GrokUpdate } | null)?.update;
  const text = (update?.content as { text?: unknown } | null)?.text;
  switch (update?.sessionUpdate) {
    case "agent_message_chunk":
    case "user_message_chunk": {
      if (typeof text !== "string") return [];
      const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
      return [{ kind: "text", payload: { role, text } }];
    }
    case "agent_thought_chunk":
      return typeof text === "string"
        ? [{ kind: "thinking", payload: { role: "assistant", preview: text.slice(0, 400) } }]
        : [];
    case "tool_call": {
      if (typeof update.toolCallId !== "string") return [];
      const name = update._meta?.["x.ai/tool"]?.name;
      return [{
        kind: "tool-use",
        payload: {
          role: "assistant",
          name: typeof name === "string" ? name : typeof update.title === "string" ? update.title : "unknown",
          tool_use_id: update.toolCallId,
          input_preview: previewJson(update.rawInput),
        },
      }];
    }
    case "tool_call_update": {
      const status = update.status;
      if (typeof update.toolCallId !== "string" || typeof status !== "string"
        || !status || status === "pending" || status === "in_progress") return [];
      const texts: string[] = [];
      if (Array.isArray(update.content)) {
        for (const item of update.content) {
          if (item?.type === "content" && typeof item.content?.text === "string") {
            texts.push(item.content.text);
          }
        }
      }
      return [{
        kind: "tool-result",
        payload: {
          tool_use_id: update.toolCallId,
          is_error: status !== "completed",
          preview: previewJson(texts.join("\n")),
        },
      }];
    }
    default:
      return [];
  }
}
// @ts-expect-error augur-inject
grokUpdateToFrames = contract(grokUpdateToFrames, { ...augurContract_f6a5d608, contractId: 'C-17', mode: 'observe', sample: 1, where: 'src/grok-transcript-frames.ts:13', rule: 'contract-wrap', id: 'f6a5d608' }); /* augur-inject:contract-wrap:f6a5d608 */
