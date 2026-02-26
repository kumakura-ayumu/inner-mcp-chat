# inner-mcp-chat

MCP (Model Context Protocol) + Gemini を使ったインフラ監視 AI アシスタントです。
React チャット UI + Azure Static Web Apps (SWA) で動作し、ブラウザからサーバーメトリクスの分析を依頼できます。

## アーキテクチャ

```
[ブラウザ :4280]
  → SWA CLI proxy
    /api/* → [Azure Functions :7071/api/chat]
              → InMemoryTransport（インプロセス）→ [MCP Server]
                → get_server_status → Gemini 2-call フロー（Function Calling）
    その他  → [Vite dev server :5173]
```

MCP サーバーは Azure Functions 内でインプロセス動作するため、外部 HTTP サーバーは不要です。
Azure Static Web Apps にそのままデプロイできます。

## フォルダ構成

```
inner-mcp-chat/
├── .env.example             ← API キーのテンプレート
├── docker/
│   ├── Dockerfile           ← 開発用イメージ（node:20-alpine + SWA CLI + Functions Core Tools）
│   ├── docker-compose.yml   ← ローカル開発環境（dev コンテナ + Azurite）
│   └── docker-entrypoint.sh ← コンテナ起動オーケストレーション
├── .dockerignore
├── staticwebapp.config.json ← Azure SWA ルーティング設定
├── frontend/                ← React 18 + Vite + Tailwind CSS v3
│   ├── src/App.tsx          ← チャット UI
│   └── vite.config.ts       ← /api を :7071 にプロキシ（非 Docker 時）
└── api/                     ← Azure Functions v4 (Node.js)
    ├── host.json            ← watchDirectories で dist/ 変更を監視
    └── src/
        ├── mcp-tools.ts         ← MCP ツール定義（ここにツールを追加）
        └── functions/
            └── chat.ts          ← POST /api/chat ハンドラー
```

## ファイルの役割

### api/src/mcp-tools.ts（ツール定義）

- `createMcpServer()` で `McpServer` インスタンスを生成してツールを登録
- ツールの追加・変更はこのファイルだけを編集すればよい
- 現在登録済みのツール:

| ツール名 | 説明 |
|---|---|
| `get_server_status` | CPU・メモリ・ディスク・バックアップ状況を JSON で返す |

### ドメイン制限

`.env` の `ALLOWED_DOMAIN` にアクセスを許可するメールドメインを設定します（例: `example.com`）。

| レイヤー | 実装 | 動作 |
|---|---|---|
| フロントエンド | `/.auth/me` でメールアドレスを取得してドメイン確認 | ドメイン不一致ならアクセス拒否画面を表示 |
| API | `x-ms-client-principal` ヘッダーを検証 | ドメイン不一致なら 403 を返す |

`ALLOWED_DOMAIN` を設定しない場合、ドメイン制限は無効になります。

### api/src/functions/chat.ts（脳と指令塔）

- `InMemoryTransport.createLinkedPair()` で MCP サーバーをインプロセス起動
- 以下の「2 回コール」フローを実装:

| ステップ | 内容 |
|---|---|
| ① | `mcpClient.listTools()` でツール定義を取得 |
| ② | `mapMcpToolsToGemini()` で JSON Schema → `FunctionDeclaration` に変換 |
| ③ | Gemini 1 回目コール: 使用ツールを選ばせる（Function Calling） |
| ④ | `mcpClient.callTool()` でツールを実行 |
| ⑤ | Gemini 2 回目コール: 実行結果を渡して最終回答を生成 |

- リクエスト: `{ message: string }` / レスポンス: `{ reply: string }`

### frontend/src/App.tsx（チャット UI）

- ユーザーメッセージを `POST /api/chat` に送信
- 応答を待つ間「分析中...」のアニメーションを表示
- Gemini の回答をチャットバブル形式で表示

## セットアップ

```bash
# 1. .env を作成して API キーを設定
cp .env.example .env
# GEMINI_API_KEY と ALLOWED_DOMAIN を書き換える

# 2. 起動（初回は --build が必要）
cd docker
docker compose up --build

# 2 回目以降
docker compose up
```

ブラウザで `http://localhost:4280` を開いてください。

> 起動時に Azure Functions の初期化で約 30 秒かかります。起動後はコンテナを停止しない限り再起動は不要です。

## 開発フロー

コンテナを起動したまま開発します。`.ts` / `.tsx` ファイルを保存するだけで自動反映されます。

| 変更内容 | 対応 | 備考 |
|---|---|---|
| `api/src/*.ts` | 保存するだけ（自動反映） | tsc --watch → func 自動再起動 |
| `frontend/src/*.tsx` | 保存するだけ（自動反映） | Vite ポーリングで検知 → ブラウザ自動更新 |
| `frontend/vite.config.ts` | `docker compose down && docker compose up` | Vite 起動時に読み込まれるため再起動が必要 |
| `package.json`（依存追加） | `docker compose down && docker compose up` | npm install はイメージビルド時に実行済み |
| `.env` | `docker compose down && docker compose up` | 環境変数はコンテナ起動時に読み込まれる |
| `docker-entrypoint.sh` | `docker compose down && docker compose up --build` | イメージに COPY されるため再ビルドが必要 |
| `Dockerfile` | `docker compose down && docker compose up --build` | イメージの再ビルドが必要 |

> API キーの取得: https://aistudio.google.com/app/apikey

> `.env` は git 管理外です（`.gitignore` で除外済み）。

## Docker 開発環境の仕組み

### コンテナ構成

| サービス | イメージ | 役割 |
|---|---|---|
| `dev` | node:20-alpine | SWA CLI + Vite + Azure Functions を 1 コンテナで実行 |
| `azurite` | mcr.microsoft.com/azure-storage/azurite | Azure Storage エミュレータ |

### 起動シーケンス（docker-entrypoint.sh）

```
1. npm install（no-op: イメージビルド時に完了済み）
2. dist/ 確認 → 空なら初回 TypeScript コンパイル
3. tsc --watch &       → .ts 変更を dist/ へ自動コンパイル
4. func start &        → dist/ を監視してワーカー自動再起動
5. :7071 のポート疎通待ち（nc -z で確認）
6. vite --host &       → フロントエンド HMR
7. exec swa start      → :4280 で統合プロキシ起動（フォアグラウンド）
```

> 初回起動時は Extension Bundle のダウンロードのため Step 5 の待機が長くなります。
> 2 回目以降は `func_extensions` ボリュームのキャッシュが効き、すぐに起動します。

### TypeScript ホットリロード

`.ts` ファイルを保存すると:

1. `tsc --watch` が変更を検知して `api/dist/` を更新
2. `host.json` の `watchDirectories: ["dist"]` により Functions ホストが変更を検知
3. Node.js ワーカーが自動再起動（約 1〜2 秒）

### node_modules の保護

docker-compose.yml で匿名ボリュームを宣言することで、ホスト PC 側への `node_modules` フォルダ作成を防止します:

```yaml
volumes:
  - /app/node_modules              # ホストに作成されない
  - /app/api/node_modules
  - /app/frontend/node_modules
  - api_dist:/app/api/dist         # TypeScript ビルド出力を永続化
  - func_extensions:/root/.azure/functions/extension-bundle  # Extension Bundle キャッシュ
```

### 停止・クリーンアップ

```bash
# 停止（docker/ ディレクトリ内で実行）
docker compose down

# ボリューム（dist/, Extension Bundle キャッシュ）も含めて完全削除
docker compose down -v
```

> `.env` を変更した場合は `docker compose down && docker compose up` で再起動してください（`--build` 不要）。

## 使用ライブラリ

| パッケージ | 用途 |
|---|---|
| `@modelcontextprotocol/sdk` | MCP サーバー / クライアント（InMemoryTransport）|
| `@google/genai` | Gemini API の呼び出し・Function Calling（公式新 SDK）|
| `@azure/functions` | Azure Functions v4 ハンドラー |
| `@azure/static-web-apps-cli` | SWA CLI（開発用統合プロキシ、ポート 4280）|
| `azure-functions-core-tools` | `func start` コマンド（コンテナ内グローバルインストール）|
| `react` + `vite` | チャット UI のフロントエンド |
| `tailwindcss` | UI スタイリング |
| `typescript` | TypeScript コンパイラ |
