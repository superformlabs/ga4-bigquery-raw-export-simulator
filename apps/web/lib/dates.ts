// Days of history, counted the way the generator counts them: up to
// yesterday, in UTC (Phase 5, item 10). Every date here is a calendar day
// written YYYY-MM-DD; none depends on the visitor's time zone.

/**
 * The earliest first day of a history (docs/contracts/api.md v2.2, decision
 * D-78): 14 October 2020, the day Google announced GA4. It replaces the
 * maximum of 400 days, which moved with the clock. No date field of the app
 * offers an earlier day, and the backend refuses one.
 */
export const EARLIEST_DAY = "2020-10-14";
/**
 * What is wrong with a start date that is earlier than the launch of GA4. One
 * short line (decision D-78): a date error, not a statement of a limit.
 */
export const EARLIEST_DAY_PROBLEM = "GA4 began on 14 October 2020. Choose a start date from that day on.";
export const DEFAULT_DAYS = 90;

const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Milliseconds at 00:00 UTC of a YYYY-MM-DD day, or null when it is not a real day. */
function utcDay(day: string): number | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 2026-02-31 would silently become a day in March.
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : null;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Yesterday in UTC: the newest day a dataset holds. */
export function yesterdayUtc(now: Date = new Date()): string {
  return iso(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS);
}

/**
 * Days of history for a start date: from that day up to yesterday, both
 * included. 0 when the text is not a date. Negative or 0 for today and later.
 */
export function daysFrom(start: string, now: Date = new Date()): number {
  const a = utcDay(start);
  if (a === null) return 0;
  return Math.round(((utcDay(yesterdayUtc(now)) as number) - a) / DAY_MS) + 1;
}

/** True for a real day of the calendar written YYYY-MM-DD. */
export const isDay = (day: string) => utcDay(day) !== null;

/** The day `n` days after a day (before it when `n` is negative), or "" when the day is not one. */
export function addDays(day: string, n: number): string {
  const a = utcDay(day);
  return a === null ? "" : iso(a + n * DAY_MS);
}

/** The days of a period, both ends included. 0 when one of the two is not a date; negative or 0 when the end is before the start. */
export function daysBetween(start: string, end: string): number {
  const a = utcDay(start);
  const b = utcDay(end);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS) + 1;
}

/** The first day of a period of `days` days that ends on `end`. */
export function startOfPeriod(days: number, end: string): string {
  return addDays(end, -(days - 1));
}

/**
 * The days of a period that keeps its start and ends on another day. `null`
 * when the period that results is none the install accepts. Used when a
 * visitor who chose two dates asks for the daily refresh after all: the end
 * becomes yesterday, the start stays.
 */
export function daysWithEnd(days: number, end: string, newEnd: string): number | null {
  const count = daysBetween(startOfPeriod(days, end), newEnd);
  return isDayCount(count) ? count : null;
}

/**
 * What is wrong with a period, in words for the visitor. Empty when nothing
 * is. Both dates end on yesterday at the latest, in UTC, the start is not
 * earlier than the launch of GA4 (`EARLIEST_DAY`, decision D-78), and the end
 * is not before the start (decision D-34, api.md v2.2).
 */
export function periodProblem(start: string, end: string, now: Date = new Date()): string {
  if (!isDay(start)) return "Choose a start date.";
  if (!isDay(end)) return "Choose an end date.";
  const yesterday = yesterdayUtc(now);
  if (end > yesterday) return "Choose an end date before today.";
  if (start > yesterday) return "Choose a start date before today.";
  if (start < EARLIEST_DAY) return EARLIEST_DAY_PROBLEM;
  if (end < start) return "Choose an end date that is not before the start date.";
  return "";
}

/** The day of a table `events_YYYYMMDD`, written YYYY-MM-DD, or "" when the name is not one. */
export function dayOfTable(table: string | null | undefined): string {
  const m = /^events_(\d{4})(\d{2})(\d{2})$/.exec(table ?? "");
  const day = m ? `${m[1]}-${m[2]}-${m[3]}` : "";
  return isDay(day) ? day : "";
}

/**
 * The backend refuses a history that neither touches nor overlaps the days a
 * dataset holds: it would leave days without data between them (api.md
 * v1.16, API-24). True when the period asked leaves such a hole. `first` and
 * `last` are the first and the last day the dataset holds.
 */
export function leavesHole(start: string, end: string, first: string, last: string): boolean {
  if (![start, end, first, last].every(isDay)) return false;
  return !(start <= addDays(last, 1) && end >= addDays(first, -1));
}

/** A number of days an install accepts: a whole number, 1 or more (api.md v2.2). The earliest day bounds it. */
export const isDayCount = (n: number) => Number.isInteger(n) && n >= 1;

/** What is wrong with a start date, in words for the visitor. Empty when nothing is. */
export function startDateProblem(start: string, now: Date = new Date()): string {
  if (!start) return "Choose a date.";
  if (utcDay(start) === null) return "Choose a date.";
  if (daysFrom(start, now) < 1) return "Choose a date before today.";
  if (start < EARLIEST_DAY) return EARLIEST_DAY_PROBLEM;
  return "";
}
