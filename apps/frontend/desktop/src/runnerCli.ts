import { startLocalRunner } from "./main/runner";

async function main(): Promise<void> {
  const status = await startLocalRunner();
  if (status.state === "error") {
    throw new Error(status.error || "Runner failed to start.");
  }

  process.stdout.write(
    `${JSON.stringify({
      runner: "ready",
      origin: status.origin,
      sessionId: status.sessionId,
      cdpUrl: status.cdpUrl,
    })}\n`,
  );

  const stop = () => process.exit(0);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => undefined, 60_000);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
