# spanner-readonly-mcp

[English](#spanner-readonly-mcp) | [日本語](#日本語)

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

---

# 日本語

Google Cloud Spanner 向けの読み取り専用 [MCP](https://modelcontextprotocol.io/) サーバーです。LLM が Spanner データベースのスキーマを安全に参照し、SELECT クエリを実行できます。

## 前提条件

- Node.js 24 以上 (最新 LTS)
- Spanner データベースを持つ Google Cloud プロジェクト
- [アプリケーションのデフォルト認証情報 (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)

```bash
gcloud auth application-default login
```

## セットアップ

```bash
pnpm install
pnpm build
```

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `SPANNER_PROJECT` | はい | GCP プロジェクト ID |
| `SPANNER_INSTANCE` | はい | Spanner インスタンス ID |
| `SPANNER_DATABASE` | はい | Spanner データベース ID |

## 使い方

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) に以下を追加します:

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

`~/.claude/settings.json` に以下を追加します:

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

### 直接実行

```bash
SPANNER_PROJECT=my-project \
SPANNER_INSTANCE=my-instance \
SPANNER_DATABASE=my-database \
pnpm start
```

開発中は `pnpm dev` を使うとビルド手順を省略できます。

## ツール

| ツール | 説明 |
|--------|------|
| `list_tables` | データベース内のすべてのユーザーテーブルを一覧表示 |
| `describe_table` | テーブルのカラム定義（型、NULL 許容、順序）を取得 |
| `list_indexes` | インデックスを一覧表示（テーブルで絞り込み可能） |
| `execute_query` | 任意の SELECT クエリを実行 |

## 読み取り専用の保証

IAM 認証情報に書き込み権限があっても、書き込みはブロックされます。2 層で強制しています:

1. **アプリケーション層（ベストエフォート）**: INSERT / UPDATE / UPSERT / DELETE / MERGE / DDL / DCL などの変更系キーワードを、Spanner に到達する前に正規表現で拒否します。これは早期失敗のための利便性であり、**セキュリティ境界ではありません**。コメント・CTE・括弧などでペイロードを書き換えれば容易に回避できます。
2. **トランザクション層（本質的な保証）**: すべてのクエリは Spanner の[読み取り専用スナップショットトランザクション](https://cloud.google.com/spanner/docs/transactions#read-only_transactions) (`database.getSnapshot()`) 内で実行されます。Snapshot クラスは DML メソッドを公開しておらず、Spanner バックエンドも読み取り専用トランザクション内での変更操作を拒否します。**こちらが実効的な保証層です。**

クライアントに返すエラーメッセージはサニタイズされます（1 行目のみ、`REGEX_BLOCKED:` または `SPANNER_ERROR:` プレフィックス付き）。スタックトレースや内部パスは漏洩しません。

### IAM 最小権限

`execute_query` は `information_schema` や `spanner_sys` を含む任意の SELECT 文を受け付けます。読み取り範囲を限定するには、サービスアカウントには **必ず** `roles/spanner.databaseReader` のみを付与してください。アプリケーション側のフィルタに依存してはいけません。

## ライセンス

MIT
