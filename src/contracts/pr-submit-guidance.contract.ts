export default {
  post: (message: string, repo: string, branch: string): true | string =>
    message.includes(JSON.stringify(repo)) && (!branch || message.includes(JSON.stringify(branch))) &&
      message.includes("result unknown") && message.includes("Do not resubmit") &&
      message.includes("GET /v1/prs/revisor") && message.includes("headRef")
      ? true
      : "the diagnostic must identify the target and the read-only reconciliation path",
};
