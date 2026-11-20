import { closeSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:2ec70dc3 */
import augurContract_50b59d78 from './contracts/agy-binding.contract.js'; /* augur-inject:contract-predicate:a4af12d7 */

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const STREAMING = /^[IWEF]\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+conversation_manager\.go:\d+\] Streaming conversation ([\da-f-]+)\s*$/i;
const STOPPING = /^[IWEF]\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+conversation_manager\.go:\d+\] Stopping conversation\b/;

export function selectAgyConversation(
  workspaceIds: string[],
  loggedId: string | null,
  presenceCreatedAt: number | null,
  spawnedAt: number,
): string | null {
  if (!loggedId || !UUID.test(loggedId) || presenceCreatedAt === null || presenceCreatedAt < spawnedAt) return null;
  return workspaceIds.length === 1 && workspaceIds[0] === loggedId ? loggedId : null;
}
// @ts-expect-error augur-inject
selectAgyConversation = contract(selectAgyConversation, { ...augurContract_50b59d78, contractId: 'C-9', mode: 'observe', sample: 1, where: 'src/agy-binding.ts:8', rule: 'contract-wrap', id: '50b59d78' }); /* augur-inject:contract-wrap:50b59d78 */

function workspaceKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function mappedIds(root: string, cwd: string): string[] {
  const mapping: unknown = JSON.parse(readFileSync(join(root, "cache", "last_conversations.json"), "utf8"));
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return [];
  const key = workspaceKey(cwd);
  const ids = new Set<string>();
  for (const [path, id] of Object.entries(mapping)) {
    if (typeof id === "string" && isAbsolute(path) && workspaceKey(path) === key) ids.add(id);
  }
  return [...ids];
}

export interface AgyConversation {
  id: string;
  path: string;
  presenceIdentity: string;
}

export function bindAgyConversation(root: string, cwd: string, loggedId: string | null, spawnedAt: number): AgyConversation | null {
  if (!loggedId || !UUID.test(loggedId)) return null;
  const lock = readPresence(root, loggedId);
  if (!lock || !selectAgyConversation(mappedIds(root, cwd), loggedId, lock.createdAt, spawnedAt)) return null;
  const path = join(root, "conversations", loggedId + ".db");
  return lstatSync(path).isFile() ? { id: loggedId, path, presenceIdentity: lock.identity } : null;
}

export function readPresence(root: string, id: string): { createdAt: number; identity: string } | null {
  const stat = lstatSync(join(root, "presence", id + ".lock"), { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  return {
    createdAt: Number(stat.birthtimeMs),
    identity: [stat.dev, stat.ino, stat.birthtimeNs].join(":"),
  };
}

/** Read only operational records from the log for this invocation. */
export class AgyConversationLog {
  private offset = 0;
  private remainder = "";
  private id: string | null = null;

  constructor(private readonly path: string) {}

  scan(): { id: string | null; caughtUp: boolean } {
    const size = statSync(this.path, { throwIfNoEntry: false })?.size ?? 0;
    if (size < this.offset) throw new Error("agy log was truncated");
    if (size === this.offset) return { id: this.id, caughtUp: true };
    const fd = openSync(this.path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(size - this.offset, 128 * 1024));
      const length = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += length;
      const lines = (this.remainder + buffer.toString("utf8", 0, length)).split("\n");
      this.remainder = lines.pop()?.slice(-1024) ?? "";
      for (const line of lines) {
        const match = line.match(STREAMING);
        if (match && UUID.test(match[1])) this.id = match[1];
        else if (STOPPING.test(line)) this.id = null;
      }
      return { id: this.id, caughtUp: this.offset === size && !this.remainder };
    } finally {
      closeSync(fd);
    }
  }
}
