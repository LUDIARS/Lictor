import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  activeReposPath,
  claudeSessionStatePath,
  claudeTranscriptStatePath,
  readClaudeSessionId,
  readClaudeTranscriptPath,
  resolveActiveReposDir,
} from "./active-repos.js";
import type { Meta } from "./meta.js";

const MAX_COMPRESSED_TRANSCRIPT_BYTES = 100 * 1024 * 1024;
const RETAINED_EDGE_BYTES = 50 * 1024 * 1024;

// @implements spec/feature/session-shutdown.md

export interface SessionArchiveOptions {
  workspaceRoot?: string;
  sessionId: string;
  claudeSessionId?: string | null;
  meta: Meta;
  activeRepos: string[];
  reason: string;
  transcriptPath?: string | null;
  stateDir?: string;
  now?: Date;
}

export interface SessionArchiveResult {
  path: string;
  truncated: boolean;
}

/**
 * session-end 後に残す transcript/state/meta のスナップショットを作る。
 * 元ファイルは provider がまだ handle を保持し得るため、移動せずコピーする。
 */
export function archiveSessionLog(options: SessionArchiveOptions): SessionArchiveResult {
  assertSafePathSegment(options.sessionId, "session id");
  const endedAt = options.now ?? new Date();
  const stateDir = options.stateDir ?? resolveActiveReposDir();
  const workspaceRoot = options.workspaceRoot ?? resolve(stateDir, "..", "..");
  const day = endedAt.toISOString().slice(0, 10);
  const archiveDir = join(workspaceRoot, "session-logs", "archive", day, options.sessionId);
  mkdirSync(archiveDir, { recursive: true });

  const sessionStatePath = claudeSessionStatePath(stateDir, options.sessionId);
  const claudeSessionId = options.claudeSessionId ?? readClaudeSessionId(sessionStatePath);
  const transcriptStatePath = claudeTranscriptStatePath(stateDir, options.sessionId);
  const transcriptPath = options.transcriptPath ?? readClaudeTranscriptPath(transcriptStatePath);

  copySessionStateFiles({
    archiveDir,
    stateDir,
    sessionId: options.sessionId,
    claudeSessionId,
  });

  const truncated = archiveTranscript(transcriptPath, archiveDir);
  writeFileSync(
    join(archiveDir, "meta.json"),
    `${JSON.stringify({
      session_id: options.sessionId,
      provider: options.meta.provider,
      persona: options.meta.persona,
      cwd: options.meta.cwd,
      active_repos: options.activeRepos,
      started_at: options.meta.start_iso,
      ended_at: endedAt.toISOString(),
      reason: options.reason,
      truncated,
    }, null, 2)}\n`,
    "utf8",
  );
  return { path: archiveDir, truncated };
}

function copySessionStateFiles(input: {
  archiveDir: string;
  stateDir: string;
  sessionId: string;
  claudeSessionId: string | null;
}): void {
  const sources = [
    claudeSessionStatePath(input.stateDir, input.sessionId),
    claudeTranscriptStatePath(input.stateDir, input.sessionId),
    ...(input.claudeSessionId
      ? [activeReposPath(input.stateDir, input.claudeSessionId)]
      : []),
  ];
  const existing = sources.filter((path) => existsSync(path));
  if (existing.length === 0) return;
  const targetDir = join(input.archiveDir, "state");
  mkdirSync(targetDir, { recursive: true });
  for (const source of existing) {
    copyFileSync(source, join(targetDir, basename(source)));
  }
}

function archiveTranscript(transcriptPath: string | null, archiveDir: string): boolean {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  const source = readFileSync(transcriptPath);
  const result = compressTranscriptForArchive(source);
  writeFileSync(join(archiveDir, "transcript.jsonl.gz"), result.data);
  return result.truncated;
}

export function compressTranscriptForArchive(
  source: Buffer,
  maxCompressedBytes = MAX_COMPRESSED_TRANSCRIPT_BYTES,
  retainedEdgeBytes = RETAINED_EDGE_BYTES,
): { data: Buffer; truncated: boolean } {
  const compressed = gzipSync(source);
  if (compressed.length <= maxCompressedBytes) {
    return { data: compressed, truncated: false };
  }
  const retained = Buffer.concat([
    source.subarray(0, retainedEdgeBytes),
    Buffer.from("\n"),
    source.subarray(Math.max(0, source.length - retainedEdgeBytes)),
  ]);
  return { data: gzipSync(retained), truncated: true };
}

function assertSafePathSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`${label} contains unsafe path characters`);
  }
}
