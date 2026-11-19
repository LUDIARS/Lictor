import type { PendingTask } from "./concordia-types.js";

export const PENDING_STAT_INSTRUCTIONS_PATH = "/v1/pending-tasks/stat-collect/";

const MAX_ENTRIES = 20;
const MAX_INSTRUCTION_BYTES = 32 * 1024;
const TASK_ID = /^[1-9]\d{0,15}$/;

/** Retains only recent periodic instructions delivered to this wrapper. */
export class PendingStatInstructions {
  private readonly entries = new Map<string, string>();

  remember(task: PendingTask): string | undefined {
    if (task.kind !== "stat-collect" || !task.payload || typeof task.payload !== "object") return;
    const { trigger, instructions } = task.payload as { trigger?: unknown; instructions?: unknown };
    if (trigger !== "interval" && trigger !== "idle") return;

    const id = String(task.id);
    if (!TASK_ID.test(id) || typeof instructions !== "string" ||
      instructions.length === 0 || Buffer.byteLength(instructions, "utf8") > MAX_INSTRUCTION_BYTES) return;

    this.entries.delete(id);
    this.entries.set(id, instructions);
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return id;
  }

  get(id: string): string | undefined {
    return this.entries.get(id);
  }
}
