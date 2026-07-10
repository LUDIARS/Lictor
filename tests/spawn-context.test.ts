import test from "node:test";
import assert from "node:assert/strict";
import {
  concordiaSpawnSessionMetadata,
  CONCORDIA_SPAWN_CWD_MODE_ENV,
  CONCORDIA_SPAWN_ID_ENV,
} from "../src/spawn-context.js";

test("concordiaSpawnSessionMetadata forwards a cwd-provided Cc spawn identity", () => {
  assert.deepEqual(concordiaSpawnSessionMetadata({
    [CONCORDIA_SPAWN_ID_ENV]: " spawn-1 ",
    [CONCORDIA_SPAWN_CWD_MODE_ENV]: "provided",
  }), {
    concordia_spawn_id: "spawn-1",
    concordia_spawn_cwd_mode: "provided",
  });
});

test("concordiaSpawnSessionMetadata forwards a cwd-omitted Cc spawn identity", () => {
  assert.deepEqual(concordiaSpawnSessionMetadata({
    [CONCORDIA_SPAWN_ID_ENV]: "spawn-2",
    [CONCORDIA_SPAWN_CWD_MODE_ENV]: "omitted",
  }), {
    concordia_spawn_id: "spawn-2",
    concordia_spawn_cwd_mode: "omitted",
  });
});

test("concordiaSpawnSessionMetadata rejects incomplete or invalid identities", () => {
  assert.deepEqual(concordiaSpawnSessionMetadata({
    [CONCORDIA_SPAWN_CWD_MODE_ENV]: "provided",
  }), {});
  assert.deepEqual(concordiaSpawnSessionMetadata({
    [CONCORDIA_SPAWN_ID_ENV]: "spawn-3",
    [CONCORDIA_SPAWN_CWD_MODE_ENV]: "unknown",
  }), {});
});
