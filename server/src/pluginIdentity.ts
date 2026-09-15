export const MAX_PLUGIN_SCRIPT_BYTES = 2 * 1024 * 1024;

export type PluginKind = 'music-source' | 'capability';
export type CapabilityRole = 'feiniu' | 'navidrome' | 'nas-sync';

export const normalizePluginToken = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

export const musicSourceIdentityKey = (name: unknown, author: unknown) =>
  `music-source:${normalizePluginToken(name)}:${normalizePluginToken(author) || '_'}`;

export const capabilityIdentityKey = (role: unknown) => `capability:${normalizePluginToken(role)}`;

export const parsePluginIdentityKey = (value: unknown) => {
  const identityKey = String(value || '').trim();
  if (identityKey.startsWith('music-source:')) {
    const rest = identityKey.slice('music-source:'.length);
    const separator = rest.lastIndexOf(':');
    if (separator <= 0) return null;
    return {
      kind: 'music-source' as const,
      identityKey,
      name: rest.slice(0, separator),
      author: rest.slice(separator + 1),
      role: '',
    };
  }
  if (identityKey.startsWith('capability:')) {
    const role = identityKey.slice('capability:'.length);
    if (!role) return null;
    return {
      kind: 'capability' as const,
      identityKey,
      name: '',
      author: '',
      role,
    };
  }
  return null;
};

const FEINIU_FIELDS = ['host', 'port', 'useHttps', 'username', 'password', 'accessCode'] as const;
const NAVIDROME_FIELDS = ['serverUrl', 'username', 'password'] as const;
const NAS_SYNC_FIELDS = ['host', 'port', 'useHttps', 'pairCode'] as const;
const SECRET_FIELDS = new Set(['password', 'accessCode', 'pairCode']);

export const capabilityFieldsForRole = (role: string) => {
  if (role === 'feiniu') return FEINIU_FIELDS;
  if (role === 'navidrome') return NAVIDROME_FIELDS;
  if (role === 'nas-sync') return NAS_SYNC_FIELDS;
  return [] as readonly string[];
};

export const isCapabilitySecretField = (key: string) => SECRET_FIELDS.has(key);

export const canonicalCapabilityRole = (value: unknown): CapabilityRole | '' => {
  const role = normalizePluginToken(value);
  if (role === 'feiniu' || role === 'navidrome' || role === 'nas-sync') return role;
  return '';
};

const asBoolean = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';

const asPort = (value: unknown) => {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? Math.floor(port) : 0;
};

export const canonicalizeCapabilityConfig = (role: string, config: Record<string, unknown> | null | undefined) => {
  const source = config && typeof config === 'object' ? config : {};
  if (role === 'feiniu') {
    const rawHost = String(source.host || source.inputHost || source.serverUrl || '').trim();
    let host = rawHost;
    let port = asPort(source.port);
    let useHttps = asBoolean(source.useHttps);
    try {
      const parsed = new URL(/^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`);
      host = parsed.hostname;
      if (!port && parsed.port) port = Number(parsed.port);
      if (/^https:/i.test(rawHost) || source.useHttps === true) useHttps = true;
      if (source.useHttps === false) useHttps = false;
    } catch {
      const [authority] = rawHost.replace(/^https?:\/\//i, '').split('/');
      const [hostname, portText] = authority.split(':');
      host = hostname || rawHost;
      if (!port && portText) port = asPort(portText);
      if (/^https:\/\//i.test(rawHost)) useHttps = true;
    }
    return {
      host,
      port,
      useHttps,
      username: String(source.username || '').trim(),
      password: String(source.password || ''),
      accessCode: String(source.accessCode || ''),
    };
  }
  if (role === 'navidrome') {
    return {
      serverUrl: String(source.serverUrl || source.host || '').trim(),
      username: String(source.username || '').trim(),
      password: String(source.password || ''),
    };
  }
  if (role === 'nas-sync') {
    const rawHost = String(source.host || source.inputHost || source.serverUrl || '').trim();
    let host = rawHost.replace(/^https?:\/\//i, '').split('/')[0];
    let port = asPort(source.port);
    let useHttps = asBoolean(source.useHttps);
    if (!port && host.includes(':')) {
      const [hostname, portText] = host.split(':');
      host = hostname;
      port = asPort(portText);
    }
    if (/^https:\/\//i.test(rawHost)) useHttps = true;
    if (source.useHttps === false) useHttps = false;
    return {
      host,
      port,
      useHttps,
      pairCode: String(source.pairCode || ''),
    };
  }
  return {};
};

export const mergeCapabilityConfig = (
  role: string,
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
) => {
  const current = canonicalizeCapabilityConfig(role, existing);
  const next = canonicalizeCapabilityConfig(role, incoming);
  const merged: Record<string, unknown> = {...current};
  for (const key of capabilityFieldsForRole(role)) {
    if (!(key in next)) continue;
    const value = next[key as keyof typeof next];
    if (isCapabilitySecretField(key) && String(value || '').trim() === '' && String(current[key as keyof typeof current] || '').trim()) {
      continue;
    }
    merged[key] = value;
  }
  return canonicalizeCapabilityConfig(role, merged);
};
