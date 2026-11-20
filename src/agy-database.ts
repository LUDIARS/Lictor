import { createRequire } from "node:module";
import type { AgyRow } from "./agy-steps.js";

interface AgyDatabaseHandle {
  prepare(sql: string): { all(cursor: number, limit: number): AgyRow[] };
  close(): void;
}

const requireBuiltin = createRequire(import.meta.url);

export function readAgyRows(path: string, cursor: number, limit: number): AgyRow[] {
  // Keep Lictor's older Node 22 entry points usable. Only agy needs node:sqlite.
  const { DatabaseSync } = requireBuiltin("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: true }) => AgyDatabaseHandle;
  };
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    // Opening the regular path in read-only mode still reads the writer's WAL.
    // The single statement gives a consistent view of mutable statuses and rows.
    return database.prepare(
      "SELECT idx, step_type, status, step_format,"
      + " CASE WHEN step_type IN (14, 132) AND length(metadata) <= 2097152 THEN metadata END AS metadata,"
      + " CASE WHEN step_type IN (14, 15) AND length(step_payload) <= 2097152 THEN step_payload END AS step_payload"
      + " FROM steps WHERE idx > ? AND step_type IN (14, 15, 132) ORDER BY idx LIMIT ?",
    ).all(cursor, limit);
  } finally {
    database.close();
  }
}
