import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { flushCostOneShotQueue, sendCostOneShot } from "../src/cost-one-shot.js";

test("sendCostOneShot queues when Concordia is unreachable, then flushes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lictor-cost-"));
  try {
    const queue = join(dir, "queue.jsonl");
    const env = {
      ...process.env,
      CONCORDIA_HOST: "127.0.0.1",
      CONCORDIA_PORT: "11111",
      CONCORDIA_COST_ONESHOT_QUEUE: queue,
    };
    const payload = {
      service: "lictor-test",
      provider: "claude",
      prompt: "hello",
    };

    const failedFetch = async () => {
      throw new Error("offline");
    };
    const r = await sendCostOneShot(payload, { env, fetchImpl: failedFetch as typeof fetch });
    assert.equal(r.queued, true);
    assert.match(await readFile(queue, "utf8"), /"prompt":"hello"/);

    const posted: unknown[] = [];
    const okFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const flushed = await flushCostOneShotQueue({ env, fetchImpl: okFetch as typeof fetch });
    assert.deepEqual(flushed, { flushed: 1, remaining: 0 });
    assert.equal((posted[0] as { prompt: string }).prompt, "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
