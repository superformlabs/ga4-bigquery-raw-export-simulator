/**
 * The HTTP routes from docs/contracts/api.md. Google is reached only through
 * the GoogleGateway passed in, so tests can substitute a fake.
 */
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isEmailAllowed, type AppConfig } from './config.js';
import { ApiError, unauthenticated, type ErrorCode } from './errors.js';
import { getExisting, parseExistingQuery } from './existing.js';
import type { GoogleGateway } from './google.js';
import { STEP_NAMES, getStatus, isStepName, parseInstallSpec, runStep, type CloudGateway } from './install.js';
import { preflight } from './preflight.js';
import { withSchedulerRetry } from './scheduler-retry.js';
import { parseUninstallSpec, uninstall } from './uninstall.js';
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  decodeOAuthState,
  deriveKey,
  encodeOAuthState,
  openSession,
  sanitizeReturnTo,
  sealSession,
  secondsUntil,
  type Session,
} from './session.js';

export interface AppDeps {
  config: AppConfig;
  google: GoogleGateway;
  /** Everything the install does in the visitor's project. */
  cloud: CloudGateway;
  /** Reported by GET /api/health. A git sha in practice. */
  version: string;
  /** Injectable clock, for tests. */
  now?: () => Date;
  /** Injectable wait between polls of a deletion and between retries, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable time limit for the look at one region, for tests. */
  regionTimeoutMs?: number;
  /** Where to log unexpected errors. */
  logError?: (message: string, err: unknown) => void;
}

const STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export function createApp(deps: AppDeps): Hono {
  const { config, google, version } = deps;
  const cloud = withSchedulerRetry(deps.cloud, { sleep: deps.sleep });
  const now = deps.now ?? (() => new Date());
  const logError = deps.logError ?? ((message, err) => (err === undefined ? console.error(message) : console.error(message, err)));
  const key = deriveKey(config.sessionSecret);

  const cookieBase = { httpOnly: true, secure: config.cookieSecure, sameSite: 'Lax' as const, path: '/' };

  const setSessionCookie = (c: Context, session: Session) =>
    setCookie(c, SESSION_COOKIE, sealSession(session, key), {
      ...cookieBase,
      maxAge: secondsUntil(session.expiresAt, now()),
    });

  const clearSessionCookie = (c: Context) => deleteCookie(c, SESSION_COOKIE, cookieBase);

  const readSession = (c: Context): Session | null => openSession(getCookie(c, SESSION_COOKIE), key, now());

  const requireSession = (c: Context): Session => {
    const session = readSession(c);
    if (!session) throw unauthenticated();
    return session;
  };

  const app = new Hono();

  app.notFound((c) =>
    c.json(
      new ApiError('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}.`, 'Check the URL against docs/contracts/api.md.').toBody(),
      404,
    ),
  );

  // The one place where an error becomes an answer. A hint that asks to
  // report the problem gets the address of the support here (api.md v1.17).
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(config.supportEmail), err.status as 400);
    logError(`Unhandled error on ${c.req.method} ${c.req.path}`, err);
    const internal = new ApiError('INTERNAL', 'Something went wrong on our side.', 'Try again in a moment.', { report: true });
    return c.json(internal.toBody(config.supportEmail), 500);
  });

  // ---- Health -----------------------------------------------------------

  app.get('/api/health', (c) => c.json({ ok: true, version }));

  // ---- Authentication ---------------------------------------------------

  /**
   * `returnTo` is the UI path to come back to after sign-in (contract v1.2).
   * It travels in the state cookie, never in the URL sent to Google, and only
   * a same-origin path survives `sanitizeReturnTo`.
   */
  app.get('/auth/login', (c) => {
    const state = randomBytes(16).toString('base64url');
    const returnTo = sanitizeReturnTo(c.req.query('returnTo'));
    setCookie(c, STATE_COOKIE, encodeOAuthState({ state, returnTo }), { ...cookieBase, maxAge: STATE_COOKIE_MAX_AGE_SECONDS });
    return c.redirect(google.authUrl(state), 302);
  });

  /**
   * Where the browser lands when sign-in fails. The callback is opened by a
   * person, not by the UI's JavaScript, so it must never answer with JSON.
   * The UI reads `?error=<CODE>` and shows the matching message (contract v1.1).
   */
  const failedSignInUrl = (code: ErrorCode) => `${config.appUrl}/?error=${code}`;

  /**
   * Validates the callback query and turns the code into a session, or throws
   * an ApiError. Also returns the UI path the visitor asked to come back to.
   */
  const completeSignIn = async (c: Context): Promise<{ session: Session; returnTo: string }> => {
    const { code, state, error } = c.req.query();
    const started = decodeOAuthState(getCookie(c, STATE_COOKIE));
    deleteCookie(c, STATE_COOKIE, cookieBase);

    if (error) {
      if (error === 'access_denied') {
        throw new ApiError(
          'PERMISSION_DENIED',
          'You cancelled the Google sign-in or did not allow the requested access.',
          'Sign in again and allow the access Google asks for. The app needs access to your Google Cloud project to install the dataset.',
        );
      }
      throw new ApiError('UPSTREAM_ERROR', `Google sign-in failed: ${error}.`, 'Try signing in again.');
    }
    if (!code) {
      throw new ApiError('INVALID_ARGUMENT', 'The sign-in callback is missing the code from Google.', 'Sign in again.');
    }
    if (!state || !started || state !== started.state) {
      throw new ApiError(
        'INVALID_ARGUMENT',
        'The sign-in did not start from this app, or it took longer than ten minutes.',
        'Sign in again.',
      );
    }

    const user = await google.exchangeCode(code);

    // Sign-in allowlist (D-16). An unverified address proves nothing about
    // who owns it, so it never satisfies the allowlist.
    const restricted = config.allowedEmailDomains.length > 0 || config.allowedEmails.length > 0;
    if (restricted && !(user.emailVerified && isEmailAllowed(user.email, config))) {
      // We hold a token we will never use: hand it back. Best effort.
      await google.revoke(user.accessToken).catch((err) => logError('Token revoke failed', err));
      throw new ApiError(
        'ACCOUNT_NOT_ALLOWED',
        `The Google account ${user.email} is not allowed to sign in to this site.`,
        `Sign in with an account from an allowed organisation, or ask for access at ${config.supportEmail}.`,
      );
    }

    return {
      session: { email: user.email, accessToken: user.accessToken, expiresAt: user.expiresAt.toISOString() },
      returnTo: started.returnTo,
    };
  };

  app.get('/auth/callback', async (c) => {
    let session: Session;
    let returnTo: string;
    try {
      ({ session, returnTo } = await completeSignIn(c));
    } catch (err) {
      if (err instanceof ApiError) {
        logError(`Sign-in failed (${err.code}): ${err.message}`, undefined);
        return c.redirect(failedSignInUrl(err.code), 302);
      }
      logError('Unhandled error on GET /auth/callback', err);
      return c.redirect(failedSignInUrl('INTERNAL'), 302);
    }
    setSessionCookie(c, session);
    return c.redirect(`${config.appUrl}${returnTo}`, 302);
  });

  app.post('/auth/logout', async (c) => {
    const session = readSession(c);
    clearSessionCookie(c);
    if (session) {
      // Best effort: the cookie is gone either way.
      await google.revoke(session.accessToken).catch((err) => logError('Token revoke failed', err));
    }
    return c.json({ ok: true });
  });

  app.get('/api/me', (c) => {
    const session = requireSession(c);
    return c.json({ email: session.email, expiresAt: session.expiresAt });
  });

  // ---- Projects ---------------------------------------------------------

  app.get('/api/projects', async (c) => {
    const session = requireSession(c);
    const projects = await google.listProjects(session.accessToken);
    return c.json({ projects });
  });

  // ---- Install ----------------------------------------------------------

  app.get('/api/install/status', async (c) => {
    const session = requireSession(c);
    // Reads only: every well-formed region, so an install made elsewhere can be seen.
    const spec = parseInstallSpec(c.req.query(), { regions: 'any', now: now() });
    return c.json(await getStatus(cloud, session.accessToken, spec));
  });

  app.get('/api/install/existing', async (c) => {
    const session = requireSession(c);
    const query = parseExistingQuery(c.req.query());
    return c.json(await getExisting(cloud, session.accessToken, query, { regionTimeoutMs: deps.regionTimeoutMs }));
  });

  const readJsonObject = async (c: Context): Promise<Record<string, unknown>> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError('INVALID_ARGUMENT', 'The request body is not valid JSON.', 'This is a bug in the app. Reload the page and try again.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ApiError('INVALID_ARGUMENT', 'The request body must be a JSON object with the install settings.', 'This is a bug in the app. Reload the page and try again.');
    }
    return body as Record<string, unknown>;
  };

  app.post('/api/install/steps/:step', async (c) => {
    const session = requireSession(c);
    const step = c.req.param('step');
    if (!isStepName(step)) {
      throw new ApiError('NOT_FOUND', `There is no install step called "${step}".`, `Use one of: ${STEP_NAMES.join(', ')}.`);
    }
    const spec = parseInstallSpec(await readJsonObject(c), { now: now() });
    const result = await runStep(cloud, session.accessToken, step, spec, {
      generatorImage: config.generatorImage,
      sleep: deps.sleep,
      now: () => now().getTime(),
    });
    return c.json(result, result.state === 'running' ? 202 : 200);
  });

  app.post('/api/install/preflight', async (c) => {
    const session = requireSession(c);
    const spec = parseInstallSpec(await readJsonObject(c), { now: now() });
    return c.json(
      await preflight(cloud, session, spec, {
        generatorImage: config.generatorImage,
        now: now(),
        uninstallEnabled: config.uninstallEnabled,
        supportEmail: config.supportEmail,
      }),
    );
  });

  // Taken out of the app for now (D-30, api.md v1.13). While the setting is
  // off the route is not there at all: 404, with or without a session.
  if (config.uninstallEnabled) {
    app.post('/api/install/uninstall', async (c) => {
      const session = requireSession(c);
      const spec = parseUninstallSpec(await readJsonObject(c));
      return c.json(await uninstall(cloud, session.accessToken, spec, { sleep: deps.sleep, regionTimeoutMs: deps.regionTimeoutMs }));
    });
  }

  return app;
}
