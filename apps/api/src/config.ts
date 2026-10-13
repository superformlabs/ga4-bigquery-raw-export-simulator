/**
 * Runtime configuration, read from environment variables. See .env.example.
 */
import { randomBytes } from 'node:crypto';
import { DEFAULT_SUPPORT_EMAIL } from './errors.js';

export interface AppConfig {
  port: number;
  googleClientId: string;
  googleClientSecret: string;
  /** Must match a redirect URI registered on the OAuth client (D-11). */
  googleRedirectUri: string;
  /** Where the browser is sent after sign-in and sign-out. The UI's origin. */
  appUrl: string;
  /** Free-form secret used to derive the cookie encryption key. */
  sessionSecret: string;
  /** Whether cookies carry the `Secure` flag. Off for plain-http localhost. */
  cookieSecure: boolean;
  /** Full name of the generator container image the visitor's job runs (infra/IMAGE). */
  generatorImage: string;
  /**
   * Sign-in allowlist (D-16), lowercase. When both lists are empty every
   * Google account may sign in. Otherwise the account's email must be in
   * `allowedEmails` or its domain in `allowedEmailDomains`.
   */
  allowedEmailDomains: string[];
  allowedEmails: string[];
  /**
   * Whether `POST /api/install/uninstall` exists (D-30, api.md v1.13). Off
   * unless `UNINSTALL_ENABLED` is `true`: the route then answers 404, as a
   * route that does not exist, and the preflight leaves the permissions of
   * the uninstall alone.
   */
  uninstallEnabled: boolean;
  /**
   * The address a visitor writes to (D-35, api.md v1.17). Every hint that
   * asks to report a problem names it. `SUPPORT_EMAIL`, with
   * `support@superformlabs.eu` as its default.
   */
  supportEmail: string;
}

export const DEFAULTS = {
  PORT: 3001,
  GOOGLE_REDIRECT_URI: 'http://localhost:3001/auth/callback',
  APP_URL: 'http://localhost:3000',
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Comma separated, trimmed, lowercased, empty items dropped. */
function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Whether `email` may sign in. The domain is everything after the last `@`
 * and must equal an allowed domain exactly: `superformlabs.eu` does not admit
 * `x@sub.superformlabs.eu` or `x@notsuperformlabs.eu`.
 */
export function isEmailAllowed(email: string, config: Pick<AppConfig, 'allowedEmailDomains' | 'allowedEmails'>): boolean {
  if (config.allowedEmailDomains.length === 0 && config.allowedEmails.length === 0) return true;
  const normalized = email.trim().toLowerCase();
  if (config.allowedEmails.includes(normalized)) return true;
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return false;
  return config.allowedEmailDomains.includes(normalized.slice(at + 1));
}

export function loadConfig(env: Env = process.env, log: (msg: string) => void = console.warn): AppConfig {
  const isProduction = env.NODE_ENV === 'production';

  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new ConfigError(
      `Missing ${missing.join(' and ')}. Copy apps/api/.env.example to apps/api/.env and fill in the OAuth client values from the Google Cloud console (task USER-2).`,
    );
  }

  const generatorImage = env.GENERATOR_IMAGE?.trim() ?? '';
  if (!/^[a-z0-9.-]+\/[A-Za-z0-9._\/-]+(:[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})$/.test(generatorImage)) {
    throw new ConfigError(
      `GENERATOR_IMAGE must be a full container image name with a tag, like us-central1-docker.pkg.dev/<project>/ga4synth/ga4synth:<tag>, got "${generatorImage}". The server reads infra/IMAGE when the variable is unset.`,
    );
  }

  const portRaw = env.PORT?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULTS.PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be a whole number between 1 and 65535, got "${portRaw}".`);
  }

  let sessionSecret = env.SESSION_SECRET?.trim() ?? '';
  if (!sessionSecret) {
    if (isProduction) {
      throw new ConfigError('SESSION_SECRET is required in production. Generate one with: openssl rand -base64 32');
    }
    sessionSecret = randomBytes(32).toString('base64');
    log('SESSION_SECRET is not set; using a random one for this run. Sessions will not survive a restart.');
  }

  const cookieSecureRaw = env.COOKIE_SECURE?.trim().toLowerCase();
  const cookieSecure = cookieSecureRaw ? cookieSecureRaw === 'true' || cookieSecureRaw === '1' : isProduction;

  // A typo here would either lock everyone out or, worse, look like a lock
  // while admitting nobody we meant. Refuse to start instead.
  const allowedEmailDomains = list(env.ALLOWED_EMAIL_DOMAINS);
  const badDomain = allowedEmailDomains.find((d) => !DOMAIN_RE.test(d));
  if (badDomain !== undefined) {
    throw new ConfigError(
      `ALLOWED_EMAIL_DOMAINS must be a comma separated list of domains such as superformlabs.eu (no "@", no address), got "${badDomain}".`,
    );
  }
  const allowedEmails = list(env.ALLOWED_EMAILS);
  const badEmail = allowedEmails.find((e) => !/^[^\s@]+@[^\s@]+$/.test(e));
  if (badEmail !== undefined) {
    throw new ConfigError(`ALLOWED_EMAILS must be a comma separated list of email addresses, got "${badEmail}".`);
  }

  // Off by default. A value that is neither `true` nor `false` is a typo:
  // better to refuse to start than to guess which one was meant.
  const uninstallRaw = env.UNINSTALL_ENABLED?.trim().toLowerCase() ?? '';
  if (uninstallRaw !== '' && uninstallRaw !== 'true' && uninstallRaw !== 'false') {
    throw new ConfigError(`UNINSTALL_ENABLED must be true or false, got "${env.UNINSTALL_ENABLED?.trim()}". Leave it out to keep the route switched off.`);
  }

  // Shown to visitors as it is. An address that cannot be written to helps nobody.
  const supportEmail = env.SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>.]+$/.test(supportEmail)) {
    throw new ConfigError(`SUPPORT_EMAIL must be one email address such as ${DEFAULT_SUPPORT_EMAIL}, got "${supportEmail}".`);
  }

  return {
    allowedEmailDomains,
    allowedEmails,
    uninstallEnabled: uninstallRaw === 'true',
    supportEmail,
    port,
    googleClientId: env.GOOGLE_CLIENT_ID!.trim(),
    googleClientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
    googleRedirectUri: env.GOOGLE_REDIRECT_URI?.trim() || DEFAULTS.GOOGLE_REDIRECT_URI,
    appUrl: (env.APP_URL?.trim() || DEFAULTS.APP_URL).replace(/\/+$/, ''),
    sessionSecret,
    cookieSecure,
    generatorImage,
  };
}
