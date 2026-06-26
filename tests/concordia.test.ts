import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConcordiaConfig } from "../src/concordia.js";

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
