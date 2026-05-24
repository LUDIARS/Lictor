import http from "node:http";

export async function runClient(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  const port = process.env.LICTOR_PORT;
  if (!port) {
    process.stderr.write(
      "lictor cli: LICTOR_PORT not set — this command must run under `lictor claude ...`.\n",
    );
    process.exit(2);
  }

  if (sub === "title") {
    const text = rest.join(" ");
    if (!text) {
      process.stderr.write("usage: lictor cli title <text>\n");
      process.exit(2);
    }
    await postJson(port, "/v1/title", { text });
    return;
  }

  if (sub === "meta") {
    const body = await getText(port, "/v1/meta");
    process.stdout.write(body + "\n");
    return;
  }

  if (sub === "health") {
    const body = await getText(port, "/v1/health");
    process.stdout.write(body + "\n");
    return;
  }

  process.stderr.write(`lictor cli: unknown subcommand '${sub ?? "(none)"}'\n`);
  process.exit(2);
}

function postJson(port: string, path: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            const txt = Buffer.concat(chunks).toString("utf8");
            reject(new Error(`HTTP ${res.statusCode}: ${txt}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function getText(port: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode === 200) resolve(body);
          else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
