import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLivenessUrl,
  isTerminalLivenessClose,
  LivenessHandle,
  loadConcordiaConfig,
} from "../src/concordia.js";

test("loadConcordiaConfig defaults", () => {
  const cfg = loadConcordiaConfig({});
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 11111);
  assert.equal(cfg.baseUrl, "http://127.0.0.1:11111");
  assert.equal(cfg.enabled, true);
});

test("loadConcordiaConfig honors env override", () => {
  const cfg = loadConcordiaConfig({
    CONCORDIA_HOST: "10.0.0.5",
    CONCORDIA_PORT: "18000",
  });
  assert.equal(cfg.host, "10.0.0.5");
  assert.equal(cfg.port, 18000);
  assert.equal(cfg.baseUrl, "http://10.0.0.5:18000");
});

test("loadConcordiaConfig honors disable flag", () => {
  const cfg = loadConcordiaConfig({ LICTOR_DISABLE_CONCORDIA: "1" });
  assert.equal(cfg.enabled, false);
});

test("loadConcordiaConfig: empty host string falls back to default", () => {
  const cfg = loadConcordiaConfig({ CONCORDIA_HOST: "   " });
  assert.equal(cfg.host, "127.0.0.1");
});

test("buildLivenessUrl carries the registered enrollment and URL-encodes both identities", () => {
  const url = buildLivenessUrl(
    { host: "127.0.0.1", port: 11111 },
    "lictor/session?1",
    "spawn token/&1",
  );
  const parsed = new URL(url);

  assert.equal(parsed.searchParams.get("session"), "lictor/session?1");
  assert.equal(parsed.searchParams.get("enrollment"), "spawn token/&1");
});

test("buildLivenessUrl omits enrollment for a non-Concordia launch", () => {
  const url = buildLivenessUrl(
    { host: "127.0.0.1", port: 11111 },
    "lictor-local",
    null,
  );
  const parsed = new URL(url);

  assert.equal(parsed.searchParams.get("session"), "lictor-local");
  assert.equal(parsed.searchParams.has("enrollment"), false);
});

test("policy close is terminal while transport closes remain retryable", () => {
  assert.equal(isTerminalLivenessClose(1008), true);
  assert.equal(isTerminalLivenessClose(1000), false);
  assert.equal(isTerminalLivenessClose(1006), false);
  assert.equal(isTerminalLivenessClose(1011), false);
});

test("LivenessHandle stops reconnecting after enrollment rejection without logging credential", {
  concurrency: false,
}, () => {
  type Listener = (event: { code?: number }) => void;
  const instances: FakeWebSocket[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;

    constructor(readonly url: string) {
      instances.push(this);
    }

    addEventListener(type: string, listener: Listener): void {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    close(): void {
      this.readyState = 3;
    }

    emit(type: string, event: { code?: number } = {}): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  const originalWebSocket = globalThis.WebSocket;
  const originalSetTimeout = globalThis.setTimeout;
  const originalStderrWrite = process.stderr.write;
  let scheduledRetries = 0;
  let stderr = "";

  try {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.setTimeout = ((..._args: unknown[]) => {
      scheduledRetries += 1;
      return { unref: () => undefined };
    }) as unknown as typeof setTimeout;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const enrollment = "secret-spawn-credential";
    const handle = new LivenessHandle(
      loadConcordiaConfig({ CONCORDIA_PORT: "11111" }),
      "lictor-test",
      enrollment,
    );
    assert.equal(instances.length, 1);
    assert.equal(new URL(instances[0].url).searchParams.get("enrollment"), enrollment);

    instances[0].readyState = FakeWebSocket.OPEN;
    instances[0].emit("open");
    instances[0].emit("close", { code: 1008 });

    assert.equal(scheduledRetries, 0);
    assert.match(stderr, /authentication failed/);
    assert.doesNotMatch(stderr, /secret-spawn-credential/);
    handle.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
    process.stderr.write = originalStderrWrite;
  }
});

test("LivenessHandle keeps retrying after a transport close", {
  concurrency: false,
}, () => {
  type Listener = (event: { code?: number }) => void;
  let closeListener: Listener | null = null;
  let scheduledRetries = 0;

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;

    constructor(readonly _url: string) {}

    addEventListener(type: string, listener: Listener): void {
      if (type === "close") closeListener = listener;
    }

    close(): void {
      this.readyState = 3;
    }
  }

  const originalWebSocket = globalThis.WebSocket;
  const originalSetTimeout = globalThis.setTimeout;

  try {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.setTimeout = ((..._args: unknown[]) => {
      scheduledRetries += 1;
      return { unref: () => undefined };
    }) as unknown as typeof setTimeout;

    const handle = new LivenessHandle(
      loadConcordiaConfig({ CONCORDIA_PORT: "11111" }),
      "lictor-test",
      "spawn-id",
    );
    assert.ok(closeListener);
    (closeListener as Listener)({ code: 1006 });

    assert.equal(scheduledRetries, 1);
    handle.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
  }
});
