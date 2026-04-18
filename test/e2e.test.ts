import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Spanner } from "@google-cloud/spanner";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { Database, Instance } from "@google-cloud/spanner";

const PROJECT_ID = "test-project";
const INSTANCE_ID = "test-instance";
const DATABASE_ID = "test-db";

const DDL = [
  `CREATE TABLE Users (
    user_id STRING(36) NOT NULL,
    name STRING(255) NOT NULL,
    email STRING(255),
  ) PRIMARY KEY (user_id)`,
  `CREATE TABLE Posts (
    post_id STRING(36) NOT NULL,
    user_id STRING(36) NOT NULL,
    title STRING(1024) NOT NULL,
    body STRING(MAX),
  ) PRIMARY KEY (user_id, post_id),
  INTERLEAVE IN PARENT Users ON DELETE CASCADE`,
  `CREATE INDEX PostsByTitle ON Posts(title)`,
];

let spanner: Spanner;
let database: Database;
let client: Client;

function parseContent(result: Awaited<ReturnType<typeof client.callTool>>): any {
  const text = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(text[0].text);
}

function errorText(result: Awaited<ReturnType<typeof client.callTool>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

async function getOrCreateInstance(spanner: Spanner): Promise<Instance> {
  const instance = spanner.instance(INSTANCE_ID);
  const [exists] = await instance.exists();
  if (exists) return instance;

  const [inst, operation] = await spanner.createInstance(INSTANCE_ID, {
    config: "emulator-config",
    nodes: 1,
    displayName: INSTANCE_ID,
  });
  await operation.promise();
  return inst;
}

async function getOrCreateDatabase(instance: Instance): Promise<Database> {
  const database = instance.database(DATABASE_ID);
  const [exists] = await database.exists();
  if (exists) {
    await database.delete();
  }

  const [, createOp] = await instance.createDatabase(DATABASE_ID);
  await createOp.promise();

  const db = instance.database(DATABASE_ID);
  const [schemaOp] = await db.updateSchema(DDL);
  await schemaOp.promise();

  return db;
}

beforeAll(async () => {
  process.env.SPANNER_EMULATOR_HOST = "127.0.0.1:9010";

  spanner = new Spanner({ projectId: PROJECT_ID });

  const instance = await getOrCreateInstance(spanner);
  database = await getOrCreateDatabase(instance);

  // Seed test data
  await database.table("Users").insert([
    { user_id: "u1", name: "Alice", email: "alice@example.com" },
    { user_id: "u2", name: "Bob", email: null },
  ]);
  await database.table("Posts").insert([
    { post_id: "p1", user_id: "u1", title: "Hello World", body: "First post" },
    { post_id: "p2", user_id: "u1", title: "Second Post", body: null },
  ]);
  // Wire MCP server + client via InMemoryTransport
  const server = createServer(database);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close();
  await database?.close();
  spanner?.close();
  delete process.env.SPANNER_EMULATOR_HOST;
});

describe("list_tables", () => {
  it("returns all user tables", async () => {
    const result = await client.callTool({ name: "list_tables", arguments: {} });
    const tables = parseContent(result);

    const names = tables.map((t: any) => t.table_name);
    expect(names).toContain("Users");
    expect(names).toContain("Posts");
  });

  it("includes parent table information", async () => {
    const result = await client.callTool({ name: "list_tables", arguments: {} });
    const tables = parseContent(result);

    const posts = tables.find((t: any) => t.table_name === "Posts");
    expect(posts.parent_table_name).toBe("Users");

    const users = tables.find((t: any) => t.table_name === "Users");
    expect(users.parent_table_name ?? "").toBe("");
  });
});

describe("describe_table", () => {
  it("returns columns for an existing table", async () => {
    const result = await client.callTool({
      name: "describe_table",
      arguments: { table_name: "Users" },
    });
    const columns = parseContent(result);

    expect(columns).toHaveLength(3);

    const names = columns.map((c: any) => c.column_name);
    expect(names).toEqual(["user_id", "name", "email"]);

    const userId = columns.find((c: any) => c.column_name === "user_id");
    expect(userId.spanner_type).toBe("STRING(36)");
    expect(userId.is_nullable).toBe("NO");

    const email = columns.find((c: any) => c.column_name === "email");
    expect(email.is_nullable).toBe("YES");
  });

  it("returns error for non-existent table", async () => {
    const result = await client.callTool({
      name: "describe_table",
      arguments: { table_name: "NonExistent" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("not found");
  });
});

describe("list_indexes", () => {
  it("lists all indexes", async () => {
    const result = await client.callTool({ name: "list_indexes", arguments: {} });
    const indexes = parseContent(result);

    const names = indexes.map((i: any) => i.index_name);
    expect(names).toContain("PostsByTitle");
  });

  it("filters by table name", async () => {
    const result = await client.callTool({
      name: "list_indexes",
      arguments: { table_name: "Posts" },
    });
    const indexes = parseContent(result);

    for (const idx of indexes) {
      expect(idx.table_name).toBe("Posts");
    }
    const names = indexes.map((i: any) => i.index_name);
    expect(names).toContain("PostsByTitle");
  });

  it("returns empty array for table with no secondary indexes", async () => {
    const result = await client.callTool({
      name: "list_indexes",
      arguments: { table_name: "Users" },
    });
    const indexes = parseContent(result);

    const secondary = indexes.filter(
      (i: any) => i.index_type !== "PRIMARY_KEY"
    );
    expect(secondary).toHaveLength(0);
  });
});

describe("execute_query", () => {
  it("executes a SELECT and returns results", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "SELECT user_id, name FROM Users ORDER BY name" },
    });
    const data = parseContent(result);

    expect(data.row_count).toBe(2);
    expect(data.rows[0].name).toBe("Alice");
    expect(data.rows[1].name).toBe("Bob");
  });

  it("handles queries with no results", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "SELECT * FROM Users WHERE user_id = 'nonexistent'" },
    });
    const data = parseContent(result);
    expect(data.row_count).toBe(0);
    expect(data.rows).toEqual([]);
  });

  it("strips trailing semicolons", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "SELECT COUNT(*) AS cnt FROM Users;" },
    });
    expect(result.isError).toBeFalsy();
    const data = parseContent(result);
    expect(data.rows[0].cnt).toBe(2);
  });

  it("rejects INSERT statements", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "INSERT INTO Users (user_id, name) VALUES ('u3', 'Eve')" },
    });
    expect(result.isError).toBe(true);
    const text = errorText(result);
    expect(text).toMatch(/^REGEX_BLOCKED:/);
    expect(text).toContain("Only SELECT queries are allowed");
  });

  it("rejects UPDATE statements", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "UPDATE Users SET name = 'Mallory' WHERE user_id = 'u1'" },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects DELETE statements", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "DELETE FROM Users WHERE user_id = 'u1'" },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects UPSERT statements", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: {
        sql: "UPSERT INTO Users (user_id, name) VALUES ('u1', 'Mallory')",
      },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects DDL statements", async () => {
    for (const ddl of [
      "DROP TABLE Users",
      "CREATE TABLE Evil (id STRING(36)) PRIMARY KEY (id)",
      "ALTER TABLE Users ADD COLUMN age INT64",
      "TRUNCATE TABLE Users",
    ]) {
      const result = await client.callTool({
        name: "execute_query",
        arguments: { sql: ddl },
      });
      expect(result.isError).toBe(true);
    }
  });

  it("rejects mutations with leading whitespace", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "  \n  DELETE FROM Users WHERE true" },
    });
    expect(result.isError).toBe(true);
  });

  it("handles JOIN queries", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: {
        sql: `SELECT u.name, p.title
              FROM Users u
              JOIN Posts p ON u.user_id = p.user_id
              ORDER BY p.title`,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = parseContent(result);
    expect(data.row_count).toBe(2);
    expect(data.rows[0].name).toBe("Alice");
  });

  it("handles aggregate queries", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: {
        sql: `SELECT u.name, COUNT(p.post_id) AS post_count
              FROM Users u
              LEFT JOIN Posts p ON u.user_id = p.user_id
              GROUP BY u.name
              ORDER BY u.name`,
      },
    });
    const data = parseContent(result);
    expect(data.rows[0]).toEqual({ name: "Alice", post_count: 2 });
    expect(data.rows[1]).toEqual({ name: "Bob", post_count: 0 });
  });
});

describe("read-only transaction enforcement", () => {
  it("snapshot transaction rejects DML even without regex guard", async () => {
    const [snapshot] = await database.getSnapshot();
    try {
      await expect(
        snapshot.run("INSERT INTO Users (user_id, name) VALUES ('evil', 'Evil')")
      ).rejects.toThrow();
    } finally {
      snapshot.end();
    }
  });

  it("row contents unchanged after all attack attempts", async () => {
    const users = await client.callTool({
      name: "execute_query",
      arguments: {
        sql: "SELECT user_id, name, email FROM Users ORDER BY user_id",
      },
    });
    expect(parseContent(users).rows).toEqual([
      { user_id: "u1", name: "Alice", email: "alice@example.com" },
      { user_id: "u2", name: "Bob", email: null },
    ]);

    const posts = await client.callTool({
      name: "execute_query",
      arguments: {
        sql: "SELECT post_id, user_id, title, body FROM Posts ORDER BY post_id",
      },
    });
    expect(parseContent(posts).rows).toEqual([
      { post_id: "p1", user_id: "u1", title: "Hello World", body: "First post" },
      { post_id: "p2", user_id: "u1", title: "Second Post", body: null },
    ]);
  });
});

describe("regex-layer bypass resistance", () => {
  // Unicode whitespace / invisible chars that some clients prepend to slip
  // past naive `^\s*` guards. These MUST be caught by the regex layer.
  it.each([
    ["BOM", "\uFEFFDELETE FROM Users WHERE true"],
    ["NBSP", "\u00A0DELETE FROM Users WHERE true"],
    ["ZWSP", "\u200BDELETE FROM Users WHERE true"],
    ["ZWNJ", "\u200CDELETE FROM Users WHERE true"],
    ["ZWJ", "\u200DDELETE FROM Users WHERE true"],
    ["mixed", "  \uFEFF\u00A0\n DROP TABLE Users"],
  ])("regex blocks DML prefixed with %s", async (_label, sql) => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/^REGEX_BLOCKED:/);
  });

  it.each([
    "RENAME TABLE Users TO Evil",
    "ANALYZE",
    "CALL some_proc()",
  ])("regex blocks extended DDL keyword: %s", async (sql) => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/^REGEX_BLOCKED:/);
  });
});

describe("snapshot-layer guarantee (mutations blocked regardless of regex)", () => {
  // These payloads bypass the regex (different leading tokens / comments) and
  // rely on Spanner's read-only snapshot to reject them. This encodes the
  // defense-in-depth contract as a test.
  it.each([
    ["block comment", "/* x */ DELETE FROM Users WHERE true"],
    ["line comment", "-- x\nDELETE FROM Users WHERE true"],
    ["multi-statement", "SELECT 1; DELETE FROM Users WHERE true"],
    ["CTE-wrapped", "WITH x AS (SELECT 1) DELETE FROM Users WHERE true"],
    ["parenthesized", "(DELETE FROM Users WHERE true)"],
  ])("blocks %s", async (_label, sql) => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql },
    });
    expect(result.isError).toBe(true);
    // Snapshot/Spanner rejection — not regex. Either path is acceptable as
    // long as the write never lands.
    const text = errorText(result);
    expect(text).toMatch(/^(SPANNER_ERROR|REGEX_BLOCKED):/);
  });

  it("does not leak stack traces or file paths", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "SELECT * FROM NoSuchTable" },
    });
    expect(result.isError).toBe(true);
    const text = errorText(result);
    expect(text).not.toMatch(/node_modules|\.ts:|\.js:|at [A-Z]/);
    expect(text.split("\n")).toHaveLength(1);
  });
});

describe("query timeout", () => {
  it("passes a 30s gaxOptions timeout on every snapshot.run query", async () => {
    const realGetSnapshot = database.getSnapshot.bind(database);
    let capturedQuery: any = undefined;

    (database as any).getSnapshot = async (...args: any[]) => {
      const [snapshot] = await realGetSnapshot(...(args as []));
      const realRun = snapshot.run.bind(snapshot);
      (snapshot as any).run = async (query: any) => {
        capturedQuery = query;
        return realRun(query);
      };
      return [snapshot];
    };

    try {
      const result = await client.callTool({
        name: "execute_query",
        arguments: { sql: "SELECT 1 AS x" },
      });
      expect(result.isError).toBeFalsy();
      expect(capturedQuery?.gaxOptions?.timeout).toBe(30000);
    } finally {
      (database as any).getSnapshot = realGetSnapshot;
    }
  });
});
