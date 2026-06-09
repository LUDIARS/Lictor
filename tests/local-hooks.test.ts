import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHooks, runHooks } from "../src/local-agent/hooks.js";

const node = JSON.stringify(process.execPath); // quote (may contain spaces)

test("loadHooks returns empty for missing file", () => {
  assert.deepEqual(loadHooks(join(tmpdir(), "no-such-hooks.json")), {});
});

test("UserPromptSubmit hook stdout becomes additional context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lictor-hk-"));
  try {
    const hooksPath = join(dir, "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { command: `${node} -e "process.stdout.write('CTX-FROM-HOOK')"` },
          ],
        },
      }),
      "utf8",
    );
    const hooks = loadHooks(hooksPath);
    const out = await runHooks(
      "UserPromptSubmit",
      { sessionId: "s", cwd: process.cwd(), prompt: "hi" },
      hooks,
    );
    assert.equal(out, "CTX-FROM-HOOK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHooks for event with no entries returns empty string", async () => {
  const out = await runHooks("Stop", { sessionId: "s", cwd: process.cwd() }, {});
  assert.equal(out, "");
});
