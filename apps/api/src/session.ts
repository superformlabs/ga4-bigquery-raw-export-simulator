/**
 * The stateless session: the visitor's Google access token, sealed inside a
 * cookie with AES-256-GCM so only this service can read it (D-7: we store
 * nothing server-side).
 *
 * Cookie value format: base64url( iv[12] || ciphertext || authTag[16] ).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'ga4fake_session';
export const STATE_COOKIE = 'ga4fake_oauth_state';

/** Where the browser goes after sign-in when `returnTo` is absent or rejected. */
export const DEFAULT_RETURN_TO = '/';

/** Longest `returnTo` we accept. Anything longer is treated as `/`. */
const RETURN_TO_MAX_LENGTH = 2048;

/**
 * Keeps only a same-origin path for the post-sign-in redirect (contract v1.2):
 * it must start with `/` and not with `//`. Everything else, including full
 * URLs, protocol-relative URLs and `/\` (which browsers read as `//`), becomes
 * `/`. The result is appended to `APP_URL`, so this is what stops an open
 * redirect to another site.
 */
export function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RETURN_TO_MAX_LENGTH) return DEFAULT_RETURN_TO;
  if (raw[0] !== '/') return DEFAULT_RETURN_TO;
  if (raw[1] === '/' || raw[1] === '\\') return DEFAULT_RETURN_TO;
  // Control characters and whitespace have no place in a path and could split the Location header.
  if (/[\u0000-\u0020\u007f]/.test(raw)) return DEFAULT_RETURN_TO;
  return raw;
}

/**
 * What the ten-minute state cookie carries between /auth/login and
 * /auth/callback: the random CSRF `state` and the sanitized `returnTo`.
 * The cookie is HttpOnly and only ever read back by this service, and
 * `returnTo` is sanitized again when read, so it does not need encryption.
 *
 * Cookie value format: base64url( JSON ).
 */
export interface OAuthState {
  state: string;
  returnTo: string;
}

export function encodeOAuthState(value: OAuthState): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Returns the decoded state, or null when the cookie is missing or malformed. */
export function decodeOAuthState(value: string | undefined): OAuthState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<OAuthState>;
    if (typeof parsed.state !== 'string' || parsed.state.length === 0) return null;
    return { state: parsed.state, returnTo: sanitizeReturnTo(parsed.returnTo) };
  } catch {
    return null;
  }
}

export interface Session {
  email: string;
  accessToken: string;
  /** ISO 8601 instant when the Google access token stops working. */
  expiresAt: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Derive a fixed-length AES key from the free-form SESSION_SECRET. */
export function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function sealSession(session: Session, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(session), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64url');
}

/**
 * Returns the session, or null when the cookie is missing, tampered with,
 * sealed with another key, malformed, or expired.
 */
export function openSession(value: string | undefined, key: Buffer, now: Date = new Date()): Session | null {
  if (!value) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  if (raw.length < IV_BYTES + TAG_BYTES + 1) return null;
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const enc = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain) as Partial<Session>;
    if (
      typeof parsed.email !== 'string' ||
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.expiresAt !== 'string'
    ) {
      return null;
    }
    const expires = new Date(parsed.expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return null;
    return { email: parsed.email, accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

/** Seconds until `expiresAt`, never below zero. Used for the cookie Max-Age. */
export function secondsUntil(expiresAt: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000));
}
