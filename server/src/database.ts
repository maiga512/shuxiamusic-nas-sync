import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

import Database from 'better-sqlite3';

import {createId, createPairCode, hashToken, nowIso} from './crypto.ts';
import {encodeSongForLegacyClient, getText, normalizeFavoriteEntityType, normalizeSong, parseJsonArray} from './normalize.ts';
import type {
  AuthUser,
  FavoriteInput,
  PlaylistInput,
  PlaylistPatchInput,
  PlaylistSongMutationInput,
  RequestContext,
  SyncEvent,
  UnknownRecord,
} from './types.ts';

const json = (value: unknown) => JSON.stringify(value ?? null);
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
    position: row.entity_type === 'podcast' ? getFavoritePosition(metadata) : undefined,
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
                (SELECT pc.code FROM pair_codes pc WHERE pc.user_id = u.id AND pc.code IS NOT NULL AND pc.used_at IS NULL ORDER BY pc.created_at ASC LIMIT 1) AS binding_code
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

  createPairCode(input: {userId: string; ttlMs?: number}) {
    const user = this.findUserById(input.userId);
    if (!user) return null;

    const existing = this.db
      .prepare(`SELECT * FROM pair_codes WHERE user_id = ? AND code IS NOT NULL AND used_at IS NULL ORDER BY created_at ASC LIMIT 1`)
      .get(input.userId) as PairCodeRow | undefined;
    if (existing?.code) return {code: existing.code, expiresAt: null, user, existing: true};

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

  listPlaylists(userId: string) {
    const rows = this.db
      .prepare(`SELECT * FROM playlists WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`)
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

    return {playlist: toPlaylist(playlist, total.total), list: rows.map(toPlaylistSong), songs: rows.map(toPlaylistSong), total: total.total};
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
        revision,
        deleted_at: null,
        created_at: at,
        updated_at: at,
      };

      this.db
        .prepare(
          `INSERT INTO playlists
           (id, user_id, local_id, title, description, cover_url, semantic_type, source, source_playlist_id, revision, deleted_at, created_at, updated_at)
           VALUES (@id, @user_id, @local_id, @title, @description, @cover_url, @semantic_type, @source, @source_playlist_id, @revision, @deleted_at, @created_at, @updated_at)`,
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

    return this.writeTransaction(userId, (revision, at) => {
      const existing = this.getPlaylistRow(userId, playlistId);
      if (!existing) return null;

      const next = {
        ...existing,
        local_id: getText(input.localId) || existing.local_id,
        title: getText(input.title) || getText(input.name) || existing.title,
        description: getText(input.description) || getText(input.describe) || existing.description,
        cover_url: getText(input.coverUrl) || getText(input.cover) || getText(input.filePath) || existing.cover_url,
        semantic_type: getText(input.semanticType) || existing.semantic_type,
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

      if (input.songlist || input.songs) {
        this.replacePlaylistSongs(userId, playlistId, parseJsonArray(input.songlist || input.songs), revision, at);
      }

      const total = this.countSongs(userId, playlistId);
      this.recordEvent(userId, revision, 'playlist', playlistId, 'upsert', toPlaylist(next, total), null, at);
      return {...toPlaylist(next, total), revision, updatedAt: at};
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

  listFavorites(userId: string, entityType?: string) {
    const type = entityType ? normalizeFavoriteEntityType(entityType) : null;
    const rows = type
      ? (this.db
          .prepare(`SELECT * FROM favorites WHERE user_id = ? AND entity_type = ? AND deleted_at IS NULL ORDER BY updated_at DESC`)
          .all(userId, type) as FavoriteRow[])
      : (this.db
          .prepare(`SELECT * FROM favorites WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`)
          .all(userId) as FavoriteRow[]);
    const items = rows.map(toFavorite);
    if (type !== 'podcast') return items;
    return items.sort((left, right) => {
      const pinnedDelta = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
      if (pinnedDelta !== 0) return pinnedDelta;
      const leftPosition = typeof left.position === 'number' && Number.isFinite(left.position)
        ? left.position
        : Number.MAX_SAFE_INTEGER;
      const rightPosition = typeof right.position === 'number' && Number.isFinite(right.position)
        ? right.position
        : Number.MAX_SAFE_INTEGER;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    });
  }

  upsertFavorite(userId: string, input: FavoriteInput) {
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
      if (input.position !== undefined) metadata.position = input.position;
      if (input.pinned !== undefined) metadata.pinned = Boolean(input.pinned);
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
        revision,
        deleted_at: null,
        created_at: existing?.created_at || at,
        updated_at: at,
      };

      this.db
        .prepare(
          `INSERT INTO favorites
           (id, user_id, entity_type, entity_id, source_entity_id, title, description, cover_url, source, owner_name, metadata_json, revision, deleted_at, created_at, updated_at)
           VALUES (@id, @user_id, @entity_type, @entity_id, @source_entity_id, @title, @description, @cover_url, @source, @owner_name, @metadata_json, @revision, @deleted_at, @created_at, @updated_at)
           ON CONFLICT(user_id, entity_type, entity_id) DO UPDATE SET
             source_entity_id = excluded.source_entity_id,
             title = excluded.title,
             description = excluded.description,
             cover_url = excluded.cover_url,
             source = excluded.source,
             owner_name = excluded.owner_name,
             metadata_json = excluded.metadata_json,
             revision = excluded.revision,
             deleted_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(row);

      this.recordEvent(userId, revision, 'favorite', row.id, 'upsert', toFavorite(row), null, at);
      return toFavorite(row);
    });
  }

  deleteFavorite(userId: string, input: {entityType?: string; entityId?: string; playlistId?: string}) {
    return this.writeTransaction(userId, (revision, at) => {
      const entityType = normalizeFavoriteEntityType(input.entityType);
      const entityId = getText(input.entityId) || getText(input.playlistId);
      if (!entityId) return null;

      const row = this.db
        .prepare(`SELECT * FROM favorites WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL`)
        .get(userId, entityType, entityId) as FavoriteRow | undefined;
      if (!row) return {playlistId: entityId, entityId, revision, deletedAt: at, updatedAt: at};

      this.db
        .prepare(`UPDATE favorites SET revision = ?, deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
        .run(revision, at, at, userId, row.id);
      this.recordEvent(userId, revision, 'favorite', row.id, 'delete', {...toFavorite(row), deletedAt: at}, at, at);
      return {id: row.id, playlistId: entityType === 'playlist' ? entityId : undefined, entityId, revision, deletedAt: at, updatedAt: at};
    });
  }

  getSyncEvents(userId: string, sinceRevision: number) {
    const rows = this.db
      .prepare(
        `SELECT revision, entity_type, entity_id, action, payload_json, deleted_at, created_at
         FROM sync_events
         WHERE user_id = ? AND revision > ?
         ORDER BY revision ASC`,
      )
      .all(userId, sinceRevision) as SyncEventRow[];
    return {revision: this.getCurrentRevision(userId), events: rows.map(toSyncEvent)};
  }

  async waitForSyncEvents(userId: string, sinceRevision: number, timeoutMs: number) {
    const immediate = this.getSyncEvents(userId, sinceRevision);
    if (immediate.events.length > 0 || timeoutMs <= 0) return immediate;

    await new Promise<void>((resolve) => {
      let settled = false;
      const waiters = this.syncWaiters.get(userId) || new Set<() => void>();
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.syncWaiters.delete(userId);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      waiters.add(finish);
      this.syncWaiters.set(userId, waiters);
    });

    return this.getSyncEvents(userId, sinceRevision);
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
        revision INTEGER NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, entity_type, entity_id),
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

      CREATE INDEX IF NOT EXISTS idx_playlists_user_revision ON playlists(user_id, revision);
      CREATE INDEX IF NOT EXISTS idx_playlist_songs_user_revision ON playlist_songs(user_id, revision);
      CREATE INDEX IF NOT EXISTS idx_favorites_user_revision ON favorites(user_id, revision);
      CREATE INDEX IF NOT EXISTS idx_sync_events_user_revision ON sync_events(user_id, revision);
      CREATE INDEX IF NOT EXISTS idx_pair_codes_hash ON pair_codes(code_hash, expires_at, used_at);
    `);

    this.migrateSchema();
  }

  private migrateSchema() {
    const pairColumns = this.db.prepare(`PRAGMA table_info(pair_codes)`).all() as Array<{name: string}>;
    if (!pairColumns.some((column) => column.name === 'code')) {
      this.db.prepare(`ALTER TABLE pair_codes ADD COLUMN code TEXT`).run();
    }
    this.coalesceDuplicateIdentityPlaylists();
    this.sanitizePlaylistSongOrder();
    this.ensurePlaylistIdentityIndexes();
  }

  private writeTransaction<T>(userId: string, callback: (revision: number, at: string) => T) {
    const result = this.db.transaction(() => {
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
      .run(revision, userId, entityType, entityId, action, json(payload), deletedAt, at);
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

    if (input.songlist || input.songs) {
      this.replacePlaylistSongs(userId, existing.id, parseJsonArray(input.songlist || input.songs), revision, at);
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
          durationText: song.durationText,
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
    const normalized: ReturnType<typeof normalizeSong>[] = [];
    const seenTrackKeys = new Set<string>();
    for (const song of normalizePlaylistSongs(songs)) {
      if (seenTrackKeys.has(song.trackKey)) continue;
      seenTrackKeys.add(song.trackKey);
      normalized.push(song);
    }

    const nextKeys = new Set(normalized.map((song) => song.trackKey));
    const currentRows = this.db
      .prepare(`SELECT * FROM playlist_songs WHERE user_id = ? AND playlist_id = ? AND deleted_at IS NULL`)
      .all(userId, playlistId) as PlaylistSongRow[];

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
          durationText: song.durationText,
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
