type Env = Record<string, string | undefined>;

const KEYS = ["LICTOR_SESSION_ID", "CONCORDIA_SESSION_ID"];

// Fixed diagnostics only: never include env values (they may carry credentials).
export default {
  post: (result: Env, env: Env, sessionId: string | null): true | string => {
    for (const key of KEYS) {
      if (sessionId === null) {
        if (Object.prototype.hasOwnProperty.call(result, key)) return "inherited session identity kept";
      } else if (result[key] !== sessionId) {
        return "session identity not pinned to own id";
      }
    }
    for (const [key, value] of Object.entries(env)) {
      if (KEYS.includes(key)) continue;
      if (result[key] !== value) return "unrelated env changed";
    }
    return result === env ? "input env mutated in place" : true;
  },
};
