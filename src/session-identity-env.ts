import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:173b2342 */
import augurContract_d28a1cc1 from './contracts/session-identity-env.contract.js'; /* augur-inject:contract-predicate:c4a21464 */
/**
 * Session identity carried to the wrapped CLI through env.
 *
 * The wrapped claude/codex and everything it runs (SessionStart hook,
 * `lictor cli`, the concordia skill) identify "this session" by
 * LICTOR_SESSION_ID / CONCORDIA_SESSION_ID. The Lictor process inherits its
 * own env from whatever launched it — often another Lictor-wrapped session's
 * shell, or a Concordia process restarted from one — so those keys may already
 * name a *different* session.
 *
 * When Concordia registration fails (e.g. Lictor started while Concordia was
 * restarting), wrap previously skipped the overwrite and the inherited id
 * leaked through: hooks wrote `claude-transcript-<other id>.txt`, skills acted
 * as the other session, and Concordia injects addressed to that id were
 * observed in this conversation (2026-11-16 incident). The identity must be
 * decided by this process alone: its own registered id, or nothing.
 */

export const SESSION_IDENTITY_ENV_KEYS = ["LICTOR_SESSION_ID", "CONCORDIA_SESSION_ID"] as const;

/**
 * Return a copy of `env` whose session identity keys equal `sessionId`, or are
 * removed when this process has no registered id. Other keys are untouched.
 */
export function pinSessionIdentityEnv(
  env: NodeJS.ProcessEnv,
  sessionId: string | null,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of SESSION_IDENTITY_ENV_KEYS) {
    if (sessionId === null) delete out[key];
    else out[key] = sessionId;
  }
  return out;
}
// @ts-expect-error augur-inject
pinSessionIdentityEnv = contract(pinSessionIdentityEnv, { ...augurContract_d28a1cc1, contractId: 'C-5', mode: 'observe', sample: 1, where: 'src/session-identity-env.ts:25', rule: 'contract-wrap', id: 'd28a1cc1' }); /* augur-inject:contract-wrap:d28a1cc1 */
