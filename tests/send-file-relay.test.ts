import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RELAY_FILES,
  buildSendFileFallbackText,
  buildSendFileText,
  describeSendFileRelayFailure,
  extractSendFileRelay,
} from "../src/send-file-relay.js";

test("extractSendFileRelay: SendUserFile 以外は中継しない", () => {
  assert.equal(extractSendFileRelay({ tool_name: "Write", tool_input: { files: ["/a.png"] } }), null);
  assert.equal(extractSendFileRelay(null), null);
  assert.equal(extractSendFileRelay("SendUserFile"), null);
});

test("extractSendFileRelay: files が空 / 非配列なら中継しない", () => {
  assert.equal(extractSendFileRelay({ tool_name: "SendUserFile", tool_input: { files: [] } }), null);
  assert.equal(extractSendFileRelay({ tool_name: "SendUserFile", tool_input: { files: "/a.png" } }), null);
  assert.equal(extractSendFileRelay({ tool_name: "SendUserFile", tool_input: {} }), null);
  // 文字列以外が混ざっていても、 残りが空なら中継しない
  assert.equal(extractSendFileRelay({ tool_name: "SendUserFile", tool_input: { files: [1, null] } }), null);
  for (const file of ["../secret", "/tmp/../secret", "\\\\server\\share\\file", "C:/directory/"]) {
    assert.equal(
      extractSendFileRelay({ tool_name: "SendUserFile", tool_input: { files: [file] } }),
      null,
    );
  }
});

test("extractSendFileRelay: files と caption を取り出す", () => {
  const relay = extractSendFileRelay({
    tool_name: "SendUserFile",
    tool_input: { files: ["C:/x/請求書.pdf", 7, "/tmp/b.png"], caption: "8月分" },
  });
  assert.deepEqual(relay, { files: ["C:/x/請求書.pdf", "/tmp/b.png"], caption: "8月分" });
});

test("extractSendFileRelay: caption が空文字なら持たせない", () => {
  const relay = extractSendFileRelay({
    tool_name: "SendUserFile",
    tool_input: { files: ["/a.png"], caption: "" },
  });
  assert.deepEqual(relay, { files: ["/a.png"] });
});

test("extractSendFileRelay: Concordia の添付上限で切る", () => {
  const files = Array.from({ length: MAX_RELAY_FILES + 5 }, (_, i) => `/tmp/f${i}.png`);
  const relay = extractSendFileRelay({ tool_name: "SendUserFile", tool_input: { files } });
  assert.equal(relay?.files.length, MAX_RELAY_FILES);
  assert.equal(relay?.files[0], "/tmp/f0.png");
});

test("buildSendFileText: caption 無しはファイル名だけを並べる", () => {
  const text = buildSendFileText({ files: ["C:\\x\\請求書.pdf", "/tmp/b.png"] });
  assert.equal(text, "請求書.pdf / b.png");
});

test("buildSendFileText: caption があれば本文の先頭に置く", () => {
  const text = buildSendFileText({ files: ["/tmp/a.png"], caption: "8月分" });
  assert.equal(text, "8月分\na.png");
});

test("buildSendFileText: Concordia の text 上限 2000 を超えない", () => {
  const text = buildSendFileText({ files: ["/tmp/a.png"], caption: "あ".repeat(3000) });
  assert.equal(text.length, 2000);
  assert.ok(text.endsWith("…"));
});

test("buildSendFileFallbackText: 理由とファイル名だけを残す", () => {
  const text = buildSendFileFallbackText(
    { files: ["C:/x/請求書.pdf"], caption: "8月分" },
    "outside_roots",
  );
  assert.match(text, /8月分/);
  assert.match(text, /outside_roots/);
  assert.match(text, /請求書\.pdf/);
  assert.doesNotMatch(text, /C:\/x/);
  assert.doesNotMatch(
    buildSendFileFallbackText({ files: ["C:/local-secret/"] }, "rejected"),
    /local-secret/,
  );
});

test("extractSendFileRelay: POSIX / Windows drive の絶対パスを受け付ける", () => {
  const relay = extractSendFileRelay({
    tool_name: "SendUserFile",
    tool_input: { files: ["/tmp/a", "C:\\tmp\\b"] },
  });
  assert.deepEqual(relay?.files, ["/tmp/a", "C:\\tmp\\b"]);
});

test("describeSendFileRelayFailure: 外部応答や URL を公開理由へ含めない", () => {
  const reason = describeSendFileRelayFailure(
    new Error("Concordia POST /v1/chat: HTTP 400 private response from http://internal.example"),
  );
  assert.equal(reason, "attachment relay failed (HTTP 400)");
  assert.doesNotMatch(reason, /private|internal\.example|\/v1\/chat/);
  assert.equal(describeSendFileRelayFailure("secret response"), "attachment relay failed");
});
