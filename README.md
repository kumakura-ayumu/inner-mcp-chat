# inner-mcp-chat

MCP (Model Context Protocol) + Gemini を使ったインフラ監視 AI アシスタントです。
React チャット UI + Azure Static Web Apps (SWA) で動作し、ブラウザからサーバーメトリクスの分析を依頼できます。

## アーキテクチャ

```
[ブラウザ :5173]
  → Vite proxy /api/* → [Azure Functions :7071/api/chat]
    → InMemoryTransport（インプロセス）→ [MCP Server]
      → get_server_status → Gemini 2-call フロー（Function Calling）
```

MCP サーバーは Azure Functions 内でインプロセス動作するため、外部 HTTP サーバーは不要です。
Azure Static Web Apps にそのままデプロイできます。

## フォルダ構成

```
inner-mcp-app/
├── package.json             ← ルート: npm run dev で全プロセス起動
├── staticwebapp.config.json ← Azure SWA ルーティング設定
├── frontend/                ← React 18 + Vite + Tailwind CSS v3
│   ├── src/App.tsx          ← チャット UI
│   └── vite.config.ts       ← /api を :7071 にプロキシ
└── api/                     ← Azure Functions v4 (Node.js)
    ├── host.json
    ├── local.settings.json  ← ローカル環境変数（git 管理外）
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

### 1. 前提ツールのインストール

```bash
# Azure Functions Core Tools v4（グローバルインストール、初回のみ）
npm install -g azure-functions-core-tools@4 --unsafe-perm true

# バージョン確認
func --version  # 4.x.x
```

### 2. 依存パッケージのインストール

```bash
npm install
npm install --prefix api
npm install --prefix frontend
```

### 3. API キーの設定

`api/local.settings.json` を作成し、Gemini API キーを設定してください。

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "GEMINI_API_KEY": "AIza...実際のキー..."
  }
}
```

> API キーの取得: https://aistudio.google.com/app/apikey

## 実行方法

### チャット UI（フル構成）

```bash
npm run dev
```

| プロセス | 役割 | URL |
|---|---|---|
| `[api]` | Azure Functions | `http://localhost:7071/api/chat` |
| `[frontend]` | Vite dev server | `http://localhost:5173` |

ブラウザで `http://localhost:5173` を開き、「サーバーの状態を確認して」などと入力してください。

## 使用ライブラリ

| パッケージ | 用途 |
|---|---|
| `@modelcontextprotocol/sdk` | MCP サーバー / クライアント（InMemoryTransport）|
| `@google/genai` | Gemini API の呼び出し・Function Calling（公式新 SDK）|
| `@azure/functions` | Azure Functions v4 ハンドラー |
| `react` + `vite` | チャット UI のフロントエンド |
| `tailwindcss` | UI スタイリング |
| `concurrently` | 複数プロセスの同時起動 |
| `typescript` + `tsx` | TypeScript の実行環境 |
