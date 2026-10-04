import { test } from "node:test";
import assert from "node:assert/strict";
import { ConcordiaClient, loadConcordiaConfig } from "../src/concordia.js";
import { startSidecar, type SidecarContext } from "../src/sidecar.js";
import { gatherBaseMeta } from "../src/meta.js";

function createContext(): SidecarContext {
  return {
    meta: gatherBaseMeta(),
    titleState: { manualOverride: null },
    concordia: new ConcordiaClient(loadConcordiaConfig({})),
    sessionId: "authoritative-session",
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

const cases = [
  { name: "success", status: 200, body: '{"ok":true}', expected: 200 },
  { name: "known missing report", status: 404, body: '{"error":"report_not_found"}', expected: 404 },
  { name: "known error redacts upstream details", status: 404,
    body: '{"error":"report_not_found","detail":"private-body http://internal.invalid authoritative-session Bearer secret"}', expected: 404 },
  { name: "different 404", status: 404, body: '{"error":"other_error"}', expected: 500 },
  { name: "known code at 503", status: 503, body: '{"error":"report_not_found"}', expected: 500 },
  { name: "non JSON", status: 404, body: "report_not_found", expected: 500 },
  { name: "nested code", status: 404, body: '{"detail":{"error":"report_not_found"}}', expected: 500 },
  { name: "null JSON", status: 404, body: "null", expected: 500 },
  { name: "transport failure", status: 0, body: "fetch failed", expected: 500 },
  { name: "unregistered client", status: 200, body: "{}", expected: 503, missing: "client" },
  { name: "unregistered session", status: 200, body: "{}", expected: 503, missing: "session" },
  { name: "other route retains 500", status: 404, body: '{"error":"report_not_found"}', expected: 500, route: "/v1/event" },
] as const;

for (const scenario of cases) {
  test(`report sidecar: ${scenario.name}`, async (t) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
      if (scenario.status === 0) throw new TypeError(scenario.body);
      return new Response(scenario.body, { status: scenario.status });
    });
    const ctx = createContext();
    if ("missing" in scenario && scenario.missing === "client") ctx.concordia = null;
    if ("missing" in scenario && scenario.missing === "session") ctx.sessionId = null;
    const sidecar = await startSidecar(ctx);
    try {
      // Use node:http so the upstream fetch mock cannot intercept this request.
      const { request } = await import("node:http");
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: sidecar.port,
          path: "route" in scenario ? scenario.route : "/v1/report", method: "POST",
          headers: { "content-type": "application/json" },
        }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => { body += chunk; });
          res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ monologue: "daily note", session_id: "spoofed", kind: "test" }));
      });
      assert.equal(response.status, scenario.expected);
      assert.equal(calls.length, "missing" in scenario ? 0 : 1);
      const body = JSON.parse(response.body);
      if (scenario.expected === 404) {
        assert.deepEqual(body, { error: "report_not_found" });
        assert.doesNotMatch(response.body, /private-body|internal|authoritative-session|Bearer|secret/);
      } else if (scenario.expected === 200) {
        assert.deepEqual(body, { ok: true });
        assert.match(calls[0].url, /\/v1\/reports\/authoritative-session\/append$/);
        assert.deepEqual(calls[0].body, { role: "reviewer", monologue: "daily note" });
      } else if (scenario.expected === 503) {
        assert.deepEqual(body, { error: "Concordia not registered for this session" });
      } else if (scenario.status === 0) {
        assert.deepEqual(body, { error: "fetch failed" });
      } else {
        const path = "route" in scenario ? "/v1/sessions/authoritative-session/event" : "/v1/reports/authoritative-session/append";
        assert.deepEqual(body, { error: `Concordia POST ${path}: HTTP ${scenario.status} ${scenario.body.slice(0, 200)}` });
      }
    } finally {
      sidecar.close();
    }
  });
}
