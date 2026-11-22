export default {
  post: (result: boolean, status: number, body: string): true | string => {
    if ([408, 502, 504].includes(status)) {
      return result || "a gateway or request timeout leaves the submission unknown";
    }
    if (status !== 200) return !result || "a definitive HTTP rejection must pass through";
    let value: { submitted?: boolean; reason?: string; detail?: string } | null;
    try {
      value = JSON.parse(body);
    } catch {
      return !result || "unrecognized response text must pass through";
    }
    const postTransportLoss = [
      "Revisor /v1/local-prs timed out after 15000ms",
      "Revisor /v1/local-prs request failed: fetch failed",
    ].includes(value?.detail ?? "");
    if (value?.submitted === false && value.reason === "error" && postTransportLoss) {
      return result || "Concordia returned an unconfirmed Revisor POST outcome";
    }
    if (value?.submitted === true || value?.reason === "already_open" || value?.reason === "no_commits" ||
        value?.detail === "Revisor /v1/local-prs failed (409): conflict") {
      return !result || "a known acceptance or rejection must pass through";
    }
    return true;
  },
};
