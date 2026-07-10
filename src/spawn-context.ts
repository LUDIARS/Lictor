/** Concordia stamps these env vars on every interactive session it spawns. */
export const CONCORDIA_SPAWN_ID_ENV = "CONCORDIA_SPAWN_ID";
export const CONCORDIA_SPAWN_CWD_MODE_ENV = "CONCORDIA_SPAWN_CWD_MODE";

/**
 * Return the spawn correlation metadata Concordia needs for its mandatory
 * initial project-identification inject. Non-Cc launches return no metadata.
 */
export function concordiaSpawnSessionMetadata(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const spawnId = env[CONCORDIA_SPAWN_ID_ENV]?.trim();
  const cwdMode = env[CONCORDIA_SPAWN_CWD_MODE_ENV]?.trim();
  if (!spawnId || (cwdMode !== "provided" && cwdMode !== "omitted")) return {};
  return {
    concordia_spawn_id: spawnId,
    concordia_spawn_cwd_mode: cwdMode,
  };
}
