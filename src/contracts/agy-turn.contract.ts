import type { AgyAssistantStep, AgyStepType } from "../agy-steps.js";
import type { AgyAssistantPhase } from "../agy-turns.js";

export default {
  post(result: AgyAssistantPhase | null, step: AgyAssistantStep, later: AgyStepType | undefined, idle: boolean): true | string | undefined {
    const eligible = step.status === 3 && !!step.text && !step.hasToolCalls
      && (later === 14 || (later === undefined && idle));
    if (eligible && result === "final_answer") return true;
    if (eligible || result === "final_answer") return "agy final answer boundary mismatch";
    return undefined;
  },
};
