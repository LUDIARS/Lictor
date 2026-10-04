// Fixed reasons only: upstream response text must never enter contract logs.
export default {
  post: (result: boolean, status: number, text: string): true | string => {
    let expected = false;
    if (status === 404) {
      try {
        const body: unknown = JSON.parse(text);
        expected = typeof body === "object" && body !== null &&
          "error" in body && body.error === "report_not_found";
      } catch {
        // Non-JSON upstream errors cannot establish the known code.
      }
    }
    return result === expected ? true : "report response classification mismatch";
  },
};
