/**
 * Cloud Scheduler answers ABORTED ("sync mutate calls cannot be queued")
 * when a schedule is changed or deleted seconds after an earlier change,
 * for example an uninstall right after an install (seen on staging,
 * 2026-09-26). Waiting a moment and trying again is the cure.
 *
 * This wraps any CloudGateway, the real one or the fake one of the tests,
 * and retries the three calls that change a schedule.
 */
import { ApiError, isAborted } from './errors.js';
import type { CloudGateway } from './install.js';

/**
 * Waits before the second, third and fourth attempt: 7 seconds in all. The
 * web app cuts requests at 30 seconds, and an uninstall also waits up to
 * about 14 seconds for the Cloud Run job, so the two must fit together.
 */
export const SCHEDULER_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];
export const SCHEDULER_MAX_ATTEMPTS = SCHEDULER_RETRY_DELAYS_MS.length + 1;

export interface RetryOptions {
  /** Injectable wait, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `fn`, again after each ABORTED, then give up with a 502 the visitor can act on. */
export async function retryWhileBusy<T>(action: string, fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  let last: unknown;
  for (let attempt = 0; attempt < SCHEDULER_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(SCHEDULER_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      return await fn();
    } catch (err) {
      // Anything else, our own 409 CONFLICT included, is not retried.
      if (!isAborted(err)) throw err;
      last = err;
    }
  }
  const text = last instanceof ApiError ? (last.upstream?.text ?? last.message) : 'ABORTED';
  throw new ApiError(
    'UPSTREAM_ERROR',
    `Cloud Scheduler was still busy with an earlier change and could not ${action}, after ${SCHEDULER_MAX_ATTEMPTS} attempts.`,
    'Try again in a minute. Nothing is lost: it continues where it stopped.',
    { upstream: { text, serviceDisabled: false, aborted: true } },
  );
}

export function withSchedulerRetry(cloud: CloudGateway, opts: RetryOptions = {}): CloudGateway {
  // The methods are read from `cloud` at call time, so a test that replaces
  // one on the fake afterwards is still honoured.
  const wrapped: Pick<CloudGateway, 'createSchedule' | 'updateSchedule' | 'deleteSchedule'> = {
    createSchedule: (token, name, schedule) => retryWhileBusy('create the daily schedule', () => cloud.createSchedule(token, name, schedule), opts),
    updateSchedule: (token, name, schedule) => retryWhileBusy('update the daily schedule', () => cloud.updateSchedule(token, name, schedule), opts),
    deleteSchedule: (token, name) => retryWhileBusy('delete the daily schedule', () => cloud.deleteSchedule(token, name), opts),
  };
  return new Proxy(cloud, {
    get(target, prop, receiver) {
      if (prop in wrapped) return wrapped[prop as keyof typeof wrapped];
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
