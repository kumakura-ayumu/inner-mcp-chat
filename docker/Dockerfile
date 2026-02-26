FROM node:20-alpine

# Alpine 上で azure-functions-core-tools の .NET バイナリを動かすための依存
# gcompat: glibc 互換レイヤー（func バイナリは glibc リンク）
# libstdc++, libgcc: C++ ランタイム
# openssl, ca-certificates: HTTPS 通信（Azurite, Extension Bundle DL 等）
RUN apk add --no-cache \
      gcompat \
      libstdc++ \
      libgcc \
      openssl \
      ca-certificates

# Alpine (musl) 環境では ICU ライブラリが存在しないため invariant モードを使用
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

WORKDIR /app

# SWA CLI と Azure Functions Core Tools をグローバルインストール
RUN npm install -g \
      azure-functions-core-tools@4 \
      @azure/static-web-apps-cli

# package.json を先にコピー（レイヤーキャッシュ効率化）
COPY api/package*.json          ./api/
COPY frontend/package*.json     ./frontend/

# 各ワークスペースの依存をインストール
# node_modules はここで生成され、匿名ボリュームの初期値としてシードされる
RUN npm install --prefix api \
 && npm install --prefix frontend

COPY . .

# コンテナ初回起動時に dist/ が必ず存在するよう事前ビルド
# api_dist 名前付きボリュームが空の場合のベースラインとなる
RUN npm run build --prefix api

EXPOSE 4280

COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
