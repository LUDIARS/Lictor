export default {
  post(result: string | null, workspaceIds: string[], loggedId: string | null, presenceCreatedAt: number | null, spawnedAt: number): true | string | undefined {
    const eligible = !!loggedId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(loggedId)
      && workspaceIds.length === 1 && workspaceIds[0] === loggedId
      && presenceCreatedAt !== null && presenceCreatedAt >= spawnedAt;
    if (result !== (eligible ? loggedId : null)) return "agy conversation lacked matching launch evidence";
    return eligible ? true : undefined;
  },
};
