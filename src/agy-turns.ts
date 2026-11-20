import {
  AGY_ASSISTANT, AGY_DONE, AGY_TOOL, AGY_USER, decodeAgyStep,
  type AgyAssistantStep, type AgyRow, type AgyStepType,
} from "./agy-steps.js";
import type { TranscriptFrameInput } from "./transcript-sink.js";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:1a7eb2bf */
import augurContract_7cc804d3 from './contracts/agy-turn.contract.js'; /* augur-inject:contract-predicate:71978700 */

export type AgyAssistantPhase = "commentary" | "final_answer";

export function selectAgyAssistantPhase(
  step: AgyAssistantStep,
  later: AgyStepType | undefined,
  idle: boolean,
): AgyAssistantPhase | null {
  if (step.status !== AGY_DONE || !step.text) return null;
  if (step.hasToolCalls || later === AGY_ASSISTANT || later === AGY_TOOL) return "commentary";
  return later === AGY_USER || idle ? "final_answer" : null;
}
// @ts-expect-error augur-inject
selectAgyAssistantPhase = contract(selectAgyAssistantPhase, { ...augurContract_7cc804d3, contractId: 'C-11', mode: 'observe', sample: 1, where: 'src/agy-turns.ts:9', rule: 'contract-wrap', id: '7cc804d3' }); /* augur-inject:contract-wrap:7cc804d3 */

const PUBLISHED_SETTLE_MS = 2_000;

export class AgyTurns {
  cursor = -1;
  private promptAt: number | null = null;
  private finalCandidate: { idx: number; text: string; since: number } | null = null;

  constructor(private readonly spawnedAt: number) {}

  consume(
    rows: readonly AgyRow[],
    limit: number,
    now: number,
    terminalDoneAt: number | null,
    allowStorageIdle = true,
  ): TranscriptFrameInput[] {
    const frames: TranscriptFrameInput[] = [];
    let lastPromptIndex = -1;
    for (let index = rows.length - 1; index >= 0; index--) {
      if (rows[index].step_type !== AGY_USER || rows[index].status !== AGY_DONE) continue;
      lastPromptIndex = index;
      break;
    }
    for (let index = 0; index < Math.min(limit, rows.length); index++) {
      const row = rows[index];
      const pending = row.status === 0 || row.status === 1 || row.status === 2;
      if (pending && index >= lastPromptIndex) break;
      const previous = this.cursor;
      this.cursor = row.idx;
      if (pending) continue;

      if (row.step_type === AGY_USER) this.promptAt = null;
      const step = decodeAgyStep(row);
      if (step.kind === "user" && row.status === AGY_DONE && step.timestamp !== null && step.timestamp >= this.spawnedAt) {
        this.promptAt = step.timestamp;
        frames.push({ kind: "text", payload: { role: "user", text: step.text } });
      } else if (this.promptAt !== null && step.kind === "tool" && [AGY_DONE, 6, 7].includes(row.status)) {
        frames.push({ kind: "tool-use", payload: { role: "assistant", name: step.name, tool_use_id: step.id } });
      } else if (this.promptAt !== null && step.kind === "assistant" && step.text && row.status === AGY_DONE) {
        const later = rows[index + 1]?.step_type;
        const idle = !later && this.isIdle(step, step.text, now, terminalDoneAt, allowStorageIdle);
        const phase = selectAgyAssistantPhase(step, later, idle);
        if (!phase) {
          // Re-read the candidate with its successors from the next SQLite snapshot.
          this.cursor = previous;
          break;
        }
        this.finalCandidate = null;
        if (phase === "final_answer") this.promptAt = null;
        frames.push({ kind: "text", payload: { role: "assistant", text: step.text, phase } });
      }
    }
    return frames;
  }

  private isIdle(
    step: AgyAssistantStep,
    text: string,
    now: number,
    terminalDoneAt: number | null,
    allowStorageIdle: boolean,
  ): boolean {
    if (terminalDoneAt !== null && this.promptAt !== null && terminalDoneAt >= this.promptAt) return true;
    // Some terminal transports discard custom OSC. In the observed SQLite format,
    // field 8 is the published response, while field 1 is the raw response. An
    // unchanged published tail without queued tools is also a completion signal.
    if (!allowStorageIdle || !step.published || step.hasToolCalls) return false;
    if (this.finalCandidate?.idx !== step.idx || this.finalCandidate.text !== text) {
      this.finalCandidate = { idx: step.idx, text, since: now };
      return false;
    }
    return now - this.finalCandidate.since >= PUBLISHED_SETTLE_MS;
  }
}
