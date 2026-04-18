# spanner-readonly-mcp

A read-only [MCP](https://modelcontextprotocol.io/) server for Google Cloud Spanner. Lets LLMs safely inspect schemas and run SELECT queries against a Spanner database.

## Prerequisites

- Node.js 18+
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

1. **Application layer**: A regex rejects INSERT, UPDATE, UPSERT, DELETE, and all DDL statements before they reach Spanner.
2. **Transaction layer**: Every query runs inside a Spanner [read-only snapshot transaction](https://cloud.google.com/spanner/docs/transactions#read-only_transactions) (`database.getSnapshot()`). The Snapshot class does not expose DML methods, and the Spanner backend rejects any mutation attempt within a read-only transaction.

For defense in depth, grant only `roles/spanner.databaseReader` to the service account.

## License

MIT
# readonly-spanner-mcp
