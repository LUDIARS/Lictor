---
id: LI-EXPLICIT-CODEX-RESUME
title: Exact transcript binding for explicit Codex resume
status: draft
domain: transcript-observation
---

# Explicit resume relay

A user resumes an existing Codex conversation without losing its ordinary Discord replies. The wrapper owns launch intent; transcript observation owns identity selection and delivery.

- Accept the explicit `resume <UUID>` argument as a thread identity. Do not infer identities from task names, latest files, or old injected skills.
- Legacy resume pins that identity. A matching old rollout may have an earlier wrapper originator; bypass only the originator and file-age candidate filters for the exact explicit identity. Continue rejecting subagent/exec records and a different cwd. Other launches retain originator isolation.
- An explicit resume with app-server transport is rejected, rather than creating another thread.
- Replay boundary: only timestamped records at or after this wrapper launch are eligible for relay; older/unknown-time records must not recreate replies or pending questions. This applies after repin as well. Previously undelivered history requires separate delivery reconciliation.
- Claim ownership and safe transcript-directory checks remain unchanged. No new HTTP endpoint or persistent token is added.

## Verification

Add behavior coverage for UUID parsing, old-originator exact identity, wrong identity/cwd/subagent rejection, and old versus new response relay. Tests are authored but not executed by the session under the active execution policy. Deployment requires main integration/build and replacement of the affected wrapper; source edits do not modify a running process.
