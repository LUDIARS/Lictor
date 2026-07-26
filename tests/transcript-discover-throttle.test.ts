import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// STALL_RECOVERY_MS は transcript-tail の module top-level で env を読むため、 モジュール
// 評価より前に設定する必要がある。 静的 import は hoist されて先に評価されてしまうので
// dynamic import を使う。 `node --test` はテストファイルごとに別プロセスで走るため、
// この env 上書きは他のテストファイルへは漏れない。
process.env.LICTOR_TRANSCRIPT_STALL_RECOVERY_MS = "2000";
const STALL_MS = 2000;

const { startTranscriptTail } = await import("../src/transcript-tail.js");
const { PROVIDERS } = await import("../src/provider.js");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** codex rollout の session_meta 先頭行 + 任意本文を書いた JSONL を作る。 */
function writeCodexRollout(dir: string, name: string, sessionId: string, cwd: string, body: unknown[] = []): string {
  const p = join(dir, name);
  const meta = {
    type: "session_meta",
    payload: { session_id: sessionId, cwd, timestamp: new Date().toISOString() },
  };
  writeFileSync(p, [meta, ...body].map((o) => JSON.stringify(o)).join("\n") + "\n");
  return p;
}

// codex は hook 権威も pin も持たないため、 進捗ゼロが STALL_RECOVERY_MS 続くと watchdog
// (maybeRecover) が recoverCodexLocked → discoverCodex を回す。 discoverCodex は
// sessions ツリーを全 statSync し、 候補の先頭 256 KiB を読む重い処理なので、 「取り直しても
// 束縛先が同じ」 = 単なるアイドルのときに進捗時刻を打ち直さないと、 以後 **毎 poll (500ms)**
// 走り続ける。 authority / pin 経路は打ち直しているのに codex 経路だけ抜けており、
// 2026-07-26 に codex 3 セッションで合計 32 MB/s の read を出して Defender を張り付かせた。
//
// discover の実行回数は provider.transcriptMetaAccepts の呼び出し回数で測れる
// (discoverCodex は候補ごとに 1 回呼ぶ。 このテストの候補は自分の rollout 1 件だけ)。
test("startTranscriptTail(codex): アイドル中の stall 復帰は poll ごとに discover を走らせない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-codex-throttle-"));
  try {
    let acceptCalls = 0;
    const base = PROVIDERS.codex;
    const provider = {
      ...base,
      transcriptDir: () => dir,
      transcriptMetaAccepts: (first: string, ctx: Parameters<NonNullable<typeof base.transcriptMetaAccepts>>[1]) => {
        acceptCalls++;
        return base.transcriptMetaAccepts ? base.transcriptMetaAccepts(first, ctx) : true;
      },
    };
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: "lictor-codex-throttle-session",
      concordiaBaseUrl: "http://127.0.0.1:1", // 到達不能 → postFrame は drop
      provider,
      isSessionActive: () => true, // active でないと watchdog は回らない
    });
    try {
      const rollout = writeCodexRollout(dir, "rollout-2026-07-26-S1.jsonl", "S1", dir, [
        { type: "event_msg", payload: { type: "agent_message", message: "hi from S1" } },
      ]);
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), rollout, "S1 rollout を tail する");

      // ここから transcript は一切伸びない = アイドル。 STALL_RECOVERY_MS を超えると
      // watchdog が回り始めるので、 最初の 1 回が済むまで待ってから計測を始める。
      await sleep(STALL_MS + 400);
      const baseline = acceptCalls;

      // 観測窓 3 秒。 poll は 500ms なので、 打ち直しが無ければ 6 回前後 discover が走る。
      // 打ち直しがあれば STALL_RECOVERY_MS (2000ms) ごとなので 1〜2 回に収まる。
      await sleep(3000);
      const discovers = acceptCalls - baseline;
      assert.ok(
        discovers <= 3,
        `アイドル中の discover が多すぎる: 3 秒で ${discovers} 回 (poll ごとに走っている疑い)`,
      );

      // 中継自体は生きたままであること (throttle が束縛を壊していない)。
      assert.equal(tail.getTranscriptPath(), rollout, "throttle 後も S1 を掴んだまま");
      assert.equal(tail.getSessionUuid(), "S1", "施錠した session_id は維持される");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 打ち直しが「復帰を止める」 ものではないことの確認。 アイドルで throttle が効いた後でも、
// 束縛先が実際に差し替わる状況 (同一 session_id の rollout が別ファイルへ rotate) では
// watchdog が次に回ったときに追従する。
test("startTranscriptTail(codex): throttle 後も同一 session_id の rotate には追従する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-codex-rotate-"));
  try {
    const provider = { ...PROVIDERS.codex, transcriptDir: () => dir };
    const tail = startTranscriptTail({
      cwd: dir,
      sessionId: "lictor-codex-rotate-session",
      concordiaBaseUrl: "http://127.0.0.1:1",
      provider,
      isSessionActive: () => true,
    });
    try {
      const first = writeCodexRollout(dir, "rollout-2026-07-26-R1.jsonl", "R1", dir, [
        { type: "event_msg", payload: { type: "agent_message", message: "before rotate" } },
      ]);
      await sleep(700);
      assert.equal(tail.getTranscriptPath(), first, "rotate 前の rollout を掴む");

      // アイドルにして throttle を効かせてから、 同一 session_id の rollout を新しい mtime で
      // 置く (codex 側のローテート相当)。 旧ファイルは残す — 消すと pollOnce の statSync が
      // 先に落ちて watchdog まで届かないため、 ここで測りたい経路にならない。
      await sleep(STALL_MS + 400);
      const rotated = writeCodexRollout(dir, "rollout-2026-07-26-R1-rotated.jsonl", "R1", dir, [
        { type: "event_msg", payload: { type: "agent_message", message: "after rotate" } },
      ]);
      const future = Date.now() / 1000 + 600;
      utimesSync(rotated, future, future);

      // 次の watchdog 一巡 (STALL_RECOVERY_MS) で追従する。
      await sleep(STALL_MS + 800);
      assert.equal(tail.getTranscriptPath(), rotated, "同一 session_id の rotate 先へ束縛し直す");
    } finally {
      tail.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
