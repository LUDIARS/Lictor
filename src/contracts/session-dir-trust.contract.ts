import {
  type ClaudeJsonFs,
  defaultClaudeJsonFs,
  loadClaudeJson,
  normalizeProjectKey,
  resolveClaudeJsonPath,
} from "../claude-json.js";
import { findSessionDirKey, isSessionDirKey } from "../session-dir-key.js";

type Opts = {
  sessionDir: string;
  sessionsRoot: string;
  claudeJsonPath?: string;
  fsApi?: ClaudeJsonFs;
};
type Result = { trustGranted: boolean; prunedCount: number } | null;

// Fixed diagnostics only: never include paths (they carry the user's home dir).
export default {
  post: (result: Result, opts: Opts): true | string => {
    const own = normalizeProjectKey(opts.sessionDir);
    if (!isSessionDirKey(own, opts.sessionsRoot)) {
      return result === null ? true : "non-session dir trusted";
    }
    if (result === null) return true;
    if (result.trustGranted !== true) return "trust not granted";
    const fsApi = opts.fsApi ?? defaultClaudeJsonFs;
    const doc = loadClaudeJson(opts.claudeJsonPath ?? resolveClaudeJsonPath(), fsApi);
    if (!doc) return "claude config unreadable after seed";
    const key = findSessionDirKey(doc.projects, own);
    if (key === undefined || doc.projects[key]?.hasTrustDialogAccepted !== true) {
      return "session dir trust not persisted";
    }
    for (const other of Object.keys(doc.projects)) {
      if (other === key || !isSessionDirKey(other, opts.sessionsRoot)) continue;
      if (!fsApi.existsSync(other)) return "stale session dir entry kept";
    }
    return true;
  },
};
