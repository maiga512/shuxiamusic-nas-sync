export type CeruMusicSource = 'local' | 'wy' | 'tx' | 'kg' | 'kw' | 'mg' | 'bd' | 'git' | 'plugin' | string;

export type CeruCloudSongQuality = {
  type: string;
  size?: string;
};

export type CeruCloudSong = {
  id: string;
  source: CeruMusicSource;
  title: string;
  artist: string;
  album?: string;
  albumId?: string;
  durationText?: string;
  artworkUrl?: string;
  qualities?: CeruCloudSongQuality[];
  position?: number;
};

export type CeruFavoriteEntityType = 'song' | 'playlist' | 'album' | 'artist' | 'rank' | 'podcast';

export type AuthUser = {
  id: string;
  username: string;
  email?: string | null;
  nickname?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionPayload = {
  accessToken: string;
  expiresAt: number;
  user: AuthUser;
};

export type RequestContext = {
  user: AuthUser;
  tokenHash: string;
};

export type PlaylistInput = {
  localId?: string;
  title?: string;
  name?: string;
  description?: string;
  describe?: string;
  coverUrl?: string;
  cover?: string;
  filePath?: string;
  semanticType?: string;
  source?: string;
  sourcePlaylistId?: string;
  orderOnly?: boolean;
  position?: number;
  songs?: UnknownRecord[];
  songlist?: UnknownRecord[] | string;
};

export type PlaylistPatchInput = PlaylistInput & {
  id?: string;
  listId?: string;
  playlistId?: string;
  baseRevision?: number;
};

export type PlaylistSongMutationInput = {
  id?: string;
  listId?: string;
  playlistId?: string;
  songs?: UnknownRecord[];
  songlist?: UnknownRecord[] | string;
  songIds?: string[];
  songmids?: string[];
  trackKeys?: string[];
};

export type PlaylistSongOperationInput = {
  operationId?: string;
  deviceId?: string;
  sequence?: number;
  occurredAtMs?: number;
  playlistId?: string;
  action?: 'add' | 'remove';
  trackKey?: string;
  song?: UnknownRecord;
};

export type PluginKind = 'music-source' | 'capability';
export type PluginAction = 'upsert' | 'remove';

export type PluginOperationInput = {
  operationId?: string;
  deviceId?: string;
  sequence?: number;
  occurredAtMs?: number;
  identityKey?: string;
  action?: PluginAction;
  kind?: PluginKind;
  name?: string;
  author?: string;
  version?: string;
  enabled?: boolean;
  disabledSources?: string[];
  contentHash?: string;
  role?: string;
  config?: UnknownRecord;
  position?: number;
};

export type SyncedPlugin = {
  identityKey: string;
  kind: PluginKind;
  name: string;
  author: string;
  version: string;
  enabled: boolean;
  disabledSources: string[];
  contentHash?: string;
  role?: string;
  config?: UnknownRecord;
  position: number;
  revision: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FavoriteInput = {
  operationId?: string;
  entityType?: CeruFavoriteEntityType;
  entityId?: string;
  playlistId?: string;
  sourcePlaylistId?: string;
  source?: CeruMusicSource;
  title?: string;
  name?: string;
  description?: string;
  describe?: string;
  coverUrl?: string;
  cover?: string;
  filePath?: string;
  ownerName?: string;
  metadata?: UnknownRecord;
  position?: number;
  pinned?: boolean;
  occurredAtMs?: number;
};

export type UnknownRecord = Record<string, unknown>;

export type SyncEvent = {
  revision: number;
  entityType: string;
  entityId: string;
  action: string;
  payload: unknown;
  deletedAt: string | null;
  createdAt: string;
};

export type NormalizedSong = CeruCloudSong & {
  trackKey: string;
  raw: UnknownRecord;
};
