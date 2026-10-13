/**
 * Google creates a service account at once, but its other services need
 * some seconds before they know the new account. Until then, a grant that
 * names the account is answered with "Service account ... does not exist"
 * (seen on staging in 3 of 4 installs, 2026-09-26; the longest wait seen
 * was 14 seconds). Waiting a moment and granting again is the cure.
 *
 * Unlike the scheduler retry, this one cannot wrap the gateway: a grant is
 * a read, a change and a write, and all three are done again at each try.
 */
import { ApiError } from './errors.js';
import { consoleLinks } from './permissions.js';

/**
 * Waits before the second to the seventh try: 20 seconds in all, shared by
 * the project roles and the dataset access of one step.
 */
export const ACCOUNT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 3000, 4000, 5000, 5000];

/**
 * No wait may end later than this after the step began. The web app cuts
 * requests at 30 seconds, and the calls themselves take time too.
 */
export const ACCOUNT_RETRY_DEADLINE_MS = 22_000;

export interface AccountRetryOptions {
  /** Injectable wait, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in milliseconds, for tests. */
  now?: () => number;
  /** When the step began, on that clock. Without it, the moment the retry is set up. */
  startedAt?: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Google does not know the service account yet. Recognised by the wording
 * only, because the services do not agree on the status they send with it.
 */
export function isAccountNotKnownYet(err: unknown, email: string): boolean {
  if (!(err instanceof ApiError) || !err.upstream) return false;
  const text = err.upstream.text;
  return /does not exist/i.test(text) && (text.includes(email) || /service account/i.test(text));
}

export const accountNotReadyMessage = (email: string, projectId: string) =>
  `Google has not finished creating the service account ${email} in ${projectId}, so it could not be given its roles yet.`;
export const ACCOUNT_NOT_READY_HINT = 'Try again in a moment. The install continues where it stopped.';

/**
 * Returns a function that runs a grant, again after each "does not exist",
 * then gives up with a 502 the visitor can act on. The waits and the
 * deadline are counted over every grant run through the same function.
 */
export function accountGrantRetry(email: string, projectId: string, opts: AccountRetryOptions = {}) {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? now();
  let waits = 0;

  return async function grant<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        // Anything else, our own 409 CONFLICT included, is not retried.
        if (!isAccountNotKnownYet(err, email)) throw err;
        const delay = ACCOUNT_RETRY_DELAYS_MS[waits];
        if (delay === undefined || now() - startedAt + delay > ACCOUNT_RETRY_DEADLINE_MS) {
          throw new ApiError('UPSTREAM_ERROR', accountNotReadyMessage(email, projectId), ACCOUNT_NOT_READY_HINT, {
            link: consoleLinks.iam(projectId),
          });
        }
        waits++;
        await sleep(delay);
      }
    }
  };
}
