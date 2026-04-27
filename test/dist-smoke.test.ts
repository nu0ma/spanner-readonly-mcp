import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Resolve dist/index.mjs relative to repo root (this file lives at <repo>/test/).
const DIST_PATH = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));

let client: Client;
let transport: StdioClientTransport;

describe("dist smoke", () => {
  beforeAll(() => {
    // The bundle must already exist — fail loudly so this gets caught in CI
    // and pre-publish, not skipped silently. Run `pnpm build` first.
    if (!existsSync(DIST_PATH)) {
      throw new Error(
        `dist/index.mjs not found at ${DIST_PATH}. Run \`pnpm build\` before \`pnpm test:smoke\`.`,
      );
    }
  });

  afterAll(async () => {
    // Closing the client closes the transport, which kills the child process.
    await client?.close();
  });

  it("spawns the bundled MCP server and completes the initialize handshake", async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_PATH],
      // Spanner client construction is lazy; these dummy values are enough to
      // get past the env-var guard in src/index.ts and reach the MCP transport.
      env: {
        ...process.env,
        SPANNER_PROJECT: "test",
        SPANNER_INSTANCE: "test",
        SPANNER_DATABASE: "test",
      } as Record<string, string>,
      // Suppress the child's "Spanner read-only MCP server started" banner from
      // polluting test output. Set to "inherit" if you need to debug.
      stderr: "ignore",
    });

    client = new Client({ name: "dist-smoke-test", version: "0.0.0" });

    // client.connect() drives the full MCP initialize handshake under the hood.
    await client.connect(transport);

    const serverInfo = client.getServerVersion();
    expect(serverInfo).toBeDefined();
    expect(serverInfo?.name).toBe("spanner-readonly");
    // Version is inlined at build time via tsdown `define` from package.json;
    // a placeholder like "0.0.0-dev" would mean the define replacement broke.
    expect(serverInfo?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(serverInfo?.version).not.toBe("0.0.0-dev");

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
  });

  it("exposes the four read-only tools via tools/list", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["describe_table", "execute_query", "list_indexes", "list_tables"]);
  });
});
