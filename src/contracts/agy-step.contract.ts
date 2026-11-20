import type { AgyRow, AgyStep } from "../agy-steps.js";

export default {
  post(result: AgyStep, row: AgyRow): true | string | undefined {
    if (result.kind === "unreadable") return undefined;
    const expectedType = { user: 14, assistant: 15, tool: 132 }[result.kind];
    if (row.step_type !== expectedType || row.step_format !== 0 || row.idx !== result.idx) {
      return "agy step identity mismatch";
    }
    if (result.kind === "tool") {
      return result.name && result.id && !("args" in result) ? true : "agy tool summary contained unexpected fields";
    }
    if (result.kind === "assistant" && !result.text) return undefined;
    return result.text ? true : "agy text frame lacked a prompt or displayed answer";
  },
};
