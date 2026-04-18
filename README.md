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

## Setup

```bash
pnpm install
pnpm build
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SPANNER_PROJECT` | Yes | GCP project ID |
| `SPANNER_INSTANCE` | Yes | Spanner instance ID |
| `SPANNER_DATABASE` | Yes | Spanner database ID |

## Usage

### Claude Code Plugin

This repo is packaged as a Claude Code plugin. Until submission to the official marketplace is approved, install locally:

```bash
git clone https://github.com/nu0ma/spanner-readonly-mcp
claude --plugin-dir ./spanner-readonly-mcp
```

The plugin launches the server via `npx -y spanner-readonly-mcp@latest`; set `SPANNER_PROJECT` / `SPANNER_INSTANCE` / `SPANNER_DATABASE` in your shell before starting Claude Code.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "spanner": {
      "command": "node",
      "args": ["/absolute/path/to/spanner-readonly-mcp/dist/index.mjs"],
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
      "command": "node",
      "args": ["/absolute/path/to/spanner-readonly-mcp/dist/index.mjs"],
      "env": {
        "SPANNER_PROJECT": "my-project",
        "SPANNER_INSTANCE": "my-instance",
        "SPANNER_DATABASE": "my-database"
      }
    }
  }
}
```

### Direct Execution

```bash
SPANNER_PROJECT=my-project \
SPANNER_INSTANCE=my-instance \
SPANNER_DATABASE=my-database \
pnpm start
```

Use `pnpm dev` during development to skip the build step.

## Tools

| Tool | Description |
|------|-------------|
| `list_tables` | List all user tables in the database |
| `describe_table` | Get column definitions (type, nullability, ordinal position) for a table |
| `list_indexes` | List indexes, optionally filtered by table |
| `execute_query` | Execute an arbitrary SELECT query |

## Read-Only Guarantee

Writes are blocked even if your IAM credentials have write permissions. Two layers enforce this:

1. **Application layer (best-effort)**: A regex rejects common mutation keywords (INSERT, UPDATE, UPSERT, DELETE, MERGE, and DDL/DCL) before they reach Spanner. This is an early-failure convenience, **not a security boundary** — payloads can trivially be rewritten (comments, CTE wrapping, parenthesization) to slip past it.
2. **Transaction layer (authoritative)**: Every query runs inside a Spanner [read-only snapshot transaction](https://cloud.google.com/spanner/docs/transactions#read-only_transactions) (`database.getSnapshot()`). The Snapshot class does not expose DML methods, and the Spanner backend rejects any mutation attempt within a read-only transaction. **This is the real guarantee.**

Error messages returned to clients are sanitized (first line only, prefixed `REGEX_BLOCKED:` or `SPANNER_ERROR:`) to avoid leaking stack traces or internal paths.

### IAM least privilege

`execute_query` accepts arbitrary SELECT statements, including queries against `information_schema` and `spanner_sys`. To bound the read surface, grant **only** `roles/spanner.databaseReader` to the service account — do not rely on application-level filtering alone.

## License

MIT
