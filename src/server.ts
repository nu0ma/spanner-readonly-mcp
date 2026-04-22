import { type Database, Float, Int, Numeric } from "@google-cloud/spanner";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Inlined at build time via tsdown `define`. Keeps the runtime free of any
// fs read against `../package.json`, which would couple the bundle to its
// install-time directory layout.
declare const __SPANNER_MCP_VERSION__: string;
const PACKAGE_VERSION: string =
  typeof __SPANNER_MCP_VERSION__ !== "undefined" ? __SPANNER_MCP_VERSION__ : "0.0.0-dev";

export const QUERY_TIMEOUT_MS = 30000;
export const MAX_ROWS = 10000;
const MAX_IDENTIFIER_LEN = 128;

// Leading-whitespace class includes ASCII \s plus BOM, NBSP, and zero-width
// spaces (U+200B..U+200D), which some clients prepend to slip past naive guards.
const LEADING_WS = "[\\s\\uFEFF\\u00A0\\u200B-\\u200D]*";
const FORBIDDEN_PATTERN = new RegExp(
  `^${LEADING_WS}(INSERT|UPDATE|UPSERT|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE|GRANT|REVOKE|RENAME|ANALYZE|CALL)\\b`,
  "i",
);

class RegexBlockedError extends Error {
  constructor() {
    super("REGEX_BLOCKED: Only SELECT queries are allowed. This is a read-only server.");
  }
}

class RowLimitExceededError extends Error {
  constructor() {
    super(
      `ROW_LIMIT_EXCEEDED: Query returned more than ${MAX_ROWS} rows. Narrow the query or add LIMIT.`,
    );
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
  if (error instanceof RowLimitExceededError) return error.message;
  const msg = error instanceof Error ? error.message : String(error);
  // Strip file paths, stack frames, and anything after the first newline to
  // avoid leaking internal details via error messages.
  const firstLine = msg.split("\n")[0];
  return `SPANNER_ERROR: ${firstLine}`;
}

// `row.toJSON()` throws on INT64 > 2^53; `wrapNumbers: true` defers that decision
// to us by handing back Spanner.Int wrappers we can keep as strings. We also
// normalize the SDK's other numeric wrappers and Buffer (BYTES) — none of which
// are JSON-safe by default — and fall back to `.toJSON()` for any other Spanner
// class (SpannerDate / Struct / Interval / Float32 / PGNumeric / PGJsonb).
function serializeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (v instanceof Int) {
    const n = Number(v.value);
    return Number.isSafeInteger(n) ? n : v.value;
  }
  if (v instanceof Float) return Number(v.value);
  if (v instanceof Numeric) return v.value;
  if (Array.isArray(v)) return v.map(serializeValue);
  const proto = Object.getPrototypeOf(v);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = serializeValue((v as Record<string, unknown>)[k]);
    return out;
  }
  if (typeof (v as { toJSON?: unknown }).toJSON === "function") {
    return (v as { toJSON: () => unknown }).toJSON();
  }
  return v;
}

function serializeRow(row: any): unknown {
  return serializeValue(row.toJSON({ wrapNumbers: true }));
}

async function readOnlyQuery(
  database: Database,
  sql: string,
  params?: Record<string, string | number | boolean | null>,
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
      gaxOptions: { timeout: QUERY_TIMEOUT_MS },
    };
    const rows: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = snapshot.runStream(query);
      stream.on("data", (row: unknown) => {
        if (rows.length >= MAX_ROWS) {
          stream.destroy(new RowLimitExceededError());
          return;
        }
        rows.push(serializeRow(row));
      });
      stream.on("end", () => resolve());
      stream.on("error", (err) => reject(err));
    });
    return rows;
  } finally {
    snapshot.end();
  }
}

export function createServer(database: Database): McpServer {
  const server = new McpServer({
    name: "spanner-readonly",
    version: PACKAGE_VERSION,
  });

  server.tool("list_tables", "List all user tables in the Spanner database", {}, async () => {
    try {
      const results = await readOnlyQuery(
        database,
        `SELECT table_name, parent_table_name
           FROM information_schema.tables
           WHERE table_schema = ''
           ORDER BY table_name`,
      );
      return ok(results);
    } catch (error) {
      return fail(sanitize(error));
    }
  });

  server.tool(
    "describe_table",
    "Get schema information (columns, types, nullability) for a specific table",
    {
      table_name: z.string().max(MAX_IDENTIFIER_LEN).describe("Name of the table to describe"),
    },
    async ({ table_name }) => {
      try {
        const columns = await readOnlyQuery(
          database,
          `SELECT column_name, spanner_type, is_nullable, ordinal_position
           FROM information_schema.columns
           WHERE table_name = @table AND table_schema = ''
           ORDER BY ordinal_position`,
          { table: table_name },
        );
        if (columns.length === 0) {
          // JSON-encode to neutralize quote/newline injection from a model-controlled
          // table_name; cap length so an oversized payload cannot dominate the response.
          const safe = JSON.stringify(table_name).slice(0, 80);
          return fail(`Table ${safe} not found.`);
        }
        return ok(columns);
      } catch (error) {
        return fail(sanitize(error));
      }
    },
  );

  server.tool(
    "list_indexes",
    "List indexes for a specific table or all tables",
    {
      table_name: z
        .string()
        .max(MAX_IDENTIFIER_LEN)
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
    },
  );

  server.tool(
    "execute_query",
    "Execute a read-only SQL query (SELECT only) against the Spanner database",
    {
      sql: z.string().describe("SQL SELECT query to execute"),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe(
          "Named parameter bindings (e.g. {userId: 'u1'}) referenced as @userId in sql. Prefer this over string interpolation.",
        ),
    },
    async ({ sql, params }) => {
      try {
        const results = await readOnlyQuery(database, sql, params);
        return ok({ row_count: results.length, rows: results });
      } catch (error) {
        return fail(sanitize(error));
      }
    },
  );

  return server;
}
