import { contract } from './contracts/contract-runtime.js'; /* augur-inject:import:7e02732b */
import augurContract_ec26bd6c from './contracts/pr-submit-outcome.contract.js'; /* augur-inject:contract-predicate:372087bf */
import augurContract_1100d899 from './contracts/pr-submit-guidance.contract.js'; /* augur-inject:contract-predicate:500beec2 */

// Match only Concordia's diagnostics for the Revisor write, not its read-only
// repository/PR lookups or Revisor's definitive "failed (<status>)" responses.
const REVISOR_WRITE_TRANSPORT_LOSS =
  /^Revisor \/v1\/local-prs(?:\/[^/\s]+\/retry)? (?:timed out after \d+ms$|request failed: )/;

/** @implements LI-PR-SUBMIT-01 */
export function isUnknownPrSubmission(status: number, body: string): boolean {
  if (status === 408 || status === 502 || status === 504) return true;
  if (status !== 200) return false;
  let response: { submitted?: unknown; reason?: unknown; detail?: unknown } | null;
  try {
    response = JSON.parse(body);
  } catch {
    // Keep the CLI's existing pass-through for complete, unrecognized replies.
    return false;
  }
  return response?.submitted === false && response.reason === "error" &&
    typeof response.detail === "string" && REVISOR_WRITE_TRANSPORT_LOSS.test(response.detail);
}
// @ts-expect-error augur-inject
isUnknownPrSubmission = contract(isUnknownPrSubmission, { ...augurContract_ec26bd6c, contractId: 'C-12', mode: 'observe', sample: 1, where: 'src/pr-submit-outcome.ts:2', rule: 'contract-wrap', id: 'ec26bd6c' }); /* augur-inject:contract-wrap:ec26bd6c */

/** @implements LI-PR-SUBMIT-01 */
export function prSubmissionUnknownMessage(repo: string, branch: string): string {
  const targetBranch = branch ? JSON.stringify(branch) : "(checkout branch could not be resolved)";
  return `PR submission result unknown for repository ${JSON.stringify(repo)}, branch ${targetBranch}. ` +
    "Do not resubmit. Check Concordia's read-only GET /v1/prs/revisor for the repository matching this checkout's origin and the branch in headRef.";
}
// @ts-expect-error augur-inject
prSubmissionUnknownMessage = contract(prSubmissionUnknownMessage, { ...augurContract_1100d899, contractId: 'C-13', mode: 'observe', sample: 1, where: 'src/pr-submit-outcome.ts:7', rule: 'contract-wrap', id: '1100d899' }); /* augur-inject:contract-wrap:1100d899 */
