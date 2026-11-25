import { grokUpdateToFrames } from "./grok-transcript-frames.js";
import type { Frame } from "./transcript-tail.js";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:20d4dee5 */
import augurContract_af0d3688 from './contracts/grok-turn-frames.contract.js'; /* augur-inject:contract-predicate:69575303 */

type PreviewJson = (value: unknown) => string;
type GrokPhase = "commentary" | "final_answer";
type TurnUpdate = { pending: string | null; frames: Frame[] };

function assistantText(text: string, phase?: GrokPhase): Frame {
  return { kind: "text", payload: { role: "assistant", text, ...(phase === undefined ? {} : { phase }) } };
}

/** @implements SPEC-GROK-TRANSCRIPT-PHASE */
export const decodeGrokTurnUpdate = contract((pending: string | null, params: unknown, previewJson: PreviewJson): TurnUpdate => {
  const update = (params as { update?: {
    sessionUpdate?: unknown;
    content?: { text?: unknown };
    stop_reason?: unknown;
  } } | null)?.update;
  switch (update?.sessionUpdate) {
    case "agent_message_chunk": {
      const text = update.content?.text;
      return { pending: typeof text === "string" ? (pending ?? "") + text : pending, frames: [] };
    }
    case "turn_completed": {
      const phase = update.stop_reason === "end_turn" ? "final_answer" : "commentary";
      return { pending: null, frames: pending === null ? [] : [assistantText(pending, phase)] };
    }
    case "tool_call":
    case "tool_call_update":
    case "user_message_chunk":
    case "agent_thought_chunk": {
      const frames = grokUpdateToFrames(params, previewJson);
      if (pending !== null) frames.unshift(assistantText(pending, "commentary"));
      return { pending: null, frames };
    }
    default:
      return { pending, frames: [] };
  }
// @ts-expect-error augur-inject emits options the local observe-only runtime does not type.
}, { ...augurContract_af0d3688, contractId: 'C-19', mode: 'observe', sample: 1, where: 'src/grok-turn-frames.ts:13', rule: 'contract-wrap', id: 'af0d3688' }) /* augur-inject:contract-wrap:af0d3688 */;

interface GrokFrameDecoder {
  consume(line: string): Frame[];
  reset(): void;
  flush(): Frame[];
}

export function createGrokFrameDecoder(previewJson: PreviewJson): GrokFrameDecoder {
  let pending: string | null = null;
  return {
    consume(line) {
      let message: { method?: unknown; params?: unknown } | null;
      try {
        message = JSON.parse(line);
      } catch {
        return []; // A malformed JSONL record provides no turn boundary.
      }
      if (message?.method !== "session/update" && message?.method !== "_x.ai/session/update") return [];
      const next = decodeGrokTurnUpdate(pending, message.params, previewJson);
      pending = next.pending;
      return next.frames;
    },
    reset() {
      pending = null;
    },
    flush() {
      const frames = pending === null ? [] : [assistantText(pending)];
      pending = null;
      return frames;
    },
  };
}
