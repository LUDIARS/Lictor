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
type Result = { removed: boolean; prunedCount: number } | null;

// Fixed diagnostics only: never include paths (they carry the user's home dir).
export default {
  post: (result: Result, opts: Opts): true | string => {
    const own = normalizeProjectKey(opts.sessionDir);
    if (!isSessionDirKey(own, opts.sessionsRoot)) {
      return result === null ? true : "non-session dir released";
    }
    if (result === null) return true;
    const doc = loadClaudeJson(opts.claudeJsonPath ?? resolveClaudeJsonPath(), opts.fsApi ?? defaultClaudeJsonFs);
    if (!doc) return "claude config unreadable after release";
    return findSessionDirKey(doc.projects, own) === undefined ? true : "session dir entry kept";
  },
};
