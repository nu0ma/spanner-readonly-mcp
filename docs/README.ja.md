# spanner-readonly-mcp

[English](../README.md) | 日本語

Google Cloud Spanner 向けの読み取り専用 [MCP](https://modelcontextprotocol.io/) サーバーです。LLM が Spanner データベースのスキーマを安全に参照し、SELECT クエリを実行できます。

## 前提条件

- Node.js 24 以上 (最新 LTS)
- Spanner データベースを持つ Google Cloud プロジェクト
- [アプリケーションのデフォルト認証情報 (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)

```bash
gcloud auth application-default login
```

## 環境変数

サーバーが実行時に参照します。Claude Code プラグイン経由でインストールした場合はインストール時にプロンプトで入力し、`settings.json` に保存されます。他クライアントでは MCP 設定の `env` ブロックに記述してください。

| 変数 | 必須 | 説明 |
|------|------|------|
| `SPANNER_PROJECT` | はい | GCP プロジェクト ID |
| `SPANNER_INSTANCE` | はい | Spanner インスタンス ID |
| `SPANNER_DATABASE` | はい | Spanner データベース ID |
| `SPANNER_EMULATOR_HOST` | いいえ | `host:port` (例 `127.0.0.1:9010`) を指定するとローカル Spanner emulator に向く。本番では未設定のまま。 |

## 使い方

### Claude Code プラグイン

このリポジトリはそのまま Claude Code プラグインマーケットプレイスとして機能します。以下でマーケットプレイスを登録してプラグインをインストールします:

```bash
/plugin marketplace add nu0ma/spanner-readonly-mcp
/plugin install spanner-readonly-mcp@spanner-readonly-mcp
```

プラグインは `npx -y spanner-readonly-mcp@latest` でサーバーを起動します。インストール時に `SPANNER_PROJECT` / `SPANNER_INSTANCE` / `SPANNER_DATABASE` を聞かれ、`settings.json` に保存されます。

### Claude Code (プラグイン以外)

プロジェクトルートに `.mcp.json` を作成します:

```json
{
  "mcpServers": {
    "spanner-readonly-mcp": {
      "type": "stdio",
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

Claude Code はセッション起動時に自動で認識し、初回起動時に承認プロンプトを出します。

## ツール

| ツール | 説明 |
|--------|------|
| `list_tables` | データベース内のすべてのユーザーテーブルを一覧表示 |
| `describe_table` | テーブルのカラム定義（型、NULL 許容、順序）を取得 |
| `list_indexes` | インデックスを一覧表示（テーブルで絞り込み可能） |
| `execute_query` | 任意の SELECT クエリを実行 |

## 読み取り専用の保証

IAM 認証情報に書き込み権限があっても、書き込みはブロックされます。2 層で強制しています:

1. **アプリケーション層 (UX、ベストエフォート)**: INSERT / UPDATE / UPSERT / DELETE / MERGE / DDL / DCL などの変更系キーワードを、Spanner に到達する前に正規表現で拒否します。エージェントが誤って変更系クエリを投げた際に分かりやすいエラーを即座に返すためのもので、**セキュリティ境界ではありません**。コメント・CTE・括弧などでペイロードを書き換えれば容易に回避できます。
2. **トランザクション層 (本質的な保証)**: すべてのクエリは Spanner の[読み取り専用スナップショットトランザクション](https://cloud.google.com/spanner/docs/transactions#read-only_transactions) (`database.getSnapshot()`) 内で実行されます。Snapshot クラスは DML メソッドを公開しておらず、Spanner バックエンドも読み取り専用トランザクション内での変更操作を拒否します。**こちらが実効的な保証層です。**

すべてのスナップショットクエリ (メタデータ系ツール含む) は、worst-case レイテンシを抑えるため 30 秒の `gaxOptions.timeout` を指定して実行されます。

クライアントに返すエラーメッセージはサニタイズされます (1 行目のみ、`REGEX_BLOCKED:` または `SPANNER_ERROR:` プレフィックス付き)。スタックトレースや内部パスは漏洩しません。

### IAM 最小権限

`execute_query` は `information_schema` や `spanner_sys` を含む任意の SELECT 文を受け付けます。読み取り範囲を限定するには、サービスアカウントには **必ず** `roles/spanner.databaseReader` のみを付与してください。アプリケーション側のフィルタに依存してはいけません。

## 開発

```bash
pnpm install
pnpm build           # dist/ へコンパイル
pnpm dev             # ビルドせずにソースから実行
pnpm test            # vitest (docker compose で Spanner emulator を起動)
```

実 Spanner に対して直接実行する場合 (先に build が必要):

```bash
pnpm build
SPANNER_PROJECT=my-project \
SPANNER_INSTANCE=my-instance \
SPANNER_DATABASE=my-database \
pnpm start
```

## ライセンス

MIT
