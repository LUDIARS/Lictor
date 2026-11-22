import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnknownPrSubmission } from "../src/pr-submit-outcome.js";
import { PrSubmissionUnknownError, requestDirectLocalPr } from "../src/pr-submit-proxy.js";

test("a completed Concordia reply is uncertain only for a Revisor write transport failure", () => {
  const reply = (detail: string) => JSON.stringify({ submitted: false, reason: "error", detail });
  for (const detail of [
    "Revisor /v1/local-prs timed out after 15000ms",
    "Revisor /v1/local-prs request failed: fetch failed",
    "Revisor /v1/local-prs/pr-1/retry request failed: fetch failed",
  ]) {
    assert.equal(isUnknownPrSubmission(200, reply(detail)), true, detail);
  }
  for (const detail of [
    "Revisor /v1/local-prs failed (409): conflict",
    "Revisor /v1/local-prs failed (403): permission denied",
    "Revisor /v1/local-prs?state=open timed out after 15000ms",
    "Revisor /v1/repositories request failed: fetch failed",
  ]) {
    assert.equal(isUnknownPrSubmission(200, reply(detail)), false, detail);
  }
});

test("Concordia transport loss is converted to a fixed diagnostic without another fetch", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("upstream private text");
  });
  await assert.rejects(requestDirectLocalPr("http://127.0.0.1:1", "authoritative-session", {
    repo_path: "E:/repo",
    branch: "feat/example",
  }), PrSubmissionUnknownError);
  assert.equal(fetch.mock.callCount(), 1);
});

test("the proxy keeps the direct submission payload and a completed Concordia reply", async (t) => {
  const endpoint = "http://127.0.0.1:1";
  const reply = { submitted: false, reason: "no_commits" };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, endpoint + "/v1/prs/local/direct");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.deepEqual(JSON.parse(String(options.body)), {
      repo_path: "E:/repo",
      branch: "feat/example",
      session_id: "authoritative-session",
    });
    return Response.json(reply);
  });
  assert.deepEqual(await requestDirectLocalPr(endpoint, "authoritative-session", {
    repo_path: "E:/repo",
    branch: "feat/example",
  }), reply);
  assert.equal(fetch.mock.callCount(), 1);
});
