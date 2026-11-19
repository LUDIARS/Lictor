import type { PendingTask } from "../concordia-types.js";
import type { PendingStatInstructions } from "../pending-stat-instructions.js";

export default {
  post(result: string, task: PendingTask, instructions: PendingStatInstructions): true | string {
    if (task.payload === undefined) {
      return result === "" ? true : "payload was added for a task without one";
    }

    const json = JSON.stringify(task.payload);
    const preview = json.length <= 200 ? json : json.substring(0, 199) + "…";
    const prefix = "\n   payload: " + preview;
    const payload = task.payload as { trigger?: unknown; instructions?: unknown } | null;
    const periodical = task.kind === "stat-collect" &&
      (payload?.trigger === "interval" || payload?.trigger === "idle");
    const id = String(task.id);
    const full = payload?.instructions;
    const retrievable = periodical && json.length > 200 && /^[1-9]\d{0,15}$/.test(id) &&
      typeof full === "string" && full.length > 0 && Buffer.byteLength(full, "utf8") <= 32 * 1024;

    if (!retrievable) {
      return result === prefix ? true : "ordinary payload preview changed";
    }
    return result.startsWith(prefix + "\n") &&
      result.includes("LICTOR_PORT") &&
      result.includes(`GET /v1/pending-tasks/stat-collect/${id}`) &&
      instructions.get(id) === full
      ? true
      : "truncated periodic instructions have no usable retrieval hint";
  },
};
