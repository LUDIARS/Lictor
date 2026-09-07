import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { startSidecar, type SidecarContext } from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";

/**
 * `/v1/internal/ask-question` が返す `ask_user_question_disabled` は、 PreToolUse
 * hook が picker を deny してよいかの唯一の判断材料になる。 deny の文面は
 * 「質問は送信済みだからターンを閉じて待て」 と言い切るので、 Concordia への
 * 早期投稿が落ちたまま true を返すと、 質問がどこにも出ないままセッションが
 * 黙って止まる (この経路が潰そうとしている事故そのもの)。
 */

/** pending-question を受ける最小 Concordia。 `status` で登録失敗を再現する。 */
async function startFakeConcordia(status: number): Promise<{ baseUrl: string; server: Server; count: () => number }> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ question_id: 4242 }) : "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, server, count: () => count };
}

function createContext(baseUrl: string, askUserQuestionDisabled: boolean): SidecarContext {
  return {
    meta: gatherBaseMeta(),
    titleState: { manualOverride: null },
    concordia: { cfg: { baseUrl } } as unknown as SidecarContext["concordia"],
    sessionId: "session-123",
    roleLabel: null,
    injector: null,
    ptyWriter: null,
    notifyState: { mark: null, expiresAt: null },
    conflictState: { count: 0, titleMark: null },
    taskState: { branch: null, desc: null, updatedAt: null },
    activeRepoState: { lastActive: null, lastList: [] },
    askUserQuestionDisabled,
    getClaudeSessionId: null,
    getTranscript: null,
    repinTranscript: null,
    forceExit: null,
    requestGracefulExit: null,
  };
}

async function postAskQuestion(port: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/internal/ask-question`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      questions: [{ question: "どちらで進めますか", options: ["A", "B"] }],
    }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

test("ask-question: 登録できたときだけ disabled=true を返す", async () => {
  const cc = await startFakeConcordia(200);
  const sidecar = await startSidecar(createContext(cc.baseUrl, true));
  try {
    const body = await postAskQuestion(sidecar.port);
    assert.equal(body.ask_user_question_disabled, true);
    assert.equal(body.registered, 1);
  } finally {
    sidecar.close();
    cc.server.close();
  }
});

test("ask-question: Concordia 登録が落ちたら fail-open (picker を開かせる)", async () => {
  // 質問がどこにも出ていないのに deny すると、モデルは 「送信済みだから待て」 と
  // 言われたままターンを閉じ、誰も答えられないセッションが無言で止まる。
  const cc = await startFakeConcordia(500);
  const sidecar = await startSidecar(createContext(cc.baseUrl, true));
  try {
    const body = await postAskQuestion(sidecar.port);
    assert.equal(body.ask_user_question_disabled, false);
    assert.equal(body.registered, 0);
  } finally {
    sidecar.close();
    cc.server.close();
  }
});

test("ask-question: picker を開かせる起動では待たずに disabled=false", async () => {
  const cc = await startFakeConcordia(200);
  const sidecar = await startSidecar(createContext(cc.baseUrl, false));
  try {
    const body = await postAskQuestion(sidecar.port);
    assert.equal(body.ask_user_question_disabled, false);
  } finally {
    sidecar.close();
    cc.server.close();
  }
});

test("ask-question: Concordia 不在なら質問を握らず skip する", async () => {
  const ctx = createContext("http://127.0.0.1:1", true);
  ctx.concordia = null;
  const sidecar = await startSidecar(ctx);
  try {
    const body = await postAskQuestion(sidecar.port);
    assert.equal(body.skipped, "no concordia");
    assert.equal(body.ask_user_question_disabled, undefined);
  } finally {
    sidecar.close();
  }
});
