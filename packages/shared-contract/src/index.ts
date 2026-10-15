export type ShuxiaMusicSource = 'local' | 'wy' | 'tx' | 'kg' | 'kw' | 'mg' | 'bd' | 'git' | 'plugin';

export type ShuxiaTrack = {
  id: string;
  source: ShuxiaMusicSource;
  pluginId?: string;
  title: string;
  artist: string;
  album?: string;
  albumId?: string;
  durationMs?: number;
  durationText?: string;
  artworkUrl?: string;
  playableUrl?: string;
  quality?: string;
  qualities?: ShuxiaCloudSongQuality[];
  songInfo?: unknown;
};

export type ShuxiaPlaybackMode = 'sequence' | 'single' | 'shuffle';

export type ShuxiaPlaybackStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error';

export type ShuxiaPlaybackState = {
  track: ShuxiaTrack | null;
  queue: ShuxiaTrack[];
  queueIndex: number;
  status: ShuxiaPlaybackStatus;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  mode: ShuxiaPlaybackMode;
  audioEffects?: ShuxiaAndroidAudioEffectsState;
  errorMessage?: string;
};

export type ShuxiaPlaybackCommand =
  | {type: 'load'; track: ShuxiaTrack}
  | {type: 'loadQueue'; tracks: ShuxiaTrack[]; startIndex: number}
  | {type: 'play'}
  | {type: 'pause'}
  | {type: 'seek'; positionMs: number}
  | {type: 'next'}
  | {type: 'previous'}
  | ShuxiaAndroidPlaybackModeCommand
  | ShuxiaAndroidAudioEffectsCommand;

export const emptyPlaybackState: ShuxiaPlaybackState = {
  track: null,
  queue: [],
  queueIndex: -1,
  status: 'idle',
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  mode: 'sequence',
};

export type ShuxiaApiResult<T> =
  | {success: true; data: T}
  | {success: false; error: string; code?: string};

export type ShuxiaAuthSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export type ShuxiaUserProfile = {
  id: string;
  username?: string;
  nickname?: string;
  avatarUrl?: string;
  email?: string;
  intro?: string;
  gender?: string;
  birthday?: string;
  region?: string;
};

export type ShuxiaCloudSongQuality = {
  type: string;
  size?: string;
};

export type ShuxiaCloudSong = {
  id: string;
  source: ShuxiaMusicSource;
  title: string;
  artist: string;
  album?: string;
  albumId?: string;
  durationText?: string;
  artworkUrl?: string;
  qualities?: ShuxiaCloudSongQuality[];
  position?: number;
};

export type ShuxiaCloudPlaylist = {
  id: string;
  localId?: string;
  title: string;
  description?: string;
  coverUrl?: string;
  updatedAt?: string;
  total?: number;
};

export type ShuxiaFavoriteEntityType = 'song' | 'playlist' | 'album' | 'artist' | 'rank' | 'podcast';

export type ShuxiaPlaylistFavorite = {
  id: string;
  playlistId: string;
  sourcePlaylistId?: string;
  source?: ShuxiaMusicSource;
  title: string;
  description?: string;
  coverUrl?: string;
  ownerName?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  revision?: number;
};

export type ShuxiaPlaylistFavoriteMutationInput = {
  playlistId: string;
  sourcePlaylistId?: string;
  source?: ShuxiaMusicSource;
  title: string;
  description?: string;
  coverUrl?: string;
  ownerName?: string;
  occurredAtMs?: number;
};

export type ShuxiaFavoriteMutationResult = {
  id?: string;
  playlistId?: string;
  entityId?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  revision?: number;
};

export type ShuxiaPodcastFavorite = {
  id: string;
  radioId: string;
  source?: ShuxiaMusicSource;
  title: string;
  description?: string;
  coverUrl?: string;
  author?: string;
  total?: number;
  playCount?: string;
  pinned?: boolean;
  position?: number;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  revision?: number;
};

export type ShuxiaPodcastFavoriteMutationInput = {
  operationId?: string;
  radioId: string;
  source?: ShuxiaMusicSource;
  title: string;
  description?: string;
  coverUrl?: string;
  author?: string;
  total?: number;
  playCount?: string;
  pinned?: boolean;
  position?: number;
  occurredAtMs?: number;
};

export type ShuxiaFavoriteSyncPage<T> = {
  items: T[];
  revision?: number;
  updatedAt?: string;
};

export type ShuxiaFavoriteMutationInput = {
  entityType: ShuxiaFavoriteEntityType;
  entityId: string;
  title?: string;
  description?: string;
  coverUrl?: string;
  source?: ShuxiaMusicSource;
  metadata?: Record<string, unknown>;
};

export type ShuxiaCloudPlaylistDetail = ShuxiaCloudPlaylist & {
  songs: ShuxiaCloudSong[];
};

export type ShuxiaCloudPlaylistSongsPage = {
  songs: ShuxiaCloudSong[];
  total: number;
};

export type ShuxiaCreateCloudPlaylistInput = {
  localId: string;
  title: string;
  description?: string;
  coverUrl?: string;
  songs: ShuxiaCloudSong[];
};

export type ShuxiaUpdateCloudPlaylistInput = {
  playlistId: string;
  localId?: string;
  title?: string;
  description?: string;
  coverUrl?: string;
  songs?: ShuxiaCloudSong[];
};

export type ShuxiaCloudPlaylistMutationResult = {
  id?: string;
  updatedAt?: string;
};

export type ShuxiaDeleteCloudPlaylistInput = {
  playlistId: string;
};

export type ShuxiaAddCloudPlaylistSongsInput = {
  playlistId: string;
  songs: ShuxiaCloudSong[];
};

export type ShuxiaRemoveCloudPlaylistSongsInput = {
  playlistId: string;
  songIds: string[];
};

export type ShuxiaCreatePlaylistShareInput = {
  cloudPlaylistId: string;
  allowWebPlayback: boolean;
  ttlDays?: number;
  pluginMd5?: string;
  quality?: string;
};

export type ShuxiaPlaylistShare = {
  id: string;
  url: string;
  template?: string;
  playExpiresAt?: number | null;
};

export type ShuxiaSourceSearchScope = 'song' | 'playlist' | 'album' | 'artist';

export type ShuxiaMusicPluginRequestBase = {
  pluginId?: string;
  source?: ShuxiaMusicSource;
  timeoutMs?: number;
};

export type ShuxiaSourceSearchInput = ShuxiaMusicPluginRequestBase & {
  keyword: string;
  page?: number;
  limit?: number;
  scope?: ShuxiaSourceSearchScope;
};

export type ShuxiaSourceSearchItem = {
  id: string;
  source: ShuxiaMusicSource;
  pluginId?: string;
  title: string;
  artist?: string;
  album?: string;
  albumId?: string;
  durationMs?: number;
  durationText?: string;
  artworkUrl?: string;
  qualities?: ShuxiaCloudSongQuality[];
  songInfo?: unknown;
};

export type ShuxiaSourceSearchPage = {
  items: ShuxiaSourceSearchItem[];
  total?: number;
  page: number;
  limit: number;
  pluginId?: string;
  source?: ShuxiaMusicSource;
};

export type ShuxiaResolvePlayableUrlInput = ShuxiaMusicPluginRequestBase & {
  track: ShuxiaTrack;
  quality?: string;
  isCache?: boolean;
};

export type ShuxiaPlayableUrl = {
  url: string;
  quality?: string;
  expiresAt?: number;
  source: ShuxiaMusicSource;
  pluginId?: string;
  raw?: unknown;
};

export type ShuxiaPlayableUrlFailureReason = 'network' | 'decode' | 'timeout' | 'http-status' | 'not-playable' | 'unknown';

export type ShuxiaPlayableUrlFailureInput = ShuxiaMusicPluginRequestBase & {
  track: ShuxiaTrack;
  failedUrl?: string;
  quality?: string;
  reason: ShuxiaPlayableUrlFailureReason;
  statusCode?: number;
};

export type ShuxiaPlaybackResolveInput = ShuxiaMusicPluginRequestBase & {
  track: ShuxiaTrack;
  preferredQuality?: string;
  qualityFallbacks?: string[];
  allowCachedUrl?: boolean;
};

export type ShuxiaPlaybackResolvedCandidate = {
  quality?: string;
  source: ShuxiaMusicSource;
  pluginId?: string;
  status: 'selected' | 'skipped-failed-url' | 'resolve-failed' | 'empty-url';
  url?: string;
  cacheHit?: boolean;
  error?: string;
};

export type ShuxiaPlaybackResolveResult = {
  track: ShuxiaTrack;
  playableUrl: ShuxiaPlayableUrl;
  selectedQuality?: string;
  fallbackUsed: boolean;
  cacheHit: boolean;
  candidates: ShuxiaPlaybackResolvedCandidate[];
};

export type ShuxiaPlaybackFailureInput = ShuxiaMusicPluginRequestBase & {
  track: ShuxiaTrack;
  failedUrl?: string;
  quality?: string;
  reason: ShuxiaPlayableUrlFailureReason;
  statusCode?: number;
};

export type ShuxiaPlaybackFailureResult = {
  trackId: string;
  failedUrl?: string;
  quality?: string;
  source?: ShuxiaMusicSource;
  pluginId?: string;
  blockedUntil: number;
};

export type ShuxiaPlaybackWorkflowBoundary = {
  resolve: ShuxiaPlaybackResolveInput | null;
  failure: ShuxiaPlaybackFailureInput | null;
  urlCache: 'node-runtime-memory-cache';
  qualityFallback: 'same-plugin-quality-fallback';
};

export type ShuxiaDownloadTaskStatus = 'queued' | 'preparing' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled';

export type ShuxiaDownloadDestination = 'android-app-files' | 'android-app-cache';

export type ShuxiaDownloadPrepareInput = ShuxiaPlaybackResolveInput & {
  fileName?: string;
  destination?: ShuxiaDownloadDestination;
  overwrite?: boolean;
};

export type ShuxiaDownloadTask = {
  id: string;
  track: ShuxiaTrack;
  pluginId?: string;
  source: ShuxiaMusicSource;
  quality?: string;
  url: string;
  fileName: string;
  destination: ShuxiaDownloadDestination;
  status: ShuxiaDownloadTaskStatus;
  progress: number;
  downloadedSize: number;
  totalSize: number;
  speed: number;
  remainingTime?: number | null;
  error?: string | null;
  filePath?: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type ShuxiaDownloadPrepareResult = {
  task: ShuxiaDownloadTask;
  playback: ShuxiaPlaybackResolveResult;
};

export type ShuxiaDownloadTaskList = {
  tasks: ShuxiaDownloadTask[];
};

export type ShuxiaDownloadTaskUpdateInput = {
  taskId: string;
  status: ShuxiaDownloadTaskStatus;
  progress?: number;
  downloadedSize?: number;
  totalSize?: number;
  speed?: number;
  remainingTime?: number | null;
  error?: string | null;
  filePath?: string | null;
};

export type ShuxiaDownloadTaskCommandInput = {
  taskId: string;
};

export type ShuxiaDownloadWorkflowBoundary = {
  prepare: ShuxiaDownloadPrepareInput | null;
  tasks: ShuxiaDownloadTask[];
  persistence: 'node-runtime-json';
  executor: 'android-native-module';
};

export type ShuxiaAndroidEqualizerBand = {
  frequencyHz: number;
  gainDb: number;
};

export type ShuxiaAndroidSurroundMode = 'off' | 'small' | 'medium' | 'large';

export type ShuxiaAndroidLoudnessTarget = 'gentle' | 'standard' | 'strong';

export type ShuxiaAndroidAudioEffectsState = {
  enabled: boolean;
  equalizer: {
    enabled: boolean;
    preset: string;
    bands: ShuxiaAndroidEqualizerBand[];
  };
  bassBoost: {
    enabled: boolean;
    gain: number;
  };
  surround: {
    enabled: boolean;
    mode: ShuxiaAndroidSurroundMode;
  };
  balance: {
    enabled: boolean;
    value: number;
  };
  loudness: {
    enabled: boolean;
    target: ShuxiaAndroidLoudnessTarget;
  };
};

export type ShuxiaAndroidAudioEffectsCommand = {
  type: 'set-audio-effects';
  effects: ShuxiaAndroidAudioEffectsState;
};

export type ShuxiaAndroidPlaybackModeCommand = {
  type: 'set-playback-mode';
  mode: ShuxiaPlaybackMode;
};

export type ShuxiaAndroidEffectsSystemBoundary = {
  playbackMode: ShuxiaPlaybackMode;
  audioEffects: ShuxiaAndroidAudioEffectsState;
  executor: 'android-media3-audio-session';
  systemControls: 'media-session-service';
  externalVerification: 'requires-device-or-emulator';
};

export const defaultAndroidAudioEffectsState: ShuxiaAndroidAudioEffectsState = {
  enabled: false,
  equalizer: {
    enabled: false,
    preset: 'Flat(原声)',
    bands: [
      {frequencyHz: 31, gainDb: 0},
      {frequencyHz: 62, gainDb: 0},
      {frequencyHz: 125, gainDb: 0},
      {frequencyHz: 250, gainDb: 0},
      {frequencyHz: 500, gainDb: 0},
      {frequencyHz: 1000, gainDb: 0},
      {frequencyHz: 2000, gainDb: 0},
      {frequencyHz: 4000, gainDb: 0},
      {frequencyHz: 8000, gainDb: 0},
      {frequencyHz: 16000, gainDb: 0},
    ],
  },
  bassBoost: {
    enabled: false,
    gain: 0,
  },
  surround: {
    enabled: false,
    mode: 'off',
  },
  balance: {
    enabled: true,
    value: 0,
  },
  loudness: {
    enabled: false,
    target: 'standard',
  },
};

export const emptyAndroidEffectsSystemBoundary: ShuxiaAndroidEffectsSystemBoundary = {
  playbackMode: 'sequence',
  audioEffects: defaultAndroidAudioEffectsState,
  executor: 'android-media3-audio-session',
  systemControls: 'media-session-service',
  externalVerification: 'requires-device-or-emulator',
};

export type ShuxiaLyricFormat = 'lrc' | 'yrc' | 'qrc' | 'ttml' | 'plain';

export type ShuxiaLyricInput = ShuxiaMusicPluginRequestBase & {
  track: ShuxiaTrack;
};

export type ShuxiaLyricPayload = {
  trackId: string;
  source: ShuxiaMusicSource;
  pluginId?: string;
  format: ShuxiaLyricFormat;
  lyric: string;
  translation?: string;
  raw?: unknown;
};

export type ShuxiaArtworkInput = ShuxiaMusicPluginRequestBase & {
  track: Pick<ShuxiaTrack, 'id' | 'source' | 'pluginId' | 'title' | 'artist' | 'album' | 'albumId' | 'artworkUrl' | 'songInfo'>;
};

export type ShuxiaArtworkCacheInput = ShuxiaArtworkInput;

export type ShuxiaArtworkCacheResult = {
  cacheKey: string;
  artworkUrl: string | null;
  source?: ShuxiaMusicSource;
  pluginId?: string;
  raw?: unknown;
};

export type ShuxiaSourcePlaylistListInput = ShuxiaMusicPluginRequestBase & {
  page?: number;
  limit?: number;
  category?: string;
  tag?: string;
};

export type ShuxiaSourcePlaylistSummary = {
  id: string;
  source?: ShuxiaMusicSource;
  pluginId?: string;
  title: string;
  description?: string;
  coverUrl?: string;
  creator?: string;
  total?: number;
  raw?: unknown;
};

export type ShuxiaSourcePlaylistPage = {
  items: ShuxiaSourcePlaylistSummary[];
  page: number;
  limit: number;
  total?: number;
  pluginId?: string;
  source?: ShuxiaMusicSource;
};

export type ShuxiaSourcePlaylistSongsInput = ShuxiaMusicPluginRequestBase & {
  playlistId: string;
  page?: number;
  limit?: number;
  rawPlaylist?: unknown;
};

export type ShuxiaSourcePlaylistSongsPage = {
  playlist: ShuxiaSourcePlaylistSummary;
  songs: ShuxiaTrack[];
  page: number;
  limit: number;
  total?: number;
};

export type ShuxiaAndroidSourceBoundary = {
  access: 'backend-aggregation' | 'pending-backend';
  desktopPluginRuntime: 'not-reused-on-android';
  search: ShuxiaSourceSearchInput | null;
  playableUrl: ShuxiaPlayableUrl | null;
  lyric: ShuxiaLyricPayload | null;
  artworkCache: ShuxiaArtworkCacheResult | null;
};

export const emptyAndroidSourceBoundary: ShuxiaAndroidSourceBoundary = {
  access: 'pending-backend',
  desktopPluginRuntime: 'not-reused-on-android',
  search: null,
  playableUrl: null,
  lyric: null,
  artworkCache: null,
};

export type ShuxiaAndroidLocalAudioScanBoundary = {
  access: 'media-library-permission-required' | 'not-started';
  supportedSources: Array<'media-store-audio'>;
  resultEntrypoint: 'local-track-list';
};

export type ShuxiaAndroidLocalCacheBoundary = {
  audio: 'app-cache-dir';
  artwork: 'app-cache-dir';
  lyric: 'app-files-dir';
};

export type ShuxiaAndroidDownloadQueueBoundary = {
  persistence: 'pending-local-store';
  worker: 'pending-background-worker';
  notification: 'pending-system-integration';
};

export type ShuxiaAndroidFilePermissionBoundary = {
  readMediaAudio: 'runtime-permission-android-13-plus';
  readExternalStorage: 'legacy-runtime-permission-android-12-minus';
  writeExternalStorage: 'legacy-scoped-to-android-9-minus';
};

export type ShuxiaAndroidLocalCapabilitiesBoundary = {
  localAudioScan: ShuxiaAndroidLocalAudioScanBoundary;
  cache: ShuxiaAndroidLocalCacheBoundary;
  downloadQueue: ShuxiaAndroidDownloadQueueBoundary;
  permissions: ShuxiaAndroidFilePermissionBoundary;
};

export const emptyAndroidLocalCapabilitiesBoundary: ShuxiaAndroidLocalCapabilitiesBoundary = {
  localAudioScan: {
    access: 'not-started',
    supportedSources: ['media-store-audio'],
    resultEntrypoint: 'local-track-list',
  },
  cache: {
    audio: 'app-cache-dir',
    artwork: 'app-cache-dir',
    lyric: 'app-files-dir',
  },
  downloadQueue: {
    persistence: 'pending-local-store',
    worker: 'pending-background-worker',
    notification: 'pending-system-integration',
  },
  permissions: {
    readMediaAudio: 'runtime-permission-android-13-plus',
    readExternalStorage: 'legacy-runtime-permission-android-12-minus',
    writeExternalStorage: 'legacy-scoped-to-android-9-minus',
  },
};

export type ShuxiaAndroidSystemIntegrationBoundary = {
  playbackNotification: 'media-session-service';
  lockscreenControls: 'media-session-metadata';
  mediaKeys: 'media-session-controller';
  backgroundPlayback: 'foreground-service-media-playback';
  appResume: 'session-activity-pending-intent';
  externalVerification: 'requires-device-or-emulator';
};

export const emptyAndroidSystemIntegrationBoundary: ShuxiaAndroidSystemIntegrationBoundary = {
  playbackNotification: 'media-session-service',
  lockscreenControls: 'media-session-metadata',
  mediaKeys: 'media-session-controller',
  backgroundPlayback: 'foreground-service-media-playback',
  appResume: 'session-activity-pending-intent',
  externalVerification: 'requires-device-or-emulator',
};

export type ShuxiaNodeRuntimeDirectoryMap = {
  root: string;
  plugins: string;
  builtinPlugins: string;
  config: string;
  logs: string;
  cache: string;
  temp: string;
  downloadMetadata: string;
};

export type ShuxiaNodeRuntimeHealth = {
  status: 'ok' | 'degraded';
  version: string;
  node: string;
  startedAt: string;
  uptimeMs: number;
  directories: ShuxiaNodeRuntimeDirectoryMap;
};

export type ShuxiaNodeRuntimeVersion = {
  name: '@shuxia/node-runtime';
  version: string;
  apiVersion: string;
  node: string;
};

export type ShuxiaNodeRuntimeEndpointMap = {
  health: string;
  version: string;
  plugins: string;
  pluginInstallLocal: string;
  pluginInstallUrl: string;
  pluginInstallBuiltin: string;
  pluginBuiltin: string;
  pluginLogs: string;
  pluginConfig: string;
  pluginHost: string;
  pluginHostLoad: string;
  pluginHostUnload: string;
  pluginHostDisable: string;
  pluginHostEnable: string;
  pluginHostCall: string;
  pluginHostEvents: string;
  sourceSearch: string;
  sourceSuggest: string;
  sourcePlayableUrl: string;
  sourcePlayableUrlFailure: string;
  sourceLyric: string;
  sourceArtwork: string;
  sourcePlaylist: string;
  sourcePlaylistSongs: string;
  sourceRanking: string;
  sourceComment: string;
  downloadPrepare: string;
  downloadTasks: string;
  downloadTaskUpdate: string;
  playbackResolve: string;
  playbackFailure: string;
};

export const shuxiaNodeRuntimeEndpoints: ShuxiaNodeRuntimeEndpointMap = {
  health: '/health',
  version: '/version',
  plugins: '/plugins',
  pluginInstallLocal: '/plugins/install/local',
  pluginInstallUrl: '/plugins/install/url',
  pluginInstallBuiltin: '/plugins/install/builtin',
  pluginBuiltin: '/plugins/builtin',
  pluginLogs: '/plugins/logs',
  pluginConfig: '/plugins/config',
  pluginHost: '/plugins/host',
  pluginHostLoad: '/plugins/host/load',
  pluginHostUnload: '/plugins/host/unload',
  pluginHostDisable: '/plugins/host/disable',
  pluginHostEnable: '/plugins/host/enable',
  pluginHostCall: '/plugins/host/call',
  pluginHostEvents: '/plugins/host/events',
  sourceSearch: '/music-source/search',
  sourceSuggest: '/music-source/suggest',
  sourcePlayableUrl: '/music-source/playable-url',
  sourcePlayableUrlFailure: '/music-source/playable-url/failure',
  sourceLyric: '/music-source/lyric',
  sourceArtwork: '/music-source/artwork',
  sourcePlaylist: '/music-source/playlist',
  sourcePlaylistSongs: '/music-source/playlist/songs',
  sourceRanking: '/music-source/ranking',
  sourceComment: '/music-source/comment',
  downloadPrepare: '/download/prepare',
  downloadTasks: '/download/tasks',
  downloadTaskUpdate: '/download/tasks/update',
  playbackResolve: '/playback/resolve',
  playbackFailure: '/playback/failure',
};

export type ShuxiaPluginType = 'music-source' | 'service' | 'lyrics' | 'artwork' | 'unknown';

export type ShuxiaPluginInstallSource = 'local-upload' | 'remote-url' | 'builtin';

export type ShuxiaPluginRuntimeStatus = 'not-loaded' | 'initializing' | 'ready' | 'sleeping' | 'throttled' | 'disabled' | 'crashed' | 'error';

export type ShuxiaPluginConfigSchemaField = {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'password' | 'select';
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: Array<{label: string; value: string}>;
  description?: string;
};

export type ShuxiaPluginInfo = {
  id: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
  type: ShuxiaPluginType;
  supportedSources: ShuxiaMusicSource[];
  disabled: boolean;
  status: ShuxiaPluginRuntimeStatus;
  installSource: ShuxiaPluginInstallSource;
  configSchema?: ShuxiaPluginConfigSchemaField[];
  installedAt?: string;
  updatedAt?: string;
};

export type ShuxiaPluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ShuxiaPluginLogLine = {
  id: string;
  pluginId: string;
  level: ShuxiaPluginLogLevel;
  message: string;
  createdAt: string;
  scope?: string;
};

export type ShuxiaPluginInstallLocalInput = {
  fileName: string;
  code: string;
  overwrite?: boolean;
};

export type ShuxiaPluginInstallUrlInput = {
  url: string;
  overwrite?: boolean;
};

export type ShuxiaPluginInstallBuiltinInput = {
  fileName: string;
  overwrite?: boolean;
};

export type ShuxiaBuiltinPluginInfo = {
  fileName: string;
  filePath: string;
  checksum: string;
  plugin: ShuxiaPluginInfo;
};

export type ShuxiaPluginConfig = Record<string, unknown>;

export type ShuxiaPluginMutationResult = {
  plugin: ShuxiaPluginInfo;
  logs?: ShuxiaPluginLogLine[];
};

export type ShuxiaPluginHostStatus = ShuxiaPluginRuntimeStatus;

export type ShuxiaPluginHostMethod =
  | 'search'
  | 'musicUrl'
  | 'getPic'
  | 'getLyric'
  | 'testConnection'
  | 'getPlaylists'
  | 'getPlaylistSongs';

export type ShuxiaPluginHostCallInput = {
  pluginId: string;
  method: ShuxiaPluginHostMethod;
  args?: unknown[];
  timeoutMs?: number;
};

export type ShuxiaPluginHostCallResult = {
  pluginId: string;
  method: ShuxiaPluginHostMethod;
  data: unknown;
  elapsedMs: number;
  status: ShuxiaPluginHostStatus;
};

export type ShuxiaPluginHostEventType = 'ready' | 'unloaded' | 'log' | 'notice' | 'throttle' | 'disabled' | 'crashed' | 'config';

export type ShuxiaPluginHostEvent = {
  id: string;
  pluginId: string;
  type: ShuxiaPluginHostEventType;
  level: ShuxiaPluginLogLevel;
  message: string;
  createdAt: string;
  payload?: unknown;
};

export type ShuxiaPluginHostMeta = {
  pluginId: string;
  status: ShuxiaPluginHostStatus;
  disabled: boolean;
  disabledReason?: string;
  throttledReason?: string;
  throttledUntil?: string;
  crashCount: number;
  hasMethods: Partial<Record<ShuxiaPluginHostMethod | 'onConfigUpdate', boolean>>;
  pluginInfo: ShuxiaPluginInfo;
};

export type ShuxiaPluginHostLoadInput = {
  pluginId: string;
};

export type ShuxiaPluginHostDisableInput = {
  pluginId: string;
  reason?: string;
};

export type ShuxiaPluginHostEnableInput = {
  pluginId: string;
};

export type ShuxiaSourceQualityPreference = {
  source: ShuxiaMusicSource;
  quality: string;
};

export type ShuxiaSourceSuggestInput = {
  keyword: string;
  sources?: ShuxiaMusicSource[];
  limit?: number;
};

export type ShuxiaSourceSuggestResult = {
  items: string[];
};

export type ShuxiaAudioEffectPreset = {
  eq?: number[];
  bassBoost?: number;
  virtualizer?: number;
  loudness?: number;
  crossfadeMs?: number;
  gapless?: boolean;
  replayGain?: boolean;
};

export type ShuxiaBusinessBoundary = {
  userProfile: ShuxiaUserProfile | null;
  cloudPlaylists: ShuxiaCloudPlaylist[];
  selectedPlaylist: ShuxiaCloudPlaylistDetail | null;
};

export const emptyBusinessBoundary: ShuxiaBusinessBoundary = {
  userProfile: null,
  cloudPlaylists: [],
  selectedPlaylist: null,
};
