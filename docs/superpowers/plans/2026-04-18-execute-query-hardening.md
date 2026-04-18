# execute_query Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the blast radius of `execute_query` for the agent-driven use case by capping result rows and adding a query timeout. Schema introspection (`information_schema` / `spanner_sys`) stays open — the agent legitimately needs it.

**Architecture:** All changes are confined to `src/server.ts`. We add a `max_rows` parameter + `truncated` flag to `execute_query`, and a `gaxOptions.timeout` on the Snapshot `run` call inside `readOnlyQuery` (so it covers the metadata tools too).

**Tech Stack:** TypeScript, Node 24+, `@modelcontextprotocol/sdk`, `@google-cloud/spanner`, vitest, Spanner emulator (docker compose).

---

## File Structure

- Modify: `src/server.ts` — add row cap to `execute_query`, add timeout to `readOnlyQuery`'s `snapshot.run` call.
- Modify: `test/e2e.test.ts` — append two new `describe` blocks (row cap, timeout). Seed extra rows in `beforeAll` to exercise the cap.
- Modify: `README.md` — update the Tools table and Read-Only Guarantee section.

No new files. The server is small (~160 LOC) and these concerns live with the existing query logic.

### Design notes locked in here

1. **Row cap:** `execute_query` accepts an optional `max_rows` parameter (`z.number().int().min(1).max(5000).optional()`, default `1000`). After the snapshot returns the rows, we slice to `max_rows`; if the original length exceeded the cap we set `truncated: true` in the response payload. We do **not** rewrite the user's SQL with `LIMIT` — Spanner has already materialized the rows by the time we slice, but this keeps the implementation trivial and avoids breaking ORDER BY / aggregation semantics. The 5000 hard ceiling bounds memory blast radius.
2. **Timeout:** Hardcoded 30000 ms passed via `gaxOptions: { timeout: 30000 }` to `snapshot.run`. Applies to **all** `readOnlyQuery` callers (metadata tools too — they should also not hang forever).
3. **Regex guard stays.** Its role is now explicitly documented as "early-fail UX so the agent gets a clear error when it forgets and writes UPDATE." The snapshot transaction remains the authoritative guarantee.
4. **Schema access stays open.** The agent needs `information_schema` to reason about the database when the dedicated metadata tools don't cover its question (foreign-key chasing, parent/child relationships beyond what `list_tables` returns, etc.). Locking this down would force us to grow the dedicated tools indefinitely.

---

## Task 1: Cap row count returned by `execute_query`

**Files:**
- Modify: `src/server.ts` (`execute_query` registration around line 143)
- Modify: `test/e2e.test.ts` (`beforeAll` for extra seed data, plus a new `describe` block at the end)

- [ ] **Step 1: Seed extra rows for the cap test**

In `test/e2e.test.ts`, find the `beforeAll` block (around line 72) and locate the Posts insert (around line 85). Immediately after the existing Posts insert, add a bulk insert so we have enough rows to exercise the cap:

```typescript
  // Bulk rows for row-cap tests
  const bulkUsers = Array.from({ length: 50 }, (_, i) => ({
    user_id: `bulk-${String(i).padStart(3, "0")}`,
    name: `Bulk User ${i}`,
    email: null,
  }));
  await database.table("Users").insert(bulkUsers);
```

(Total Users rows now = 2 original + 50 bulk = 52.)

- [ ] **Step 2: Write the failing tests**

Append to the very end of `test/e2e.test.ts` (after the closing `});` of the `snapshot-layer guarantee` describe):

```typescript
describe("execute_query row cap", () => {
  it("defaults to capping at 1000 rows and reports truncation accurately", async () => {
    // 52 rows total — well under 1000, so truncated should be false.
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "SELECT user_id FROM Users" },
    });
    const data = parseContent(result);
    expect(data.row_count).toBe(52);
    expect(data.truncated).toBe(false);
    expect(data.rows).toHaveLength(52);
  });

  it("respects an explicit max_rows and sets truncated when exceeded", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: {
        sql: "SELECT user_id FROM Users ORDER BY user_id",
        max_rows: 10,
      },
    });
    const data = parseContent(result);
    expect(data.row_count).toBe(10);
    expect(data.truncated).toBe(true);
    expect(data.rows).toHaveLength(10);
  });

  it("does not set truncated when result size equals max_rows exactly", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: {
        sql: "SELECT user_id FROM Users ORDER BY user_id LIMIT 5",
        max_rows: 5,
      },
    });
    const data = parseContent(result);
    expect(data.row_count).toBe(5);
    expect(data.truncated).toBe(false);
  });

  it("rejects max_rows above the hard ceiling of 5000", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "SELECT 1 AS x", max_rows: 5001 },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects max_rows below 1", async () => {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { sql: "SELECT 1 AS x", max_rows: 0 },
    });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- -t "execute_query row cap"`
Expected: the first three tests FAIL (no `truncated` field / no cap), the last two FAIL (no `max_rows` validation).

Note: the existing `executes a SELECT and returns results` test (around line 198) still expects `row_count` and `rows` to exist — those stay; we are only **adding** a `truncated` field, not removing anything.

- [ ] **Step 4: Implement the cap**

In `src/server.ts`, replace the `execute_query` tool registration (currently lines 143-157) with:

```typescript
  server.tool(
    "execute_query",
    "Execute a read-only SQL query (SELECT only) against the Spanner database. Accepts an optional max_rows (default 1000, max 5000); the response includes a truncated flag when the underlying result exceeded the cap.",
    {
      sql: z.string().describe("SQL SELECT query to execute"),
      max_rows: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe(
          "Maximum rows to return (default 1000, hard ceiling 5000). When the underlying result exceeds this, the response is truncated and `truncated: true` is set."
        ),
    },
    async ({ sql, max_rows }) => {
      try {
        const cap = max_rows ?? 1000;
        const results = await readOnlyQuery(database, sql);
        const truncated = results.length > cap;
        const rows = truncated ? results.slice(0, cap) : results;
        return ok({ row_count: rows.length, truncated, rows });
      } catch (error) {
        return fail(sanitize(error));
      }
    }
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- -t "execute_query row cap"`
Expected: all 5 new tests PASS.

The pre-existing `executes a SELECT and returns results` test (line 198) will now also see a `truncated: false` field on the response — it doesn't assert on it, so it should still PASS. Run the full suite to confirm:

Run: `pnpm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/e2e.test.ts
git commit -m "feat: cap execute_query results at max_rows (default 1000, ceiling 5000)

Adds an opt-in max_rows parameter and a truncated flag in the response
payload. Bounds context blast radius when the agent issues a broad
SELECT against a large table."
```

---

## Task 2: Add a 30-second timeout to all snapshot queries

**Files:**
- Modify: `src/server.ts` (`readOnlyQuery`, the `snapshot.run` call around line 56)
- Modify: `test/e2e.test.ts` (append a small wiring test — we cannot easily provoke a real timeout against the emulator, so we verify the option reaches `snapshot.run` by spying on a wrapped Database)

- [ ] **Step 1: Write the failing test**

Append to the end of `test/e2e.test.ts`:

```typescript
describe("query timeout", () => {
  it("passes a 30s gaxOptions timeout to snapshot.run", async () => {
    // Spy on getSnapshot to capture the options handed to snapshot.run.
    const realGetSnapshot = database.getSnapshot.bind(database);
    let capturedOptions: any = undefined;

    (database as any).getSnapshot = async (...args: any[]) => {
      const [snapshot] = await realGetSnapshot(...(args as []));
      const realRun = snapshot.run.bind(snapshot);
      (snapshot as any).run = async (
        query: any,
        options?: any
      ) => {
        capturedOptions = options;
        return realRun(query, options);
      };
      return [snapshot];
    };

    try {
      const result = await client.callTool({
        name: "execute_query",
        arguments: { sql: "SELECT 1 AS x" },
      });
      expect(result.isError).toBeFalsy();
      expect(capturedOptions?.gaxOptions?.timeout).toBe(30000);
    } finally {
      (database as any).getSnapshot = realGetSnapshot;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- -t "query timeout"`
Expected: FAIL with `capturedOptions` being `undefined` (current code calls `snapshot.run(query)` with no second arg).

- [ ] **Step 3: Wire the timeout**

In `src/server.ts`, inside `readOnlyQuery`, replace the `snapshot.run` call. Currently:

```typescript
    const [rows] = await snapshot.run(
      params ? { sql: normalized, params } : normalized
    );
```

with:

```typescript
    const query = params ? { sql: normalized, params } : normalized;
    const [rows] = await snapshot.run(query, {
      gaxOptions: { timeout: 30000 },
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- -t "query timeout"`
Expected: PASS.

Run the full suite:

Run: `pnpm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/e2e.test.ts
git commit -m "feat: add 30s timeout to all read-only Spanner queries"
```

---

## Task 3: Run typecheck and update README

**Files:**
- Modify: `README.md` (the Tools table around lines 80-87 and the Read-Only Guarantee section around lines 89-100)

- [ ] **Step 1: Verify the build still typechecks**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 2: Update the Tools table**

In `README.md`, replace the entire Tools table (currently lines 80-87) with:

```markdown
## Tools

| Tool | Description |
|------|-------------|
| `list_tables` | List all user tables in the database |
| `describe_table` | Get column definitions (type, nullability, ordinal position) for a table |
| `list_indexes` | List indexes, optionally filtered by table |
| `execute_query` | Execute an arbitrary SELECT query. Accepts an optional `max_rows` (default 1000, max 5000); the response includes a `truncated` flag when the underlying result exceeded the cap. All queries run with a 30-second timeout. |
```

- [ ] **Step 3: Update the Read-Only Guarantee section**

In `README.md`, replace the Read-Only Guarantee section (currently lines 89-100, from `## Read-Only Guarantee` through the end of the IAM least privilege subsection) with:

```markdown
## Read-Only Guarantee

Writes are blocked even if your IAM credentials have write permissions. Two layers enforce this:

1. **Application layer (UX, best-effort)**: A regex rejects common mutation keywords (INSERT, UPDATE, UPSERT, DELETE, MERGE, and DDL/DCL) before they reach Spanner. Its purpose is to give the agent a clear, fast error when it accidentally writes a mutation — **not** to act as a security boundary. Payloads can trivially be rewritten (comments, CTE wrapping, parenthesization) to slip past it.
2. **Transaction layer (authoritative)**: Every query runs inside a Spanner [read-only snapshot transaction](https://cloud.google.com/spanner/docs/transactions#read-only_transactions) (`database.getSnapshot()`). The Snapshot class does not expose DML methods, and the Spanner backend rejects any mutation attempt within a read-only transaction. **This is the real guarantee.**

In addition to the read-only guarantee, two operational controls bound the blast radius of `execute_query`:

- **Row cap.** Results are capped at `max_rows` (default 1000, hard ceiling 5000). When the underlying result exceeds the cap, the response is sliced and `truncated: true` is set so the agent knows it saw a partial view.
- **Timeout.** All snapshot queries (including the metadata tools) run with a 30-second `gaxOptions.timeout`.

Error messages returned to clients are sanitized (first line only, prefixed `REGEX_BLOCKED:` or `SPANNER_ERROR:`) to avoid leaking stack traces or internal paths.

### IAM least privilege

`execute_query` accepts arbitrary SELECT statements, including queries against `information_schema` and `spanner_sys`. To bound the read surface, grant **only** `roles/spanner.databaseReader` to the service account — do not rely on application-level filtering alone.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe execute_query row cap and timeout"
```

---

## Done criteria

- `pnpm test` passes (all original tests + 6 new tests).
- `pnpm typecheck` passes.
- `execute_query` returns `{ row_count, truncated, rows }`; `truncated` is `true` when the underlying result exceeded `max_rows` (default 1000, ceiling 5000).
- `snapshot.run` is invoked with `gaxOptions.timeout: 30000` for every tool.
- README's Tools table and Read-Only Guarantee section reflect the new behavior.
