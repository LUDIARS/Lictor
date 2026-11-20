import { agyInteger, agyMessage, agyString, readAgyWire } from "./agy-wire.js";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:69645431 */
import augurContract_cca51b05 from './contracts/agy-step.contract.js'; /* augur-inject:contract-predicate:fea1df41 */

export const AGY_USER = 14;
export const AGY_ASSISTANT = 15;
export const AGY_TOOL = 132;
export const AGY_DONE = 3;
export type AgyStepType = typeof AGY_USER | typeof AGY_ASSISTANT | typeof AGY_TOOL;

export interface AgyRow {
  idx: number;
  step_type: AgyStepType;
  status: number;
  step_format: number;
  metadata: Uint8Array | null;
  step_payload: Uint8Array | null;
}

export interface AgyAssistantStep {
  kind: "assistant";
  idx: number;
  status: number;
  text: string | null;
  published: boolean;
  hasToolCalls: boolean;
}

export type AgyStep = AgyAssistantStep
  | { kind: "user"; idx: number; text: string; timestamp: number | null }
  | { kind: "tool"; idx: number; name: string; id: string }
  | { kind: "unreadable"; idx: number };

function stepTimestamp(metadata: ReturnType<typeof readAgyWire>): number | null {
  const created = agyMessage(metadata, 1);
  const seconds = agyInteger(created, 1);
  const nanos = agyInteger(created, 2) ?? 0;
  if (seconds === null || seconds < 0 || nanos < 0 || nanos >= 1e9) return null;
  const milliseconds = seconds * 1000 + Math.floor(nanos / 1e6);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

export function decodeAgyStep(row: AgyRow): AgyStep {
  const unreadable = { kind: "unreadable", idx: row.idx } as const;
  if (row.step_format !== 0) return unreadable;

  if (row.step_type === AGY_TOOL) {
    const call = agyMessage(readAgyWire(row.metadata), 4);
    const id = agyString(call, 1);
    const name = agyString(call, 2);
    if (!id || id.length > 128 || !name || !/^[\w./:-]{1,160}$/.test(name)) return unreadable;
    return { kind: "tool", idx: row.idx, name, id };
  }

  const payload = readAgyWire(row.step_payload);
  if (agyInteger(payload, 1) !== row.step_type) return unreadable;
  if (row.step_type === AGY_USER) {
    const input = agyMessage(payload, 19);
    const text = agyString(input, 2) ?? agyString(agyMessage(input, 3), 1);
    if (!text) return unreadable;
    const timestamp = stepTimestamp(readAgyWire(row.metadata)) ?? stepTimestamp(agyMessage(payload, 5));
    return { kind: "user", idx: row.idx, text, timestamp };
  }

  const response = agyMessage(payload, 20);
  if (!response) return unreadable;
  const published = agyString(response, 8);
  return {
    kind: "assistant",
    idx: row.idx,
    status: row.status,
    text: published ?? agyString(response, 1),
    published: published !== null,
    hasToolCalls: response.has(7),
  };
}
// @ts-expect-error augur-inject
decodeAgyStep = contract(decodeAgyStep, { ...augurContract_cca51b05, contractId: 'C-10', mode: 'observe', sample: 1, where: 'src/agy-steps.ts:41', rule: 'contract-wrap', id: 'cca51b05' }); /* augur-inject:contract-wrap:cca51b05 */
