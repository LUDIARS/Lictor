type Payload = { repo?: string; branch?: string; desc?: string };
type Probe = { isDirectory(path: string): boolean; currentBranch(path: string): string | null };
type Result = { ok: true; payload: Payload } | { ok: false; error: string };

// Fixed diagnostics only: never include paths.
export default {
  post: (result: Result, payload: Payload, probe: Probe): true | string => {
    if (payload.repo === undefined) return result.ok && result.payload === payload ? true : "non-repo payload changed";
    if (!probe.isDirectory(payload.repo)) return result.ok ? "missing repo accepted" : true;
    const current = probe.currentBranch(payload.repo);
    if (current === null) return result.ok ? "non-checkout accepted" : true;
    const expected = payload.branch || (current && current !== "HEAD" ? current : undefined);
    if (expected === undefined) return result.ok ? "detached checkout accepted without branch" : true;
    return result.ok && result.payload.branch === expected && result.payload.repo === payload.repo
      ? true : "branch fill mismatch";
  },
};
