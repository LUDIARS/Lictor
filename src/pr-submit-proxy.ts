const CONCORDIA_PR_DEADLINE_MS = 90_000;
const CONCORDIA_PR_PATH = "/v1/prs/local/direct";

export class PrSubmissionUnknownError extends Error {
  constructor() {
    super("pr_submission_result_unknown");
  }
}

/** Stamp the session and bound the one upstream POST, including its response body. */
export async function requestDirectLocalPr(
  baseUrl: string,
  sessionId: string,
  payload: { repo_path: string; branch?: string },
): Promise<unknown> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${baseUrl}${CONCORDIA_PR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, session_id: sessionId }),
      signal: AbortSignal.timeout(CONCORDIA_PR_DEADLINE_MS),
      redirect: "error",
    });
    text = await response.text();
  } catch {
    throw new PrSubmissionUnknownError();
  }
  if (response.status === 408 || response.status === 502 || response.status === 504) {
    throw new PrSubmissionUnknownError();
  }
  if (!response.ok) {
    throw new Error(`Concordia POST ${CONCORDIA_PR_PATH}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new PrSubmissionUnknownError();
  }
}
