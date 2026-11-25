import type { Frame } from "../transcript-tail.js";

export default {
  post(result: { pending: string | null; frames: Frame[] }, pending: string | null, params: unknown): true | string {
    const update = (params as { update?: Record<string, unknown> } | null)?.update;
    const event = update?.sessionUpdate;
    const text = (update?.content as { text?: unknown } | null)?.text;
    if (event === "agent_message_chunk") {
      const expected = typeof text === "string" ? (pending ?? "") + text : pending;
      return (result.pending === expected && result.frames.length === 0)
        || "assistant chunks must accumulate without emitting";
    }
    const boundary = event === "turn_completed" || event === "tool_call" || event === "tool_call_update"
      || event === "user_message_chunk" || event === "agent_thought_chunk";
    if (!boundary) {
      return (result.pending === pending && result.frames.length === 0)
        || "control updates must preserve pending text";
    }
    if (result.pending !== null) return "a boundary must clear pending text";
    const assistantTexts = result.frames.filter((frame) => frame.kind === "text"
      && (frame.payload as { role?: unknown })?.role === "assistant");
    if (pending === null) return assistantTexts.length === 0 || "emitted assistant text without a chunk";
    const expectedPhase = event === "turn_completed" && update?.stop_reason === "end_turn"
      ? "final_answer" : "commentary";
    const payload = assistantTexts[0]?.payload as { text?: unknown; phase?: unknown } | undefined;
    return (assistantTexts.length === 1 && assistantTexts[0] === result.frames[0]
      && payload?.text === pending && payload.phase === expectedPhase
      && (event !== "turn_completed" || result.frames.length === 1))
      || "pending text must be emitted first with the phase selected by the boundary";
  },
};
