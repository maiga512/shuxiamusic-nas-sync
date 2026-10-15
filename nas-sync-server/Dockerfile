FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY nas-sync-server/package.json ./package.json
COPY packages/shared-contract /packages/shared-contract
RUN npm install --omit=dev --ignore-scripts \
  && npm rebuild better-sqlite3

COPY nas-sync-server/src ./src
COPY nas-sync-server/tsconfig.json ./

ENV SHUXIA_SYNC_HOST=0.0.0.0
ENV SHUXIA_SYNC_PORT=31231
ENV SHUXIA_SYNC_DB_PATH=/data/shuxia-sync.sqlite

VOLUME ["/data"]
EXPOSE 31231

CMD ["node", "src/index.ts"]
