/**
 * Structured errors, exactly as described in docs/contracts/api.md.
 *
 * Every non-2xx response has the body
 *   {"error": {"code": ..., "message": ..., "hint": ...}}
 * where `hint` tells a non-expert what to do next. Two optional fields carry
 * the same meaning as in a preflight check (api.md v1.6): `link`, a Google
 * Cloud console page where the problem can be fixed, and `missing`, the
 * permissions the visitor lacks.
 *
 * A hint that asks the visitor to report a problem names the address of the
 * support (api.md v1.17, D-35). The address is a setting, `SUPPORT_EMAIL`.
 * An error made far from the settings says only that it is one to report;
 * the sentence and the address are added where the answer is written.
 */

/** The address a visitor writes to, unless the setting `SUPPORT_EMAIL` names another. */
export const DEFAULT_SUPPORT_EMAIL = 'support@superformlabs.eu';

/** The one sentence that asks the visitor to report a problem that does not go away. */
export const reportSentence = (supportEmail: string) => `If it keeps failing, please report it to ${supportEmail}.`;

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'CONFLICT'
  | 'ACCOUNT_NOT_ALLOWED'
  | 'BILLING_DISABLED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export const HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  CONFLICT: 409,
  ACCOUNT_NOT_ALLOWED: 403,
  BILLING_DISABLED: 412,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; hint: string; link?: string; missing?: string[]; taken?: string[] };
}

export interface ErrorExtras {
  /** A Google Cloud console page where the visitor can fix the problem. */
  link?: string;
  /** The permissions the visitor lacks. */
  missing?: string[];
  /**
   * The names of the install that something else holds: `job`, `schedule`
   * (api.md v2.0). The web app then draws another install number.
   */
  taken?: string[];
  /** Set when the error came from Google. Never sent to the browser as such. */
  upstream?: UpstreamInfo;
  /**
   * True for a problem the visitor cannot cure: the hint sent to the browser
   * ends with the sentence that asks to report it, with the address.
   */
  report?: boolean;
}

/** What Google said, kept so a caller can explain the error in its own words. */
export interface UpstreamInfo {
  /** Google's own text. */
  text: string;
  /** True when Google refused because an API is not enabled. */
  serviceDisabled: boolean;
  /**
   * True when Google answered ABORTED: it was still busy with an earlier
   * change to the same thing. Trying again a moment later usually works.
   */
  aborted?: boolean;
  /**
   * True when Google answered 400 and its text names no field of the install
   * form. The request was built by this app, so the visitor cannot cure it
   * by changing a value.
   */
  rejected?: boolean;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly status: number;
  readonly link?: string;
  readonly missing?: string[];
  readonly taken?: string[];
  readonly upstream?: UpstreamInfo;
  readonly report: boolean;

  constructor(code: ErrorCode, message: string, hint: string, extras: ErrorExtras = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint;
    this.status = HTTP_STATUS[code];
    this.link = extras.link;
    this.missing = extras.missing;
    this.taken = extras.taken;
    this.upstream = extras.upstream;
    this.report = extras.report === true;
  }

  /** The hint as the visitor reads it: with the request to report, when the error is one to report. */
  hintFor(supportEmail: string = DEFAULT_SUPPORT_EMAIL): string {
    return this.report ? `${this.hint} ${reportSentence(supportEmail)}` : this.hint;
  }

  toBody(supportEmail: string = DEFAULT_SUPPORT_EMAIL): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hintFor(supportEmail),
        ...(this.link ? { link: this.link } : {}),
        ...(this.missing?.length ? { missing: [...this.missing] } : {}),
        ...(this.taken?.length ? { taken: [...this.taken] } : {}),
      },
    };
  }
}

export function unauthenticated(message = 'You are not signed in.'): ApiError {
  return new ApiError('UNAUTHENTICATED', message, 'Sign in with Google to continue.');
}

/** gRPC status codes used by the Google Cloud client libraries. */
const GRPC_TO_CODE: Record<number, ErrorCode> = {
  3: 'INVALID_ARGUMENT',
  5: 'NOT_FOUND',
  7: 'PERMISSION_DENIED',
  16: 'UNAUTHENTICATED',
};

const HTTP_TO_CODE: Record<number, ErrorCode> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
};

const HINTS: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'Your Google session has expired. Sign in again.',
  PERMISSION_DENIED:
    'Ask a project Owner to grant you the Editor role on that project, or pick another project.',
  NOT_FOUND: 'Check that the project still exists and that you have access to it.',
  INVALID_ARGUMENT: 'Check your settings and try again.',
  UPSTREAM_ERROR: 'Google returned an unexpected error. Wait a minute and try again.',
};

/**
 * Google answers 403 when an API is not enabled, with this wording or one of
 * these reasons. It is not a missing permission and must not be shown as one.
 *
 * BigQuery says it in its own way: 400 INVALID_ARGUMENT, reason "invalid",
 * "The project <id> has not enabled BigQuery." (seen on 2026-09-27, for
 * datasets.get, datasets.list and tables.list alike). Only the words tell it
 * apart from a request that is really wrong.
 */
const SERVICE_DISABLED_TEXT =
  /has not been used in project .* before or it is disabled|API has not been enabled|is not enabled for project|\bproject \S+ has not enabled BigQuery\b|SERVICE_DISABLED|accessNotConfigured/i;

function isServiceDisabled(err: unknown, text: string): boolean {
  const e = (err ?? {}) as {
    reason?: unknown;
    errors?: { reason?: unknown }[];
    response?: { data?: { error?: { details?: { reason?: unknown }[]; errors?: { reason?: unknown }[] } } };
  };
  const reasons = [
    e.reason,
    ...(Array.isArray(e.errors) ? e.errors.map((x) => x?.reason) : []),
    ...(e.response?.data?.error?.details ?? []).map((x) => x?.reason),
    ...(e.response?.data?.error?.errors ?? []).map((x) => x?.reason),
  ];
  if (reasons.some((r) => r === 'SERVICE_DISABLED' || r === 'accessNotConfigured')) return true;
  return SERVICE_DISABLED_TEXT.test(text);
}

/**
 * Whether an error of ours came from Google refusing a call because the API
 * behind it is not enabled in the project. The one place that decides it,
 * for the preflight, the install steps and the status.
 */
export function isApiNotEnabled(err: unknown): boolean {
  return err instanceof ApiError && err.upstream?.serviceDisabled === true;
}

// ---- The two kinds of HTTP 409 ---------------------------------------------
//
// Google answers 409 both for "this already exists" and for "I am still busy
// with an earlier change" (ABORTED). The first is success for an idempotent
// create. The second means nothing was created. They must never be confused,
// and neither is our own 409 CONFLICT, which Google never sends.

interface GoogleErrorShape {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  reason?: unknown;
  errors?: { reason?: unknown; message?: unknown }[];
  response?: {
    status?: unknown;
    data?: { error?: { status?: unknown; message?: unknown; errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] } };
  };
}

/** The status name Google puts in the error body, such as "ABORTED", or undefined. */
export function googleStatus(err: unknown): string | undefined {
  const e = (err ?? {}) as GoogleErrorShape;
  const inBody = e.response?.data?.error?.status;
  if (typeof inBody === 'string' && inBody) return inBody.toUpperCase();
  // The gRPC based client libraries carry the status as a number.
  if (e.code === 10) return 'ABORTED';
  if (e.code === 6) return 'ALREADY_EXISTS';
  return undefined;
}

function googleTexts(err: unknown): string {
  const e = (err ?? {}) as GoogleErrorShape;
  return [e.message, e.response?.data?.error?.message, ...(Array.isArray(e.errors) ? e.errors.map((x) => x?.message) : [])]
    .filter((t): t is string => typeof t === 'string')
    .join(' ');
}

function googleReasons(err: unknown): unknown[] {
  const e = (err ?? {}) as GoogleErrorShape;
  return [
    e.reason,
    ...(Array.isArray(e.errors) ? e.errors.map((x) => x?.reason) : []),
    ...(e.response?.data?.error?.errors ?? []).map((x) => x?.reason),
    ...(e.response?.data?.error?.details ?? []).map((x) => x?.reason),
  ];
}

/**
 * Google was still busy with an earlier change. Recognised by the status
 * and, in case the status sits elsewhere than expected, by the wording.
 */
export function isAborted(err: unknown): boolean {
  if (err instanceof ApiError) return err.upstream?.aborted === true;
  if (googleStatus(err) === 'ABORTED') return true;
  return /\bABORTED\b|cannot be queued/.test(googleTexts(err));
}

/**
 * Google says the thing is already there. Needs positive evidence: a bare
 * 409 is not enough, and anything that looks like ABORTED is never success.
 */
export function isAlreadyExists(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  if (isAborted(err)) return false;
  const status = googleStatus(err);
  if (status !== undefined) return status === 'ALREADY_EXISTS';
  if (googleReasons(err).some((r) => r === 'duplicate' || r === 'alreadyExists' || r === 'ALREADY_EXISTS')) return true;
  return /already exists/i.test(googleTexts(err));
}

/**
 * Google's text, made fit to show: without the "Help Token" Google appends
 * for its own support staff, and with each repeated line kept once.
 */
export function cleanGoogleText(text: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of text.replace(/Help Token:\s*\S+/gi, '\n').split(/\n+/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    kept.push(line);
  }
  return kept.join(' ');
}

/**
 * The fields of the install form that Google itself can reject: a region or
 * a location that does not exist, a schedule it cannot read. The project and
 * dataset names are checked by this app before Google sees them.
 */
const FORM_FIELD_WORDS = /\b(region|location|schedule|cron)\b/i;

/** Whether Google's text names a field of the install form. */
export function namesFormField(text: string): boolean {
  return FORM_FIELD_WORDS.test(text);
}

/**
 * Google refused a request this app built. One text, inside a step and
 * outside (API-23). The request to report it follows, with the address.
 */
export const REJECTED_HINT = 'This is not about your settings. Wait a minute, then try again.';

/**
 * Turn an error thrown by a Google client library into an ApiError.
 * `action` is a short description of what we were doing, in plain English,
 * e.g. "list your projects". It becomes part of the message.
 */
export function fromGoogleError(err: unknown, action: string): ApiError {
  if (err instanceof ApiError) return err;

  const e = (err ?? {}) as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    response?: { status?: unknown; data?: unknown };
  };

  let code: ErrorCode | undefined;
  if (typeof e.code === 'number' && GRPC_TO_CODE[e.code]) code = GRPC_TO_CODE[e.code];
  const httpStatus =
    typeof e.status === 'number' ? e.status : typeof e.response?.status === 'number' ? e.response.status : undefined;
  if (!code && httpStatus !== undefined && HTTP_TO_CODE[httpStatus]) code = HTTP_TO_CODE[httpStatus];
  if (!code) code = 'UPSTREAM_ERROR';

  const googleText = (typeof e.message === 'string' ? cleanGoogleText(e.message) : '') || 'unknown error';
  const message =
    code === 'UPSTREAM_ERROR'
      ? `Google returned an error while trying to ${action}: ${googleText}`
      : `Could not ${action}: ${googleText}`;
  const upstream: UpstreamInfo = { text: googleText, serviceDisabled: isServiceDisabled(err, googleText) };
  // One code for an API that is not enabled, whatever status the service chose to say it with.
  if (upstream.serviceDisabled) code = 'PERMISSION_DENIED';
  if (isAborted(err)) {
    return new ApiError(
      'UPSTREAM_ERROR',
      `Google was still busy with an earlier change and could not ${action}. Google said: ${googleText}`,
      'Try again in a minute.',
      { upstream: { ...upstream, aborted: true } },
    );
  }

  if (upstream.serviceDisabled) {
    return new ApiError(
      code,
      `Could not ${action}, because a Google Cloud API it needs is not enabled: ${googleText}`,
      'This is not about your permissions. If the API was enabled a moment ago, wait a minute and try again.',
      { upstream },
    );
  }
  if (code === 'INVALID_ARGUMENT' && !namesFormField(googleText)) {
    // Not about the settings of the install: the hint must not send the visitor back to them.
    return new ApiError(
      'UPSTREAM_ERROR',
      `Google rejected the request while trying to ${action}: ${googleText}`,
      REJECTED_HINT,
      { upstream: { ...upstream, rejected: true }, report: true },
    );
  }
  return new ApiError(code, message, HINTS[code] ?? HINTS.UPSTREAM_ERROR!, { upstream });
}
