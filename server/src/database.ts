import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

import Database from 'better-sqlite3';

import {createId, createPairCode, decryptJson, encryptJson, generateDataKey, hashToken, nowIso, sha256Hex} from './crypto.ts';
import {encodeSongForLegacyClient, getText, normalizeFavoriteEntityType, normalizeSong, normalizeTrackKey, parseJsonArray} from './normalize.ts';
import {isStaleFavoriteWrite} from './favoriteLww.ts';
import {
  MAX_PLUGIN_SCRIPT_BYTES,
  canonicalizeCapabilityConfig,
  capabilityIdentityKey,
  canonicalCapabilityRole,
  mergeCapabilityConfig,
  musicSourceIdentityKey,
} from './pluginIdentity.ts';
import type {
  AuthUser,
  FavoriteInput,
  PlaylistInput,
  PlaylistPatchInput,
  PlaylistSongMutationInput,
  PlaylistSongOperationInput,
  PluginKind,
  PluginOperationInput,
  SyncedPlugin,
  RequestContext,
  SyncEvent,
  UnknownRecord,
} from './types.ts';

const json = (value: unknown) => JSON.stringify(value ?? null);
const CAPABILITY_SECRET_SETTING = 'capability.secretKey';
const MAX_SYNC_EVENTS_PER_REQUEST = 5000;
const MAX_SYNC_RESPONSE_BYTES = 6 * 1024 * 1024;
const SYNC_SECRET_KEYS = new Set(['password', 'accesscode', 'token', 'accesstoken', 'cookie', 'paircode']);
const parseJsonRecord = (value: unknown) => parseJson<UnknownRecord>(value, {});
const storedDurationText = (row: {track_json: string} | undefined) => {
  if (!row) return '';
  const stored = parseJsonRecord(row.track_json).durationText;
  return typeof stored === 'string' ? stored : '';
};
const parseStringArray = (value: unknown) =>
  Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
const FAVORITES_SEMANTIC = 'favorites';
const FAVORITES_TITLE = '我的喜欢';
const FAVORITES_STABLE_LOCAL_ID = 'system:favorites';
const FAVORITES_TITLE_ALIASES = new Set(['我的喜欢', '我的收藏']);
const ALLOWED_CLOUD_SONG_SOURCES = new Set(['wy', 'tx', 'kg', 'kw', 'mg', 'bd', 'git', 'plugin']);
const BRIDGED_PROVIDER_KEYS = new Set(['feiniu', '飞牛音乐', 'fnos']);
const BRIDGED_STABLE_ID_PREFIXES = ['provider:feiniu:', 'provider:飞牛音乐:', 'provider:fnos:'];

const isFavoritesTitle = (title?: string | null) => !!title && FAVORITES_TITLE_ALIASES.has(title.trim());
const normalizeProviderKey = (value: unknown) =>
  String(value || '')
    .trim()
    .normalize('NFKC')
    .toLowerCase();
const isBridgedProvider = (value: unknown) => BRIDGED_PROVIDER_KEYS.has(normalizeProviderKey(value));
const isBridgedTitle = (value: unknown) => {
  const normalized = normalizeProviderKey(value);
  return normalized.includes('飞牛') || normalized.includes('fnos') || BRIDGED_PROVIDER_KEYS.has(normalized);
};
const isBridgedIdentifier = (value: unknown) => {
  const normalized = normalizeProviderKey(value);
  return Boolean(
    normalized &&
      (BRIDGED_PROVIDER_KEYS.has(normalized) ||
        BRIDGED_STABLE_ID_PREFIXES.some((prefix) => normalized.startsWith(prefix))),
  );
};
const isBridgedPlaylistInput = (input: {
  source?: string;
  sourcePlaylistId?: string;
  localId?: string;
  title?: string;
  name?: string;
}) =>
  isBridgedProvider(input.source) ||
  isBridgedIdentifier(input.sourcePlaylistId) ||
  isBridgedIdentifier(input.localId) ||
  isBridgedTitle(input.title) ||
  isBridgedTitle(input.name);
const normalizePlaylistSongs = (songs: UnknownRecord[]) =>
  songs
    .map(normalizeSong)
    .filter((song) => (
      ALLOWED_CLOUD_SONG_SOURCES.has(song.source) &&
      !song.trackKey.startsWith('local:') &&
      (!Number.isFinite(song.position) || Number(song.position) >= 0)
    ));

const resolveSemanticType = (input: {semanticType?: string}, title: string, localId: string | null) => {
  const explicit = getText(input.semanticType);
  if (explicit) return explicit;
  if (localId === FAVORITES_STABLE_LOCAL_ID || isFavoritesTitle(title)) return FAVORITES_SEMANTIC;
  return null;
};
const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const sanitizeSyncPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeSyncPayload);
  if (!value || typeof value !== 'object') return value;
  const result: UnknownRecord = {};
  for (const [key, item] of Object.entries(value as UnknownRecord)) {
    if (SYNC_SECRET_KEYS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())) continue;
    result[key] = sanitizeSyncPayload(item);
  }
  return result;
};

const getFavoritePosition = (metadata: UnknownRecord | null) => {
  const position = Number(metadata?.position);
  return Number.isFinite(position) ? position : undefined;
};

type UserRow = {
  id: string;
  username: string;
  email: string | null;
  nickname: string | null;
  password_hash: string;
  created_at: string;
  updated_at: string;
};

type PairCodeRow = {
  id: string;
  user_id: string;
  code?: string | null;
  code_hash: string;
  expires_at: number;
  used_at: string | null;
  created_at: string;
};

type PlaylistRow = {
  id: string;
  user_id: string;
  local_id: string | null;
  title: string;
  description: string | null;
  cover_url: string | null;
  semantic_type: string | null;
  source: string | null;
  source_playlist_id: string | null;
  position: number;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

const isBridgedPlaylistRow = (row: PlaylistRow) =>
  isBridgedProvider(row.source) ||
  isBridgedIdentifier(row.source_playlist_id) ||
  isBridgedIdentifier(row.local_id) ||
  isBridgedTitle(row.title);

type PlaylistSongRow = {
  id: string;
  user_id: string;
  playlist_id: string;
  track_key: string;
  track_json: string;
  sort_order: number;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type FavoriteRow = {
  id: string;
  user_id: string;
  entity_type: string;
  entity_id: string;
  source_entity_id: string | null;
  title: string | null;
  description: string | null;
  cover_url: string | null;
  source: string | null;
  owner_name: string | null;
  metadata_json: string | null;
  position: number;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type SyncEventRow = {
  revision: number;
  entity_type: string;
  entity_id: string;
  action: string;
  payload_json: string;
  deleted_at: string | null;
  created_at: string;
};

type UserPluginRow = {
  id: string;
  user_id: string;
  kind: PluginKind;
  identity_key: string;
  name: string | null;
  author: string | null;
  version: string | null;
  enabled: number;
  disabled_sources_json: string;
  content_hash: string | null;
  config_cipher: string | null;
  position: number;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type PluginOperationRow = {
  operation_id: string;
  user_id: string;
  device_id: string;
  sequence: number;
  occurred_at_ms: number;
  identity_key: string;
  action: string;
  kind: string;
  applied: number;
  changed: number;
  stale: number;
  result_json: string;
  revision: number;
  created_at: string;
};

type PlaylistSongOperationRow = {
  operation_id: string;
  user_id: string;
  device_id: string;
  sequence: number;
  occurred_at_ms: number;
  playlist_id: string;
  action: string;
  track_key: string;
  applied: number;
  changed: number;
  stale: number;
  result_json: string;
  revision: number;
  created_at: string;
};

const toUser = (row: UserRow): AuthUser => ({
  id: row.id,
  username: row.username,
  email: row.email,
  nickname: row.nickname,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toPlaylist = (row: PlaylistRow, total = 0) => ({
  id: row.id,
  localId: row.local_id || undefined,
  title: row.title,
  name: row.title,
  description: row.description || '',
  describe: row.description || '',
  coverUrl: row.cover_url || undefined,
  cover: row.cover_url || undefined,
  filePath: row.cover_url || undefined,
  semanticType: row.semantic_type || undefined,
  source: row.source || undefined,
  sourcePlaylistId: row.source_playlist_id || undefined,
  position: row.position ?? 0,
  total,
  revision: row.revision,
  deletedAt: row.deleted_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toPlaylistSong = (row: PlaylistSongRow) => {
  const song = parseJson<Record<string, unknown>>(row.track_json, {});
  return {
    ...encodeSongForLegacyClient(song as never),
    ...song,
    position: row.sort_order,
    pos: row.sort_order,
    trackKey: row.track_key,
    revision: row.revision,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const toFavorite = (row: FavoriteRow) => {
  const metadata = parseJson<UnknownRecord | null>(row.metadata_json, null);
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    playlistId: row.entity_type === 'playlist' ? row.entity_id : undefined,
    radioId:
      row.entity_type === 'podcast'
        ? String(metadata?.radioId || row.entity_id)
        : undefined,
    sourcePlaylistId: row.source_entity_id || undefined,
    source: row.source || undefined,
    title: row.title || '未命名收藏',
    name: row.title || '未命名收藏',
    description: row.description || '',
    describe: row.description || '',
    coverUrl: row.cover_url || undefined,
    cover: row.cover_url || undefined,
    filePath: row.cover_url || undefined,
    ownerName: row.owner_name || undefined,
    metadata: metadata || undefined,
    pinned: row.entity_type === 'podcast' ? Boolean(metadata?.pinned) : undefined,
    position: Number.isFinite(Number(row.position)) ? Number(row.position) : getFavoritePosition(metadata) ?? 0,
    revision: row.revision,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const toSyncEvent = (row: SyncEventRow): SyncEvent => ({
  revision: row.revision,
  entityType: row.entity_type,
  entityId: row.entity_id,
  action: row.action,
  payload: parseJson(row.payload_json, null),
  deletedAt: row.deleted_at,
  createdAt: row.created_at,
});

export class SyncDatabase {
  private readonly db: Database.Database;
  private readonly syncWaiters = new Map<string, Set<() => void>>();

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), {recursive: true});
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
    this.sanitizeStoredSyncEvents();
    this.removeBridgedPlaylists();
  }

  close() {
    this.db.close();
  }

  getSetting(key: string) {
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as {value: string} | undefined;
    return row?.value || '';
  }

  setSetting(key: string, value: string) {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, at);
  }

  deleteSetting(key: string) {
    this.db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
  }

  createAdminSession(token: string, ttlMs: number) {
    const at = nowIso();
    const expiresAt = Date.now() + ttlMs;
    this.db
      .prepare(
        `INSERT INTO admin_sessions (token_hash, expires_at, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(hashToken(token), expiresAt, at);
    return expiresAt;
  }

  authenticateAdminToken(token: string) {
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT token_hash
         FROM admin_sessions
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, Date.now()) as {token_hash: string} | undefined;
    return Boolean(row);
  }

  revokeAdminSessions() {
    const at = nowIso();
    return this.db
      .prepare(`UPDATE admin_sessions SET revoked_at = ? WHERE revoked_at IS NULL`)
      .run(at).changes;
  }

  createUser(input: {username: string; email?: string; nickname?: string; passwordHash: string}) {
    const at = nowIso();
    const user = {
      id: createId('usr'),
      username: input.username.trim(),
      email: input.email?.trim() || null,
      nickname: input.nickname?.trim() || null,
      password_hash: input.passwordHash,
      created_at: at,
      updated_at: at,
    };

    this.db
      .prepare(
        `INSERT INTO users (id, username, email, nickname, password_hash, created_at, updated_at)
         VALUES (@id, @username, @email, @nickname, @password_hash, @created_at, @updated_at)`,
      )
      .run(user);
    this.db.prepare(`INSERT INTO user_revision (user_id, current_revision) VALUES (?, 0)`).run(user.id);

    return toUser(user);
  }

  findUserWithPassword(username: string) {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE username = ? OR email = ?`)
      .get(username, username) as UserRow | undefined;
    if (!row) return null;
    return {user: toUser(row), passwordHash: row.password_hash};
  }

  findUserById(userId: string) {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  listUsers() {
    const rows = this.db.prepare(`SELECT * FROM users ORDER BY created_at ASC`).all() as UserRow[];
    return rows.map(toUser);
  }

  deleteUser(userId: string) {
    const user = this.findUserById(userId);
    if (!user) return null;
    const result = this.db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
    return {user, deleted: result.changes > 0};
  }

  listUserSummaries() {
    const rows = this.db
      .prepare(
        `SELECT u.*,
                COALESCE(r.current_revision, 0) AS current_revision,
                (SELECT COUNT(*) FROM playlists p WHERE p.user_id = u.id AND p.deleted_at IS NULL) AS playlist_count,
                (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.user_id = u.id AND ps.deleted_at IS NULL) AS song_count,
                (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id AND f.deleted_at IS NULL) AS favorite_count,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_session_count,
                (SELECT pc.code FROM pair_codes pc WHERE pc.user_id = u.id AND pc.code IS NOT NULL AND pc.used_at IS NULL ORDER BY pc.created_at DESC LIMIT 1) AS binding_code
         FROM users u
         LEFT JOIN user_revision r ON r.user_id = u.id
         ORDER BY u.created_at ASC`,
      )
      .all(Date.now()) as Array<
      UserRow & {
        current_revision: number;
        playlist_count: number;
        song_count: number;
        favorite_count: number;
        active_session_count: number;
        binding_code: string | null;
      }
    >;

    return rows.map((row) => ({
      ...toUser(row),
      revision: Number(row.current_revision || 0),
      playlistCount: Number(row.playlist_count || 0),
      songCount: Number(row.song_count || 0),
      favoriteCount: Number(row.favorite_count || 0),
      activeSessionCount: Number(row.active_session_count || 0),
      bindingCode: row.binding_code || '',
      hasBindingCode: Boolean(row.binding_code),
    }));
  }

  createPairCode(input: {userId: string; ttlMs?: number; force?: boolean}) {
    const user = this.findUserById(input.userId);
    if (!user) return null;

    const existing = this.db
      .prepare(`SELECT * FROM pair_codes WHERE user_id = ? AND code IS NOT NULL AND used_at IS NULL ORDER BY created_at ASC LIMIT 1`)
      .get(input.userId) as PairCodeRow | undefined;
    if (existing?.code && !input.force) return {code: existing.code, expiresAt: null, user, existing: true};
    if (existing?.code && input.force) {
      this.db.prepare(`UPDATE pair_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).run(nowIso(), input.userId);
    }
    const code = createPairCode();
    const at = nowIso();
    const row: PairCodeRow = {
      id: createId('pair'),
      user_id: input.userId,
      code,
      code_hash: hashToken(code),
      expires_at: 0,
      used_at: null,
      created_at: at,
    };

    this.db
      .prepare(
        `INSERT INTO pair_codes (id, user_id, code, code_hash, expires_at, used_at, created_at)
         VALUES (@id, @user_id, @code, @code_hash, @expires_at, @used_at, @created_at)`,
      )
      .run(row);

    return {code, expiresAt: null, user, existing: false};
  }

  getUserDetails(userId: string) {
    const user = this.findUserById(userId);
    if (!user) return null;
    const playlists = this.listPlaylists(userId).map((playlist) => ({
      ...playlist,
      songs: this.getPlaylistSongs(userId, playlist.id, 'asc', 10000, 0)?.songs || [],
    }));
    return {
      user,
      playlists,
      plugins: this.listPlugins(userId),
      favorites: this.listFavorites(userId, 'playlist'),
      podcasts: this.listFavorites(userId, 'podcast'),
    };
  }

  consumePairCode(code: string) {
    const normalized = code.trim();
    if (!normalized) return null;
    // Accept both the original and upper-cased form so codes created by older
    // server versions (lower-case hash) still work after an upgrade.
    const hashes = Array.from(new Set([
      hashToken(normalized),
      hashToken(normalized.toUpperCase()),
    ]));
    const placeholders = hashes.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT pc.*
         FROM pair_codes pc
         WHERE pc.code_hash IN (${placeholders})
           AND pc.used_at IS NULL
           AND (pc.expires_at = 0 OR pc.expires_at > ?)`,
      )
      .get(...hashes, Date.now()) as PairCodeRow | undefined;
    if (!row) return null;

    // Keep the binding code reusable across devices; it is a long-lived user binding,
    // not a one-time token. The used_at column is reserved for legacy data.

    return this.findUserById(row.user_id);
  }

  createSession(userId: string, token: string, ttlMs: number) {
    const at = nowIso();
    const expiresAt = Date.now() + ttlMs;
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(hashToken(token), userId, expiresAt, at);
    return expiresAt;
  }

  authenticateBearerToken(token: string): RequestContext | null {
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT u.*
         FROM sessions s
         INNER JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      )
      .get(tokenHash, Date.now()) as UserRow | undefined;

    if (!row) return null;
    return {user: toUser(row), tokenHash};
  }

  getCurrentRevision(userId: string) {
    const row = this.db
      .prepare(`SELECT current_revision FROM user_revision WHERE user_id = ?`)
      .get(userId) as {current_revision: number} | undefined;
    return row?.current_revision ?? 0;
  }

  registerDevice(userId: string, deviceId: string, deviceName: string, deviceType: string) {
    const at = nowIso();
    this.db.prepare(
      `INSERT INTO devices (device_id, user_id, device_name, device_type, last_synced_revision, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET device_name = excluded.device_name, device_type = excluded.device_type, last_seen_at = excluded.last_seen_at`
    ).run(deviceId, userId, deviceName || null, deviceType || null, at, at);
    return {success: true, deviceId};
  }

  updateDeviceSyncRevision(userId: string, deviceId: string, revision: number) {
    // 设备上报的 revision 必须夹在 [0, 当前全局 revision] 内，防止任意值
    // （含超过当前 revision 的伪值）污染设备进度展示。
    const currentRow = this.db
      .prepare(`SELECT current_revision FROM user_revision WHERE user_id = ?`)
      .get(userId) as {current_revision?: number} | undefined;
    const currentRevision = Number(currentRow?.current_revision ?? 0);
    const safeRevision = Math.max(0, Math.min(Math.floor(Number(revision) || 0), currentRevision));
    const result = this.db.prepare(`UPDATE devices SET last_synced_revision = ?, last_seen_at = ? WHERE user_id = ? AND device_id = ?`)
      .run(safeRevision, nowIso(), userId, deviceId);
    return {success: result.changes > 0, deviceId, revision: safeRevision};
  }

  listDevices(userId: string) {
    const rows = this.db.prepare(`SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC`).all(userId) as any[];
    return {items: rows.map((r: any) => ({deviceId: r.device_id, deviceName: r.device_name, deviceType: r.device_type, lastSyncedRevision: r.last_synced_revision, lastSeenAt: r.last_seen_at, createdAt: r.created_at}))};
  }

  reorderPlaylists(userId: string, orderedIds: string[], baseRevision?: number) {
    const normalized = this.validateCompleteOrder(
      userId,
      orderedIds,
      `SELECT id AS item_id FROM playlists WHERE user_id = ? AND deleted_at IS NULL`,
      [],
      '歌单',
    );
    return this.writeTransaction(userId, (revision, at) => {
      for (let i = 0; i < normalized.length; i++) {
        this.db.prepare(`UPDATE playlists SET position = ?, revision = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL`)
          .run(i, revision, at, userId, normalized[i]);
      }
      this.recordEvent(userId, revision, 'playlist', 'reorder', 'reorder', {orderedIds: normalized}, null, at);
      return {orderedIds: normalized, revision};
    }, baseRevision, 'playlist');
  }

  reorderFavorites(userId: string, entityType: string, orderedIds: string[], baseRevision?: number) {
    const type = normalizeFavoriteEntityType(entityType);
    const normalized = this.validateCompleteOrder(
      userId,
      orderedIds,
      `SELECT entity_id AS item_id FROM favorites WHERE user_id = ? AND entity_type = ? AND deleted_at IS NULL`,
      [type],
      `${type} 收藏`,
    );
    return this.writeTransaction(userId, (revision, at) => {
      for (let i = 0; i < normalized.length; i++) {
        this.db.prepare('UPDATE favorites SET position = ?, revision = ?, updated_at = ? WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL')
          .run(i, revision, at, userId, type, normalized[i]);
      }
      this.recordEvent(userId, revision, 'favorite', type + ':reorder', 'reorder', {entityType: type, orderedIds: normalized}, null, at);
      return {entityType: type, orderedIds: normalized, revision};
    }, baseRevision, 'favorite:' + type);
  }

  reorderPlugins(userId: string, orderedIds: string[], baseRevision?: number) {
    const normalized = this.validateCompleteOrder(
      userId,
      orderedIds,
      `SELECT identity_key AS item_id FROM user_plugins WHERE user_id = ? AND deleted_at IS NULL`,
      [],
      '插件',
    );
    return this.writeTransaction(userId, (revision, at) => {
      for (let i = 0; i < normalized.length; i++) {
        this.db.prepare('UPDATE user_plugins SET position = ?, revision = ?, updated_at = ? WHERE user_id = ? AND identity_key = ? AND deleted_at IS NULL')
          .run(i, revision, at, userId, normalized[i]);
      }
      this.recordEvent(userId, revision, 'plugin', 'reorder', 'reorder', {orderedIds: normalized}, null, at);
      return {orderedIds: normalized, revision};
    }, baseRevision, 'plugin');
  }

  listPlaylists(userId: string) {
    const rows = this.db
      .prepare(`SELECT * FROM playlists WHERE user_id = ? AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`)
      .all(userId) as PlaylistRow[];
    const count = this.db.prepare(
      `SELECT COUNT(*) AS total FROM playlist_songs WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`,
    );
    return rows
      .filter((row) => !isBridgedPlaylistRow(row))
      .map((row) => toPlaylist(row, Number((count.get(userId, row.id) as {total: number}).total || 0)));
  }

  getPlaylistSongs(userId: string, playlistId: string, sort: 'asc' | 'desc' = 'asc', limit?: number, pos?: number) {
    const playlist = this.db
      .prepare(`SELECT * FROM playlists WHERE user_id = ? AND id = ? AND deleted_at IS NULL`)
      .get(userId, playlistId) as PlaylistRow | undefined;
    if (!playlist) return null;

    const order = sort === 'desc' ? 'DESC' : 'ASC';
    const offset = Math.max(0, pos ?? 0);
    const max = Math.max(0, limit ?? 5000);
    const rows = this.db
      .prepare(
        `SELECT * FROM playlist_songs
         WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL
         ORDER BY sort_order ${order}, created_at ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(userId, playlistId, max, offset) as PlaylistSongRow[];
    const total = this.db
      .prepare(`SELECT COUNT(*) AS total FROM playlist_songs WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`)
      .get(userId, playlistId) as {total: number};

    const songs = rows.map(toPlaylistSong);
    return {playlist: toPlaylist(playlist, total.total), list: songs, songs, total: total.total};
  }

  createPlaylist(userId: string, input: PlaylistInput) {
    const previewLocalId = getText(input.localId) || null;
    const previewTitle = getText(input.title) || getText(input.name) || '未命名歌单';
    if (isBridgedPlaylistInput({...input, localId: previewLocalId || undefined, title: previewTitle})) {
      return {
        id: '',
        name: previewTitle,
        title: previewTitle,
        skipped: true,
        reason: 'bridged-playlist-excluded',
        revision: this.getCurrentRevision(userId),
      };
    }
    if (resolveSemanticType(input, previewTitle, previewLocalId) === FAVORITES_SEMANTIC) {
      const aliases = this.listFavoriteAliasPlaylists(userId);
      if (aliases.length > 1) {
        this.db.transaction(() => {
          this.coalesceFavoritePlaylistsForUser(userId);
        })();
      }
    }

    return this.writeTransaction(userId, (revision, at) => {
      const localId = previewLocalId;
      const requestedTitle = previewTitle;
      const semanticType = resolveSemanticType(input, requestedTitle, localId);
      const title = semanticType === FAVORITES_SEMANTIC ? FAVORITES_TITLE : requestedTitle;
      const requestedPosition = Number(input.position);
      const position = Number.isFinite(requestedPosition) && requestedPosition >= 0
        ? requestedPosition
        : (this.db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM playlists WHERE user_id = ? AND deleted_at IS NULL`).get(userId) as {next_pos: number}).next_pos;
      const existing = this.findReusablePlaylist(userId, {localId, semanticType, title: requestedTitle});
      if (existing) {
        return this.mutateExistingPlaylist(
          userId,
          existing,
          {
            ...input,
            localId: this.resolvePlaylistLocalId(existing, localId, semanticType) || undefined,
            title,
            name: title,
            semanticType: semanticType || existing.semantic_type || undefined,
          },
          revision,
          at,
        );
      }

      const playlist = {
        id: createId('pl'),
        user_id: userId,
        local_id: semanticType === FAVORITES_SEMANTIC ? localId || FAVORITES_STABLE_LOCAL_ID : localId,
        title,
        description: getText(input.description) || getText(input.describe) || '',
        cover_url: getText(input.coverUrl) || getText(input.cover) || getText(input.filePath) || null,
        semantic_type: semanticType,
        source: getText(input.source) || null,
        source_playlist_id: getText(input.sourcePlaylistId) || null,
        position,
        revision,
        deleted_at: null,
        created_at: at,
        updated_at: at,
      };

      this.db
        .prepare(
          `INSERT INTO playlists
           (id, user_id, local_id, title, description, cover_url, semantic_type, source, source_playlist_id, position, revision, deleted_at, created_at, updated_at)
           VALUES (@id, @user_id, @local_id, @title, @description, @cover_url, @semantic_type, @source, @source_playlist_id, @position, @revision, @deleted_at, @created_at, @updated_at)`,
        )
        .run(playlist);

      const songs = parseJsonArray(input.songlist || input.songs);
      this.upsertSongs(userId, playlist.id, songs, revision, at);
      this.recordEvent(userId, revision, 'playlist', playlist.id, 'upsert', toPlaylist(playlist, songs.length), null, at);
      return {...toPlaylist(playlist, songs.length), revision, updatedAt: at};
    });
  }

  updatePlaylist(userId: string, input: PlaylistPatchInput) {
    const playlistId = getText(input.playlistId) || getText(input.listId) || getText(input.id);
    if (!playlistId) return null;
    const preview = this.getPlaylistRow(userId, playlistId);
    if (isBridgedPlaylistInput(input) || (preview && isBridgedPlaylistRow(preview))) {
      const deleted = this.deletePlaylist(userId, playlistId);
      return deleted ? {...deleted, skipped: true, reason: 'bridged-playlist-excluded'} : null;
    }
    if (preview) {
      this.assertBaseRevision(
        userId,
        Number.isFinite(Number(input.baseRevision)) ? Number(input.baseRevision) : undefined,
        'playlist:' + playlistId,
      );
      const previewNext = this.buildPlaylistUpdate(preview, input, preview.revision, preview.updated_at);
      const snapshotSongs = parseJsonArray(input.songlist || input.songs);
      const shouldReplaceSongs =
        Boolean(input.songlist || input.songs) &&
        this.canReplaceFavoriteSongsFromSnapshot(userId, preview, snapshotSongs, input.orderOnly === true);
      const unchanged =
        this.playlistMetadataEquals(preview, previewNext) &&
        (!shouldReplaceSongs || this.isSamePlaylistSongSnapshot(userId, playlistId, snapshotSongs));
      if (unchanged) {
        return {
          ...toPlaylist(preview, this.countSongs(userId, playlistId)),
          revision: preview.revision,
          updatedAt: preview.updated_at,
        };
      }
    }

    const baseRevision = Number.isFinite(Number(input.baseRevision)) ? Number(input.baseRevision) : undefined;
    return this.writeTransaction(userId, (revision, at) => {
      const existing = this.getPlaylistRow(userId, playlistId);
      if (!existing) return null;

      const next = this.buildPlaylistUpdate(existing, input, revision, at);

      this.db
        .prepare(
          `UPDATE playlists
           SET local_id = @local_id,
               title = @title,
               description = @description,
               cover_url = @cover_url,
               semantic_type = @semantic_type,
               source = @source,
               source_playlist_id = @source_playlist_id,
               position = @position,
               revision = @revision,
               deleted_at = @deleted_at,
               updated_at = @updated_at
           WHERE user_id = @user_id AND id = @id`,
        )
        .run(next);

      const snapshotSongs = parseJsonArray(input.songlist || input.songs);
      if (
        (input.songlist || input.songs) &&
        this.canReplaceFavoriteSongsFromSnapshot(userId, existing, snapshotSongs, input.orderOnly === true)
      ) {
        this.replacePlaylistSongs(userId, playlistId, snapshotSongs, revision, at);
      }

      const total = this.countSongs(userId, playlistId);
      this.recordEvent(userId, revision, 'playlist', playlistId, 'upsert', toPlaylist(next, total), null, at);
      return {...toPlaylist(next, total), revision, updatedAt: at};
    }, baseRevision, 'playlist:' + playlistId);
  }

  private buildPlaylistUpdate(
    existing: PlaylistRow,
    input: PlaylistPatchInput,
    revision: number,
    at: string,
  ): PlaylistRow {
    return {
      ...existing,
      local_id: getText(input.localId) || existing.local_id,
      title: getText(input.title) || getText(input.name) || existing.title,
      description: getText(input.description) || getText(input.describe) || existing.description,
      cover_url: getText(input.coverUrl) || getText(input.cover) || getText(input.filePath) || existing.cover_url,
      semantic_type: getText(input.semanticType) || existing.semantic_type,
      source: getText(input.source) || existing.source,
      source_playlist_id: getText(input.sourcePlaylistId) || existing.source_playlist_id,
      position: Number.isFinite(Number(input.position)) && Number(input.position) >= 0
        ? Number(input.position)
        : existing.position,
      revision,
      deleted_at: null,
      updated_at: at,
    };
  }

  private playlistMetadataEquals(left: PlaylistRow, right: PlaylistRow) {
    return (
      left.local_id === right.local_id &&
      left.title === right.title &&
      left.description === right.description &&
      left.cover_url === right.cover_url &&
      left.semantic_type === right.semantic_type &&
      left.source === right.source &&
      left.source_playlist_id === right.source_playlist_id &&
      left.position === right.position
    );
  }

  private isSamePlaylistSongSnapshot(userId: string, playlistId: string, songs: UnknownRecord[]) {
    const normalized = this.normalizePlaylistSnapshot(songs);
    const currentRows = this.db
      .prepare(
        `SELECT *
         FROM playlist_songs
         WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL
         ORDER BY sort_order ASC, created_at ASC, id ASC`,
      )
      .all(userId, playlistId) as PlaylistSongRow[];
    if (normalized.length !== currentRows.length) return false;

    return normalized.every((song, index) => {
      const row = currentRows[index];
      if (!row || row.track_key !== song.trackKey) return false;
      const stored = parseJsonRecord(row.track_json);
      return (
        stored.id === song.id &&
        stored.source === song.source &&
        stored.title === song.title &&
        stored.artist === song.artist &&
        stored.album === song.album &&
        stored.albumId === song.albumId &&
        stored.durationText === song.durationText &&
        stored.artworkUrl === song.artworkUrl &&
        json(stored.qualities ?? null) === json(song.qualities ?? null)
      );
    });
  }

  deletePlaylist(userId: string, playlistId: string) {
    return this.writeTransaction(userId, (revision, at) => {
      const existing = this.getPlaylistRow(userId, playlistId);
      if (!existing) return null;

      this.db
        .prepare(`UPDATE playlists SET revision = ?, deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
        .run(revision, at, at, userId, playlistId);
      this.db
        .prepare(
          `UPDATE playlist_songs SET revision = ?, deleted_at = ?, updated_at = ?
           WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`,
        )
        .run(revision, at, at, userId, playlistId);

      this.recordEvent(userId, revision, 'playlist', playlistId, 'delete', {id: playlistId}, at, at);
      return {id: playlistId, playlistId, revision, deletedAt: at, updatedAt: at};
    });
  }

  private removeBridgedPlaylists() {
    const rows = this.db
      .prepare(`SELECT * FROM playlists WHERE deleted_at IS NULL`)
      .all() as PlaylistRow[];
    for (const row of rows) {
      if (isBridgedPlaylistRow(row)) {
        this.deletePlaylist(row.user_id, row.id);
      }
    }
  }

  addSongs(userId: string, input: PlaylistSongMutationInput) {
    const playlistId = getText(input.playlistId) || getText(input.listId) || getText(input.id);
    if (!playlistId) return null;
    const preview = this.getPlaylistRow(userId, playlistId);
    if (preview && isBridgedPlaylistRow(preview)) {
      const deleted = this.deletePlaylist(userId, playlistId);
      return deleted ? {...deleted, skipped: true, reason: 'bridged-playlist-excluded'} : null;
    }
    if (preview?.semantic_type === FAVORITES_SEMANTIC) {
      return {
        id: playlistId,
        playlistId,
        skipped: true,
        reason: 'favorites-require-operation',
        revision: this.getCurrentRevision(userId),
        updatedAt: nowIso(),
      };
    }

    return this.writeTransaction(userId, (revision, at) => {
      if (!this.getPlaylistRow(userId, playlistId)) return null;
      const songs = parseJsonArray(input.songlist || input.songs);
      this.upsertSongs(userId, playlistId, songs, revision, at, 'prepend');
      this.touchPlaylist(userId, playlistId, revision, at);
      this.recordEvent(userId, revision, 'playlistSongs', playlistId, 'upsert', {playlistId, songs: normalizePlaylistSongs(songs)}, null, at);
      return {id: playlistId, playlistId, revision, updatedAt: at};
    });
  }

  removeSongs(userId: string, input: PlaylistSongMutationInput) {
    const playlistId = getText(input.playlistId) || getText(input.listId) || getText(input.id);
    if (!playlistId) return null;
    const preview = this.getPlaylistRow(userId, playlistId);
    if (preview?.semantic_type === FAVORITES_SEMANTIC) {
      return {
        id: playlistId,
        playlistId,
        skipped: true,
        reason: 'favorites-require-operation',
        revision: this.getCurrentRevision(userId),
        updatedAt: nowIso(),
      };
    }
    const ids = [...(input.songIds || []), ...(input.songmids || []), ...(input.trackKeys || [])].map(String).filter(Boolean);

    return this.writeTransaction(userId, (revision, at) => {
      if (!this.getPlaylistRow(userId, playlistId)) return null;
      const rows = this.db
        .prepare(`SELECT * FROM playlist_songs WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`)
        .all(userId, playlistId) as PlaylistSongRow[];
      const remove = rows.filter((row) => {
        const song = parseJson<UnknownRecord>(row.track_json, {});
        return ids.some((id) => id === row.track_key || row.track_key.endsWith(`:${id}`) || id === song.id || id === song.songmid || id === song.hash);
      });

      for (const row of remove) {
        this.db
          .prepare(`UPDATE playlist_songs SET revision = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
          .run(revision, at, at, row.id, userId);
      }

      this.touchPlaylist(userId, playlistId, revision, at);
      this.recordEvent(userId, revision, 'playlistSongs', playlistId, 'delete', {playlistId, songIds: ids}, at, at);
      return {id: playlistId, playlistId, revision, deletedAt: at, updatedAt: at};
    });
  }

  applySongOperation(userId: string, input: PlaylistSongOperationInput) {
    const operationId = getText(input.operationId);
    const deviceId = getText(input.deviceId);
    const playlistId = getText(input.playlistId);
    const action = input.action === 'remove' ? 'remove' : input.action === 'add' ? 'add' : null;
    const sequence = Number(input.sequence);
    if (!operationId || !deviceId || !playlistId || !action || !Number.isSafeInteger(sequence) || sequence < 1) {
      const error = new Error('operationId、deviceId、sequence、playlistId、action 必须有效');
      Object.assign(error, {statusCode: 400});
      throw error;
    }
    const requestedOccurredAtMs = Number(input.occurredAtMs);
    const occurredAtMs = Number.isSafeInteger(requestedOccurredAtMs) && requestedOccurredAtMs > 0
      ? requestedOccurredAtMs
      : Date.now();

    const normalizedSong = action === 'add' && input.song && typeof input.song === 'object'
      ? normalizeSong(input.song)
      : null;
    const trackKey = normalizeTrackKey(getText(input.trackKey) || normalizedSong?.trackKey || '');
    if (!trackKey) {
      const error = new Error('trackKey 不能为空');
      Object.assign(error, {statusCode: 400});
      throw error;
    }
    if (
      action === 'add' &&
      (!normalizedSong ||
        !ALLOWED_CLOUD_SONG_SOURCES.has(normalizedSong.source) ||
        normalizedSong.trackKey.startsWith('local:'))
    ) {
      const error = new Error('只能同步受支持的云端歌曲');
      Object.assign(error, {statusCode: 400});
      throw error;
    }

    const result = this.db.transaction(() => {
      const existingOperation = this.db
        .prepare(
          `SELECT * FROM playlist_song_operations
           WHERE user_id = ? AND operation_id = ?`,
        )
        .get(userId, operationId) as PlaylistSongOperationRow | undefined;
      if (existingOperation) {
        return parseJson<UnknownRecord>(existingOperation.result_json, {
          operationId,
          applied: Boolean(existingOperation.applied),
          changed: Boolean(existingOperation.changed),
          stale: Boolean(existingOperation.stale),
          action: existingOperation.action,
          trackKey: existingOperation.track_key,
          removedCount: 0,
          revision: existingOperation.revision,
          updatedAt: existingOperation.created_at,
        });
      }

      const at = nowIso();
      const persistResult = (
        result: Record<string, unknown>,
        revision: number,
        applied: boolean,
        changed: boolean,
        stale: boolean,
      ) => {
        this.db
          .prepare(
            `INSERT INTO playlist_song_operations
             (operation_id, user_id, device_id, sequence, playlist_id, action, track_key,
              occurred_at_ms, applied, changed, stale, result_json, revision, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            operationId,
            userId,
            deviceId,
            sequence,
            playlistId,
            action,
            trackKey,
            occurredAtMs,
            applied ? 1 : 0,
            changed ? 1 : 0,
            stale ? 1 : 0,
            json(result),
            revision,
            at,
          );
        return result;
      };
      const currentRevision = this.getCurrentRevision(userId);
      const newerOperation = this.db
        .prepare(
          `SELECT operation_id
           FROM playlist_song_operations
           WHERE user_id = ? AND device_id = ? AND track_key = ? AND sequence > ?
           LIMIT 1`,
        )
        .get(userId, deviceId, trackKey, sequence) as {operation_id: string} | undefined;
      if (newerOperation) {
        const winningOperation = this.db
          .prepare(
            `SELECT occurred_at_ms
             FROM playlist_song_operations
             WHERE user_id = ? AND operation_id = ?
             LIMIT 1`,
          )
          .get(userId, newerOperation.operation_id) as {occurred_at_ms: number} | undefined;
        return persistResult(
          {
            operationId,
            applied: false,
            changed: false,
            stale: true,
            action,
            trackKey,
            removedCount: 0,
            revision: currentRevision,
            updatedAt: at,
            winningOperationId: newerOperation.operation_id,
            winningOccurredAtMs: Number(winningOperation?.occurred_at_ms || 0),
          },
          currentRevision,
          false,
          false,
          true,
        );
      }

      const latestTrackOperation = this.db
        .prepare(
          `SELECT operation_id, device_id, sequence, occurred_at_ms
           FROM playlist_song_operations
           WHERE user_id = ? AND playlist_id = ? AND track_key = ?
           ORDER BY occurred_at_ms DESC, operation_id DESC
           LIMIT 1`,
        )
        .get(userId, playlistId, trackKey) as
          | {operation_id: string; device_id: string; sequence: number; occurred_at_ms: number}
          | undefined;
      const latestSameDevice = latestTrackOperation?.device_id === deviceId;
      if (
        latestTrackOperation &&
        (
          (latestSameDevice
            ? sequence <= Number(latestTrackOperation.sequence || 0)
            : occurredAtMs < Number(latestTrackOperation.occurred_at_ms || 0) ||
              (
                occurredAtMs === Number(latestTrackOperation.occurred_at_ms || 0) &&
                operationId <= latestTrackOperation.operation_id
              ))
        )
      ) {
        return persistResult(
          {
            operationId,
            applied: false,
            changed: false,
            stale: true,
            action,
            trackKey,
            removedCount: 0,
            revision: currentRevision,
            updatedAt: at,
            winningOperationId: latestTrackOperation.operation_id,
            winningOccurredAtMs: Number(latestTrackOperation.occurred_at_ms || 0),
          },
          currentRevision,
          false,
          false,
          true,
        );
      }

      if (!this.getPlaylistRow(userId, playlistId)) {
        const error = new Error('歌单不存在');
        Object.assign(error, {statusCode: 404});
        throw error;
      }

      const currentRows = this.db
        .prepare(`SELECT * FROM playlist_songs WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`)
        .all(userId, playlistId) as PlaylistSongRow[];

      if (action === 'remove') {
        const remove = currentRows.filter((row) => {
          if (row.track_key === trackKey) return true;
          const song = parseJson<UnknownRecord>(row.track_json, {});
          return String(song.id || song.songmid || song.hash || '') === trackKey.substring(trackKey.indexOf(':') + 1);
        });
        if (remove.length === 0) {
          return persistResult(
            {
              operationId,
              applied: false,
              changed: false,
              stale: false,
              action,
              trackKey,
              removedCount: 0,
              revision: currentRevision,
              updatedAt: at,
            },
            currentRevision,
            false,
            false,
            false,
          );
        }

        const revision = this.nextRevision(userId);
        for (const row of remove) {
          this.db
            .prepare(`UPDATE playlist_songs SET revision = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
            .run(revision, at, at, row.id, userId);
        }
        this.touchPlaylist(userId, playlistId, revision, at);
        this.recordEvent(
          userId,
          revision,
          'playlistSongs',
          playlistId,
          'delete',
          {
            playlistId,
            songIds: remove.map((row) => row.track_key),
            trackKey,
            operationId,
            deviceId,
            sequence,
            action,
            removedCount: remove.length,
          },
          at,
          at,
        );
        return persistResult(
          {
            operationId,
            applied: true,
            changed: true,
            stale: false,
            action,
            trackKey,
            removedCount: remove.length,
            revision,
            updatedAt: at,
          },
          revision,
          true,
          true,
          false,
        );
      }

      const existing = currentRows.find((row) => row.track_key === trackKey);
      if (existing) {
        return persistResult(
          {
            operationId,
            applied: true,
            changed: false,
            stale: false,
            action,
            trackKey,
            removedCount: 0,
            revision: currentRevision,
            updatedAt: at,
          },
          currentRevision,
          true,
          false,
          false,
        );
      }

      const revision = this.nextRevision(userId);
      this.db
        .prepare(
          `UPDATE playlist_songs
           SET sort_order = sort_order + 1
           WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`,
        )
        .run(userId, playlistId);
      this.insertOrUpdatePlaylistSong({
        id: createId('trk'),
        user_id: userId,
        playlist_id: playlistId,
        track_key: trackKey,
        track_json: json({
          id: normalizedSong!.id,
          source: normalizedSong!.source,
          title: normalizedSong!.title,
          artist: normalizedSong!.artist,
          album: normalizedSong!.album,
          albumId: normalizedSong!.albumId,
          durationText: normalizedSong!.durationText,
          artworkUrl: normalizedSong!.artworkUrl,
          qualities: normalizedSong!.qualities,
          position: 0,
        }),
        sort_order: 0,
        revision,
        deleted_at: null,
        created_at: at,
        updated_at: at,
      });
      this.touchPlaylist(userId, playlistId, revision, at);
      this.recordEvent(
        userId,
        revision,
        'playlistSongs',
        playlistId,
        'upsert',
        {
          playlistId,
          songs: [{...normalizedSong!, position: 0}],
          trackKey,
          operationId,
          deviceId,
          sequence,
          action,
          removedCount: 0,
        },
        null,
        at,
      );
      return persistResult(
        {
          operationId,
          applied: true,
          changed: true,
          stale: false,
          action,
          trackKey,
          removedCount: 0,
          revision,
          updatedAt: at,
        },
        revision,
        true,
        true,
        false,
      );
    })();
    this.notifySyncWaiters(userId);
    return result;
  }

  listFavorites(userId: string, entityType?: string) {
    const type = entityType ? normalizeFavoriteEntityType(entityType) : null;
    const rows = type
      ? (this.db
          .prepare(`SELECT * FROM favorites WHERE user_id = ? AND entity_type = ? AND deleted_at IS NULL ORDER BY position ASC, updated_at DESC`)
          .all(userId, type) as FavoriteRow[])
      : (this.db
          .prepare(`SELECT * FROM favorites WHERE user_id = ? AND deleted_at IS NULL ORDER BY entity_type ASC, position ASC, updated_at DESC`)
          .all(userId) as FavoriteRow[]);
    const items = rows.map(toFavorite);
    return items.sort((left, right) => {
      if (type === 'podcast') {
        const pinnedDelta = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
        if (pinnedDelta !== 0) return pinnedDelta;
      }
      return (left.position ?? 0) - (right.position ?? 0) || String(left.createdAt).localeCompare(String(right.createdAt));
    });
  }

  upsertFavorite(userId: string, input: FavoriteInput) {
    const operationId = getText(input.operationId);
    if (operationId) {
      const existingOperation = this.db
        .prepare(`SELECT result_json FROM favorite_operations WHERE user_id = ? AND operation_id = ?`)
        .get(userId, operationId) as {result_json: string} | undefined;
      if (existingOperation) return parseJson<UnknownRecord | null>(existingOperation.result_json, null);
    }
    return this.writeTransaction(userId, (revision, at) => {
      const entityType = normalizeFavoriteEntityType(input.entityType);
      const entityId = getText(input.entityId) || getText(input.playlistId) || getText(input.sourcePlaylistId);
      if (!entityId) return null;

      const existing = this.db
        .prepare(`SELECT * FROM favorites WHERE user_id = ? AND entity_type = ? AND entity_id = ?`)
        .get(userId, entityType, entityId) as FavoriteRow | undefined;
      const existingMetadata = parseJson<UnknownRecord>(existing?.metadata_json, {});
      const inputMetadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
      const metadata = {...existingMetadata, ...inputMetadata};
      const position = input.position !== undefined
        ? Number(input.position)
        : Number.isFinite(Number(existing?.position)) ? Number(existing?.position) : getFavoritePosition(existingMetadata) ?? 0;
      if (input.position !== undefined) metadata.position = position;
      if (input.pinned !== undefined) metadata.pinned = Boolean(input.pinned);
      const existingOccurredAtMs = Number(existingMetadata.occurredAtMs || 0);
      const incomingOccurredAtMs = Number(input.occurredAtMs || inputMetadata.occurredAtMs || 0);
      if (
        existing &&
        isStaleFavoriteWrite(existingOccurredAtMs, incomingOccurredAtMs, Boolean(existing.deleted_at), false)
      ) {
        // 回传获胜时间戳（对端墓碑的墙上时钟），让落后端把重发时间抬到墓碑之上稳定胜出。
        // 缺了它时安卓只能退回解析 updatedAt（服务器时钟），对端墙钟超前时永远抬不过墓碑。
        return {...toFavorite(existing), stale: true, applied: false, winningOccurredAtMs: existingOccurredAtMs};
      }
      if (incomingOccurredAtMs > 0) metadata.occurredAtMs = incomingOccurredAtMs;
      const row = {
        id: existing?.id || createId('fav'),
        user_id: userId,
        entity_type: entityType,
        entity_id: entityId,
        source_entity_id: getText(input.sourcePlaylistId) || existing?.source_entity_id || null,
        title: getText(input.title) || getText(input.name) || existing?.title || '未命名收藏',
        description: getText(input.description) || getText(input.describe) || existing?.description || '',
        cover_url: getText(input.coverUrl) || getText(input.cover) || getText(input.filePath) || existing?.cover_url || null,
        source: getText(input.source) || existing?.source || null,
        owner_name: getText(input.ownerName) || existing?.owner_name || null,
        metadata_json: Object.keys(metadata).length ? json(metadata) : null,
        position: Number.isFinite(position) && position >= 0 ? position : 0,
        revision,
        deleted_at: null,
        created_at: existing?.created_at || at,
        updated_at: at,
      };

      this.db
        .prepare(
          `INSERT INTO favorites
           (id, user_id, entity_type, entity_id, source_entity_id, title, description, cover_url, source, owner_name, metadata_json, position, revision, deleted_at, created_at, updated_at)
           VALUES (@id, @user_id, @entity_type, @entity_id, @source_entity_id, @title, @description, @cover_url, @source, @owner_name, @metadata_json, @position, @revision, @deleted_at, @created_at, @updated_at)
           ON CONFLICT(user_id, entity_type, entity_id) DO UPDATE SET
             source_entity_id = excluded.source_entity_id,
             title = excluded.title,
             description = excluded.description,
             cover_url = excluded.cover_url,
             source = excluded.source,
             owner_name = excluded.owner_name,
             metadata_json = excluded.metadata_json,
             position = excluded.position,
             revision = excluded.revision,
             deleted_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(row);

      const result = toFavorite(row);
      this.recordEvent(userId, revision, 'favorite', row.id, 'upsert', result, null, at);
      if (operationId) {
        this.db
          .prepare(`INSERT INTO favorite_operations (operation_id, user_id, result_json, revision, created_at) VALUES (?, ?, ?, ?, ?)` )
          .run(operationId, userId, json(result), revision, at);
      }
      return result;
    });
  }

  deleteFavorite(userId: string, input: {entityType?: string; entityId?: string; playlistId?: string; operationId?: string; occurredAtMs?: number}) {
    const incomingOccurredAtMs = Number(input.occurredAtMs || 0);
    const operationId = getText(input.operationId);
    if (operationId) {
      const existingOperation = this.db
        .prepare(`SELECT result_json FROM favorite_operations WHERE user_id = ? AND operation_id = ?`)
        .get(userId, operationId) as {result_json: string} | undefined;
      if (existingOperation) {
        this.deleteSonglistForPlaylistFavorite(userId, input);
        return parseJson<UnknownRecord | null>(existingOperation.result_json, null);
      }
    }
    const removed = this.writeTransaction(userId, (revision, at) => {
      const entityType = normalizeFavoriteEntityType(input.entityType);
      const entityId = getText(input.entityId) || getText(input.playlistId);
      if (!entityId) return null;

      const row = this.db
        .prepare(`SELECT * FROM favorites WHERE user_id = ? AND entity_type = ? AND entity_id = ?`)
        .get(userId, entityType, entityId) as FavoriteRow | undefined;
      if (!row) {
        const result = {playlistId: entityId, entityId, revision, deletedAt: at, updatedAt: at};
        if (operationId) {
          this.db
            .prepare(`INSERT INTO favorite_operations (operation_id, user_id, result_json, revision, created_at) VALUES (?, ?, ?, ?, ?)` )
            .run(operationId, userId, json(result), revision, at);
        }
        return result;
      }
      const existingMetadata = parseJson<UnknownRecord>(row.metadata_json, {});
      const existingOccurredAtMs = Number(existingMetadata.occurredAtMs || 0);
      if (isStaleFavoriteWrite(existingOccurredAtMs, incomingOccurredAtMs, Boolean(row.deleted_at), true)) {
        return {id: row.id, playlistId: entityType === 'playlist' ? entityId : undefined, entityId, revision: row.revision, deletedAt: row.deleted_at, updatedAt: row.updated_at, stale: true, applied: false, winningOccurredAtMs: existingOccurredAtMs};
      }
      if (row.deleted_at) {
        return {id: row.id, playlistId: entityType === 'playlist' ? entityId : undefined, entityId, revision: row.revision, deletedAt: row.deleted_at, updatedAt: row.updated_at, stale: false, applied: false};
      }
      const metadata = {...existingMetadata};
      if (incomingOccurredAtMs > 0) metadata.occurredAtMs = incomingOccurredAtMs;

      this.db
        .prepare(`UPDATE favorites SET revision = ?, deleted_at = ?, updated_at = ?, metadata_json = ? WHERE user_id = ? AND id = ?`)
        .run(revision, at, at, Object.keys(metadata).length ? json(metadata) : null, userId, row.id);
      this.recordEvent(userId, revision, 'favorite', row.id, 'delete', {...toFavorite({...row, metadata_json: Object.keys(metadata).length ? json(metadata) : null}), deletedAt: at}, at, at);
      const result = {id: row.id, playlistId: entityType === 'playlist' ? entityId : undefined, entityId, revision, deletedAt: at, updatedAt: at, applied: true};
      if (operationId) {
        this.db
          .prepare(`INSERT INTO favorite_operations (operation_id, user_id, result_json, revision, created_at) VALUES (?, ?, ?, ?, ?)` )
          .run(operationId, userId, json(result), revision, at);
      }
      return result;
    });
    this.deleteSonglistForPlaylistFavorite(userId, input);
    return removed;
  }

  /**
   * 收藏歌单和歌单本身是同一件事。
   * 取消收藏时一并删掉云端歌单，另一台设备才会跟着消失。
   * “我的喜欢”和飞牛曲库不能被这次取消删掉。
   */
  private deleteSonglistForPlaylistFavorite(userId: string, input: {entityType?: string; entityId?: string; playlistId?: string}) {
    const entityType = normalizeFavoriteEntityType(input.entityType);
    const playlistId = getText(input.playlistId) || getText(input.entityId);
    if (entityType !== 'playlist' || !playlistId) return;
    const row = this.getPlaylistRow(userId, playlistId);
    if (!row || row.semantic_type === FAVORITES_SEMANTIC || isBridgedPlaylistRow(row)) return;
    this.deletePlaylist(userId, playlistId);
  }

  getCapabilitySecretKey() {
    const existing = this.getSetting(CAPABILITY_SECRET_SETTING);
    if (existing) return existing;
    const generated = generateDataKey();
    this.setSetting(CAPABILITY_SECRET_SETTING, generated);
    return generated;
  }

  putPluginBlob(script: string) {
    const value = String(script || '');
    const byteSize = Buffer.byteLength(value, 'utf8');
    if (!value.trim()) {
      const error = new Error('plugin script 不能为空');
      Object.assign(error, {statusCode: 400});
      throw error;
    }
    if (byteSize > MAX_PLUGIN_SCRIPT_BYTES) {
      const error = new Error('插件脚本不能超过 2MB');
      Object.assign(error, {statusCode: 400});
      throw error;
    }
    const contentHash = sha256Hex(value);
    this.db
      .prepare(
        `INSERT INTO plugin_blobs (content_hash, script, byte_size, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(content_hash) DO NOTHING`,
      )
      .run(contentHash, value, byteSize, nowIso());
    return {contentHash, byteSize};
  }

  getPluginBlob(contentHash: string) {
    const hash = getText(contentHash);
    if (!hash) return null;
    const row = this.db
      .prepare(`SELECT content_hash, script, byte_size FROM plugin_blobs WHERE content_hash = ?`)
      .get(hash) as {content_hash: string; script: string; byte_size: number} | undefined;
    if (!row) return null;
    return {contentHash: row.content_hash, script: row.script, byteSize: Number(row.byte_size || 0)};
  }

  listPlugins(userId: string, options: {includeDeleted?: boolean} = {}) {
    const rows = this.db
      .prepare(
        options.includeDeleted
          ? `SELECT * FROM user_plugins WHERE user_id = ? ORDER BY position ASC, created_at ASC`
          : `SELECT * FROM user_plugins WHERE user_id = ? AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`,
      )
      .all(userId) as UserPluginRow[];
    const plugins = rows.map((row) => this.toSyncedPlugin(row));
    if (options.includeDeleted) return plugins;
    // 同一脚本哈希不代表同一个插件：不同 identityKey 仍然必须分别返回，
    // 否则多个音源使用相同脚本时会被错误折叠，客户端看起来像插件丢失。
    return plugins;
  }

  applyPluginOperation(userId: string, input: PluginOperationInput) {
    const operationId = getText(input.operationId);
    const deviceId = getText(input.deviceId);
    const sequence = Number(input.sequence);
    const action = input.action === 'remove' ? 'remove' : input.action === 'upsert' ? 'upsert' : null;
    if (!operationId || !deviceId || !action || !Number.isSafeInteger(sequence) || sequence < 1) {
      const error = new Error('operationId、deviceId、sequence、action 必须有效');
      Object.assign(error, {statusCode: 400});
      throw error;
    }

    const requestedOccurredAtMs = Number(input.occurredAtMs);
    const occurredAtMs = Number.isSafeInteger(requestedOccurredAtMs) && requestedOccurredAtMs > 0
      ? requestedOccurredAtMs
      : Date.now();

    const kind: PluginKind = input.kind === 'capability' ? 'capability' : 'music-source';
    const role = kind === 'capability' ? canonicalCapabilityRole(input.role || input.identityKey?.replace(/^capability:/, '')) : '';
    const identityKey = kind === 'capability'
      ? capabilityIdentityKey(role)
      : getText(input.identityKey) || musicSourceIdentityKey(input.name, input.author);
    if (!identityKey || (kind === 'capability' && !role)) {
      const error = new Error(kind === 'capability' ? 'capability role 必须有效' : 'identityKey 不能为空');
      Object.assign(error, {statusCode: 400});
      throw error;
    }
    if (kind === 'music-source' && action === 'upsert' && !getText(input.contentHash)) {
      const error = new Error('music-source 插件必须提供 contentHash');
      Object.assign(error, {statusCode: 400});
      throw error;
    }
    if (kind === 'music-source' && action === 'upsert') {
      const blob = this.getPluginBlob(String(input.contentHash || ''));
      if (!blob) {
        const error = new Error('请先上传插件脚本');
        Object.assign(error, {statusCode: 400});
        throw error;
      }
    }

    const result = this.db.transaction(() => {
      const existingOperation = this.db
        .prepare(`SELECT * FROM plugin_operations WHERE user_id = ? AND operation_id = ?`)
        .get(userId, operationId) as PluginOperationRow | undefined;
      if (existingOperation) {
        return parseJson<UnknownRecord>(existingOperation.result_json, {
          operationId,
          applied: Boolean(existingOperation.applied),
          changed: Boolean(existingOperation.changed),
          stale: Boolean(existingOperation.stale),
          action: existingOperation.action,
          identityKey: existingOperation.identity_key,
          revision: existingOperation.revision,
          updatedAt: existingOperation.created_at,
        });
      }

      const at = nowIso();
      const persistResult = (
        result: Record<string, unknown>,
        revision: number,
        applied: boolean,
        changed: boolean,
        stale: boolean,
      ) => {
        this.db
          .prepare(
            `INSERT INTO plugin_operations
             (operation_id, user_id, device_id, sequence, occurred_at_ms, identity_key, action, kind,
              applied, changed, stale, result_json, revision, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            operationId,
            userId,
            deviceId,
            sequence,
            occurredAtMs,
            identityKey,
            action,
            kind,
            applied ? 1 : 0,
            changed ? 1 : 0,
            stale ? 1 : 0,
            json(result),
            revision,
            at,
          );
        return result;
      };

      const currentRevision = this.getCurrentRevision(userId);
      const newerOperation = this.db
        .prepare(
          `SELECT operation_id
           FROM plugin_operations
           WHERE user_id = ? AND device_id = ? AND identity_key = ? AND sequence > ?
           LIMIT 1`,
        )
        .get(userId, deviceId, identityKey, sequence) as {operation_id: string} | undefined;
      if (newerOperation) {
        return persistResult(
          {
            operationId,
            applied: false,
            changed: false,
            stale: true,
            action,
            identityKey,
            revision: currentRevision,
            updatedAt: at,
          },
          currentRevision,
          false,
          false,
          true,
        );
      }

      const latest = this.db
        .prepare(
          `SELECT operation_id, device_id, sequence, occurred_at_ms
           FROM plugin_operations
           WHERE user_id = ? AND identity_key = ?
           ORDER BY occurred_at_ms DESC, operation_id DESC
           LIMIT 1`,
        )
        .get(userId, identityKey) as
          | {operation_id: string; device_id: string; sequence: number; occurred_at_ms: number}
          | undefined;
      const latestSameDevice = latest?.device_id === deviceId;
      if (
        latest &&
        (
          (latestSameDevice
            ? sequence <= Number(latest.sequence || 0)
            : occurredAtMs < Number(latest.occurred_at_ms || 0) ||
              (occurredAtMs === Number(latest.occurred_at_ms || 0) && operationId <= latest.operation_id))
        )
      ) {
        return persistResult(
          {
            operationId,
            applied: false,
            changed: false,
            stale: true,
            action,
            identityKey,
            revision: currentRevision,
            updatedAt: at,
            winningOperationId: latest.operation_id,
            winningOccurredAtMs: Number(latest.occurred_at_ms || 0),
          },
          currentRevision,
          false,
          false,
          true,
        );
      }

      const existing = this.db
        .prepare(`SELECT * FROM user_plugins WHERE user_id = ? AND identity_key = ?`)
        .get(userId, identityKey) as UserPluginRow | undefined;

      if (action === 'remove') {
        const revision = this.nextRevision(userId);
        if (!existing || existing.deleted_at) {
          const result = {
            operationId,
            applied: false,
            changed: false,
            stale: false,
            action,
            identityKey,
            revision,
            updatedAt: at,
          };
          persistResult(result, revision, false, false, false);
          return result;
        }
        // 只墓碑被显式删除的这一个 identityKey。
        // 旧实现按 content_hash 级联墓碑所有共用同一脚本 hash 的插件：
        // 同一脚本被多个音源插件复用时（同 hash ≠ 同插件），一次 remove 会把
        // 云端整批音源插件打掉，且级联部分没有逐条 delete 事件，其他设备
        // 永远收不到删除通知 —— 这是“同步后插件只剩两个”的服务端根因。
        this.db
          .prepare(`UPDATE user_plugins SET revision = ?, deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
          .run(revision, at, at, userId, existing.id);
        const payload = this.toSyncedPlugin({...existing, revision, deleted_at: at, updated_at: at});
        this.recordEvent(userId, revision, 'plugin', identityKey, 'delete', payload, at, at);
        const result = {
          operationId,
          applied: true,
          changed: true,
          stale: false,
          action,
          identityKey,
          plugin: payload,
          revision,
          updatedAt: at,
        };
        persistResult(result, revision, true, true, false);
        return result;
      }

      const next = this.buildUserPluginRow(userId, existing, {
        kind,
        identityKey,
        role,
        name: getText(input.name) || (kind === 'capability' ? role : '') || '',
        author: getText(input.author) || '',
        version: getText(input.version) || '',
        enabled: input.enabled !== false,
        disabledSources: parseStringArray(input.disabledSources),
        contentHash: kind === 'music-source' ? (getText(input.contentHash) || '') : '',
        config: kind === 'capability' ? mergeCapabilityConfig(role, this.decryptPluginConfig(existing), input.config) : {},
        position: Number.isFinite(Number(input.position)) && Number(input.position) >= 0
          ? Number(input.position)
          : Number(existing?.position || 0),
        revision: currentRevision,
        at,
      });

      if (existing && !existing.deleted_at && this.userPluginContentEquals(existing, next)) {
        const result = {
          operationId,
          applied: true,
          changed: false,
          stale: false,
          action,
          identityKey,
          plugin: this.toSyncedPlugin(existing),
          revision: currentRevision,
          updatedAt: existing.updated_at,
        };
        persistResult(result, currentRevision, true, false, false);
        return result;
      }

      const revision = this.nextRevision(userId);
      const persisted = {...next, revision, updated_at: at};
      this.db
        .prepare(
          `INSERT INTO user_plugins
           (id, user_id, kind, identity_key, name, author, version, enabled, disabled_sources_json,
            content_hash, config_cipher, position, revision, deleted_at, created_at, updated_at)
           VALUES (@id, @user_id, @kind, @identity_key, @name, @author, @version, @enabled, @disabled_sources_json,
            @content_hash, @config_cipher, @position, @revision, @deleted_at, @created_at, @updated_at)
           ON CONFLICT(user_id, identity_key) DO UPDATE SET
             kind = excluded.kind,
             name = excluded.name,
             author = excluded.author,
             version = excluded.version,
             enabled = excluded.enabled,
             disabled_sources_json = excluded.disabled_sources_json,
             content_hash = excluded.content_hash,
             config_cipher = excluded.config_cipher,
             position = excluded.position,
             revision = excluded.revision,
             deleted_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(persisted);
      const payload = this.toSyncedPlugin(persisted);
      this.recordEvent(userId, revision, 'plugin', identityKey, 'upsert', payload, null, at);
      const result = {
        operationId,
        applied: true,
        changed: true,
        stale: false,
        action,
        identityKey,
        plugin: payload,
        revision,
        updatedAt: at,
      };
      persistResult(result, revision, true, true, false);
      return result;
    })();
    this.notifySyncWaiters(userId);
    return result;
  }

  private decryptPluginConfig(row?: UserPluginRow | null) {
    if (!row?.config_cipher) return {};
    return decryptJson<UnknownRecord>(this.getCapabilitySecretKey(), row.config_cipher, {});
  }

  private userPluginContentEquals(left: UserPluginRow, right: UserPluginRow) {
    const leftPlugin = this.toSyncedPlugin(left);
    const rightPlugin = this.toSyncedPlugin(right);
    const normalizeConfig = (plugin: SyncedPlugin) => (
      plugin.kind === 'capability'
        ? canonicalizeCapabilityConfig(plugin.role || '', plugin.config || {})
        : {}
    );
    return json({
      kind: leftPlugin.kind,
      name: leftPlugin.name || '',
      author: leftPlugin.author || '',
      version: leftPlugin.version || '',
      enabled: Boolean(leftPlugin.enabled),
      disabledSources: [...(leftPlugin.disabledSources || [])].sort(),
      contentHash: leftPlugin.contentHash || '',
      role: leftPlugin.role || '',
      config: normalizeConfig(leftPlugin),
      position: leftPlugin.position,
    }) === json({
      kind: rightPlugin.kind,
      name: rightPlugin.name || '',
      author: rightPlugin.author || '',
      version: rightPlugin.version || '',
      enabled: Boolean(rightPlugin.enabled),
      disabledSources: [...(rightPlugin.disabledSources || [])].sort(),
      contentHash: rightPlugin.contentHash || '',
      role: rightPlugin.role || '',
      config: normalizeConfig(rightPlugin),
      position: rightPlugin.position,
    });
  }

  private buildUserPluginRow(
    userId: string,
    existing: UserPluginRow | undefined,
    input: {
      kind: PluginKind;
      identityKey: string;
      role: string;
      name: string;
      author: string;
      version: string;
      enabled: boolean;
      disabledSources: string[];
      contentHash: string;
      config: UnknownRecord;
      position: number;
      revision: number;
      at: string;
    },
  ): UserPluginRow {
    const configCipher = input.kind === 'capability'
      ? encryptJson(this.getCapabilitySecretKey(), canonicalizeCapabilityConfig(input.role, input.config))
      : null;
    return {
      id: existing?.id || createId('plg'),
      user_id: userId,
      kind: input.kind,
      identity_key: input.identityKey,
      name: input.name || existing?.name || '',
      author: input.author || existing?.author || '',
      version: input.version || existing?.version || '',
      enabled: input.enabled ? 1 : 0,
      disabled_sources_json: json(input.disabledSources),
      content_hash: input.contentHash || null,
      config_cipher: configCipher,
      position: input.position,
      revision: input.revision,
      deleted_at: null,
      created_at: existing?.created_at || input.at,
      updated_at: input.at,
    };
  }

  private toSyncedPlugin(row: UserPluginRow): SyncedPlugin {
    const role = row.kind === 'capability' ? canonicalCapabilityRole(row.identity_key.replace(/^capability:/, '')) : undefined;
    return {
      identityKey: row.identity_key,
      kind: row.kind,
      name: row.name || '',
      author: row.author || '',
      version: row.version || '',
      enabled: Boolean(row.enabled),
      disabledSources: parseStringArray(parseJson(row.disabled_sources_json, [])),
      contentHash: row.content_hash || undefined,
      role: role || undefined,
      config: row.kind === 'capability' ? this.decryptPluginConfig(row) : undefined,
      position: Number(row.position || 0),
      revision: row.revision,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getSyncEvents(userId: string, sinceRevision: number, tokenHash?: string) {
    const safeSinceRevision = Math.max(0, Math.floor(Number(sinceRevision) || 0));
    const candidateRows = this.db
      .prepare(
        `SELECT revision, entity_type, entity_id, action, payload_json, deleted_at, created_at
         FROM sync_events
         WHERE user_id = ? AND revision > ?
         ORDER BY revision ASC
         LIMIT ?`,
      )
      .all(userId, safeSinceRevision, MAX_SYNC_EVENTS_PER_REQUEST + 1) as SyncEventRow[];
    const currentRevision = this.getCurrentRevision(userId);
    const rows: SyncEventRow[] = [];
    let requiresRefresh = false;
    let responseBytes = Buffer.byteLength('{"revision":0,"nextRevision":0,"hasMore":false,"events":[]}', 'utf8');
    for (const candidate of candidateRows.slice(0, MAX_SYNC_EVENTS_PER_REQUEST)) {
      const event = toSyncEvent(candidate);
      let eventBytes = Buffer.byteLength(json(event), 'utf8') + 1;
      if (responseBytes + eventBytes > MAX_SYNC_RESPONSE_BYTES) {
        if (rows.length > 0) break;
        const compactPayload = candidate.entity_type === 'playlistSongs'
          ? {playlistId: candidate.entity_id, requiresRefresh: true}
          : {entityId: candidate.entity_id, requiresRefresh: true};
        requiresRefresh = true;
        const compact = {...candidate, payload_json: json(compactPayload)};
        eventBytes = Buffer.byteLength(json(toSyncEvent(compact)), 'utf8') + 1;
        if (responseBytes + eventBytes > MAX_SYNC_RESPONSE_BYTES) {
          throw new Error(`同步事件 ${candidate.revision} 无法压缩到响应限制内`);
        }
        rows.push(compact);
        responseBytes += eventBytes;
        break;
      }
      rows.push(candidate);
      responseBytes += eventBytes;
    }
    let nextRevision = rows.length > 0 ? rows[rows.length - 1].revision : safeSinceRevision;
    const hasMoreEvent = this.db
      .prepare(`SELECT 1 AS found FROM sync_events WHERE user_id = ? AND revision > ? LIMIT 1`)
      .get(userId, nextRevision) as {found: number} | undefined;
    const hasMore = Boolean(hasMoreEvent);
    // A user's revision may advance for maintenance writes which do not publish an
    // event. Once every real event has been delivered, advance across that gap so
    // clients do not poll the same empty page forever.
    if (!hasMore && rows.length === 0) nextRevision = currentRevision;
    if (tokenHash) {
      this.updateSyncWatermark(tokenHash, userId, nextRevision);
    }
    this.cleanupOldSyncEvents(userId);
    return {revision: currentRevision, nextRevision, hasMore, requiresRefresh, events: rows.map(toSyncEvent)};
  }

  getSyncSnapshotMarker(userId: string) {
    // Read the marker after the collections so callers never receive a
    // revision that is older than the data counts they just observed.
    const playlists = this.listPlaylists(userId);
    const plugins = this.listPlugins(userId);
    const podcasts = this.listFavorites(userId, 'podcast');
    const favorites = this.listFavorites(userId, 'song');
    const revision = this.getCurrentRevision(userId);
    return {
      revision,
      counts: {
        playlists: playlists.length,
        plugins: plugins.length,
        podcasts: podcasts.length,
        favorites: favorites.length,
      },
    };
  }

  async waitForSyncEvents(
    userId: string,
    sinceRevision: number,
    timeoutMs: number,
    signal?: AbortSignal,
    tokenHash?: string,
  ) {
    const immediate = this.getSyncEvents(userId, sinceRevision, tokenHash);
    if (immediate.events.length > 0 || timeoutMs <= 0 || signal?.aborted) return immediate;

    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiters = this.syncWaiters.get(userId) || new Set<() => void>();
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        waiters.delete(finish);
        if (waiters.size === 0) this.syncWaiters.delete(userId);
        resolve();
      };
      signal?.addEventListener('abort', finish, {once: true});
      waiters.add(finish);
      this.syncWaiters.set(userId, waiters);
      timer = setTimeout(finish, timeoutMs);
    });

    return this.getSyncEvents(userId, sinceRevision, tokenHash);
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT UNIQUE,
        nickname TEXT,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pair_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code TEXT,
        code_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_revision (
        user_id TEXT PRIMARY KEY,
        current_revision INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        local_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        cover_url TEXT,
        semantic_type TEXT,
        source TEXT,
        source_playlist_id TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS playlist_songs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        playlist_id TEXT NOT NULL,
        track_key TEXT NOT NULL,
        track_json TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, playlist_id, track_key),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS favorites (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        source_entity_id TEXT,
        title TEXT,
        description TEXT,
        cover_url TEXT,
        source TEXT,
        owner_name TEXT,
        metadata_json TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, entity_type, entity_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS favorite_operations (
        operation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(user_id, operation_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_events (
        revision INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(user_id, revision),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS playlist_song_operations (
        operation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        occurred_at_ms INTEGER NOT NULL DEFAULT 0,
        playlist_id TEXT NOT NULL,
        action TEXT NOT NULL,
        track_key TEXT NOT NULL,
        applied INTEGER NOT NULL,
        changed INTEGER NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(user_id, operation_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_playlists_user_revision ON playlists(user_id, revision);
      CREATE INDEX IF NOT EXISTS idx_playlist_songs_user_revision ON playlist_songs(user_id, revision);
      CREATE INDEX IF NOT EXISTS idx_favorites_user_revision ON favorites(user_id, revision);
      CREATE INDEX IF NOT EXISTS idx_sync_events_user_revision ON sync_events(user_id, revision);
CREATE INDEX IF NOT EXISTS idx_playlist_song_ops_order
ON playlist_song_operations(user_id, device_id, track_key, sequence);
CREATE INDEX IF NOT EXISTS idx_pair_codes_hash ON pair_codes(code_hash, expires_at, used_at);

CREATE TABLE IF NOT EXISTS plugin_blobs (
content_hash TEXT PRIMARY KEY,
script TEXT NOT NULL,
byte_size INTEGER NOT NULL,
created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_plugins (
id TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
kind TEXT NOT NULL,
identity_key TEXT NOT NULL,
name TEXT,
author TEXT,
version TEXT,
enabled INTEGER NOT NULL DEFAULT 1,
disabled_sources_json TEXT NOT NULL DEFAULT '[]',
content_hash TEXT,
config_cipher TEXT,
position INTEGER NOT NULL DEFAULT 0,
revision INTEGER NOT NULL,
deleted_at TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
UNIQUE(user_id, identity_key),
FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plugin_operations (
operation_id TEXT NOT NULL,
user_id TEXT NOT NULL,
device_id TEXT NOT NULL,
sequence INTEGER NOT NULL,
occurred_at_ms INTEGER NOT NULL DEFAULT 0,
identity_key TEXT NOT NULL,
action TEXT NOT NULL,
kind TEXT NOT NULL,
applied INTEGER NOT NULL,
changed INTEGER NOT NULL,
stale INTEGER NOT NULL DEFAULT 0,
result_json TEXT NOT NULL,
revision INTEGER NOT NULL,
created_at TEXT NOT NULL,
PRIMARY KEY(user_id, operation_id),
FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_plugins_user_revision ON user_plugins(user_id, revision);
CREATE INDEX IF NOT EXISTS idx_plugin_ops_order
ON plugin_operations(user_id, device_id, identity_key, sequence);

CREATE TABLE IF NOT EXISTS devices (
device_id TEXT NOT NULL,
user_id TEXT NOT NULL,
device_name TEXT,
device_type TEXT,
last_synced_revision INTEGER NOT NULL DEFAULT 0,
last_seen_at TEXT NOT NULL,
created_at TEXT NOT NULL,
PRIMARY KEY(user_id, device_id),
FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS client_sync_state (
token_hash TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
last_synced_revision INTEGER NOT NULL DEFAULT 0,
updated_at TEXT NOT NULL,
FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_sync_state_user ON client_sync_state(user_id);
`);

    this.migrateSchema();
  }

  private migrateSchema() {
    // Ensure client_sync_state table exists
    const syncStateExists = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='client_sync_state'`).get();
    if (!syncStateExists) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS client_sync_state (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          last_synced_revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_client_sync_state_user ON client_sync_state(user_id);
      `);
    }
    // Add position column to playlists if missing
    const plCols = this.db.prepare(`PRAGMA table_info(playlists)`).all() as Array<{name: string}>;
    if (!plCols.some((c) => c.name === 'position')) {
      this.db.prepare(`ALTER TABLE playlists ADD COLUMN position INTEGER NOT NULL DEFAULT 0`).run();
    }
    // Add position column to favorites if missing
    const favCols = this.db.prepare(`PRAGMA table_info(favorites)`).all() as Array<{name: string}>;
    if (!favCols.some((c) => c.name === 'position')) {
      this.db.prepare(`ALTER TABLE favorites ADD COLUMN position INTEGER NOT NULL DEFAULT 0`).run();
    }
    // Add position column to user_plugins if missing
    const plugCols = this.db.prepare(`PRAGMA table_info(user_plugins)`).all() as Array<{name: string}>;
    if (!plugCols.some((c) => c.name === 'position')) {
      this.db.prepare(`ALTER TABLE user_plugins ADD COLUMN position INTEGER NOT NULL DEFAULT 0`).run();
    }
    // Add devices table if missing
    const devExists = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='devices'`).get();
    if (!devExists) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS devices (device_id TEXT NOT NULL, user_id TEXT NOT NULL, device_name TEXT, device_type TEXT, last_synced_revision INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id, device_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
    }
    // Add position indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_playlists_user_position ON playlists(user_id, position)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_favorites_user_position ON favorites(user_id, entity_type, position)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_favorite_operations_user ON favorite_operations(user_id, created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_user_plugins_user_position ON user_plugins(user_id, position)`);
    this.db.prepare(`UPDATE favorites SET position = COALESCE(CAST(json_extract(metadata_json, '$.position') AS INTEGER), position) WHERE metadata_json IS NOT NULL`).run();
    this.db.exec(`
      WITH ranked_plugins AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at ASC, id ASC) - 1 AS next_position
        FROM user_plugins
      )
      UPDATE user_plugins
      SET position = (SELECT next_position FROM ranked_plugins WHERE ranked_plugins.id = user_plugins.id)
      WHERE position = 0
    `);
    const pairColumns = this.db.prepare(`PRAGMA table_info(pair_codes)`).all() as Array<{name: string}>;
    if (!pairColumns.some((column) => column.name === 'code')) {
      this.db.prepare(`ALTER TABLE pair_codes ADD COLUMN code TEXT`).run();
    }
    const operationColumns = this.db.prepare(`PRAGMA table_info(playlist_song_operations)`).all() as Array<{name: string}>;
    if (!operationColumns.some((column) => column.name === 'stale')) {
      this.db.prepare(`ALTER TABLE playlist_song_operations ADD COLUMN stale INTEGER NOT NULL DEFAULT 0`).run();
    }
    if (!operationColumns.some((column) => column.name === 'occurred_at_ms')) {
      this.db.prepare(`ALTER TABLE playlist_song_operations ADD COLUMN occurred_at_ms INTEGER NOT NULL DEFAULT 0`).run();
    }
    this.db
      .prepare(
        `UPDATE playlist_song_operations
         SET occurred_at_ms = COALESCE(
           CAST(strftime('%s', created_at) AS INTEGER) * 1000,
           CAST(strftime('%s', 'now') AS INTEGER) * 1000
         )
         WHERE occurred_at_ms <= 0`,
      )
      .run();
    this.coalesceDuplicateIdentityPlaylists();
    this.sanitizePlaylistSongOrder();
    this.ensurePlaylistIdentityIndexes();
  }

  private writeTransaction<T>(
    userId: string,
    callback: (revision: number, at: string) => T,
    baseRevision?: number,
    entityType?: string,
  ) {
    const result = this.db.transaction(() => {
      if (baseRevision !== undefined) this.assertBaseRevision(userId, baseRevision, entityType || 'sync');
      const revision = this.nextRevision(userId);
      return callback(revision, nowIso());
    })();
    this.notifySyncWaiters(userId);
    return result;
  }

  private notifySyncWaiters(userId: string) {
    const waiters = this.syncWaiters.get(userId);
    if (!waiters?.size) return;
    this.syncWaiters.delete(userId);
    for (const resolve of [...waiters]) resolve();
  }

  private nextRevision(userId: string) {
    this.db.prepare(`INSERT OR IGNORE INTO user_revision (user_id, current_revision) VALUES (?, 0)`).run(userId);
    this.db.prepare(`UPDATE user_revision SET current_revision = current_revision + 1 WHERE user_id = ?`).run(userId);
    const row = this.db.prepare(`SELECT current_revision FROM user_revision WHERE user_id = ?`).get(userId) as {current_revision: number};
    return row.current_revision;
  }

  private recordEvent(
    userId: string,
    revision: number,
    entityType: string,
    entityId: string,
    action: string,
    payload: unknown,
    deletedAt: string | null,
    at: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO sync_events (revision, user_id, entity_type, entity_id, action, payload_json, deleted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(revision, userId, entityType, entityId, action, json(sanitizeSyncPayload(payload)), deletedAt, at);
  }

  private sanitizeStoredSyncEvents() {
    const rows = this.db.prepare(`SELECT user_id, revision, payload_json FROM sync_events`).all() as Array<{
      user_id: string;
      revision: number;
      payload_json: string;
    }>;
    const update = this.db.prepare(`UPDATE sync_events SET payload_json = ? WHERE user_id = ? AND revision = ?`);
    this.db.transaction(() => {
      for (const row of rows) {
        const parsed = parseJson(row.payload_json, null);
        const sanitized = json(sanitizeSyncPayload(parsed));
        if (sanitized !== row.payload_json) update.run(sanitized, row.user_id, row.revision);
      }
    })();
  }

  private validateCompleteOrder(
    userId: string,
    orderedIds: string[],
    query: string,
    queryArgs: unknown[],
    label: string,
  ) {
    const normalized = orderedIds.map(String).map((item) => item.trim()).filter(Boolean);
    const rows = this.db.prepare(query).all(userId, ...queryArgs) as Array<{item_id: string}>;
    const expected = rows.map((row) => String(row.item_id));
    const expectedSet = new Set(expected);
    const actualSet = new Set(normalized);
    if (normalized.length !== actualSet.size || actualSet.size !== expectedSet.size || normalized.some((id) => !expectedSet.has(id))) {
      const error = new Error(`${label}排序必须包含全部且不重复的有效 ID`);
      Object.assign(error, {statusCode: 409});
      throw error;
    }
    return normalized;
  }

  private assertBaseRevision(userId: string, baseRevision: number | undefined, entityType: string) {
    if (baseRevision === undefined || baseRevision === null || !Number.isFinite(Number(baseRevision))) return;
    const expected = Math.max(0, Math.floor(Number(baseRevision)));
    const currentRevision = this.getCurrentRevision(userId);
    if (expected === currentRevision) return;
    const error = new Error(
      '排序版本已过期，请先同步最新数据（客户端=' + expected + '，服务端=' + currentRevision + '）',
    );
    Object.assign(error, {
      statusCode: 409,
      conflict: {type: 'stale-base-revision', entityType, baseRevision: expected, currentRevision},
    });
    throw error;
  }

  private updateSyncWatermark(tokenHash: string, userId: string, revision: number) {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO client_sync_state (token_hash, user_id, last_synced_revision, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET
           last_synced_revision = MAX(client_sync_state.last_synced_revision, excluded.last_synced_revision),
           updated_at = excluded.updated_at`,
      )
      .run(tokenHash, userId, revision, at);
  }

  private cleanupOldSyncEvents(userId: string) {
    // Find the minimum synced revision across all active sessions for this user
    const minRow = this.db
      .prepare(
        `SELECT MIN(css.last_synced_revision) AS min_rev
         FROM client_sync_state css
         JOIN sessions s ON s.token_hash = css.token_hash
         WHERE css.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      )
      .get(userId, Date.now()) as {min_rev: number | null} | undefined;

    const minRev = minRow?.min_rev;
    if (minRev == null || minRev <= 0) return;

    // 保护：任何已注册设备还没追到 minRev（含新注册、last_synced_revision=0 的设备）
    // 就不清理事件，否则新设备从此无法回放历史增量，恢复只能全量快照。
    const lagging = this.db
      .prepare(`SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND last_synced_revision < ?`)
      .get(userId, minRev) as {n: number};
    if (Number(lagging?.n ?? 0) > 0) return;

    // Delete events that all active sessions have already synced past
    this.db
      .prepare(`DELETE FROM sync_events WHERE user_id = ? AND revision <= ?`)
      .run(userId, minRev);

    // Also clean up stale client_sync_state entries for expired/revoked sessions
    this.db
      .prepare(
        `DELETE FROM client_sync_state WHERE user_id = ? AND token_hash NOT IN (
          SELECT token_hash FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        )`,
      )
      .run(userId, userId, Date.now());
  }

  private getPlaylistRow(userId: string, playlistId: string) {
    return this.db
      .prepare(`SELECT * FROM playlists WHERE user_id = ? AND id = ? AND deleted_at IS NULL`)
      .get(userId, playlistId) as PlaylistRow | undefined;
  }

  private resolvePlaylistLocalId(existing: PlaylistRow, localId: string | null, semanticType: string | null) {
    if (semanticType === FAVORITES_SEMANTIC) {
      if (existing.local_id === FAVORITES_STABLE_LOCAL_ID || localId === FAVORITES_STABLE_LOCAL_ID) {
        return FAVORITES_STABLE_LOCAL_ID;
      }
    }
    return localId || existing.local_id || (semanticType === FAVORITES_SEMANTIC ? FAVORITES_STABLE_LOCAL_ID : null);
  }

  private findReusablePlaylist(
    userId: string,
    identity: {localId: string | null; semanticType: string | null; title: string},
  ) {
    if (identity.localId) {
      const byLocalId = this.db
        .prepare(`SELECT * FROM playlists WHERE user_id = ? AND local_id = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`)
        .get(userId, identity.localId) as PlaylistRow | undefined;
      if (byLocalId) return byLocalId;
    }

    if (identity.semanticType === FAVORITES_SEMANTIC) {
      const bySemantic = this.db
        .prepare(
          `SELECT * FROM playlists
           WHERE user_id = ? AND semantic_type = ? AND deleted_at IS NULL
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(userId, FAVORITES_SEMANTIC) as PlaylistRow | undefined;
      if (bySemantic) return bySemantic;

      const byAlias = this.db
        .prepare(
          `SELECT * FROM playlists
           WHERE user_id = ? AND deleted_at IS NULL AND title IN ('我的喜欢', '我的收藏')
           ORDER BY CASE title WHEN '我的喜欢' THEN 0 ELSE 1 END, created_at ASC
           LIMIT 1`,
        )
        .get(userId) as PlaylistRow | undefined;
      if (byAlias) return byAlias;
    }

    return undefined;
  }

  private listFavoriteAliasPlaylists(userId: string) {
    return this.db
      .prepare(
        `SELECT * FROM playlists
         WHERE user_id = ? AND deleted_at IS NULL
           AND (
             semantic_type = ?
             OR local_id = ?
             OR title IN ('我的喜欢', '我的收藏')
           )
         ORDER BY created_at ASC`,
      )
      .all(userId, FAVORITES_SEMANTIC, FAVORITES_STABLE_LOCAL_ID) as PlaylistRow[];
  }

  private pickCanonicalFavoritePlaylist(playlists: PlaylistRow[]) {
    return [...playlists].sort((left, right) => {
      const leftSongs = this.countSongs(left.user_id, left.id);
      const rightSongs = this.countSongs(right.user_id, right.id);
      if (leftSongs !== rightSongs) return rightSongs - leftSongs;
      const leftSemantic = left.semantic_type === FAVORITES_SEMANTIC ? 0 : 1;
      const rightSemantic = right.semantic_type === FAVORITES_SEMANTIC ? 0 : 1;
      if (leftSemantic !== rightSemantic) return leftSemantic - rightSemantic;
      const leftTitle = left.title === FAVORITES_TITLE ? 0 : 1;
      const rightTitle = right.title === FAVORITES_TITLE ? 0 : 1;
      if (leftTitle !== rightTitle) return leftTitle - rightTitle;
      return left.created_at.localeCompare(right.created_at);
    })[0];
  }

  private movePlaylistSongs(userId: string, fromPlaylistId: string, toPlaylistId: string, revision: number, at: string) {
    const canonicalKeys = new Set(
      (
        this.db
          .prepare(
            `SELECT track_key FROM playlist_songs
             WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`,
          )
          .all(userId, toPlaylistId) as Array<{track_key: string}>
      ).map((row) => row.track_key),
    );
    const extraSongs = this.db
      .prepare(
        `SELECT * FROM playlist_songs
         WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`,
      )
      .all(userId, fromPlaylistId) as PlaylistSongRow[];

    for (const song of extraSongs) {
      if (canonicalKeys.has(song.track_key)) {
        this.db
          .prepare(`UPDATE playlist_songs SET revision = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
          .run(revision, at, at, song.id, userId);
        continue;
      }
      this.db
        .prepare(
          `UPDATE playlist_songs
           SET playlist_id = ?, revision = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .run(toPlaylistId, revision, at, song.id, userId);
      canonicalKeys.add(song.track_key);
    }
  }

  private mutateExistingPlaylist(
    userId: string,
    existing: PlaylistRow,
    input: PlaylistInput,
    revision: number,
    at: string,
  ) {
    const semanticType = getText(input.semanticType) || existing.semantic_type;
    const next = {
      ...existing,
      local_id: this.resolvePlaylistLocalId(existing, getText(input.localId) || null, semanticType),
      title: semanticType === FAVORITES_SEMANTIC ? FAVORITES_TITLE : getText(input.title) || getText(input.name) || existing.title,
      description: getText(input.description) || getText(input.describe) || existing.description,
      cover_url: getText(input.coverUrl) || getText(input.cover) || getText(input.filePath) || existing.cover_url,
      semantic_type: semanticType,
      source: getText(input.source) || existing.source,
      source_playlist_id: getText(input.sourcePlaylistId) || existing.source_playlist_id,
      revision,
      deleted_at: null,
      updated_at: at,
    };

    this.db
      .prepare(
        `UPDATE playlists
         SET local_id = @local_id,
             title = @title,
             description = @description,
             cover_url = @cover_url,
             semantic_type = @semantic_type,
             source = @source,
             source_playlist_id = @source_playlist_id,
             revision = @revision,
             deleted_at = @deleted_at,
             updated_at = @updated_at
         WHERE user_id = @user_id AND id = @id`,
      )
      .run(next);

    const snapshotSongs = parseJsonArray(input.songlist || input.songs);
    if (
      (input.songlist || input.songs) &&
      this.canReplaceFavoriteSongsFromSnapshot(userId, existing, snapshotSongs, input.orderOnly === true)
    ) {
      this.replacePlaylistSongs(userId, existing.id, snapshotSongs, revision, at);
    }

    const total = this.countSongs(userId, existing.id);
    this.recordEvent(userId, revision, 'playlist', existing.id, 'upsert', toPlaylist(next, total), null, at);
    return {...toPlaylist(next, total), revision, updatedAt: at};
  }

  private coalesceFavoritePlaylistsForUser(userId: string) {
    const playlists = this.listFavoriteAliasPlaylists(userId);
    if (playlists.length === 0) return;

    const canonical = this.pickCanonicalFavoritePlaylist(playlists);
    for (const extra of playlists) {
      if (extra.id === canonical.id) continue;
      const revision = this.nextRevision(userId);
      const at = nowIso();
      this.movePlaylistSongs(userId, extra.id, canonical.id, revision, at);
      this.db
        .prepare(`UPDATE playlists SET revision = ?, deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
        .run(revision, at, at, userId, extra.id);
      this.db
        .prepare(
          `UPDATE playlist_songs SET revision = ?, deleted_at = ?, updated_at = ?
           WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`,
        )
        .run(revision, at, at, userId, extra.id);
      this.recordEvent(userId, revision, 'playlist', extra.id, 'delete', {id: extra.id}, at, at);
    }

    const existing = this.getPlaylistRow(userId, canonical.id);
    if (!existing) return;
    const localId =
      playlists.map((playlist) => playlist.local_id).find((value) => value === FAVORITES_STABLE_LOCAL_ID) ||
      existing.local_id ||
      playlists.map((playlist) => playlist.local_id).find(Boolean) ||
      FAVORITES_STABLE_LOCAL_ID;
    const revision = this.nextRevision(userId);
    this.mutateExistingPlaylist(
      userId,
      existing,
      {
        localId,
        title: FAVORITES_TITLE,
        semanticType: FAVORITES_SEMANTIC,
      },
      revision,
      nowIso(),
    );
  }

  private coalesceDuplicateIdentityPlaylists() {
    const users = this.db.prepare(`SELECT id FROM users`).all() as Array<{id: string}>;
    for (const user of users) {
      const playlists = this.listFavoriteAliasPlaylists(user.id);
      if (playlists.length === 0) continue;
      const needsCanonicalize = playlists.length > 1 || playlists.some((playlist) => (
        playlist.semantic_type !== FAVORITES_SEMANTIC ||
        playlist.title !== FAVORITES_TITLE
      ));
      if (!needsCanonicalize) continue;
      this.db.transaction(() => {
        this.coalesceFavoritePlaylistsForUser(user.id);
      })();
    }
  }

  private sanitizePlaylistSongOrder() {
    const playlists = this.db
      .prepare(`SELECT * FROM playlists WHERE deleted_at IS NULL`)
      .all() as PlaylistRow[];

    for (const playlist of playlists) {
      const rows = this.db
        .prepare(
          `SELECT * FROM playlist_songs
           WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL
           ORDER BY sort_order ASC, created_at ASC, id ASC`,
        )
        .all(playlist.user_id, playlist.id) as PlaylistSongRow[];
      const portableRows = rows.filter((row) => {
        const song = parseJson<UnknownRecord>(row.track_json, {});
        const trackSource = row.track_key.split(':', 1)[0];
        return !row.track_key.startsWith('local:') &&
          ALLOWED_CLOUD_SONG_SOURCES.has(String(song.source)) &&
          ALLOWED_CLOUD_SONG_SOURCES.has(trackSource) &&
          row.sort_order >= 0;
      });
      const needsRewrite = portableRows.length !== rows.length ||
        portableRows.some((row, index) => row.sort_order !== index);
      if (!needsRewrite) continue;

      const revision = this.nextRevision(playlist.user_id);
      const at = nowIso();
      const portableIds = new Set(portableRows.map((row) => row.id));

      for (const row of rows) {
        if (portableIds.has(row.id)) continue;
        this.db
          .prepare(`UPDATE playlist_songs SET revision = ?, deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
          .run(revision, at, at, playlist.user_id, row.id);
      }

      const songs = portableRows.map((row, index) => {
        const song = parseJson<UnknownRecord>(row.track_json, {});
        const nextSong = {...song, position: index, pos: index};
        this.db
          .prepare(
            `UPDATE playlist_songs
             SET track_json = ?, sort_order = ?, revision = ?, deleted_at = NULL, updated_at = ?
             WHERE user_id = ? AND id = ?`,
          )
          .run(json(nextSong), index, revision, at, playlist.user_id, row.id);
        return nextSong;
      });

      this.touchPlaylist(playlist.user_id, playlist.id, revision, at);
      this.recordEvent(
        playlist.user_id,
        revision,
        'playlistSongs',
        playlist.id,
        'replace',
        {playlistId: playlist.id, songs},
        null,
        at,
      );
    }
  }

  private ensurePlaylistIdentityIndexes() {
    try {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_user_active_local_id
          ON playlists(user_id, local_id)
          WHERE deleted_at IS NULL AND local_id IS NOT NULL AND local_id != '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_user_active_favorites
          ON playlists(user_id)
          WHERE deleted_at IS NULL AND semantic_type = 'favorites';
      `);
    } catch (error) {
      console.warn('[nas-sync] playlist identity indexes skipped:', error);
    }
  }

  private countSongs(userId: string, playlistId: string) {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM playlist_songs WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`)
      .get(userId, playlistId) as {total: number};
    return row.total;
  }

  private canReplaceFavoriteSongsFromSnapshot(
    userId: string,
    playlist: PlaylistRow,
    songs: UnknownRecord[],
    orderOnly: boolean,
  ) {
    if (playlist.semantic_type !== FAVORITES_SEMANTIC) return true;
    const nextKeys = new Set(normalizePlaylistSongs(songs).map((song) => song.trackKey));
    if (orderOnly) {
      const currentKeys = new Set(
        (
          this.db
            .prepare(
              `SELECT track_key
               FROM playlist_songs
               WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`,
            )
            .all(userId, playlist.id) as Array<{track_key: string}>
        ).map((row) => row.track_key),
      );
      return (
        nextKeys.size === currentKeys.size &&
        [...nextKeys].every((trackKey) => currentKeys.has(trackKey))
      );
    }
    const operationCount = this.db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM playlist_song_operations
         WHERE user_id = ? AND playlist_id = ?`,
      )
      .get(userId, playlist.id) as {total: number};
    return Number(operationCount.total || 0) === 0 && this.countSongs(userId, playlist.id) === 0;
  }

  private touchPlaylist(userId: string, playlistId: string, revision: number, at: string) {
    this.db
      .prepare(`UPDATE playlists SET revision = ?, updated_at = ?, deleted_at = NULL WHERE user_id = ? AND id = ?`)
      .run(revision, at, userId, playlistId);
  }

  private upsertSongs(
    userId: string,
    playlistId: string,
    songs: UnknownRecord[],
    revision: number,
    at: string,
    positionMode: 'append' | 'prepend' = 'append',
  ) {
    const bounds = this.db
      .prepare(
        `SELECT
           COALESCE(MAX(sort_order), -1) AS max_sort_order,
           COALESCE(MIN(sort_order), 0) AS min_sort_order
         FROM playlist_songs
         WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`,
      )
      .get(userId, playlistId) as {max_sort_order: number; min_sort_order: number};
    const existingRows = this.db
      .prepare(`SELECT * FROM playlist_songs WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`)
      .all(userId, playlistId) as PlaylistSongRow[];
    const existingByTrackKey = new Map(existingRows.map((row) => [row.track_key, row]));
    const normalized: ReturnType<typeof normalizeSong>[] = [];
    const seenTrackKeys = new Set<string>();
    for (const song of normalizePlaylistSongs(songs)) {
      if (seenTrackKeys.has(song.trackKey)) continue;
      seenTrackKeys.add(song.trackKey);
      normalized.push(song);
    }

    const implicitNewCount = normalized.filter((song) => (
      !existingByTrackKey.has(song.trackKey) &&
      !Number.isFinite(song.position)
    )).length;
    if (positionMode === 'prepend' && implicitNewCount > 0) {
      this.db
        .prepare(
          `UPDATE playlist_songs
           SET sort_order = sort_order + ?
           WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`,
        )
        .run(implicitNewCount, userId, playlistId);
      for (const row of existingByTrackKey.values()) {
        row.sort_order += implicitNewCount;
      }
    }

    let prependPosition = 0;
    normalized.forEach((song, index) => {
      const existing = existingByTrackKey.get(song.trackKey);
      const explicitPosition = Number.isFinite(song.position) ? Number(song.position) : undefined;
      const sortOrder = explicitPosition ??
        existing?.sort_order ??
        (positionMode === 'prepend'
          ? prependPosition++
          : bounds.max_sort_order + implicitNewCount + index + 1);
      const row = {
        id: existing?.id || createId('trk'),
        user_id: userId,
        playlist_id: playlistId,
        track_key: song.trackKey,
        track_json: json({
          id: song.id,
          source: song.source,
          title: song.title,
          artist: song.artist,
          album: song.album,
          albumId: song.albumId,
          durationText: song.durationText || storedDurationText(existing),
          artworkUrl: song.artworkUrl,
          qualities: song.qualities,
          position: sortOrder,
        }),
        sort_order: sortOrder,
        revision,
        deleted_at: null,
        created_at: existing?.created_at || at,
        updated_at: at,
      };

      this.insertOrUpdatePlaylistSong(row);
    });
  }

  private replacePlaylistSongs(userId: string, playlistId: string, songs: UnknownRecord[], revision: number, at: string) {
    // A snapshot is not proof that the user wants to re-add a song. If the
    // operation log says the latest explicit intent for that track was remove,
    // ignore the stale snapshot entry. Re-adding must use applySongOperation.
    const normalized = this.normalizePlaylistSnapshot(songs).filter((song) => {
      const latest = this.db
        .prepare(
          `SELECT action
           FROM playlist_song_operations
           WHERE user_id = ? AND playlist_id = ? AND track_key = ?
           ORDER BY occurred_at_ms DESC, sequence DESC, operation_id DESC
           LIMIT 1`,
        )
        .get(userId, playlistId, song.trackKey) as {action?: string} | undefined;
      return latest?.action !== 'remove';
    });

    const nextKeys = new Set(normalized.map((song) => song.trackKey));
    const currentRows = this.db
      .prepare(`SELECT * FROM playlist_songs WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`)
      .all(userId, playlistId) as PlaylistSongRow[];
    const existingByTrackKey = new Map(currentRows.map((row) => [row.track_key, row]));

    normalized.forEach((song, index) => {
      const row = {
        id: createId('trk'),
        user_id: userId,
        playlist_id: playlistId,
        track_key: song.trackKey,
        track_json: json({
          id: song.id,
          source: song.source,
          title: song.title,
          artist: song.artist,
          album: song.album,
          albumId: song.albumId,
          durationText: song.durationText || storedDurationText(existingByTrackKey.get(song.trackKey)),
          artworkUrl: song.artworkUrl,
          qualities: song.qualities,
          position: index,
        }),
        sort_order: index,
        revision,
        deleted_at: null,
        created_at: at,
        updated_at: at,
      };
      this.insertOrUpdatePlaylistSong(row);
    });

    currentRows
      .filter((row) => !nextKeys.has(row.track_key))
      .forEach((row) => {
        this.db
          .prepare(`UPDATE playlist_songs SET revision = ?, deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
          .run(revision, at, at, userId, row.id);
      });
  }

  private normalizePlaylistSnapshot(songs: UnknownRecord[]) {
    const normalized: ReturnType<typeof normalizeSong>[] = [];
    const seenTrackKeys = new Set<string>();
    for (const song of normalizePlaylistSongs(songs)) {
      if (seenTrackKeys.has(song.trackKey)) continue;
      seenTrackKeys.add(song.trackKey);
      normalized.push(song);
    }
    return normalized;
  }

  private insertOrUpdatePlaylistSong(row: {
    id: string;
    user_id: string;
    playlist_id: string;
    track_key: string;
    track_json: string;
    sort_order: number;
    revision: number;
    deleted_at: null;
    created_at: string;
    updated_at: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO playlist_songs
         (id, user_id, playlist_id, track_key, track_json, sort_order, revision, deleted_at, created_at, updated_at)
         VALUES (@id, @user_id, @playlist_id, @track_key, @track_json, @sort_order, @revision, @deleted_at, @created_at, @updated_at)
         ON CONFLICT(user_id, playlist_id, track_key) DO UPDATE SET
           track_json = excluded.track_json,
           sort_order = excluded.sort_order,
           revision = excluded.revision,
           deleted_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(row);
  }
}
