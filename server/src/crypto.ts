import {randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createCipheriv, createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_LENGTH = 64;

export const createId = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;

export const createToken = () => randomBytes(32).toString('base64url');

export const createPairCode = () => randomBytes(9).toString('base64url').toUpperCase();

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const hashPassword = async (password: string) => {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
};

export const verifyPassword = async (password: string, storedHash: string) => {
  const [scheme, salt, hash] = storedHash.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;

  const stored = Buffer.from(hash, 'hex');
  const key = (await scrypt(password, salt, stored.length)) as Buffer;
  return stored.length === key.length && timingSafeEqual(stored, key);
};

export const nowIso = () => new Date().toISOString();

export const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export const generateDataKey = () => randomBytes(32).toString('hex');

export const encryptJson = (keyHex: string, value: unknown) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
};

export const decryptJson = <T>(keyHex: string, payload: string, fallback: T): T => {
  try {
    const [version, ivHex, tagHex, dataHex] = String(payload || '').split(':');
    if (version !== 'v1' || !ivHex || !tagHex || !dataHex) return fallback;
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  } catch {
    return fallback;
  }
};
