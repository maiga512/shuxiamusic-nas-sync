import {resolve} from 'node:path';

import {SyncDatabase} from './database.ts';
import {SYNC_HOST, SYNC_PORT, resolveDbPath} from './env.ts';
import {createSyncServer} from './http.ts';

// 环境变量兼容读取：SHUXIA_SYNC_* 优先，CERU_SYNC_* 回退（见 env.ts）
const port = SYNC_PORT();
const host = SYNC_HOST();
const dbPath = resolve(resolveDbPath('./data'));
const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

const database = new SyncDatabase(dbPath);
const server = createSyncServer({database, port, host});

server.listen(port, host, () => {
  console.log(`[shuxia-sync] listening on http://${displayHost}:${port}`);
  console.log(`[shuxia-sync] sqlite: ${dbPath}`);
});

const shutdown = () => {
  server.close(() => {
    database.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);