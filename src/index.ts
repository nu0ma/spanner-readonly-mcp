import { Spanner } from "@google-cloud/spanner";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const PROJECT_ID = process.env.SPANNER_PROJECT;
const INSTANCE_ID = process.env.SPANNER_INSTANCE;
const DATABASE_ID = process.env.SPANNER_DATABASE;

if (!PROJECT_ID || !INSTANCE_ID || !DATABASE_ID) {
  console.error(
    "Required environment variables: SPANNER_PROJECT, SPANNER_INSTANCE, SPANNER_DATABASE",
  );
  process.exit(1);
}

const spanner = new Spanner({ projectId: PROJECT_ID });
const instance = spanner.instance(INSTANCE_ID);
const database = instance.database(DATABASE_ID);

const server = createServer(database);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Spanner read-only MCP server started");
}

let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 5000;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Safety net: if any close() hangs (e.g. in-flight gRPC stream that never
  // settles), force-exit so the process doesn't linger as a zombie.
  const forceExit = setTimeout(() => {
    console.error("Shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  let exitCode = 0;
  // Close in order (server → database → spanner) but isolate each step so a
  // partial failure does not skip the remaining handles. Otherwise, e.g. a
  // server.close() rejection would leak the Spanner session pool / gRPC
  // channel and delay process exit.
  for (const [name, fn] of [
    ["server", () => server.close()],
    ["database", () => database.close()],
    ["spanner", () => spanner.close()],
  ] as const) {
    try {
      await fn();
    } catch (error) {
      console.error(`Shutdown error closing ${name}:`, error);
      exitCode = 1;
    }
  }
  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
