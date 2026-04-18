import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Spanner } from "@google-cloud/spanner";
import { createServer } from "./server.js";

const PROJECT_ID = process.env.SPANNER_PROJECT;
const INSTANCE_ID = process.env.SPANNER_INSTANCE;
const DATABASE_ID = process.env.SPANNER_DATABASE;

if (!PROJECT_ID || !INSTANCE_ID || !DATABASE_ID) {
  console.error(
    "Required environment variables: SPANNER_PROJECT, SPANNER_INSTANCE, SPANNER_DATABASE"
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
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  let exitCode = 0;
  try {
    await server.close();
    await database.close();
    await spanner.close();
  } catch (error) {
    console.error("Shutdown error:", error);
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
