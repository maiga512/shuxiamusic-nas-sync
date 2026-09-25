import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {URL} from 'node:url';

import {renderAdminPage} from './adminPage.ts';
import {createToken, hashPassword, verifyPassword} from './crypto.ts';
import {SyncDatabase} from './database.ts';
import {MAX_PLUGIN_SCRIPT_BYTES} from './pluginIdentity.ts';
import type {AuthUser, RequestContext, UnknownRecord} from './types.ts';

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ADMIN_PASSWORD_SETTING_KEY = 'admin.passwordHash';
const ADMIN_USERNAME_SETTING_KEY = 'admin.username';
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'password';
const MAX_REQUEST_BODY_BYTES = MAX_PLUGIN_SCRIPT_BYTES + 64 * 1024;

export type ServerConfig = {
  port: number;
  host: string;
  database: SyncDatabase;
};

type RouteHandler = (ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  body: UnknownRecord;
  auth: RequestContext | null;
}) => Promise<unknown> | unknown;

const readBody = async (request: IncomingMessage): Promise<UnknownRecord> => {
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = new Error('请求体过大');
    Object.assign(error, {statusCode: 413});
    throw error;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      const error = new Error('请求体过大');
      Object.assign(error, {statusCode: 413});
      throw error;
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};
  const buffer = Buffer.concat(chunks);
  const contentType = String(request.headers['content-type'] || '').toLowerCase();

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(buffer.toString('utf8')) as UnknownRecord;
    } catch {
      return {};
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(buffer.toString('utf8')).entries());
  }

  if (contentType.includes('multipart/form-data')) {
    return parseMultipartTextFields(buffer, contentType);
  }

  try {
    return JSON.parse(buffer.toString('utf8')) as UnknownRecord;
  } catch {
    return {};
  }
};

const parseMultipartTextFields = (buffer: Buffer, contentType: string): UnknownRecord => {
  const boundary = contentType.match(/boundary=([^;]+)/)?.[1]?.replace(/^"|"$/g, '');
  if (!boundary) return {};

  const result: UnknownRecord = {};
  const raw = buffer.toString('binary');
  const parts = raw.split(`--${boundary}`);

  for (const part of parts) {
    const [rawHeaders, ...rest] = part.split('\r\n\r\n');
    if (!rawHeaders || !rest.length) continue;

    const headers = rawHeaders.toLowerCase();
    const name = rawHeaders.match(/name="([^"]+)"/)?.[1];
    if (!name || headers.includes('filename=')) continue;

    const value = rest.join('\r\n\r\n').replace(/\r\n--$/, '').replace(/\r\n$/, '');
    result[name] = Buffer.from(value, 'binary').toString('utf8');
  }

  return result;
};

const sendJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
};

const sendHtml = (response: ServerResponse, html: string) => {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
};

const sendSseHeaders = (response: ServerResponse) => {
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
};

const toPublicAuthUser = (user: AuthUser) => ({
  id: user.id,
  username: user.username,
  nickname: user.nickname || user.username,
  email: user.email || undefined,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const getBearerToken = (request: IncomingMessage) => {
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || '';
};

const requireAuth = (auth: RequestContext | null) => {
  if (!auth) {
    const error = new Error('请先登录 NAS 同步服务');
    Object.assign(error, {statusCode: 401});
    throw error;
  }
  return auth;
};

const getAdminToken = (request: IncomingMessage) => {
  const bearer = getBearerToken(request);
  if (bearer) return bearer;
  return String(request.headers['x-admin-token'] || '');
};

const getAdminPasswordHash = async (database: SyncDatabase) => {
  const existing = database.getSetting(ADMIN_PASSWORD_SETTING_KEY);
  if (existing) return existing;
  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
  database.setSetting(ADMIN_PASSWORD_SETTING_KEY, passwordHash);
  return passwordHash;
};

const getAdminUsername = (database: SyncDatabase) => database.getSetting(ADMIN_USERNAME_SETTING_KEY) || DEFAULT_ADMIN_USERNAME;

const requireAdmin = (database: SyncDatabase, request: IncomingMessage) => {
  const token = getAdminToken(request);
  const envAdminToken = process.env.CERU_SYNC_ADMIN_TOKEN || '';
  if (envAdminToken && token === envAdminToken) return;

  if (!token || !database.authenticateAdminToken(token)) {
    const error = new Error('请先登录管理后台');
    Object.assign(error, {statusCode: 401});
    throw error;
  }
};

const getString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const getBodyOrQueryId = (body: UnknownRecord, url: URL, names: string[]) => {
  for (const name of names) {
    const fromBody = getString(body[name]);
    if (fromBody) return fromBody;
    const fromQuery = getString(url.searchParams.get(name));
    if (fromQuery) return fromQuery;
  }
  return '';
};

const createRouter = (database: SyncDatabase): Record<string, Partial<Record<string, RouteHandler>>> => ({
  '/health': {
    GET: () => ({status: 'ok', service: 'ceru-nas-sync-server'}),
  },
  '/version': {
    GET: () => ({name: '@ceru/nas-sync-server', version: '0.1.0'}),
  },
  '/auth/register': {
    POST: async ({body}) => {
      const username = getString(body.username || body.email);
      const password = getString(body.password);
      if (!username || !password) {
        const error = new Error('username 和 password 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }

      const user = database.createUser({
        username,
        email: getString(body.email) || undefined,
        nickname: getString(body.nickname) || undefined,
        passwordHash: await hashPassword(password),
      });
      const token = createToken();
      const expiresAt = database.createSession(user.id, token, DEFAULT_SESSION_TTL_MS);
      return {accessToken: token, expiresAt, user: toPublicAuthUser(user)};
    },
  },
  '/auth/login': {
    POST: async ({body}) => {
      const username = getString(body.username || body.email);
      const password = getString(body.password);
      const account = username ? database.findUserWithPassword(username) : null;
      if (!account || !(await verifyPassword(password, account.passwordHash))) {
        const error = new Error('账号或密码错误');
        Object.assign(error, {statusCode: 401});
        throw error;
      }

      const token = createToken();
      const expiresAt = database.createSession(account.user.id, token, DEFAULT_SESSION_TTL_MS);
      return {accessToken: token, expiresAt, user: toPublicAuthUser(account.user)};
    },
  },
  '/auth/pair': {
    POST: ({body}) => {
      const pairCode = getString(body.pairCode || body.code || body.bindingCode);
      if (!pairCode) {
        const error = new Error('pairCode 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }

      const user = database.consumePairCode(pairCode);
      if (!user) {
        const error = new Error('配对码无效或已过期');
        Object.assign(error, {statusCode: 401});
        throw error;
      }

      const token = createToken();
      const expiresAt = database.createSession(user.id, token, DEFAULT_SESSION_TTL_MS);
      return {accessToken: token, expiresAt, user: toPublicAuthUser(user)};
    },
  },
  '/admin/users': {
    GET: ({request}) => {
      requireAdmin(database, request);
      return {items: database.listUserSummaries()};
    },
    POST: async ({request, body}) => {
      requireAdmin(database, request);
      const username = getString(body.username || body.email);
      if (!username) {
        const error = new Error('username 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }

      const tempPassword = createToken();
      const user = database.createUser({
        username,
        email: undefined,
        nickname: username,
        passwordHash: await hashPassword(tempPassword),
      });
      return {user: toPublicAuthUser(user)};
    },
    DELETE: ({request, body, url}) => {
      requireAdmin(database, request);
      const userId = getBodyOrQueryId(body, url, ['userId', 'id']);
      const confirmText = getString(body.confirmText);
      if (!userId) {
        const error = new Error('userId 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      if (confirmText !== '我要删除') {
        const error = new Error('请输入“我要删除”确认删除');
        Object.assign(error, {statusCode: 400});
        throw error;
      }

      const result = database.deleteUser(userId);
      if (!result?.deleted) {
        const error = new Error('用户不存在');
        Object.assign(error, {statusCode: 404});
        throw error;
      }
      return {success: true, user: toPublicAuthUser(result.user)};
    },
  },
  '/admin/login': {
    POST: async ({body}) => {
      const username = getString(body.username);
      const password = getString(body.password);
      if (username !== getAdminUsername(database) || !password) {
        const error = new Error('管理员账号或密码错误');
        Object.assign(error, {statusCode: 401});
        throw error;
      }

      const passwordHash = await getAdminPasswordHash(database);
      if (!(await verifyPassword(password, passwordHash))) {
        const error = new Error('管理员账号或密码错误');
        Object.assign(error, {statusCode: 401});
        throw error;
      }

      const token = createToken();
      const expiresAt = database.createAdminSession(token, DEFAULT_ADMIN_SESSION_TTL_MS);
      return {
        accessToken: token,
        expiresAt,
        admin: {
          username: getAdminUsername(database),
          defaultAccount: getAdminUsername(database) === DEFAULT_ADMIN_USERNAME && password === DEFAULT_ADMIN_PASSWORD,
        },
      };
    },
  },
  '/admin/bootstrap': {
    GET: async () => {
      const username = getAdminUsername(database);
      const passwordHash = await getAdminPasswordHash(database);
      const defaultPassword = await verifyPassword(DEFAULT_ADMIN_PASSWORD, passwordHash);
      return {
        admin: {username, defaultAccount: username === DEFAULT_ADMIN_USERNAME && defaultPassword},
      };
    },
  },
  '/admin/change-username': {
    POST: ({request, body}) => {
      requireAdmin(database, request);
      const username = getString(body.username);
      if (!username) {
        const error = new Error('管理员用户名不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      database.setSetting(ADMIN_USERNAME_SETTING_KEY, username);
      return {success: true, admin: {username}};
    },
  },
  '/admin/reset-admin': {
    POST: async ({request, body}) => {
      const token = getAdminToken(request);
      const envAdminToken = process.env.CERU_SYNC_ADMIN_TOKEN || '';
      if (!envAdminToken || token !== envAdminToken) {
        const error = new Error('需要使用 CERU_SYNC_ADMIN_TOKEN 重置管理员账号');
        Object.assign(error, {statusCode: 401});
        throw error;
      }

      const username = getString(body.username) || DEFAULT_ADMIN_USERNAME;
      const password = getString(body.password);
      if (!password) {
        const error = new Error('新管理员密码不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      if (password.length < 6) {
        const error = new Error('新管理员密码至少需要 6 位');
        Object.assign(error, {statusCode: 400});
        throw error;
      }

      database.setSetting(ADMIN_USERNAME_SETTING_KEY, username);
      database.setSetting(ADMIN_PASSWORD_SETTING_KEY, await hashPassword(password));
      return {success: true, admin: {username}};
    },
  },
  '/admin/change-password': {
    POST: async ({request, body}) => {
      requireAdmin(database, request);
      const oldPassword = getString(body.oldPassword);
      const newPassword = getString(body.newPassword);
      if (!oldPassword || !newPassword) {
        const error = new Error('旧密码和新密码不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      if (newPassword.length < 6) {
        const error = new Error('新密码至少需要 6 位');
        Object.assign(error, {statusCode: 400});
        throw error;
      }

      const passwordHash = await getAdminPasswordHash(database);
      if (!(await verifyPassword(oldPassword, passwordHash))) {
        const error = new Error('旧密码不正确');
        Object.assign(error, {statusCode: 401});
        throw error;
      }

      database.setSetting(ADMIN_PASSWORD_SETTING_KEY, await hashPassword(newPassword));
      database.revokeAdminSessions();
      return {success: true};
    },
  },
  '/admin/status': {
    GET: ({request}) => {
      requireAdmin(database, request);
      return {
        service: {status: 'ok', name: '@ceru/nas-sync-server', version: '0.1.0'},
        admin: {username: getAdminUsername(database)},
        users: database.listUserSummaries(),
      };
    },
  },
  '/admin/pair-codes': {
    POST: ({request, body}) => {
      requireAdmin(database, request);
      const username = getString(body.username || body.email);
      const userId = getString(body.userId);
      const account = userId ? database.findUserById(userId) : username ? database.findUserWithPassword(username)?.user : null;
      if (!account) {
        const error = new Error('用户不存在');
        Object.assign(error, {statusCode: 404});
        throw error;
      }

      const pair = database.createPairCode({userId: account.id, force: body.force === true});
      if (!pair) {
        const error = new Error('创建配对码失败');
        Object.assign(error, {statusCode: 500});
        throw error;
      }
      return {pairCode: pair.code, expiresAt: pair.expiresAt, existing: pair.existing, user: toPublicAuthUser(pair.user)};
    },
  },
  '/admin/user-details': {
    GET: ({request, url}) => {
      requireAdmin(database, request);
      const userId = getString(url.searchParams.get('userId'));
      if (!userId) {
        const error = new Error('userId 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      const details = database.getUserDetails(userId);
      if (!details) {
        const error = new Error('用户不存在');
        Object.assign(error, {statusCode: 404});
        throw error;
      }
      return details;
    },
  },
  '/auth/refresh': {
    POST: ({auth}) => {
      const session = requireAuth(auth);
      const token = createToken();
      const expiresAt = database.createSession(session.user.id, token, DEFAULT_SESSION_TTL_MS);
      return {accessToken: token, expiresAt, user: toPublicAuthUser(session.user)};
    },
  },
  '/me': {
    GET: ({auth}) => toPublicAuthUser(requireAuth(auth).user),
  },
  '/sync': {
    GET: ({auth, url}) => {
      const session = requireAuth(auth);
      const sinceRevision = Number(url.searchParams.get('sinceRevision') || 0);
      return database.getSyncEvents(session.user.id, Number.isFinite(sinceRevision) ? sinceRevision : 0, session.tokenHash);
    },
  },
  '/sync/snapshot': {
    GET: ({auth}) => database.getSyncSnapshotMarker(requireAuth(auth).user.id),
  },
  '/sync/wait': {
    GET: async ({auth, url, response}) => {
      const session = requireAuth(auth);
      const sinceRevision = Number(url.searchParams.get('sinceRevision') || 0);
      const timeoutMs = Math.min(
        8_000,
        Math.max(0, Number(url.searchParams.get('timeout') || 8_000)),
      );
      const abortController = new AbortController();
      const abortIfDisconnected = () => {
        if (!response.writableEnded) abortController.abort();
      };
      response.once('close', abortIfDisconnected);
      try {
        return await database.waitForSyncEvents(
          session.user.id,
          Number.isFinite(sinceRevision) ? sinceRevision : 0,
          Number.isFinite(timeoutMs) ? timeoutMs : 8_000,
          abortController.signal,
          session.tokenHash,
        );
      } finally {
        response.off('close', abortIfDisconnected);
      }
    },
  },
  '/user-songlist': {
    GET: ({auth}) => database.listPlaylists(requireAuth(auth).user.id),
    POST: ({auth, body}) => database.createPlaylist(requireAuth(auth).user.id, body),
    PATCH: ({auth, body}) => database.updatePlaylist(requireAuth(auth).user.id, body),
    DELETE: ({auth, body, url}) => {
      const playlistId = getBodyOrQueryId(body, url, ['playlistId', 'listId', 'id']);
      if (!playlistId) {
        const error = new Error('playlistId 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      return database.deletePlaylist(requireAuth(auth).user.id, playlistId);
    },
  },
  '/playlists': {
    GET: ({auth}) => database.listPlaylists(requireAuth(auth).user.id),
    POST: ({auth, body}) => database.createPlaylist(requireAuth(auth).user.id, body),
  },
  '/playlist-reorder': {
    POST: ({auth, body}) => {
      const session = requireAuth(auth);
      const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : [];
      if (orderedIds.length === 0) {
        const error = new Error('orderedIds 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      return database.reorderPlaylists(session.user.id, orderedIds, Number.isFinite(Number(body.baseRevision)) ? Number(body.baseRevision) : undefined);
    },
  },
  '/favorite-reorder': {
    POST: ({auth, body}) => {
      const session = requireAuth(auth);
      const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : [];
      const entityType = getString(body.entityType);
      if (!entityType || orderedIds.length === 0) {
        const error = new Error('entityType、orderedIds 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      return database.reorderFavorites(session.user.id, entityType, orderedIds, Number.isFinite(Number(body.baseRevision)) ? Number(body.baseRevision) : undefined);
    },
  },
  '/plugin-reorder': {
    POST: ({auth, body}) => {
      const session = requireAuth(auth);
      const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : [];
      if (orderedIds.length === 0) {
        const error = new Error('orderedIds 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      return database.reorderPlugins(session.user.id, orderedIds, Number.isFinite(Number(body.baseRevision)) ? Number(body.baseRevision) : undefined);
    },
  },
  '/sync/register': {
    POST: ({auth, body}) => {
      const session = requireAuth(auth);
      const deviceId = getString(body.deviceId);
      const deviceName = getString(body.deviceName);
      const deviceType = getString(body.deviceType);
      if (!deviceId) {
        const error = new Error('deviceId 不能为空');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      return database.registerDevice(session.user.id, deviceId, deviceName, deviceType);
    },
  },
  '/sync/device-revision': {
    POST: ({auth, body}) => {
      const session = requireAuth(auth);
      const deviceId = getString(body.deviceId);
      const revision = Number(body.revision);
      if (!deviceId || !Number.isSafeInteger(revision) || revision < 0) {
        const error = new Error('deviceId 和 revision 必须有效');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
      return database.updateDeviceSyncRevision(session.user.id, deviceId, revision);
    },
  },
  '/sync/devices': {
    GET: ({auth}) => {
      const session = requireAuth(auth);
      return database.listDevices(session.user.id);
    },
  },
  '/user-songlist/list': {
    GET: ({auth, url}) => {
      const playlistId = getBodyOrQueryId({}, url, ['playlistId', 'listId', 'id']);
      const detail = database.getPlaylistSongs(
        requireAuth(auth).user.id,
        playlistId,
        url.searchParams.get('sort') === 'desc' ? 'desc' : 'asc',
        Number(url.searchParams.get('limit') || 5000),
        Number(url.searchParams.get('pos') || 0),
      );
      if (!detail) {
        const error = new Error('歌单不存在');
        Object.assign(error, {statusCode: 404});
        throw error;
      }
      return detail;
    },
    PATCH: ({auth, body}) => database.addSongs(requireAuth(auth).user.id, body),
    POST: ({auth, body}) => database.addSongs(requireAuth(auth).user.id, body),
    DELETE: ({auth, body}) => database.removeSongs(requireAuth(auth).user.id, body),
  },
  '/playlist-song-ops': {
    POST: ({auth, body}) => database.applySongOperation(requireAuth(auth).user.id, body),
  },
  '/playlist-song-operations': {
    POST: ({auth, body}) => database.applySongOperation(requireAuth(auth).user.id, body),
  },
  '/playlist-favorites': {
    GET: ({auth}) => ({items: database.listFavorites(requireAuth(auth).user.id, 'playlist')}),
    POST: ({auth, body}) => database.upsertFavorite(requireAuth(auth).user.id, {...body, entityType: 'playlist'}),
    DELETE: ({auth, body, url}) => {
      const playlistId = getBodyOrQueryId(body, url, ['playlistId', 'entityId', 'id']);
      return database.deleteFavorite(requireAuth(auth).user.id, {entityType: 'playlist', playlistId, occurredAtMs: Number(body.occurredAtMs) || undefined, operationId: getString(body.operationId)});
    },
  },
  '/favorites': {
    GET: ({auth, url}) => ({items: database.listFavorites(requireAuth(auth).user.id, url.searchParams.get('entityType') || undefined)}),
    POST: ({auth, body}) => database.upsertFavorite(requireAuth(auth).user.id, body),
    DELETE: ({auth, body, url}) =>
      database.deleteFavorite(requireAuth(auth).user.id, {
        entityType: getString(body.entityType || url.searchParams.get('entityType')),
        entityId: getString(body.entityId || url.searchParams.get('entityId')),
        playlistId: getString(body.playlistId || url.searchParams.get('playlistId')),
        operationId: getString(body.operationId),
        occurredAtMs: Number(body.occurredAtMs || url.searchParams.get('occurredAtMs')) || undefined,
      }),
  },
  '/plugins': {
    GET: ({auth, url}) => ({
      items: database.listPlugins(requireAuth(auth).user.id, {
        includeDeleted: url.searchParams.get('includeDeleted') === 'true',
      }),
    }),
  },
  '/plugin-blobs': {
    POST: ({auth, body}) => {
      requireAuth(auth);
      const script = typeof body.script === 'string' ? body.script : '';
      return database.putPluginBlob(script);
    },
  },
  '/plugin-ops': {
    POST: ({auth, body}) => database.applyPluginOperation(requireAuth(auth).user.id, body),
  },
  '/plugin-operations': {
    POST: ({auth, body}) => database.applyPluginOperation(requireAuth(auth).user.id, body),
  },
});

type DynamicRoute =
  | {type: 'playlist'; id: string}
  | {type: 'playlistSongs'; playlistId: string; songId?: string}
  | {type: 'favoriteDelete'; entityType: string; entityId: string}
  | {type: 'pluginBlob'; hash: string};

const findDynamicRoute = (pathname: string): DynamicRoute | null => {
  const playlistPatch = pathname.match(/^\/playlists\/([^/]+)$/);
  if (playlistPatch?.[1]) return {type: 'playlist', id: decodeURIComponent(playlistPatch[1])};

  const playlistSongs = pathname.match(/^\/playlists\/([^/]+)\/songs(?:\/([^/]+))?$/);
  if (playlistSongs?.[1]) {
    return {
      type: 'playlistSongs',
      playlistId: decodeURIComponent(playlistSongs[1]),
      songId: playlistSongs[2] ? decodeURIComponent(playlistSongs[2]) : undefined,
    };
  }

  const favoriteDelete = pathname.match(/^\/favorites\/([^/]+)\/([^/]+)$/);
  if (favoriteDelete?.[1] && favoriteDelete[2]) {
    return {type: 'favoriteDelete', entityType: decodeURIComponent(favoriteDelete[1]), entityId: decodeURIComponent(favoriteDelete[2])};
  }

  const pluginBlob = pathname.match(/^\/plugin-blobs\/([^/]+)$/);
  if (pluginBlob?.[1]) return {type: 'pluginBlob', hash: decodeURIComponent(pluginBlob[1])};

  return null;
};

const handleDynamicRoute = (database: SyncDatabase, dynamic: DynamicRoute | null, method: string, auth: RequestContext | null, body: UnknownRecord) => {
  if (!dynamic) return undefined;
  const session = requireAuth(auth);

  if (dynamic.type === 'playlist') {
    if (method === 'GET') return database.getPlaylistSongs(session.user.id, dynamic.id);
    if (method === 'PATCH') return database.updatePlaylist(session.user.id, {...body, playlistId: dynamic.id});
    if (method === 'DELETE') return database.deletePlaylist(session.user.id, dynamic.id);
  }

  if (dynamic.type === 'playlistSongs') {
    if (method === 'GET') return database.getPlaylistSongs(session.user.id, dynamic.playlistId);
    if (method === 'POST') return database.addSongs(session.user.id, {...body, playlistId: dynamic.playlistId});
    if (method === 'DELETE') {
      const ids = dynamic.songId ? [dynamic.songId] : [];
      return database.removeSongs(session.user.id, {...body, playlistId: dynamic.playlistId, songIds: ids});
    }
  }

  if (dynamic.type === 'favoriteDelete' && method === 'DELETE') {
    return database.deleteFavorite(session.user.id, {
      entityType: dynamic.entityType,
      entityId: dynamic.entityId,
      operationId: getString(body.operationId),
      occurredAtMs: Number(body.occurredAtMs) || undefined,
    });
  }

  if (dynamic.type === 'pluginBlob' && method === 'GET') {
    const blob = database.getPluginBlob(dynamic.hash);
    if (!blob) {
      const error = new Error('插件脚本不存在');
      Object.assign(error, {statusCode: 404});
      throw error;
    }
    return blob;
  }

  return undefined;
};

export const createSyncServer = ({database}: ServerConfig) => {
  const router = createRouter(database);

  return createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, null);
      return;
    }

    const url = new URL(request.url || '/', 'http://localhost');
    const method = request.method || 'GET';

    if ((url.pathname === '/' || url.pathname === '/admin') && method === 'GET') {
      sendHtml(response, renderAdminPage());
      return;
    }

    if (url.pathname === '/sync/stream' && method === 'GET') {
      const token = getBearerToken(request);
      const auth = token ? database.authenticateBearerToken(token) : null;
      if (!auth) {
        sendJson(response, 401, {success: false, error: '请先登录 NAS 同步服务'});
        return;
      }
      sendSseHeaders(response);
      let cursor = Math.max(0, Math.floor(Number(url.searchParams.get('sinceRevision') || 0)));
      let closed = false;
      const abortController = new AbortController();
      const close = () => {
        closed = true;
        abortController.abort();
      };
      response.once('close', close);
      response.write(': ceru-sync stream connected\n\n');
      try {
        while (!closed && !response.writableEnded) {
          const page = await database.waitForSyncEvents(
            auth.user.id,
            cursor,
            25_000,
            abortController.signal,
          );
          if (page.events.length > 0) {
            cursor = page.nextRevision;
            response.write(`event: sync\ndata: ${JSON.stringify({revision: cursor})}\n\n`);
          } else {
            response.write(': keep-alive\n\n');
          }
        }
      } catch (error) {
        if (!closed && !response.writableEnded) {
          response.write(`event: error\ndata: ${JSON.stringify({error: error instanceof Error ? error.message : 'stream error'})}\n\n`);
        }
      } finally {
        response.off('close', close);
        if (!response.writableEnded) response.end();
      }
      return;
    }

    try {
      const token = getBearerToken(request);
      const auth = token ? database.authenticateBearerToken(token) : null;
      const body = await readBody(request);
      const dynamic = findDynamicRoute(url.pathname);
      const route = router[url.pathname]?.[method];
      const result = route
        ? await route({request, response, url, body, auth})
        : handleDynamicRoute(database, dynamic, method, auth, body);

      if (result === undefined) {
        sendJson(response, 404, {success: false, error: '接口不存在', code: 'NOT_FOUND'});
        return;
      }

      sendJson(response, 200, result);
    } catch (error) {
      const statusCode = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
      sendJson(response, Number.isFinite(statusCode) ? statusCode : 500, {
        success: false,
        error: error instanceof Error ? error.message : '服务端错误',
        code: String(Number.isFinite(statusCode) ? statusCode : 500),
        ...(typeof error === 'object' && error && 'conflict' in error ? {conflict: (error as {conflict: unknown}).conflict} : {}),
      });
    }
  });
};
