import { test } from "node:test";
import assert from "node:assert/strict";
import { startSidecar, type SidecarContext } from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";

function createContext(chat: (...args: unknown[]) => Promise<unknown>): SidecarContext {
  return {
    meta: {
      ...gatherBaseMeta(),
      discord: {
        session_channel_id: "discord-session-123",
        meta_channels: { chitchat: null, consultation: null, houkoku: null, system: null },
      },
    },
    titleState: { manualOverride: null },
    concordia: { chat } as unknown as SidecarContext["concordia"],
    sessionId: "session-123",
    roleLabel: "reviewer",
    injector: null,
    ptyWriter: null,
    notifyState: { mark: null, expiresAt: null },
    conflictState: { count: 0, titleMark: null },
    taskState: { branch: null, desc: null, updatedAt: null },
    activeRepoState: { lastActive: null, lastList: [] },
    getClaudeSessionId: null,
    getTranscript: null,
    repinTranscript: null,
    forceExit: null,
    requestGracefulExit: null,
  };
}

async function postSendFile(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/internal/send-file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("send-file sidecar: session identity and destination are authoritative", async () => {
  const calls: unknown[] = [];
  const sidecar = await startSidecar(createContext(async (payload) => {
    calls.push(payload);
    return { ok: true };
  }));
  try {
    const response = await postSendFile(sidecar.port, {
      files: ["C:/workspace/result.png"],
      caption: "result",
      session_id: "spoofed",
      discord_channel_id: "spoofed-channel",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{
      channel: "system",
      author_label: "reviewer",
      session_id: "session-123",
      discord_channel_id: "discord-session-123",
      text: "result\nresult.png",
      attachment_paths: ["C:/workspace/result.png"],
    }]);
  } finally {
    sidecar.close();
  }
});

test("send-file sidecar: fallback redacts local paths and upstream response text", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const sidecar = await startSidecar(createContext(async (payload) => {
    calls.push(payload as Record<string, unknown>);
    if (calls.length === 1) {
      throw new Error(
        "Concordia POST /v1/chat: HTTP 400 private response from http://internal.example",
      );
    }
    return { ok: true };
  }));
  try {
    const response = await postSendFile(sidecar.port, {
      files: ["C:/local-secret/workspace/result.png"],
    });
    assert.equal(response.status, 502);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].attachment_paths, ["C:/local-secret/workspace/result.png"]);
    assert.equal(calls[1].attachment_paths, undefined);
    const fallback = calls[1].text;
    assert.equal(typeof fallback, "string");
    assert.match(fallback as string, /result\.png/);
    assert.match(fallback as string, /HTTP 400/);
    assert.doesNotMatch(
      fallback as string,
      /C:\/local-secret|private response|internal\.example|\/v1\/chat/,
    );
  } finally {
    sidecar.close();
  }
});
