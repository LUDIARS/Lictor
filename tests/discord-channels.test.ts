import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDiscordChannelId, type SidecarContext } from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";

function ctxWithDiscord(discord: SidecarContext["meta"]["discord"]): SidecarContext {
  const meta = gatherBaseMeta();
  meta.discord = discord;
  return {
    meta,
    titleState: { manualOverride: null },
    concordia: null,
    sessionId: "lictor-x",
    roleLabel: null,
    injector: null,
    ptyWriter: null,
    notifyState: { mark: null, expiresAt: null },
    conflictState: { count: 0, titleMark: null },
    taskState: { branch: null, desc: null, updatedAt: null },
    pendingPermissions: new Map(),
    activeRepoState: { lastActive: null, lastList: [] },
    getClaudeSessionId: null,
  } as unknown as SidecarContext;
}

const FULL = {
  ok: true,
  session_channel_id: "sess-1",
  session_channel_status: "active",
  meta_channels: {
    chitchat: "ch-chit",
    consultation: "ch-cons",
    houkoku: "ch-houk",
    system: "ch-sys",
  },
};

test("resolveDiscordChannelId maps meta channel names to held ids", () => {
  const ctx = ctxWithDiscord(FULL);
  assert.equal(resolveDiscordChannelId(ctx, "chitchat"), "ch-chit");
  assert.equal(resolveDiscordChannelId(ctx, "consultation"), "ch-cons");
  assert.equal(resolveDiscordChannelId(ctx, "報告"), "ch-houk");
  assert.equal(resolveDiscordChannelId(ctx, "houkoku"), "ch-houk");
  assert.equal(resolveDiscordChannelId(ctx, "system"), "ch-sys");
  assert.equal(resolveDiscordChannelId(ctx, "session"), "sess-1");
});

test("resolveDiscordChannelId returns undefined when discord not held", () => {
  const ctx = ctxWithDiscord(null);
  assert.equal(resolveDiscordChannelId(ctx, "chitchat"), undefined);
});

test("resolveDiscordChannelId returns undefined for unknown / unmapped channel", () => {
  const ctx = ctxWithDiscord(FULL);
  assert.equal(resolveDiscordChannelId(ctx, "nonsense"), undefined);
});

test("resolveDiscordChannelId returns undefined when session channel not yet created", () => {
  const ctx = ctxWithDiscord({
    ...FULL,
    session_channel_id: null,
    meta_channels: { chitchat: "ch-chit", consultation: null, houkoku: null, system: null },
  });
  assert.equal(resolveDiscordChannelId(ctx, "session"), undefined);
  assert.equal(resolveDiscordChannelId(ctx, "consultation"), undefined);
  assert.equal(resolveDiscordChannelId(ctx, "chitchat"), "ch-chit");
});
