export default {
  post(result: string | null, path: string): true | string {
    const match = /(?:^|[\\/])([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})[\\/]updates\.jsonl$/i.exec(path);
    const expected = path.endsWith("updates.jsonl") ? match?.[1] ?? null : null;
    return result === expected || "Grok discovery accepted a sibling log or missed the parent session ID";
  },
};
