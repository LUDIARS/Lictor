import type { Frame } from "../transcript-tail.js";

export default {
  post(result: Frame[], params: unknown): true | string {
    const update = (params as { update?: Record<string, unknown> } | null)?.update;
    const text = (update?.content as { text?: unknown } | null)?.text;
    const frame = result[0];
    const payload = frame?.payload as Record<string, unknown> | undefined;
    if (result.length > 1) return "one Grok update emitted multiple frames";
    switch (update?.sessionUpdate) {
      case "user_message_chunk":
      case "agent_message_chunk": {
        if (typeof text !== "string") break;
        const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
        return (frame?.kind === "text" && payload?.role === role && payload?.text === text)
          || "Grok message or role was changed";
      }
      case "agent_thought_chunk":
        if (typeof text !== "string") break;
        return (frame?.kind === "thinking" && payload?.role === "assistant" && payload?.preview === text.slice(0, 400))
          || "Grok thinking preview differs from its source";
      case "tool_call":
        if (typeof update.toolCallId !== "string") break;
        return (frame?.kind === "tool-use" && payload?.role === "assistant"
          && payload?.tool_use_id === update.toolCallId && typeof payload?.name === "string"
          && typeof payload?.input_preview === "string") || "Grok tool call lost its identity or preview";
      case "tool_call_update": {
        const status = update.status;
        if (typeof update.toolCallId !== "string" || typeof status !== "string"
          || !status || status === "pending" || status === "in_progress") break;
        return (frame?.kind === "tool-result" && payload?.tool_use_id === update.toolCallId
          && payload?.is_error === (status !== "completed") && typeof payload?.preview === "string")
          || "Grok terminal tool status was not preserved";
      }
    }
    return result.length === 0 || "Grok control or incomplete update emitted a frame";
  },
};
