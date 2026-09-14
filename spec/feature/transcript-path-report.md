---
id: LI-TRANSCRIPT-PATH-REPORT
title: Acknowledged authoritative transcript path reporting
status: draft
domain: transcript-observation
---

# Transcript path reporting

Lictor owns the identity of the provider transcript it tails. Concordia consumes the reported path and must not discover another file when a report is missing.

`src/transcript-path-report.ts` owns delivery acknowledgement for that binding. `transcript-tail.ts` offers the verified bound path and drives retries with the existing poll, including idle polls. `wrap.ts` returns the PATCH promise; rejection must not become success.

One request can be in flight, with only the latest desired path retained. Old path completion cannot acknowledge a newer binding. Failures retry with 1–30 second capped exponential backoff and a diagnostic; successful delivery suppresses duplicate reports. Stopping the tail prevents new sends. The existing Concordia HTTP client owns the request timeout and request resources.

Tests in `tests/transcript-path-report.test.ts` cover transient failure while idle, serialized rotation, coalescing and stop. Tests have not been executed under the active session policy. No new endpoint, service, dependency or automatic restart is introduced.
