/** Safe, route-specific diagnostic; never retain the upstream body or identity. */
export class ReportNotFoundError extends Error {
  constructor() {
    super("report_not_found");
    this.name = "ReportNotFoundError";
  }
}

export function isMissingReportResponse(status: number, text: string): boolean {
  if (status !== 404) return false;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON responses are handled by the existing generic error path.
    return false;
  }
  return typeof body === "object" && body !== null &&
    "error" in body && body.error === "report_not_found";
}
