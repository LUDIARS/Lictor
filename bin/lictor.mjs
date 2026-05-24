#!/usr/bin/env node
import("../dist/cli.js").catch((err) => {
  console.error("[lictor] failed to load CLI:", err.message);
  console.error("[lictor] did you run `npm run build`? for dev use `npm run dev -- ...`");
  process.exit(1);
});
