# spanner-readonly-mcp

English | [日本語](docs/README.ja.md)

A read-only [MCP](https://modelcontextprotocol.io/) server for Google Cloud Spanner. Lets LLMs safely inspect schemas and run SELECT queries against a Spanner database.

## Prerequisites

- Node.js 24+ (latest LTS)
- A Google Cloud project with a Spanner database
- [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)

```bash
gcloud auth application-default login
```

## Environment Variables

The server reads these at runtime (the Claude Code plugin prompts for them on install and persists to `settings.json`; for other clients, set them in the MCP config's `env` block).

| Variable | Required | Description |
|----------|----------|-------------|
| `SPANNER_PROJECT` | Yes | GCP project ID |
| `SPANNER_INSTANCE` | Yes | Spanner instance ID |
| `SPANNER_DATABASE` | Yes | Spanner database ID |

## Usage

### Claude Code Plugin

This repo doubles as a Claude Code plugin marketplace. Register it and install the plugin:

```bash
/plugin marketplace add nu0ma/spanner-readonly-mcp
/plugin install spanner-readonly-mcp@spanner-readonly-mcp
```

The plugin launches the server via `npx -y spanner-readonly-mcp@latest`. Claude Code will prompt for `SPANNER_PROJECT`, `SPANNER_INSTANCE`, and `SPANNER_DATABASE` on install and persist them to `settings.json`.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "spanner": {
      "command": "npx",
      "args": ["-y", "spanner-readonly-mcp@latest"],
      "env": {
        "SPANNER_PROJECT": "my-project",
        "SPANNER_INSTANCE": "my-instance",
        "SPANNER_DATABASE": "my-database"
      }
    }
  }
}
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "spanner": {
      "command": "npx",
      "args": ["-y", "spanner-readonly-mcp@latest"],
      "env": {
        "SPANNER_PROJECT": "my-project",
        "SPANNER_INSTANCE": "my-instance",
        "SPANNER_DATABASE": "my-database"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_tables` | List all user tables in the database |
| `describe_table` | Get column definitions (type, nullability, ordinal position) for a table |
| `list_indexes` | List indexes, optionally filtered by table |
| `execute_query` | Execute an arbitrary SELECT query |

## Read-Only Guarantee

Writes are blocked even if your IAM credentials have write permissions. Two layers enforce this:

1. **Application layer (UX, best-effort)**: A regex rejects common mutation keywords (INSERT, UPDATE, UPSERT, DELETE, MERGE, and DDL/DCL) before they reach Spanner. Its purpose is to give the agent a clear, fast error when it accidentally writes a mutation — **not** to act as a security boundary. Payloads can trivially be rewritten (comments, CTE wrapping, parenthesization) to slip past it.
2. **Transaction layer (authoritative)**: Every query runs inside a Spanner [read-only snapshot transaction](https://cloud.google.com/spanner/docs/transactions#read-only_transactions) (`database.getSnapshot()`). The Snapshot class does not expose DML methods, and the Spanner backend rejects any mutation attempt within a read-only transaction. **This is the real guarantee.**

All snapshot queries (including the metadata tools) run with a 30-second `gaxOptions.timeout` to bound worst-case latency.

Error messages returned to clients are sanitized (first line only, prefixed `REGEX_BLOCKED:` or `SPANNER_ERROR:`) to avoid leaking stack traces or internal paths.

### IAM least privilege

`execute_query` accepts arbitrary SELECT statements, including queries against `information_schema` and `spanner_sys`. To bound the read surface, grant **only** `roles/spanner.databaseReader` to the service account — do not rely on application-level filtering alone.

## Development

```bash
pnpm install
pnpm build           # compile to dist/
pnpm dev             # run from source without building
pnpm test            # vitest, starts the Spanner emulator via docker compose
```

Direct execution against a real Spanner instance:

```bash
SPANNER_PROJECT=my-project \
SPANNER_INSTANCE=my-instance \
SPANNER_DATABASE=my-database \
pnpm start
```

## License

MIT
