#!/bin/sh
set -e

API_DIR="/app/api"
FRONTEND_DIR="/app/frontend"

echo "[entrypoint] Starting inner-mcp-chat dev environment..."

# Step 1: 依存インストール（イメージビルド時に完了済みのため通常 no-op）
# 匿名ボリュームへのシード後も念のため確認する
echo "[entrypoint] Verifying dependencies..."
npm install --prefix "$API_DIR" --silent
npm install --prefix "$FRONTEND_DIR" --silent

# Step 2: dist/ の確認
# api_dist 名前付きボリュームが初回作成で空の場合のフォールバック
if [ ! -f "$API_DIR/dist/src/functions/chat.js" ]; then
  echo "[entrypoint] dist/ is empty - running initial TypeScript compile..."
  npm run build --prefix "$API_DIR"
else
  echo "[entrypoint] dist/ already populated - skipping initial compile."
fi

# Step 3: TypeScript watch をバックグラウンドで起動
# .ts ファイルの変更を検知して dist/ へ自動コンパイルする
# host.json の watchDirectories により func start がワーカーを自動再起動する
echo "[entrypoint] Starting tsc --watch in background..."
npm run build:watch --prefix "$API_DIR" &

# Step 4: Azure Functions をバックグラウンドで起動
# dist/ を読み込んで HTTP ハンドラを提供する（port 7071）
echo "[entrypoint] Starting Azure Functions on port 7071..."
cd "$API_DIR" && func start --port 7071 &

# Step 5: func start の起動完了を待機
# SWA CLI の --api-devserver-url はサーバーが応答できる状態である必要がある
echo "[entrypoint] Waiting for Azure Functions (port 7071) to be ready..."
echo "[entrypoint] (初回は Extension Bundle のダウンロードで 30〜60 秒かかります)"
RETRIES=30
ELAPSED=0
until nc -z localhost 7071 >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  ELAPSED=$((ELAPSED + 2))
  if [ "$RETRIES" -eq 0 ]; then
    echo "[entrypoint] WARNING: func start did not respond after ${ELAPSED}s. Continuing anyway."
    break
  fi
  echo "[entrypoint] Still waiting... (${ELAPSED}s elapsed)"
  sleep 2
done
echo "[entrypoint] Azure Functions is ready."

# Step 6: Vite dev server をバックグラウンドで起動
# --host 0.0.0.0: コンテナ内の全インターフェースでリッスン（SWA CLI からアクセス可能にする）
echo "[entrypoint] Starting Vite dev server on port 5173..."
cd "$FRONTEND_DIR" && npx vite --host 0.0.0.0 --port 5173 &
sleep 3

# Step 7: SWA CLI をフォアグラウンドで起動
# exec により SWA CLI がコンテナの主プロセスになり、SIGTERM が正しく伝播する
# --app-devserver-url: フロントエンド（Vite）の URL
# --api-devserver-url: API（func start）の URL
# --host 0.0.0.0: ホストから port 4280 でアクセス可能にする
echo "[entrypoint] Starting SWA CLI on port 4280..."
exec swa start \
  --app-devserver-url http://localhost:5173 \
  --api-devserver-url http://localhost:7071 \
  --host 0.0.0.0 \
  --port 4280
