import { codexTranscriptMetaStartedAt } from "./provider.js";

export interface CodexTranscriptCandidate {
  path: string;
  firstLine: string | null;
}

interface OwnedConversation {
  path: string;
  sessionId: string;
  startedAt: number;
}

/** Select a later top-level conversation belonging to this exact Lictor wrapper. */
export function findCodexTranscriptSuccessor(
  current: CodexTranscriptCandidate,
  candidates: readonly CodexTranscriptCandidate[],
  owner: string,
  expectedOriginator: string | null,
): OwnedConversation | null {
  // Custom/shared originators are not proof of ownership across session IDs.
  if (!owner || expectedOriginator !== `lictor:${owner}`) return null;
  const previous = ownedConversation(current, expectedOriginator);
  if (!previous) return null;
  const newer = candidates
    .map((candidate) => ownedConversation(candidate, expectedOriginator))
    .filter((candidate): candidate is OwnedConversation => candidate !== null
      && candidate.sessionId !== previous.sessionId
      && candidate.startedAt > previous.startedAt)
    .sort((a, b) => b.startedAt - a.startedAt);
  if (!newer.length) return null;
  // Equal creation times are ambiguous. File modification times cannot resolve ownership.
  if (newer[1]?.startedAt === newer[0].startedAt) return null;
  return newer[0];
}

function ownedConversation(
  candidate: CodexTranscriptCandidate,
  originator: string,
): OwnedConversation | null {
  if (!candidate.firstLine) return null;
  let record: { type?: unknown; payload?: Record<string, unknown> };
  try {
    record = JSON.parse(candidate.firstLine);
  } catch {
    return null; // A partially written metadata line is retried on the next discovery.
  }
  if (!record || record.type !== "session_meta") return null;
  const meta = record.payload;
  if (!meta || meta.originator !== originator) return null;
  // payload.source は旧形式が文字列 ("cli")、 新しめの codex は variant オブジェクト
  // ({ cli: {...} } 等)。 どちらの形でも同じ判定を効かせる (codexTranscriptMetaAccepts と同じ扱い)。
  const sourceVariants = typeof meta.source === "string"
    ? [meta.source]
    : typeof meta.source === "object" && meta.source !== null && !Array.isArray(meta.source)
      ? Object.keys(meta.source as Record<string, unknown>)
      : [];
  if (!sourceVariants.includes("cli") || sourceVariants.includes("subagent")) return null;
  if (meta.thread_source === "subagent" || meta.parent_thread_id) return null;
  const sessionId = meta.session_id ?? meta.id;
  const startedAt = codexTranscriptMetaStartedAt(candidate.firstLine);
  if (typeof sessionId !== "string" || !sessionId || startedAt === null) return null;
  return { path: candidate.path, sessionId, startedAt };
}
