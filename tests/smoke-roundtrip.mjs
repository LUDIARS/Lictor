// Smoke: register a real Concordia session via ConcordiaClient, then unregister.
// Requires Concordia running on 127.0.0.1:17330.
import { ConcordiaClient, loadConcordiaConfig } from "../src/concordia.ts";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const cfg = loadConcordiaConfig();
console.log("config:", cfg);
const client = new ConcordiaClient(cfg);
const id = `lictor-smoke-${randomUUID()}`;

try {
  const reg = await client.register({
    id,
    provider: "claude-code",
    repo_path: process.cwd(),
    host: hostname(),
    branch: "feat/concordia-integration",
    metadata: { smoke: true },
  });
  console.log("registered:", reg);

  const conflicts = await client.conflicts({
    repo: process.cwd(),
    excludeSession: id,
  });
  console.log("conflicts:", JSON.stringify(conflicts, null, 2));
} catch (err) {
  console.error("smoke roundtrip failed:", err);
  process.exitCode = 1;
} finally {
  await client.unregister(id);
  console.log("unregistered:", id);
}
