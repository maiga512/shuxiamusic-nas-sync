/**
 * 环境变量兼容读取：新名 SHUXIA_SYNC_* 优先，旧名 CERU_SYNC_* 作为回退。
 *
 * 背景：本项目原名 Ceru Music NAS Sync，环境变量统一叫 CERU_SYNC_*。
 * 更名为树夏Music 后改为 SHUXIA_SYNC_*，但老部署的 .env / docker-compose 里
 * 写的还是旧名，不能一改名就断掉。所以这里统一按「新名 -> 旧名 -> 默认值」读取，
 * 文档与示例一律只写新名，旧名继续静默兼容。
 */
import {existsSync} from 'node:fs';

/** 读环境变量：优先新名，回退旧名。 */
export function envValue(newName: string, legacyName: string, fallback: string): string {
  return process.env[newName] || process.env[legacyName] || fallback;
}

export function envNumber(newName: string, legacyName: string, fallback: number): number {
  const raw = envValue(newName, legacyName, '');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 服务端口 / 主机 / 管理 token 的兼容读取入口。 */
export const SYNC_PORT = (): number => envNumber('SHUXIA_SYNC_PORT', 'CERU_SYNC_PORT', 31231);
export const SYNC_HOST = (): string =>
  envValue('SHUXIA_SYNC_HOST', 'CERU_SYNC_HOST', '0.0.0.0');
export const SYNC_ADMIN_TOKEN = (): string =>
  envValue('SHUXIA_SYNC_ADMIN_TOKEN', 'CERU_SYNC_ADMIN_TOKEN', '');

/**
 * SQLite 数据库路径兼容：
 *   1) 显式指定的新/旧变量优先；
 *   2) 都没指定时，如果老文件 ceru-sync.sqlite 已存在就继续用它（老部署零迁移）；
 *   3) 否则用新文件名 shuxia-sync.sqlite。
 */
export function resolveDbPath(fallbackDir: string): string {
  const explicit = envValue('SHUXIA_SYNC_DB_PATH', 'CERU_SYNC_DB_PATH', '') ||
    envValue('SHUXIA_SYNC_DB', 'CERU_SYNC_DB', '');
  if (explicit) return explicit;

  const base = fallbackDir.replace(/\/$/, '');
  const legacy = `${base}/ceru-sync.sqlite`;
  const modern = `${base}/shuxia-sync.sqlite`;
  if (existsSync(legacy)) return legacy;
  return modern;
}
