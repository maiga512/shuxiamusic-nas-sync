import {resolve} from 'node:path';

import {hashPassword, nowIso} from './crypto.ts';
import {SyncDatabase} from './database.ts';

const username = process.argv[2] || 'admin';
const password = process.argv[3];

if (!password || password.length < 6) {
  console.error('用法: node src/resetAdmin.ts <管理员用户名> <新密码，至少 6 位>');
  process.exit(1);
}

const dbPath = resolve(process.env.CERU_SYNC_DB_PATH || process.env.CERU_SYNC_DB || './data/ceru-sync.sqlite');
const database = new SyncDatabase(dbPath);

database.setSetting('admin.username', username);
database.setSetting('admin.passwordHash', await hashPassword(password));
database.setSetting('admin.passwordResetAt', nowIso());

console.log(`管理员账号已重置: ${username}`);
