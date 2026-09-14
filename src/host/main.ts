import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RequestSchema } from "./protocol.ts";
import { HostService } from "./service.ts";

export async function serveHost(): Promise<void> {
  const service = new HostService((event) =>
    process.stdout.write(JSON.stringify(event) + "\n"),
  );
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const requests = new Set<Promise<void>>();
  const stop = (): void => {
    lines.close();
    void service.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        if (Buffer.byteLength(line) > 2 * 1024 * 1024)
          throw new Error("Request exceeds 2 MiB");
        const request = RequestSchema.parse(JSON.parse(line));
        const pending = service.handle(request);
        requests.add(pending);
        void pending.finally(() => requests.delete(pending));
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            protocolVersion: 1,
            type: "error",
            error: {
              code: "HOST_INVALID_REQUEST",
              message: error instanceof Error ? error.message : String(error),
              recoverable: true,
            },
          }) + "\n",
        );
      }
    }
    await Promise.all(requests);
  } finally {
    await service.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
)
  await serveHost();
