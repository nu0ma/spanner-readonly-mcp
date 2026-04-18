import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "@google-cloud/spanner";
import { z } from "zod";

// Resolved at runtime from the installed package's package.json so the
// version reported to MCP clients matches what npm actually shipped.
const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string }
).version;

// Leading-whitespace class includes ASCII \s plus BOM, NBSP, and zero-width
// spaces (U+200B..U+200D), which some clients prepend to slip past naive guards.
const LEADING_WS = "[\\s\\uFEFF\\u00A0\\u200B-\\u200D]*";
const FORBIDDEN_PATTERN = new RegExp(
  `^${LEADING_WS}(INSERT|UPDATE|UPSERT|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE|GRANT|REVOKE|RENAME|ANALYZE|CALL)\\b`,
  "i"
);

class RegexBlockedError extends Error {
  constructor() {
    super("REGEX_BLOCKED: Only SELECT queries are allowed. This is a read-only server.");
  }
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

function sanitize(error: unknown): string {
  if (error instanceof RegexBlockedError) return error.message;
  const msg = error instanceof Error ? error.message : String(error);
  // Strip file paths, stack frames, and anything after the first newline to
  // avoid leaking internal details via error messages.
  const firstLine = msg.split("\n")[0];
  return `SPANNER_ERROR: ${firstLine}`;
}

async function readOnlyQuery(
  database: Database,
  sql: string,
  params?: Record<string, string | number | boolean | null>
): Promise<any[]> {
  const normalized = sql.trim().replace(/;\s*$/, "");
  if (FORBIDDEN_PATTERN.test(normalized)) {
    throw new RegexBlockedError();
  }
  const [snapshot] = await database.getSnapshot();
  try {
    const query = {
      sql: normalized,
      ...(params ? { params } : {}),
      gaxOptions: { timeout: 30000 },
    };
    const [rows] = await snapshot.run(query);
    return rows.map((row: any) => row.toJSON());
  } finally {
    snapshot.end();
  }
}

export function createServer(database: Database): McpServer {
  const server = new McpServer({
    name: "spanner-readonly",
    version: PACKAGE_VERSION,
  });

  server.tool(
    "list_tables",
    "List all user tables in the Spanner database",
    {},
    async () => {
      try {
        const results = await readOnlyQuery(
          database,
          `SELECT table_name, parent_table_name
           FROM information_schema.tables
           WHERE table_schema = ''
           ORDER BY table_name`
        );
        return ok(results);
      } catch (error) {
        return fail(sanitize(error));
      }
    }
  );

  server.tool(
    "describe_table",
    "Get schema information (columns, types, nullability) for a specific table",
    { table_name: z.string().describe("Name of the table to describe") },
    async ({ table_name }) => {
      try {
        const columns = await readOnlyQuery(
          database,
          `SELECT column_name, spanner_type, is_nullable, ordinal_position
           FROM information_schema.columns
           WHERE table_name = @table AND table_schema = ''
           ORDER BY ordinal_position`,
          { table: table_name }
        );
        if (columns.length === 0) {
          return fail(`Table '${table_name}' not found.`);
        }
        return ok(columns);
      } catch (error) {
        return fail(sanitize(error));
      }
    }
  );

  server.tool(
    "list_indexes",
    "List indexes for a specific table or all tables",
    {
      table_name: z
        .string()
        .optional()
        .describe("Table name to list indexes for. Omit to list all indexes."),
    },
    async ({ table_name }) => {
      try {
        let sql = `SELECT table_name, index_name, index_type, is_unique, index_state
                   FROM information_schema.indexes
                   WHERE table_schema = ''`;
        const params: Record<string, string | number | boolean | null> = {};
        if (table_name) {
          sql += ` AND table_name = @table`;
          params.table = table_name;
        }
        sql += ` ORDER BY table_name, index_name`;
        const indexes = await readOnlyQuery(database, sql, params);
        return ok(indexes);
      } catch (error) {
        return fail(sanitize(error));
      }
    }
  );

  server.tool(
    "execute_query",
    "Execute a read-only SQL query (SELECT only) against the Spanner database",
    {
      sql: z.string().describe("SQL SELECT query to execute"),
    },
    async ({ sql }) => {
      try {
        const results = await readOnlyQuery(database, sql);
        return ok({ row_count: results.length, rows: results });
      } catch (error) {
        return fail(sanitize(error));
      }
    }
  );

  return server;
}
