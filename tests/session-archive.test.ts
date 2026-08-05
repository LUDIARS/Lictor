import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  archiveSessionLog,
  compressTranscriptForArchive,
} from "../src/session-archive.js";
import { gatherBaseMeta } from "../src/meta.js";
import {
  activeReposPath,
  claudeSessionStatePath,
  claudeTranscriptStatePath,
} from "../src/active-repos.js";

test("archive writes transcript, copied state, and metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "lictor-archive-"));
  try {
    const state = join(root, "state");
    const transcript = join(root, "transcript.jsonl");
    mkdirSync(state);
    writeFileSync(claudeSessionStatePath(state, "lictor-test"), "claude-id", "utf8");
    writeFileSync(claudeTranscriptStatePath(state, "lictor-test"), transcript, "utf8");
    writeFileSync(activeReposPath(state, "claude-id"), root, "utf8");
    writeFileSync(transcript, '{"type":"message"}\n', "utf8");
    const meta = gatherBaseMeta();
    const result = archiveSessionLog({
      workspaceRoot: root,
      sessionId: "lictor-test",
      meta,
      activeRepos: [root],
      reason: "test",
      stateDir: state,
      now: new Date("2026-08-02T00:00:00Z"),
    });
    assert.equal(result.truncated, false);
    assert.equal(gunzipSync(readFileSync(join(result.path, "transcript.jsonl.gz"))).toString(), '{"type":"message"}\n');
    assert.equal(readFileSync(join(result.path, "state", "claude-session-lictor-test.txt"), "utf8"), "claude-id");
    assert.ok(existsSync(join(result.path, "state", "active-repos-claude-id.txt")));
    assert.equal(readFileSync(transcript, "utf8"), '{"type":"message"}\n', "source transcript must remain");
    const archivedMeta = JSON.parse(readFileSync(join(result.path, "meta.json"), "utf8"));
    assert.equal(archivedMeta.started_at, meta.start_iso);
    assert.equal(archivedMeta.ended_at, "2026-08-02T00:00:00.000Z");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compression threshold is evaluated after gzip and retains both edges", () => {
  const source = Buffer.from("0123456789abcdefghij", "utf8");
  const result = compressTranscriptForArchive(source, 1, 5);
  assert.equal(result.truncated, true);
  assert.equal(gunzipSync(result.data).toString("utf8"), "01234\nfghij");
});
