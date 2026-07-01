import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConcordiaConfig } from "./concordia.js";

export interface CostOneShotPayload {
  ts?: number;
  service: string;
  provider: string;
  command?: string;
  model?: string | null;
  cwd?: string | null;
  prompt: string;
  status?: "ok" | "error" | "timeout" | "unknown";
  exit_code?: number | null;
  duration_ms?: number | null;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  metadata?: Record<string, unknown>;
}

export function costOneShotQueuePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CONCORDIA_COST_ONESHOT_QUEUE?.trim();
  return explicit || join(process.cwd(), "logs", "cost-one-shot-queue.jsonl");
}

export async function sendCostOneShot(
  payload: CostOneShotPayload,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; queued: boolean; error?: string }> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cfg = loadConcordiaConfig(env);
  if (!cfg.enabled) {
    await queueCostOneShot(payload, env);
    return { ok: false, queued: true, error: "concordia disabled" };
  }
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/v1/cost/one-shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    await flushCostOneShotQueue({ env, fetchImpl });
    return { ok: true, queued: false };
  } catch (err) {
    await queueCostOneShot(payload, env);
    return { ok: false, queued: true, error: (err as Error).message };
  }
}

export async function queueCostOneShot(
  payload: CostOneShotPayload,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = costOneShotQueuePath(env);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(payload) + "\n", "utf8");
}

export async function flushCostOneShotQueue(
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ flushed: number; remaining: number }> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cfg = loadConcordiaConfig(env);
  const path = costOneShotQueuePath(env);
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { flushed: 0, remaining: 0 };
  }
  const pending = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as CostOneShotPayload);
  const failed: CostOneShotPayload[] = [];
  let flushed = 0;
  for (const payload of pending) {
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/v1/cost/one-shots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      flushed++;
    } catch {
      failed.push(payload);
    }
  }
  if (failed.length === 0) {
    await writeFile(path, "", "utf8");
  } else {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, failed.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
    await rename(tmp, path);
  }
  return { flushed, remaining: failed.length };
}
