# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `pnpm install` — install deps (pnpm is required; see `packageManager` in package.json)
- `pnpm dev` — run the server from source via tsx (stdio MCP transport)
- `pnpm build` — bundle to `dist/` with tsdown; inlines `__SPANNER_MCP_VERSION__` from package.json
- `pnpm start` — run the built `dist/index.mjs` (requires `pnpm build` first)
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — vitest; globalSetup starts Spanner Omni via `docker compose up -d` and polls its container logs for the readiness banner before tests run. Tears down (with `-v`) after. Docker must be running.
- `pnpm test:watch` — vitest watch mode (Spanner Omni still required)
- Run a single test: `pnpm exec vitest run test/e2e.test.ts -t "<test name pattern>"`
- `pnpm inspect` — launch the MCP Inspector against the built server

Runtime env vars (required for `dev`/`start`): `SPANNER_PROJECT`, `SPANNER_INSTANCE`, `SPANNER_DATABASE`. Optional `SPANNER_EMULATOR_HOST` (e.g. `127.0.0.1:15000` for Spanner Omni single-server, or `127.0.0.1:9010` for the legacy emulator) points the client at a local Spanner.

## Architecture

Tiny codebase — two source files. The interesting design lives in `src/server.ts`.

- `src/index.ts` — stdio entrypoint. Reads env, constructs `Spanner` → `instance` → `database`, hands the `Database` to `createServer()`, wires `StdioServerTransport`, and installs SIGINT/SIGTERM shutdown that closes server → database → spanner in order.
- `src/server.ts` — defines the four MCP tools (`list_tables`, `describe_table`, `list_indexes`, `execute_query`) on an `McpServer`. All tool handlers funnel through `readOnlyQuery()`.

### Read-only guarantee (two layers)

1. **Regex gate (best-effort UX)** — `FORBIDDEN_PATTERN` rejects mutation/DDL/DCL keywords at the start of the statement. Whitespace class explicitly covers BOM, NBSP, and zero-width spaces (U+200B–U+200D) because some clients prepend them. This is **not** a security boundary — it can be bypassed with comments/CTEs. Its job is to give the agent a fast, clear error.
2. **Snapshot transaction (authoritative)** — every query runs inside `database.getSnapshot()`. The Snapshot class exposes no DML methods, and the Spanner backend rejects mutations inside a read-only transaction. This is the real guarantee. IAM should still be `roles/spanner.databaseReader` — `execute_query` accepts arbitrary SELECTs including `information_schema` / `spanner_sys`.

Every query passes `gaxOptions.timeout: QUERY_TIMEOUT_MS` (30s). Streaming results are capped at `MAX_ROWS` (10000) by destroying the stream with `RowLimitExceededError`.

### Result serialization

Spanner returns rich wrapper types that aren't JSON-safe. `serializeValue()` handles this explicitly:

- `Int` → `number` if safe-integer, else the string `.value` (avoids `toJSON()` throwing on INT64 > 2^53; we pass `wrapNumbers: true` to keep control).
- `Float` → `number`, `Numeric` → string, `Buffer` (BYTES) → base64.
- Plain objects recurse; any other class falls back to `toJSON()` (covers `SpannerDate`, `Struct`, `Interval`, `Float32`, `PGNumeric`, `PGJsonb`).

Touching this function needs care — it's the reason the server doesn't crash on large INT64, BYTES, or Spanner-specific types.

### Error handling

All tool handlers catch and route through `sanitize()`, which returns only the first line prefixed `REGEX_BLOCKED:`, `ROW_LIMIT_EXCEEDED:`, or `SPANNER_ERROR:`. This is deliberate — don't leak stack traces or filesystem paths back to the client. `describe_table` also JSON-encodes and length-caps the echoed `table_name` to neutralize quote/newline injection from model-controlled input.

### Parameters

`execute_query` accepts named params via `@name` placeholders. The schema restricts values to `string | number | boolean | null` — prefer this over string interpolation.

## Build specifics

- tsdown (`tsdown.config.ts`) bundles `src/index.ts` → `dist/index.mjs` and `define`s `__SPANNER_MCP_VERSION__` from package.json at build time. Runtime never reads package.json — the bundle is location-independent once installed via `npx`.
- Node 24+ required (`engines.node`). ESM only (`"type": "module"`).

## Tests

- `test/e2e.test.ts` drives the real MCP server against Spanner Omni's single-server container.
- `test/global-setup.ts` owns the Docker lifecycle and polls `docker compose logs spanner-omni` for the "Spanner is ready" banner before tests run. The server under test connects via gRPC `127.0.0.1:15000` and the pre-provisioned `default` project / `default` instance.
- Tests require Docker; there's no mock path.
