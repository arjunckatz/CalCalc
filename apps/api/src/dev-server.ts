import { createApiHostFromEnvironment } from "./host.js";

const host = createApiHostFromEnvironment();
const address = { host: "127.0.0.1", port: 3001 } as const;
let closing: Promise<void> | undefined;

function shutdown(exitCode = 0): Promise<void> {
  process.exitCode = exitCode;
  closing ??= host.close().catch(() => {
    process.exitCode = 1;
    process.stderr.write("CalCalc API shutdown failed.\n");
  });
  return closing;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
host.postgres.pool.on("error", () => {
  process.stderr.write("CalCalc API lost an idle PostgreSQL connection.\n");
  void shutdown(1);
});

try {
  await host.app.listen(address);
  process.stdout.write(
    `CalCalc API listening on http://${address.host}:${address.port}\n`,
  );
} catch {
  process.stderr.write(
    "CalCalc API could not start. Check local configuration and port.\n",
  );
  await shutdown(1);
}
