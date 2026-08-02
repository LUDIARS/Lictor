import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installVestigiumBestEffort } from "../src/vestigium.js";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

/** LICTOR_DEBUG を触るテストの後始末。 */
async function withDebug<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.LICTOR_DEBUG;
  if (value === undefined) delete process.env.LICTOR_DEBUG;
  else process.env.LICTOR_DEBUG = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.LICTOR_DEBUG;
    else process.env.LICTOR_DEBUG = prev;
  }
}

/** process.stderr.write を捕捉する。 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    captured += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  return captured;
}

test("install is called with the lictor observability options", async () => {
  const calls: unknown[] = [];
  await installVestigiumBestEffort(async () => ({
    install: (options: unknown) => {
      calls.push(options);
    },
  }));
  assert.deepEqual(calls, [
    { serviceCode: "lictor", captureConsole: true, pinoTransport: false },
  ]);
});

test("a missing Vestigium dist degrades instead of throwing", async () => {
  const out = await withDebug(undefined, () =>
    captureStderr(async () => {
      await installVestigiumBestEffort(async () => {
        throw new Error("Cannot find module '.../@ludiars/vestigium/dist/index.js'");
      });
    }),
  );
  // 既定では hook / 通常 CLI の stderr を汚さない。
  assert.equal(out, "");
});

test("a throwing install() also degrades", async () => {
  const out = await withDebug(undefined, () =>
    captureStderr(async () => {
      await installVestigiumBestEffort(async () => ({
        install: () => {
          throw new Error("transport boom");
        },
      }));
    }),
  );
  assert.equal(out, "");
});

test("a rejecting async install() degrades instead of becoming an unhandled rejection", async () => {
  const out = await withDebug("1", () =>
    captureStderr(async () => {
      await installVestigiumBestEffort(async () => ({
        install: async () => {
          throw new Error("async transport boom");
        },
      }));
    }),
  );
  assert.match(out, /async transport boom/);
});

test("LICTOR_DEBUG=1 reports the degradation reason on stderr", async () => {
  const out = await withDebug("1", () =>
    captureStderr(async () => {
      await installVestigiumBestEffort(async () => {
        throw new Error("Cannot find module");
      });
    }),
  );
  assert.match(out, /Vestigium unavailable/);
  assert.match(out, /Cannot find module/);
  assert.ok(out.endsWith("\n"));
});

test("the degradation reason stays on a single stderr line", async () => {
  const out = await withDebug("1", () =>
    captureStderr(async () => {
      await installVestigiumBestEffort(async () => {
        throw new Error("Cannot find module\nRequire stack:\n- /tmp/dist/index.js");
      });
    }),
  );
  assert.equal(out.split("\n").filter((line) => line !== "").length, 1);
});

test("control characters in the reason never reach the terminal", async () => {
  const out = await withDebug("1", () =>
    captureStderr(async () => {
      await installVestigiumBestEffort(async () => {
        throw new Error("boom \x1b]0;pwned\x07 \x07end");
      });
    }),
  );
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(out), false);
  assert.match(out, /boom .*end/);
});

test("a closed stderr does not turn degradation into a crash", async () => {
  await withDebug("1", async () => {
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: () => boolean }).write = () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    };
    try {
      await installVestigiumBestEffort(async () => {
        throw new Error("Cannot find module");
      });
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
  });
});

// 元の障害は 「module load 時点で落ちる」 こと。 静的 import が復活すると
// `lictor cli task set` 等が sidecar に届く前に全滅するので、 source 側で固定する。
test("no src module statically imports the observability package", () => {
  const offenders = tsFiles(SRC_DIR).filter((file) => {
    const source = readFileSync(file, "utf8");
    return (
      /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']@ludiars\/vestigium["']/m.test(source) ||
      /^\s*import\s*["']@ludiars\/vestigium["']/m.test(source)
    );
  });
  assert.deepEqual(offenders, []);
});
