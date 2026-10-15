import {resolve} from 'node:path';
import {SYNC_HOST, SYNC_PORT, resolveDbPath} from './env.ts';

import {SyncDatabase} from './database.ts';
import {createSyncServer} from './http.ts';

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