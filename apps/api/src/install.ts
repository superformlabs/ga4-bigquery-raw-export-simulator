/**
 * The install: six idempotent steps and a derived status, exactly as in
 * docs/contracts/api.md ("Install") and docs/contracts/generator-cli.md
 * ("Container contract", "Schedule").
 *
 * Nothing is stored (D-7). Every question ("is the dataset there?") is asked
 * of the visitor's project through the CloudGateway, which is the only thing
 * that talks to Google. Tests replace it with an in-memory fake.
 */
import { accountGrantRetry } from './account-retry.js';
import { ApiError, REJECTED_HINT, isApiNotEnabled } from './errors.js';
import { STEP_ACTIONS, STEP_LINKS, STEP_PERMISSIONS, consoleLinks, roleHint } from './permissions.js';

// ---- InstallSpec ------------------------------------------------------------

export interface InstallSpec {
  projectId: string;
  datasetId: string;
  location: string;
  region: string;
  historyDays: number;
  schedule: string;
  datasetType: DatasetType;
  /**
   * Whether the install holds the daily schedule (api.md v1.14, D-31). The
   * choice is made at the install and never changed by a later request.
   */
  dailyRefresh: boolean;
  /**
   * The last day of the history, `YYYY-MM-DD` in UTC (api.md v1.16, D-34).
   * Null: yesterday at the moment the history runs, as before v1.16. Only
   * an install without the daily refresh may name it.
   */
  historyEnd: string | null;
  /**
   * The number of the install (api.md v2.0, D-42). The job and the schedule
   * carry it in their names, so a project can hold several installs. Null
   * names an install made before v2.0, whose job and schedule are
   * `ga4synth-daily`.
   */
  installId: string | null;
}

/**
 * The type of dataset (api.md v2.3, decisions D-96 and D-97; v1.8, D-23).
 * Each names one configuration of the generator inside the image,
 * `/app/config/<type>/`. The four are one invented software website seen
 * from four angles (D-97).
 */
export const DATASET_TYPES = ['default', 'ecommerce', 'eu-consent', 'lead-generation'] as const;
export type DatasetType = (typeof DATASET_TYPES)[number];

export function isDatasetType(s: string): s is DatasetType {
  return (DATASET_TYPES as readonly string[]).includes(s);
}

/**
 * The name a visitor reads for each type (api.md v2.3). Every message that
 * names a type uses this name, never the value. The one exception is the
 * message of a malformed `datasetType`, which names the values of the field.
 */
export const DATASET_TYPE_NAMES: Readonly<Record<DatasetType, string>> = {
  default: 'Default',
  ecommerce: 'Ecommerce',
  'eu-consent': 'EU consent',
  'lead-generation': 'Lead generation',
};

/** The name a visitor reads for a type, for the text of a message (api.md v2.3). */
export const typeName = (type: DatasetType): string => DATASET_TYPE_NAMES[type];

export const INSTALL_DEFAULTS: Omit<InstallSpec, 'projectId'> = {
  datasetId: 'analytics_770000001',
  location: 'US',
  region: 'us-central1',
  historyDays: 90,
  schedule: '0 6 * * *',
  datasetType: 'default',
  dailyRefresh: true,
  historyEnd: null,
  installId: null,
};

/**
 * The earliest day a history may begin: 2020-10-14, the day Google announced
 * GA4 (api.md v2.2, D-78). It replaces the maximum of 400 days, which moved
 * with the clock. `historyDays` has no maximum of its own; this day bounds it.
 */
export const HISTORY_FIRST_DAY = '2020-10-14';

export const STEP_NAMES = [
  'enable-apis',
  'create-dataset',
  'create-service-account',
  'deploy-job',
  'create-schedule',
  'run-backfill',
] as const;
export type StepName = (typeof STEP_NAMES)[number];

export function isStepName(s: string): s is StepName {
  return (STEP_NAMES as readonly string[]).includes(s);
}

const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATASET_ID_RE = /^[A-Za-z0-9_]{1,1024}$/;
const LOCATION_RE = /^[A-Za-z0-9-]{1,40}$/;
const REGION_RE = /^[a-z]+-[a-z]+[0-9]$/;
/** 6 to 12 digits and lowercase letters (api.md v2.0). So no install number is `daily`, the name of before. */
const INSTALL_ID_RE = /^[a-z0-9]{6,12}$/;

const invalid = (message: string) => new ApiError('INVALID_ARGUMENT', message, 'Correct the value in your settings and try again.');

export interface ParseOptions {
  /**
   * `offered`, the default: only a region of `OFFERED_REGIONS`, for what
   * installs (the steps and the preflight). `any`: every well-formed
   * region, for what reads or removes (status, existing, uninstall), so an
   * install made elsewhere with the scripts of `infra/` can still be read
   * and removed.
   */
  regions?: 'offered' | 'any';
  /** The moment of the request, for the limits of `historyEnd`. Injectable for tests. */
  now?: Date;
}

export const isOfferedRegion = (region: string) => (OFFERED_REGIONS as readonly string[]).includes(region);

/**
 * Validate a spec from a JSON body or a query string (where numbers arrive
 * as strings). Missing fields take the defaults. Throws INVALID_ARGUMENT.
 */
export function parseInstallSpec(input: Record<string, unknown>, opts: ParseOptions = {}): InstallSpec {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  const projectId = str(input.projectId);
  const datasetId = str(input.datasetId) || INSTALL_DEFAULTS.datasetId;
  const location = str(input.location) || INSTALL_DEFAULTS.location;
  const region = str(input.region) || INSTALL_DEFAULTS.region;
  const schedule = str(input.schedule) || INSTALL_DEFAULTS.schedule;
  const datasetType = str(input.datasetType) || INSTALL_DEFAULTS.datasetType;
  const historyDays =
    input.historyDays === undefined || input.historyDays === '' ? INSTALL_DEFAULTS.historyDays : Number(input.historyDays);

  if (!projectId || !PROJECT_ID_RE.test(projectId)) {
    throw invalid('projectId must be a valid Google Cloud project ID (6 to 30 lowercase letters, digits or hyphens).');
  }
  if (!DATASET_ID_RE.test(datasetId)) throw invalid('datasetId may only contain letters, digits and underscores.');
  if (!LOCATION_RE.test(location)) throw invalid('location must be a BigQuery location such as US, EU or europe-west1.');
  if (!REGION_RE.test(region)) throw invalid('region must be a Google Cloud region such as us-central1.');
  if (opts.regions !== 'any' && !isOfferedRegion(region)) {
    throw invalid(`region must be one of the regions the app offers: ${OFFERED_REGIONS.join(', ')}. Got ${region}.`);
  }
  if (!Number.isInteger(historyDays) || historyDays < 1) {
    throw invalid('historyDays must be a whole number, 1 or more.');
  }
  if (schedule.split(/\s+/).length !== 5) {
    throw invalid('schedule must be a cron expression with five fields, for example 0 6 * * *.');
  }
  if (!isDatasetType(datasetType)) throw invalid(`datasetType must be one of: ${DATASET_TYPES.join(', ')}.`);
  const dailyRefresh = parseDailyRefresh(input.dailyRefresh);
  const now = opts.now ?? new Date();
  const historyEnd = parseHistoryEnd(input.historyEnd, { dailyRefresh, now });
  // The first day is checked with and without `historyEnd` (api.md v2.2).
  checkHistoryFirstDay({ historyDays, historyEnd, now });
  const installId = parseInstallId(input.installId);
  return { projectId, datasetId, location, region, historyDays, schedule, datasetType, dailyRefresh, historyEnd, installId };
}

/** Absent, empty or null: an install made before v2.0. Anything else must be an install number. */
export function parseInstallId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const id = typeof value === 'string' ? value.trim() : '';
  if (!INSTALL_ID_RE.test(id)) throw invalid('installId must be 6 to 12 characters, digits and lowercase letters only.');
  return id;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of a moment, in UTC. */
export const utcDay = (moment: Date): string => moment.toISOString().slice(0, 10);

/** The day `days` after `day` (before it, when negative). Both `YYYY-MM-DD`, UTC. */
export const addDays = (day: string, days: number): string => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

/** The first day of a history of `historyDays` days that ends on `historyEnd`. */
export const historyStart = (historyEnd: string, historyDays: number): string => addDays(historyEnd, 1 - historyDays);

/** The number of days from 1970-01-01 to `day` (`YYYY-MM-DD`, UTC). Negative before it. */
const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

/** The earliest day `YYYY-MM-DD` can write, 0000-01-01, as a day number. */
const FIRST_WRITABLE_DAY = dayNumber('0000-01-01');

/**
 * The end of the history (api.md v1.16). Absent means yesterday when the
 * history runs. Never later than yesterday. With the daily refresh the end
 * cannot be chosen: an end in the past would leave days without data before
 * the first daily run, and no hole in the data is possible (the owner's
 * answer). The first day is checked after this, by `checkHistoryFirstDay`,
 * because it is checked without `historyEnd` too (api.md v2.2).
 */
function parseHistoryEnd(value: unknown, at: { dailyRefresh: boolean; now: Date }): string | null {
  if (value === undefined || value === null || value === '') return null;
  const day = typeof value === 'string' ? value.trim() : '';
  // A real day of the calendar: 2026-02-30 reads as a date to JavaScript, and is none.
  const real = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && utcDay(new Date(`${day}T00:00:00Z`)) === day;
  if (!real) throw invalid('historyEnd must be a day of the calendar written as YYYY-MM-DD, for example 2026-06-30.');
  if (at.dailyRefresh) {
    throw new ApiError(
      'INVALID_ARGUMENT',
      'The end of the history cannot be chosen together with the daily refresh.',
      'With the daily refresh the history ends yesterday, so that no day is left without data. To choose the end date, choose no daily refresh in your settings.',
    );
  }
  const yesterday = addDays(utcDay(at.now), -1);
  if (day > yesterday) throw invalid(`historyEnd is ${day}. The history cannot end later than yesterday, ${yesterday} (UTC).`);
  return day;
}

/**
 * The first day of the history is never earlier than `HISTORY_FIRST_DAY`
 * (api.md v2.2, D-78). It is checked with and without `historyEnd`: without
 * it the history ends yesterday (UTC), so the first day moves with the clock
 * while the earliest day stands still. Comes after the check of the end,
 * which is the order of the contract.
 */
function checkHistoryFirstDay(at: { historyDays: number; historyEnd: string | null; now: Date }): void {
  const yesterday = addDays(utcDay(at.now), -1);
  const last = at.historyEnd ?? yesterday;
  const ends = at.historyEnd ? `ends on ${at.historyEnd}` : `ends yesterday, ${yesterday} (UTC),`;
  // Counted in day numbers, not in dates: a `historyDays` of a billion would
  // make a date JavaScript cannot hold, and that must not be a crash.
  const longest = dayNumber(last) - dayNumber(HISTORY_FIRST_DAY) + 1;
  if (at.historyDays <= longest) return;
  const firstNumber = dayNumber(last) + 1 - at.historyDays;
  if (firstNumber < FIRST_WRITABLE_DAY) {
    // No day of the calendar can be written for a history this long, so the
    // refusal names the longest history instead of its first day. api.md v2.2
    // does not cover this case; no screen of the app can ask for it.
    throw invalid(
      `historyDays is ${at.historyDays}. A history that ${ends} can hold at most ${longest} days. It cannot begin earlier than ${HISTORY_FIRST_DAY}, the day GA4 was launched.`,
    );
  }
  const length = `${at.historyDays} ${at.historyDays === 1 ? 'day' : 'days'}`;
  throw invalid(
    `A history of ${length} that ${ends} begins on ${utcDay(new Date(firstNumber * DAY_MS))}. It cannot begin earlier than ${HISTORY_FIRST_DAY}, the day GA4 was launched.`,
  );
}

/**
 * A real boolean in a body, the words `true` or `false` in a query string.
 * Anything else is refused: a value read loosely must not decide whether a
 * schedule is installed.
 */
function parseDailyRefresh(value: unknown): boolean {
  if (value === undefined || value === '') return INSTALL_DEFAULTS.dailyRefresh;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw invalid('dailyRefresh must be true or false.');
}

// ---- Names and settings from the contracts --------------------------------

/** APIs enabled by `enable-apis` (api.md). */
export const REQUIRED_SERVICES = [
  'run.googleapis.com',
  'cloudscheduler.googleapis.com',
  'bigquery.googleapis.com',
  'iam.googleapis.com',
  'cloudresourcemanager.googleapis.com',
] as const;

/** The one API that only the daily schedule needs. */
export const SCHEDULER_SERVICE = 'cloudscheduler.googleapis.com';

/** The APIs an install needs: all of them, or all but Cloud Scheduler without the daily refresh (api.md v1.14). */
export const requiredServices = (dailyRefresh: boolean): readonly string[] =>
  dailyRefresh ? REQUIRED_SERVICES : REQUIRED_SERVICES.filter((s) => s !== SCHEDULER_SERVICE);

/**
 * The regions the app offers for the job and the schedule: the four of the
 * Guided choices and the list of the Pro page. `GET /api/install/existing`
 * looks in each of them when the request names no region.
 */
export const OFFERED_REGIONS = ['us-central1', 'europe-west1', 'europe-west3', 'asia-northeast1', 'australia-southeast1'] as const;

/** The name of the job and of the schedule of an install made before v2.0. */
export const JOB_ID_BEFORE_V2 = 'ga4synth-daily';
/** What the names of the job and of the schedule of every install begin with. */
export const JOB_ID_PREFIX = 'ga4synth-';
export const SERVICE_ACCOUNT_ID = 'ga4synth';
export const SERVICE_ACCOUNT_DISPLAY_NAME = 'Synthetic GA4 export generator';
export const PROJECT_ROLES = ['roles/bigquery.jobUser', 'roles/run.invoker'] as const;
export const DAILY_DAYS = 3;
export const DAILY_TIMEOUT_SECONDS = 30 * 60;
/**
 * The size of the Cloud Run job and how many days it makes at once (D-43).
 * A Cloud Run job stops at 8 vCPU, and above a fraction `--cpu` takes only
 * 1, 2, 4 or 8, so 8 is the ceiling. One worker holds one full day in
 * memory, about 344 MiB measured in DEP-6, so 16 GiB leaves room for the
 * eight. Cloud Run has no way to give one execution another size: the
 * overrides of a run carry arguments, environment, task count and timeout,
 * and nothing of CPU or memory. So the daily run of three days is charged
 * at this size too.
 */
export const JOB_MEMORY = '16Gi';
export const JOB_CPU = '8';
/** Days published at once, one process each (`publish --workers`, generator-cli.md). */
export const JOB_WORKERS = 8;
export const JOB_MAX_RETRIES = 1;

/**
 * Dataset ownership (D-19, api.md v1.6). The daily job replaces tables named
 * `events_YYYYMMDD`, and a real GA4 export dataset holds tables with exactly
 * those names. So the installer labels the datasets it creates, and never
 * writes into, or deletes, a dataset without that label.
 */
export const OWNERSHIP_LABEL_KEY = 'managed-by';
export const OWNERSHIP_LABEL_VALUE = 'ga4-fake-dataset-installer';
export const OWNERSHIP_LABELS: Readonly<Record<string, string>> = { [OWNERSHIP_LABEL_KEY]: OWNERSHIP_LABEL_VALUE };

/**
 * One type per dataset (api.md v1.11, found by QA-6). A dataset holds days
 * of one type only, so the installer writes the type on the datasets it
 * creates, in a second label.
 */
export const DATASET_TYPE_LABEL_KEY = 'dataset-type';

/**
 * What a dataset of the installer holds when it carries no type and holds
 * tables: it was filled before v1.11, by an install of that time.
 */
export const TYPE_BEFORE_V1_11: DatasetType = 'ecommerce';

/**
 * The daily refresh is a choice (api.md v1.14, D-31). Nothing is stored about
 * a visitor (D-7), so the choice is written on the Cloud Run job, as a label.
 * Without it, an install without a schedule could not be told from an
 * install that stopped before `create-schedule`.
 */
export const DAILY_REFRESH_LABEL_KEY = 'daily-refresh';
export const DAILY_REFRESH_ON = 'on';
export const DAILY_REFRESH_OFF = 'off';
export const dailyRefreshLabel = (dailyRefresh: boolean) => (dailyRefresh ? DAILY_REFRESH_ON : DAILY_REFRESH_OFF);

/**
 * The choice an existing job carries. Only `off` means no daily refresh: a
 * job without the label was installed before v1.14, when every install had
 * the schedule, and a value this app does not write is read the same way.
 */
export const dailyRefreshOf = (job: { labels?: Readonly<Record<string, string>> }): boolean =>
  job.labels?.[DAILY_REFRESH_LABEL_KEY] !== DAILY_REFRESH_OFF;

/** The labels of a dataset the installer creates: whose it is, and of which type. */
export const datasetLabels = (type: DatasetType): Record<string, string> => ({ ...OWNERSHIP_LABELS, [DATASET_TYPE_LABEL_KEY]: type });

export const serviceAccountEmail = (projectId: string) => `${SERVICE_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
/** What names the components of an install: where it lives, and its number. */
export type InstallName = Pick<InstallSpec, 'projectId' | 'region' | 'installId'>;

/** `ga4synth-<installId>`, the short name of the job and of the schedule. `ga4synth-daily` without a number. */
export const jobId = (spec: Pick<InstallSpec, 'installId'>) => (spec.installId === null ? JOB_ID_BEFORE_V2 : `${JOB_ID_PREFIX}${spec.installId}`);

/**
 * The install number a short name carries: null for `ga4synth-daily`.
 * Undefined when the name is not one this app gives.
 */
export function installIdOf(shortName: string): string | null | undefined {
  if (shortName === JOB_ID_BEFORE_V2) return null;
  const id = shortName.startsWith(JOB_ID_PREFIX) ? shortName.slice(JOB_ID_PREFIX.length) : '';
  return INSTALL_ID_RE.test(id) ? id : undefined;
}

export const jobName = (spec: InstallName) => `projects/${spec.projectId}/locations/${spec.region}/jobs/${jobId(spec)}`;
export const schedulerJobName = jobName;
export const schedulerTargetUri = (spec: InstallName) =>
  `https://${spec.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${spec.projectId}/jobs/${jobId(spec)}:run`;

/**
 * Cloud Run reports the latest execution as a short id ("ga4synth-daily-9rf5j"),
 * but executions.get needs the full resource name. Qualify it when needed.
 */
export function qualifyExecutionName(jobName: string, name: string): string {
  return name.includes('/') ? name : `${jobName}/executions/${name}`;
}

/** Where the image holds the configuration of each type of dataset (api.md v1.8). */
export const CONFIG_DIR = '/app/config';
export const configPaths = (type: DatasetType) => ({
  property: `${CONFIG_DIR}/${type}/property.yaml`,
  mixer: `${CONFIG_DIR}/${type}/mixer.yaml`,
});

/**
 * What a job installed before v1.8 produces. Its arguments name no
 * configuration, and the image of that time held the ecommerce one only.
 */
export const TYPE_BEFORE_V1_8: DatasetType = 'ecommerce';

/** `--property` and `--mixer` are global options of the generator: they come before the sub-command. */
export function publishArgs(spec: InstallSpec, days: number): string[] {
  const config = configPaths(spec.datasetType);
  return [
    '--property',
    config.property,
    '--mixer',
    config.mixer,
    'publish',
    '--dataset',
    `${spec.projectId}:${spec.datasetId}`,
    '--days',
    String(days),
    '--location',
    spec.location,
    '--workers',
    String(JOB_WORKERS),
  ];
}

/**
 * The arguments of the run that generates the history: those of the job,
 * with the days of the history, and with its last day when the request
 * names one (`--date`, generator-cli.md, command `publish`). Without
 * `--date` the generator ends on yesterday.
 */
export function historyArgs(spec: InstallSpec): string[] {
  const args = publishArgs(spec, spec.historyDays);
  if (spec.historyEnd === null) return args;
  const days = args.indexOf('--days');
  return [...args.slice(0, days), '--date', spec.historyEnd, ...args.slice(days)];
}

const argValue = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * Read back the dataset an existing job writes to from its container args,
 * which `publishArgs` writes as `--dataset <project>:<dataset>`. Null when
 * the args carry no such pair (a job we did not create).
 */
export function datasetFromArgs(args: readonly string[]): { projectId: string; datasetId: string } | null {
  const ref = argValue(args, '--dataset');
  if (!ref) return null;
  const colon = ref.indexOf(':');
  if (colon <= 0 || colon === ref.length - 1) return null;
  return { projectId: ref.slice(0, colon), datasetId: ref.slice(colon + 1) };
}

/**
 * Read back the type of dataset an existing job produces from the two
 * configuration paths `publishArgs` writes. A job that names no
 * configuration was installed before v1.8. Null when the paths are not a
 * pair this app writes (a job changed by hand).
 */
export function typeFromArgs(args: readonly string[]): DatasetType | null {
  if (!args.includes('--property') && !args.includes('--mixer')) return TYPE_BEFORE_V1_8;
  const property = argValue(args, '--property');
  const mixer = argValue(args, '--mixer');
  return DATASET_TYPES.find((t) => configPaths(t).property === property && configPaths(t).mixer === mixer) ?? null;
}

/**
 * The period a run was asked for, read back from its arguments. `end` is
 * null when the run names no date: it then ended on the day before it ran.
 */
export function historyFromArgs(args: readonly string[]): { days: number | null; end: string | null } {
  const days = Number(argValue(args, '--days'));
  const end = argValue(args, '--date');
  return { days: Number.isInteger(days) && days > 0 ? days : null, end: end !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null };
}

/** The BigQuery location an existing job loads into, from its `--location` argument, or null. */
export const locationFromArgs = (args: readonly string[]): string | null => argValue(args, '--location') ?? null;

/**
 * How an existing job's dataset is shown to the visitor: the bare id when it
 * lives in the same project, `project:dataset` otherwise.
 */
export function existingDatasetName(existing: { projectId: string; datasetId: string }, projectId: string): string {
  return existing.projectId === projectId ? existing.datasetId : `${existing.projectId}:${existing.datasetId}`;
}

/**
 * `historyDays * 10 seconds + 10 minutes`, capped at 24 hours (generator-cli.md,
 * API-32). Sized for eight workers (D-43): DEP-10 measured a 90-day history in
 * 317 s, and this gives it 1,500 s. The fixed 10 minutes cover provisioning.
 */
export function backfillTimeoutSeconds(historyDays: number): number {
  return Math.min(historyDays * 10 + 10 * 60, 24 * 60 * 60);
}

// ---- What the gateway must offer ------------------------------------------

export interface DatasetInfo {
  location: string;
  etag?: string;
  access: DatasetAccessEntry[];
  labels: Record<string, string>;
}

/** One dataset of a list: what BigQuery tells without reading the dataset itself. */
export interface LabelledDataset {
  datasetId: string;
  location: string;
  labels: Record<string, string>;
}

/** The type written on the dataset, or null when it carries none that this app writes. */
export function labelledType(dataset: { labels: Record<string, string> }): DatasetType | null {
  const value = dataset.labels[DATASET_TYPE_LABEL_KEY];
  return value !== undefined && isDatasetType(value) ? value : null;
}

/**
 * The type of a dataset of the installer, read the same way everywhere: the
 * label when there is one; without it, `ecommerce` when the dataset holds
 * `events_*` tables, and none yet when it is empty.
 */
export function datasetTypeOf(dataset: { labels: Record<string, string> }, eventsTables: number): DatasetType | null {
  return labelledType(dataset) ?? (eventsTables > 0 ? TYPE_BEFORE_V1_11 : null);
}

/** Whether the installer created this dataset (D-19). */
export const isOwnedDataset = (dataset: Pick<DatasetInfo, 'labels'>) => dataset.labels[OWNERSHIP_LABEL_KEY] === OWNERSHIP_LABEL_VALUE;

export interface ProjectInfo {
  projectId: string;
  displayName: string;
  /** False for a project that is scheduled for deletion. */
  active: boolean;
}

/** The effective organisation policy for one constraint, reduced to what the preflight reads. */
export interface OrgPolicyInfo {
  /** Boolean constraints: the rule is enforced. */
  enforced: boolean;
  /** List constraints. */
  allowAll: boolean;
  denyAll: boolean;
  allowedValues: string[];
  deniedValues: string[];
}

export type ImageState = 'readable' | 'missing' | 'private';
export interface DatasetAccessEntry {
  role?: string;
  userByEmail?: string;
  [other: string]: unknown;
}

export interface IamBinding {
  role: string;
  members: string[];
  condition?: unknown;
}
export interface IamPolicy {
  bindings: IamBinding[];
  etag?: string;
  version?: number;
}

export interface JobSpec {
  image: string;
  args: string[];
  serviceAccountEmail: string;
  timeoutSeconds: number;
  /** The labels of the job. The installer writes one, `daily-refresh`, and keeps the others. */
  labels: Record<string, string>;
}
export interface JobInfo {
  /** `succeeded`, `failed`, or `pending` while Cloud Run is still reconciling. */
  condition: 'succeeded' | 'failed' | 'pending';
  latestExecution: string | null;
  /** What the job currently runs, so deploy-job can skip a rewrite that changes nothing. */
  spec: JobSpec;
}
/** A job of a list: the job, and its full name. */
export interface NamedJob {
  name: string;
  job: JobInfo;
}
export interface ExecutionInfo {
  state: 'running' | 'succeeded' | 'failed';
  /** The arguments the run was started with, those of the history included. Google keeps them with the run. */
  args: string[];
}
export interface ScheduleSpec {
  schedule: string;
  uri: string;
  serviceAccountEmail: string;
}
export interface LongRunning {
  done: boolean;
  operation: string;
}

/** One method per Google call. Every method is given the visitor's access token. */
export interface CloudGateway {
  /** Which of `serviceIds` are enabled on the project. */
  enabledServices(token: string, projectId: string, serviceIds: readonly string[]): Promise<Set<string>>;
  enableServices(token: string, projectId: string, serviceIds: readonly string[]): Promise<LongRunning>;

  getDataset(token: string, projectId: string, datasetId: string): Promise<DatasetInfo | null>;
  createDataset(token: string, projectId: string, datasetId: string, location: string, labels: Readonly<Record<string, string>>): Promise<void>;
  setDatasetAccess(token: string, projectId: string, datasetId: string, access: DatasetAccessEntry[], etag?: string): Promise<void>;
  /** Writes the whole set of labels of the dataset. With the etag, a change made elsewhere since the read is refused by Google. */
  setDatasetLabels(token: string, projectId: string, datasetId: string, labels: Readonly<Record<string, string>>, etag?: string): Promise<void>;
  /** Names of the `events_*` tables in the dataset, or null when the dataset is missing. */
  listEventsTables(token: string, projectId: string, datasetId: string): Promise<string[] | null>;
  /**
   * Every dataset of the project the visitor can see, whoever created it,
   * with its labels. Hidden datasets are not asked for (api.md v1.15).
   */
  listDatasets(token: string, projectId: string): Promise<LabelledDataset[]>;

  serviceAccountExists(token: string, projectId: string, email: string): Promise<boolean>;
  createServiceAccount(token: string, projectId: string, accountId: string, displayName: string): Promise<void>;
  getProjectIamPolicy(token: string, projectId: string): Promise<IamPolicy>;
  setProjectIamPolicy(token: string, projectId: string, policy: IamPolicy): Promise<void>;

  getJob(token: string, name: string): Promise<JobInfo | null>;
  /** Every Cloud Run job of the project in one region, under its full name (api.md v2.0). */
  listJobs(token: string, projectId: string, region: string): Promise<NamedJob[]>;
  createJob(token: string, name: string, job: JobSpec): Promise<LongRunning>;
  updateJob(token: string, name: string, job: JobSpec): Promise<LongRunning>;
  runJob(token: string, name: string, args: string[], timeoutSeconds: number): Promise<void>;
  getExecution(token: string, name: string): Promise<ExecutionInfo | null>;

  getSchedule(token: string, name: string): Promise<ScheduleSpec | null>;
  createSchedule(token: string, name: string, schedule: ScheduleSpec): Promise<void>;
  updateSchedule(token: string, name: string, schedule: ScheduleSpec): Promise<void>;

  // Uninstall (api.md v1.4). Each resolves when the resource was already gone.
  deleteSchedule(token: string, name: string): Promise<void>;
  /** Starts the deletion. Cloud Run finishes it a little later; poll `getJob` until it answers null. */
  deleteJob(token: string, name: string): Promise<void>;
  deleteServiceAccount(token: string, projectId: string, email: string): Promise<void>;
  /** Deletes the dataset and every table in it. */
  deleteDataset(token: string, projectId: string, datasetId: string): Promise<void>;

  // Preflight (api.md v1.5). All read-only.
  /** Null when Google says the project does not exist. No access at all is a PERMISSION_DENIED error. */
  getProject(token: string, projectId: string): Promise<ProjectInfo | null>;
  billingEnabled(token: string, projectId: string): Promise<boolean>;
  /** The subset of `permissions` the visitor holds on the project. */
  testPermissions(token: string, projectId: string, permissions: readonly string[]): Promise<string[]>;
  /** Null when no policy is set for the constraint. */
  getOrgPolicy(token: string, projectId: string, constraint: string): Promise<OrgPolicyInfo | null>;
  /** Anonymous read of our generator image, as the visitor's Cloud Run job will do it. No token. */
  imageState(image: string): Promise<ImageState>;
}

// ---- Steps -----------------------------------------------------------------

/** `skipped` is present, and true, only when `create-schedule` created nothing because the install has no daily refresh (api.md v1.14). */
export type StepResult = { step: StepName; state: 'done'; skipped?: true } | { step: StepName; state: 'running'; operation: string };

export interface InstallOptions {
  /** Full generator image name, from infra/IMAGE (D-10). */
  generatorImage: string;
  /** Injectable wait between two tries of a grant, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in milliseconds, for tests. */
  now?: () => number;
}

/** The labels of an existing job are kept. Only the one of the installer is written. */
function jobSpec(spec: InstallSpec, image: string, existing: JobInfo | null): JobSpec {
  return {
    image,
    args: publishArgs(spec, DAILY_DAYS),
    serviceAccountEmail: serviceAccountEmail(spec.projectId),
    timeoutSeconds: DAILY_TIMEOUT_SECONDS,
    labels: { ...(existing?.spec.labels ?? {}), [DAILY_REFRESH_LABEL_KEY]: dailyRefreshLabel(spec.dailyRefresh) },
  };
}

function scheduleSpec(spec: InstallSpec): ScheduleSpec {
  return { schedule: spec.schedule, uri: schedulerTargetUri(spec), serviceAccountEmail: serviceAccountEmail(spec.projectId) };
}

/**
 * The choice of the daily refresh is compared as it reads, not as it is
 * written: a job without the label reads as `on`, so an install made before
 * v1.14 is not rewritten for the label alone.
 */
const sameJob = (a: JobSpec, b: JobSpec) =>
  a.image === b.image &&
  a.serviceAccountEmail === b.serviceAccountEmail &&
  a.timeoutSeconds === b.timeoutSeconds &&
  dailyRefreshOf(a) === dailyRefreshOf(b) &&
  a.args.length === b.args.length &&
  a.args.every((x, i) => x === b.args[i]);

const sameSchedule = (a: ScheduleSpec, b: ScheduleSpec) =>
  a.schedule === b.schedule && a.uri === b.uri && a.serviceAccountEmail === b.serviceAccountEmail;

// ---- The look at a name before a component is created ------------------------

/** The components whose name comes from the install number (api.md v2.0). */
export type TakenName = 'job' | 'schedule';

/**
 * Why a job under the name of this install is not the job of this install,
 * or null when it is. It is, when it writes into the dataset of the
 * request, with the type and the daily refresh of the request. Anything
 * else under that name belongs to something else: the name is taken.
 */
export function jobTakenBy(job: JobInfo, spec: InstallSpec): string | null {
  const target = datasetFromArgs(job.spec.args);
  if (!target) return 'it was not created by this installer';
  if (target.projectId !== spec.projectId || target.datasetId !== spec.datasetId) {
    return `it writes to dataset ${existingDatasetName(target, spec.projectId)}, not ${spec.datasetId}`;
  }
  const type = typeFromArgs(job.spec.args);
  if (type === null) return 'it does not run a configuration of this installer';
  if (type !== spec.datasetType) return `it makes data of type ${typeName(type)}, not ${typeName(spec.datasetType)}`;
  const dailyRefresh = dailyRefreshOf(job.spec);
  if (dailyRefresh !== spec.dailyRefresh) return dailyRefresh ? 'it was installed with the daily refresh, not without' : 'it was installed without the daily refresh, not with';
  return null;
}

/** The schedule of this install starts the job of this install. */
export const scheduleIsOurs = (schedule: ScheduleSpec, spec: InstallName) => schedule.uri === schedulerTargetUri(spec);

export const jobTakenMessage = (spec: InstallName, why: string) =>
  `The name ${jobId(spec)} is taken in project ${spec.projectId}, region ${spec.region}: a Cloud Run job of that name exists, and ${why}.`;
export const scheduleTakenMessage = (spec: InstallName) =>
  `The name ${jobId(spec)} is taken in project ${spec.projectId}, region ${spec.region}: a schedule of that name exists, and it does not start the job of this install.`;
/** The web app draws another install number and goes on. A visitor who reads this does the same by starting again. */
export const TAKEN_HINT = 'Start the install again. It takes names that are free, and changes nothing of what exists.';

/** Throws CONFLICT with `taken` when the job under the name of this install belongs to something else. */
function assertJobIsOurs(job: JobInfo, spec: InstallSpec): void {
  const why = jobTakenBy(job, spec);
  if (why === null) return;
  throw new ApiError('CONFLICT', jobTakenMessage(spec, why), TAKEN_HINT, { link: consoleLinks.runJobs(spec.projectId), taken: ['job'] });
}

export const notOursMessage = (spec: Pick<InstallSpec, 'projectId' | 'datasetId'>) =>
  `Dataset ${spec.datasetId} already exists in project ${spec.projectId} and was not created by this installer. Installing would overwrite tables named events_YYYYMMDD in it.`;
export const NOT_OURS_HINT = 'Start the install again to get another dataset name, or set another name in the Pro settings.';

export const wrongLocationMessage = (spec: Pick<InstallSpec, 'projectId' | 'datasetId' | 'location'>, actual: string) =>
  `Dataset ${spec.datasetId} already exists in ${spec.projectId} but in location ${actual}, not ${spec.location}.`;
export const wrongLocationHint = (actual: string) => `In your settings, choose ${actual} as the location, or use another dataset name.`;

/** Dataset ownership (D-19): refuse a dataset the installer did not create. Throws CONFLICT. */
function assertOwnedDataset(dataset: DatasetInfo, spec: InstallSpec): void {
  if (isOwnedDataset(dataset)) return;
  throw new ApiError('CONFLICT', notOursMessage(spec), NOT_OURS_HINT, { link: consoleLinks.bigquery(spec.projectId) });
}

export const otherTypeMessage = (spec: Pick<InstallSpec, 'projectId' | 'datasetId'>, type: DatasetType) =>
  `Dataset ${spec.datasetId} in project ${spec.projectId} holds data of type ${typeName(type)}.`;
export const OTHER_TYPE_HINT = 'Start the install again to get another dataset name, or set another name in the Pro settings.';

export const typeNotSetMessage = (spec: Pick<InstallSpec, 'projectId' | 'datasetId' | 'datasetType'>) =>
  `Dataset ${spec.datasetId} in project ${spec.projectId} is not set to type ${typeName(spec.datasetType)} yet.`;
export const START_AGAIN_HINT = 'Start the install again. It creates what is missing and keeps what exists.';

export const tablesNotSeenMessage = (spec: Pick<InstallSpec, 'projectId' | 'datasetId'>) =>
  `Could not see whether dataset ${spec.datasetId} in project ${spec.projectId} holds tables, so its type could not be checked.`;
export const tablesNotSeenHint = (spec: Pick<InstallSpec, 'datasetId'>) =>
  `Ask a project Owner to give you the role BigQuery Data Viewer on dataset ${spec.datasetId}, or start the install again to get another dataset name.`;

/**
 * The list of the `events_*` tables of the dataset of a request. A step
 * that needs it twice asks Google once and hands the same list on.
 */
export type TableList = () => Promise<string[] | null>;

/**
 * How many `events_*` tables the dataset holds. Reading the tables of a
 * dataset is granted by the dataset's own access list, not by a role on the
 * project, so a visitor may be refused here who could read the dataset
 * itself. The refusal is answered in words of our own: the permissions of
 * the step are not what is missing.
 */
export async function countEventsTables(
  cloud: CloudGateway,
  token: string,
  spec: Pick<InstallSpec, 'projectId' | 'datasetId'>,
  list: TableList = () => cloud.listEventsTables(token, spec.projectId, spec.datasetId),
): Promise<number> {
  try {
    return ((await list()) ?? []).length;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PERMISSION_DENIED' && !isApiNotEnabled(err)) {
      throw new ApiError('PERMISSION_DENIED', tablesNotSeenMessage(spec), tablesNotSeenHint(spec), { link: consoleLinks.bigquery(spec.projectId) });
    }
    throw err;
  }
}

// ---- No hole in the data ------------------------------------------------------

/** A run of days, both ends included. `YYYY-MM-DD`, UTC. */
export interface Period {
  first: string;
  last: string;
}

/** The period a request asks for. Without an end date it ends yesterday, as the generator does. */
export function periodAsked(spec: Pick<InstallSpec, 'historyDays' | 'historyEnd'>, today: string): Period {
  const last = spec.historyEnd ?? addDays(today, -1);
  return { first: historyStart(last, spec.historyDays), last };
}

/** The days the dataset holds, read from the names of its day tables: `YYYY-MM-DD`, in order. */
export const daysHeld = (tables: readonly string[]): string[] => dayTables(tables).map((t) => `${t.slice(7, 11)}-${t.slice(11, 13)}-${t.slice(13, 15)}`);

/** From the first to the last day the dataset holds, read from the names of its day tables. Null when it holds none. */
export function periodHeld(tables: readonly string[]): Period | null {
  const days = daysHeld(tables);
  return days.length === 0 ? null : { first: days[0]!, last: days[days.length - 1]! };
}

/**
 * The runs of days between the first and the last day held that have no
 * table, in order (API-31). With one worker the generator made the days in
 * order, so a history that failed left a gap at its end only. With
 * `--workers 8` (D-43) it makes them in parallel and a failure leaves the
 * days it had finished, so a gap can sit in the middle of the days held.
 */
export function gapsHeld(tables: readonly string[]): Period[] {
  const days = daysHeld(tables);
  const gaps: Period[] = [];
  for (let i = 1; i < days.length; i++) {
    const first = addDays(days[i - 1]!, 1);
    if (first < days[i]!) gaps.push({ first, last: addDays(days[i]!, -1) });
  }
  return gaps;
}

/** What `asked` leaves of `gaps`: the days of each that it does not cover, in order. */
export function gapsLeft(gaps: readonly Period[], asked: Period): Period[] {
  const left: Period[] = [];
  for (const gap of gaps) {
    if (gap.first < asked.first) left.push({ first: gap.first, last: gap.last < asked.first ? gap.last : addDays(asked.first, -1) });
    if (gap.last > asked.last) left.push({ first: gap.first > asked.last ? gap.first : addDays(asked.last, 1), last: gap.last });
  }
  return left;
}

const daysIn = (period: Period): number => Math.round((Date.parse(`${period.last}T00:00:00Z`) - Date.parse(`${period.first}T00:00:00Z`)) / DAY_MS) + 1;
const periodWords = (period: Period): string => (period.first === period.last ? period.first : `${period.first} to ${period.last}`);

/** The gaps as words: up to three runs, such as "2026-01-05, 2026-01-09 to 2026-01-11 and 4 more days". */
export function gapWords(gaps: readonly Period[]): string {
  const shown = gaps.slice(0, 3).map(periodWords);
  const rest = gaps.slice(3).reduce((n, gap) => n + daysIn(gap), 0);
  if (rest > 0) shown.push(`${rest} more ${rest === 1 ? 'day' : 'days'}`);
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * Whether `asked` overlaps `held` or touches it: it begins on the day after
 * the last day held at the latest, and ends on the day before the first day
 * held at the earliest. Then no day lies between them.
 */
export const leavesNoHole = (held: Period, asked: Period): boolean => asked.first <= addDays(held.last, 1) && asked.last >= addDays(held.first, -1);

export const holeMessage = (spec: Pick<InstallSpec, 'projectId' | 'datasetId'>, held: Period, asked: Period) =>
  `Dataset ${spec.datasetId} in project ${spec.projectId} holds the days from ${held.first} to ${held.last}. A history from ${asked.first} to ${asked.last} would leave the days between them without data.`;
export const holeHint = (held: Period) =>
  `In your settings, choose a period that touches or overlaps these days: it begins on ${addDays(held.last, 1)} or earlier, and ends on ${addDays(held.first, -1)} or later.`;

const theseDays = (left: readonly Period[]): string => (left.length === 1 && left[0]!.first === left[0]!.last ? 'that day' : 'those days');
/** For a gap that is already there (API-31). `left` is what the request would leave of it, never empty. */
export const gapMessage = (spec: Pick<InstallSpec, 'projectId' | 'datasetId'>, held: Period, left: readonly Period[], asked: Period) =>
  `Dataset ${spec.datasetId} in project ${spec.projectId} holds the days from ${held.first} to ${held.last}, but has no data for ${gapWords(left)}. A history from ${asked.first} to ${asked.last} would leave ${theseDays(left)} without data.`;
export const gapHint = (left: readonly Period[]) =>
  `In your settings, choose a period that covers ${theseDays(left)}: it begins on ${left[0]!.first} or earlier, and ends on ${left[left.length - 1]!.last} or later. Or delete the dataset in BigQuery and start the install again: it makes the dataset again and keeps the rest.`;

export const daysNotSeenMessage = (spec: Pick<InstallSpec, 'projectId' | 'datasetId'>) =>
  `Could not see which days dataset ${spec.datasetId} in project ${spec.projectId} holds, so the period of the history could not be checked.`;
export const daysNotSeenHint = (spec: Pick<InstallSpec, 'datasetId'>) =>
  `Ask a project Owner to give you the role BigQuery Data Viewer on dataset ${spec.datasetId}, then try again.`;

/**
 * No hole in the data is possible (D-34, the owner's answer, API-24). A
 * history that neither touches nor overlaps the days the dataset holds would
 * leave days without data between them, so it is refused before it starts.
 * So is a history that leaves a gap the dataset already has in the middle of
 * its days (API-31): only a period that covers every missing day is let
 * through, and heals it. A dataset that holds no day accepts every period.
 * Throws INVALID_ARGUMENT.
 */
async function assertNoHole(spec: InstallSpec, today: string, list: TableList): Promise<void> {
  let tables: string[] | null;
  try {
    tables = await list();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PERMISSION_DENIED' && !isApiNotEnabled(err)) {
      throw new ApiError('PERMISSION_DENIED', daysNotSeenMessage(spec), daysNotSeenHint(spec), { link: consoleLinks.bigquery(spec.projectId) });
    }
    throw err;
  }
  const held = periodHeld(tables ?? []);
  if (!held) return;
  const asked = periodAsked(spec, today);
  const left = gapsLeft(gapsHeld(tables ?? []), asked);
  if (left.length > 0) throw new ApiError('INVALID_ARGUMENT', gapMessage(spec, held, left, asked), gapHint(left), { link: consoleLinks.bigquery(spec.projectId) });
  if (leavesNoHole(held, asked)) return;
  throw new ApiError('INVALID_ARGUMENT', holeMessage(spec, held, asked), holeHint(held), { link: consoleLinks.bigquery(spec.projectId) });
}

/**
 * One type per dataset (api.md v1.11). Answers `ready` when the dataset is
 * of the type of the request, and `empty` when it holds no table and is not
 * set to that type. Throws CONFLICT when it holds tables of another type.
 *
 * A dataset that carries the type of the request costs no call. Any other
 * costs one list of its tables.
 */
export async function checkDatasetType(cloud: CloudGateway, token: string, spec: InstallSpec, dataset: DatasetInfo, list?: TableList): Promise<'ready' | 'empty'> {
  if (labelledType(dataset) === spec.datasetType) return 'ready';
  const tables = await countEventsTables(cloud, token, spec, list);
  if (tables === 0) return 'empty';
  const type = datasetTypeOf(dataset, tables)!;
  if (type === spec.datasetType) return 'ready';
  throw new ApiError('CONFLICT', otherTypeMessage(spec, type), OTHER_TYPE_HINT, { link: consoleLinks.bigquery(spec.projectId) });
}

/**
 * For the steps that make the job write to the dataset: it must be set to
 * the type of the request, which `create-dataset` does. So no order of
 * calls can put days of one type into a dataset that says another.
 */
async function requireDatasetOfType(cloud: CloudGateway, token: string, spec: InstallSpec, dataset: DatasetInfo, list?: TableList): Promise<void> {
  if ((await checkDatasetType(cloud, token, spec, dataset, list)) === 'ready') return;
  throw new ApiError('INVALID_ARGUMENT', typeNotSetMessage(spec), START_AGAIN_HINT, { link: consoleLinks.bigquery(spec.projectId) });
}

/**
 * For the steps that make the job write to the dataset: it must exist and be
 * ours, so that no order of calls can point the job at someone else's data.
 */
async function requireOwnedDataset(cloud: CloudGateway, token: string, spec: InstallSpec): Promise<DatasetInfo> {
  const dataset = await cloud.getDataset(token, spec.projectId, spec.datasetId);
  if (!dataset) {
    throw new ApiError(
      'INVALID_ARGUMENT',
      `Dataset ${spec.datasetId} does not exist in ${spec.projectId} yet.`,
      'Start the install again. It creates what is missing and keeps what exists.',
      { link: consoleLinks.bigquery(spec.projectId) },
    );
  }
  assertOwnedDataset(dataset, spec);
  return dataset;
}

// ---- The installs of a project, in every region ------------------------------

/**
 * How long the look at one region may take. The regions are asked at the
 * same time, so all of them together take about as long as the slowest one,
 * and never much longer than this.
 */
export const REGION_TIMEOUT_MS = 4000;

export interface RegionOptions {
  /** Injectable time limit for one region, for tests. */
  regionTimeoutMs?: number;
}

export type RegionOutcome<T> = { region: string; ok: true; value: T } | { region: string; ok: false; error: unknown };

/** Rejects when `work` takes longer than `ms`. The work itself is not stopped: it only reads. */
function withDeadline<T>(work: Promise<T>, ms: number, region: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ApiError('UPSTREAM_ERROR', `Google did not answer in time for region ${region}.`, 'Wait a moment and try again.')),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Ask every region at the same time, each within the time limit. Never
 * throws: a region that fails is an outcome like the others, so one region
 * cannot hide the rest.
 */
export async function lookInRegions<T>(regions: readonly string[], look: (region: string) => Promise<T>, opts: RegionOptions = {}): Promise<RegionOutcome<T>[]> {
  const timeout = opts.regionTimeoutMs ?? REGION_TIMEOUT_MS;
  const settled = await Promise.allSettled(regions.map((region) => withDeadline(look(region), timeout, region)));
  return settled.map((s, i): RegionOutcome<T> => {
    const region = regions[i]!;
    return s.status === 'fulfilled' ? { region, ok: true, value: s.value } : { region, ok: false, error: s.reason as unknown };
  });
}

/** The job of an install, and where it lives. */
export interface InstallJob {
  region: string;
  /** The number of the install, or null for an install made before v2.0. */
  installId: string | null;
  job: JobInfo;
  /** The dataset the job writes to. */
  target: { projectId: string; datasetId: string };
}

/**
 * The installs of one region (api.md v2.0): the jobs whose name is one this
 * app gives, `ga4synth-daily` or `ga4synth-<installId>`, and whose arguments
 * name a dataset. The install made before v2.0 comes first, the others in
 * the order of their numbers. A Cloud Run API that is not switched on reads
 * as "nothing there".
 */
export async function installsIn(cloud: CloudGateway, token: string, projectId: string, region: string): Promise<InstallJob[]> {
  const jobs = await lookup(() => cloud.listJobs(token, projectId, region), []);
  const found: InstallJob[] = [];
  for (const { name, job } of jobs) {
    const installId = installIdOf(name.slice(name.lastIndexOf('/') + 1));
    const target = datasetFromArgs(job.spec.args);
    if (installId !== undefined && target) found.push({ region, installId, job, target });
  }
  return found.sort((x, y) => (x.installId === null ? -1 : y.installId === null ? 1 : x.installId.localeCompare(y.installId)));
}

export interface InstallsFound {
  /** The installs found in the regions looked at, in the order of the regions. */
  installs: InstallJob[];
  /** The regions that could not be read. An install may be there. */
  notChecked: string[];
}

/**
 * Every install of the project in the offered regions. It refuses nothing
 * (api.md v2.0): it serves what reads or removes. A region that cannot be
 * read does not block: it is reported.
 */
export async function lookForInstalls(cloud: CloudGateway, token: string, projectId: string, regions: readonly string[], opts: RegionOptions = {}): Promise<InstallsFound> {
  const outcomes = await lookInRegions(regions, (region) => installsIn(cloud, token, projectId, region), opts);
  const installs: InstallJob[] = [];
  const notChecked: string[] = [];
  for (const o of outcomes) {
    if (o.ok) {
      installs.push(...o.value);
    } else if (o.error instanceof ApiError) {
      notChecked.push(o.region);
    } else {
      // Not an answer of Google: a fault on our side, which must not pass unseen.
      throw o.error;
    }
  }
  return { installs, notChecked };
}

/**
 * The steps that can run before Cloud Run is switched on in the project.
 * There, a refusal for that reason means no job could be looked for. The
 * steps from deploy-job on look again, with Cloud Run on.
 */
const STEPS_BEFORE_CLOUD_RUN: readonly StepName[] = ['enable-apis', 'create-dataset', 'create-service-account'];

/**
 * The look at the name of the job (api.md v2.0), asked first in every step,
 * before anything is created, so a name that is taken leaves nothing
 * behind. Returns the job of this install, or null. Throws CONFLICT.
 */
async function findJobOfThisInstall(cloud: CloudGateway, token: string, step: StepName, spec: InstallSpec): Promise<JobInfo | null> {
  let job: JobInfo | null;
  try {
    job = await cloud.getJob(token, jobName(spec));
  } catch (err) {
    if (isApiNotEnabled(err) && STEPS_BEFORE_CLOUD_RUN.includes(step)) return null;
    throw err;
  }
  if (job) assertJobIsOurs(job, spec);
  return job;
}

/** Whether the service account holds both project roles, in unconditional bindings. */
export function holdsProjectRoles(policy: IamPolicy, email: string): boolean {
  const member = `serviceAccount:${email}`;
  return PROJECT_ROLES.every((role) => policy.bindings.some((b) => b.role === role && !b.condition && b.members.includes(member)));
}

/** Whether the service account has its WRITER entry on the dataset. */
export const holdsDatasetAccess = (dataset: Pick<DatasetInfo, 'access'>, email: string) =>
  dataset.access.some((e) => e.role === 'WRITER' && e.userByEmail === email);

/** Add `member` to `role` (unconditional binding). Returns true when the policy changed. */
export function addBinding(policy: IamPolicy, role: string, member: string): boolean {
  const binding = policy.bindings.find((b) => b.role === role && !b.condition);
  if (binding) {
    if (binding.members.includes(member)) return false;
    binding.members.push(member);
    return true;
  }
  policy.bindings.push({ role, members: [member] });
  return true;
}

/**
 * Every step error has the same shape as a failed preflight check (api.md
 * v1.5): what happened in one sentence, which permission or setting is
 * involved, what to do next, and a console link when one exists.
 *
 * Errors the steps raise themselves already have that shape. Errors that
 * came from Google are rewritten here. For a refusal, Google is asked which
 * of the step's permissions the visitor lacks, so the message can name them.
 */
export async function explainStepError(
  cloud: CloudGateway,
  token: string,
  step: StepName,
  spec: InstallSpec,
  err: unknown,
): Promise<unknown> {
  if (!(err instanceof ApiError) || !err.upstream) return err;
  const { projectId } = spec;
  const action = STEP_ACTIONS[step];
  const google = err.upstream.text;

  if (err.upstream.aborted) {
    return new ApiError(
      'UPSTREAM_ERROR',
      `Google was still busy with an earlier change in ${projectId}, so the app could not ${action}. Nothing was created at this step.`,
      'Try again in a minute. The install continues where it stopped.',
      { link: STEP_LINKS[step](projectId), upstream: err.upstream },
    );
  }

  if (err.upstream.serviceDisabled) {
    return new ApiError(
      err.code,
      `Could not ${action} in ${projectId}, because a Google Cloud API it needs is not enabled yet. Google said: ${google}`,
      'This is not about your permissions. Google can take a few minutes to finish enabling an API. Wait a minute, then try again.',
      { link: consoleLinks.apis(projectId), upstream: err.upstream },
    );
  }

  if (err.upstream.rejected) {
    return new ApiError(
      'UPSTREAM_ERROR',
      `Google rejected a request of the app while trying to ${action} in ${projectId}. Google said: ${google}`,
      REJECTED_HINT,
      { link: STEP_LINKS[step](projectId), upstream: err.upstream, report: true },
    );
  }

  switch (err.code) {
    case 'PERMISSION_DENIED': {
      const needed = STEP_PERMISSIONS[step];
      let missing: string[] | undefined;
      try {
        const granted = new Set(await cloud.testPermissions(token, projectId, needed));
        missing = needed.filter((p) => !granted.has(p));
      } catch {
        // Could not ask. Fall back to naming what the step needs.
      }
      if (missing && missing.length > 0) {
        return new ApiError(
          'PERMISSION_DENIED',
          `You do not have permission to ${action} in ${projectId}. ${missing.length === 1 ? 'This permission is' : 'These permissions are'} missing: ${missing.join(', ')}.`,
          roleHint(missing),
          { link: consoleLinks.iam(projectId), missing, upstream: err.upstream },
        );
      }
      if (missing) {
        // The visitor holds every permission of the step, so something else refused.
        return new ApiError(
          'PERMISSION_DENIED',
          `Google refused to ${action} in ${projectId}, although you hold the permissions this step needs. Google said: ${google}`,
          'An organisation policy or a condition on your role may be the cause. Ask the administrator of your Google Cloud organisation, or pick another project.',
          { link: consoleLinks.orgPolicies(projectId), upstream: err.upstream },
        );
      }
      return new ApiError(
        'PERMISSION_DENIED',
        `You do not have permission to ${action} in ${projectId}. The step needs: ${needed.join(', ')}.`,
        roleHint(needed),
        { link: consoleLinks.iam(projectId), upstream: err.upstream },
      );
    }
    case 'UNAUTHENTICATED':
      return new ApiError(
        'UNAUTHENTICATED',
        `Google no longer accepts your sign-in, so the app could not ${action} in ${projectId}.`,
        'Sign in again, then try again. The install continues where it stopped.',
        { upstream: err.upstream },
      );
    case 'NOT_FOUND':
      return new ApiError(
        'NOT_FOUND',
        `Could not ${action}, because Google did not find what it needs in ${projectId}. Google said: ${google}`,
        'Check that the project still exists and that the earlier steps are done, then try again.',
        { link: STEP_LINKS[step](projectId), upstream: err.upstream },
      );
    case 'INVALID_ARGUMENT':
      // Only reached when Google's text names a setting of the install (errors.ts).
      return new ApiError(
        'INVALID_ARGUMENT',
        `Google rejected the settings while trying to ${action} in ${projectId}. Google said: ${google}`,
        'Check the region, the location and the schedule in your settings, and try again.',
        { link: STEP_LINKS[step](projectId), upstream: err.upstream },
      );
    case 'BILLING_DISABLED':
      return new ApiError(err.code, err.message, err.hint, { link: consoleLinks.billing(projectId), upstream: err.upstream, report: err.report });
    default:
      return new ApiError(
        err.code,
        `Google returned an error while trying to ${action} in ${projectId}. Google said: ${google}`,
        'This is usually temporary. Wait a minute, then try again.',
        { link: STEP_LINKS[step](projectId), upstream: err.upstream },
      );
  }
}

export async function runStep(
  cloud: CloudGateway,
  token: string,
  step: StepName,
  spec: InstallSpec,
  opts: InstallOptions,
): Promise<StepResult> {
  try {
    return await runStepUnexplained(cloud, token, step, spec, opts);
  } catch (err) {
    throw await explainStepError(cloud, token, step, spec, err);
  }
}

async function runStepUnexplained(
  cloud: CloudGateway,
  token: string,
  step: StepName,
  spec: InstallSpec,
  opts: InstallOptions,
): Promise<StepResult> {
  const { projectId, datasetId } = spec;
  const sa = serviceAccountEmail(projectId);
  const startedAt = (opts.now ?? Date.now)();

  // The name of the job is looked at first, whatever the step. No other
  // install of the project is looked for: each has names of its own.
  const job = await findJobOfThisInstall(cloud, token, step, spec);

  const done: StepResult = { step, state: 'done' };
  const longRunning = (op: LongRunning): StepResult => (op.done ? done : { step, state: 'running', operation: op.operation });

  switch (step) {
    case 'enable-apis': {
      // Without the daily refresh, Cloud Scheduler is left as it is.
      const needed = requiredServices(spec.dailyRefresh);
      const enabled = await cloud.enabledServices(token, projectId, needed);
      const missing = needed.filter((s) => !enabled.has(s));
      if (missing.length === 0) return done;
      return longRunning(await cloud.enableServices(token, projectId, missing));
    }

    case 'create-dataset': {
      const existing = await cloud.getDataset(token, projectId, datasetId);
      if (existing) {
        assertOwnedDataset(existing, spec);
        if (existing.location.toUpperCase() !== spec.location.toUpperCase()) {
          throw new ApiError('INVALID_ARGUMENT', wrongLocationMessage(spec, existing.location), wrongLocationHint(existing.location), {
            link: consoleLinks.bigquery(projectId),
          });
        }
        if ((await checkDatasetType(cloud, token, spec, existing)) === 'empty') {
          // An empty dataset takes the type of the request. The other labels
          // are kept, and the etag makes Google refuse the write if the
          // dataset changed since it was read.
          await cloud.setDatasetLabels(token, projectId, datasetId, { ...existing.labels, [DATASET_TYPE_LABEL_KEY]: spec.datasetType }, existing.etag);
        }
        return done;
      }
      await cloud.createDataset(token, projectId, datasetId, spec.location, datasetLabels(spec.datasetType));
      return done;
    }

    case 'create-service-account': {
      // Checked before anything is created: the account gets WRITER on the
      // dataset, so the dataset must exist, be ours (D-19) and of this type.
      await requireDatasetOfType(cloud, token, spec, await requireOwnedDataset(cloud, token, spec));

      if (!(await cloud.serviceAccountExists(token, projectId, sa))) {
        await cloud.createServiceAccount(token, projectId, SERVICE_ACCOUNT_ID, SERVICE_ACCOUNT_DISPLAY_NAME);
      }

      // Google needs some seconds before a new account can be named in a
      // grant. Both grants are tried again while it says so.
      // Counted from the beginning of the step, the look at the regions included.
      const grant = accountGrantRetry(sa, projectId, { ...opts, startedAt });

      // Project roles: read-modify-write, keeping the etag so a concurrent
      // change elsewhere makes Google reject ours instead of silently losing it.
      await grant(async () => {
        const policy = await cloud.getProjectIamPolicy(token, projectId);
        let changed = false;
        for (const role of PROJECT_ROLES) changed = addBinding(policy, role, `serviceAccount:${sa}`) || changed;
        if (changed) await cloud.setProjectIamPolicy(token, projectId, policy);
      });

      // WRITER on the dataset only (never project-wide data access).
      await grant(async () => {
        const dataset = await requireOwnedDataset(cloud, token, spec);
        if (!holdsDatasetAccess(dataset, sa)) {
          await cloud.setDatasetAccess(token, projectId, datasetId, [...dataset.access, { role: 'WRITER', userByEmail: sa }], dataset.etag);
        }
      });
      return done;
    }

    case 'deploy-job': {
      const name = jobName(spec);
      await requireDatasetOfType(cloud, token, spec, await requireOwnedDataset(cloud, token, spec));
      const wanted = jobSpec(spec, opts.generatorImage, job);
      if (job && sameJob(job.spec, wanted)) {
        // Nothing to change. A rewrite would only create a new job generation.
        return job.condition === 'pending' ? { step, state: 'running', operation: name } : done;
      }
      const op = job ? await cloud.updateJob(token, name, wanted) : await cloud.createJob(token, name, wanted);
      return longRunning(op);
    }

    case 'create-schedule': {
      // Without the daily refresh nothing is created, and nothing is read: a
      // schedule that exists is never removed, paused or changed (api.md
      // v1.14), and Cloud Scheduler may not be switched on.
      if (!spec.dailyRefresh) return { ...done, skipped: true };
      const name = schedulerJobName(spec);
      const wanted = scheduleSpec(spec);
      const existing = await cloud.getSchedule(token, name);
      if (!existing) {
        await cloud.createSchedule(token, name, wanted);
        return done;
      }
      // A schedule of that name that starts something else is not ours to change.
      if (!scheduleIsOurs(existing, spec)) {
        throw new ApiError('CONFLICT', scheduleTakenMessage(spec), TAKEN_HINT, { link: consoleLinks.scheduler(projectId), taken: ['schedule'] });
      }
      if (!sameSchedule(existing, wanted)) await cloud.updateSchedule(token, name, wanted);
      return done;
    }

    case 'run-backfill': {
      const name = jobName(spec);
      if (!job) {
        // A dataset that does not exist, or that is not ours, is refused in
        // the same words with or without a job (D-19). So is a dataset that
        // holds days of another type.
        const dataset = await requireOwnedDataset(cloud, token, spec);
        await checkDatasetType(cloud, token, spec, dataset);
        throw new ApiError('NOT_FOUND', `The Cloud Run job ${jobId(spec)} does not exist in ${projectId} yet.`, 'Start the install again. It creates what is missing and keeps what exists.', {
          link: consoleLinks.runJobs(projectId),
        });
      }
      // One list of the tables serves the type of the dataset and the days it holds.
      let listed: Promise<string[] | null> | undefined;
      const tables: TableList = () => (listed ??= cloud.listEventsTables(token, projectId, datasetId));
      await requireDatasetOfType(cloud, token, spec, await requireOwnedDataset(cloud, token, spec), tables);
      if (job.latestExecution) {
        const latest = await cloud.getExecution(token, job.latestExecution);
        // Idempotent: a backfill that is already running is not started twice.
        if (latest?.state === 'running') return done;
      }
      await assertNoHole(spec, utcDay(new Date(startedAt)), tables);
      await cloud.runJob(token, name, historyArgs(spec), backfillTimeoutSeconds(spec.historyDays));
      return done;
    }
  }
}

// ---- Status ----------------------------------------------------------------

export type StepStatus = 'done' | 'missing' | 'error';
export interface InstallStatus {
  apisEnabled: StepStatus;
  dataset: StepStatus;
  serviceAccount: StepStatus;
  job: StepStatus;
  schedule: StepStatus;
  backfill: { state: 'none' | 'running' | 'succeeded' | 'failed' };
  tables: { count: number; first: string | null; last: string | null };
  /** The dataset the existing job writes to, or null when there is no job (api.md v1.3, D-12). */
  existingDataset: string | null;
  /** The type of dataset the existing job produces, or null when there is no job (api.md v1.8). */
  existingType: DatasetType | null;
  /**
   * The choice of the daily refresh the existing job carries, or null when
   * there is no job (api.md v1.14). With `false`, an install is complete
   * without the schedule.
   */
  dailyRefresh: boolean | null;
  /**
   * The period of the history (api.md v1.16), read from the arguments of the
   * latest run of the job. Nothing is stored, so this is all that can be
   * known. Both are null when there is no job or no run, and for an install
   * with the daily refresh, whose latest run is soon a daily one.
   * `historyEnd` is also null when the run named no date: the history then
   * ended on the day before it ran.
   */
  historyDays: number | null;
  historyEnd: string | null;
}

/**
 * `dailyRefresh` is the choice of the request. It counts only while no job
 * exists: it then says which APIs the install needs. Once the job exists,
 * its label speaks.
 */
export type StatusQuery = Pick<InstallSpec, 'projectId' | 'datasetId' | 'region' | 'installId'> & Partial<Pick<InstallSpec, 'dailyRefresh'>>;

/**
 * One lookup of the status. A project where the API behind the lookup is
 * not switched on yet answers with a refusal. Nothing can be seen there, so
 * the row reads as missing and the install may start: `enable-apis` switches
 * the API on and the steps after it look again.
 */
export async function lookup<T>(fn: () => Promise<T>, whenSwitchedOff: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isApiNotEnabled(err)) return whenSwitchedOff;
    throw err;
  }
}

/**
 * The schedule, for the status and for `existing`. An install without the
 * daily refresh asks no permission of Cloud Scheduler from the visitor
 * (api.md v1.14), so there a refusal to read the schedule is not an error:
 * nothing could be seen, and the install does not need it.
 */
export async function lookupSchedule(
  cloud: CloudGateway,
  token: string,
  at: InstallName,
  dailyRefresh: boolean,
): Promise<ScheduleSpec | null> {
  try {
    return await lookup(() => cloud.getSchedule(token, schedulerJobName(at)), null);
  } catch (err) {
    if (!dailyRefresh && err instanceof ApiError && err.code === 'PERMISSION_DENIED') return null;
    throw err;
  }
}

/** The day tables among `tables`, `events_YYYYMMDD`, in order. Intraday tables do not count. */
export const dayTables = (tables: readonly string[]): string[] => tables.filter((t) => /^events_\d{8}$/.test(t)).sort();

/**
 * Everything is derived from the project. The lookups run in parallel,
 * except the schedule, which is read once the job has said whether the
 * install has the daily refresh.
 */
export async function getStatus(cloud: CloudGateway, token: string, q: StatusQuery): Promise<InstallStatus> {
  const { projectId, datasetId } = q;
  const sa = serviceAccountEmail(projectId);

  const jobRead = lookup(() => cloud.getJob(token, jobName(q)), null);
  const scheduleRead = jobRead.then((found) => {
    const choice = found && datasetFromArgs(found.spec.args) ? dailyRefreshOf(found.spec) : (q.dailyRefresh ?? INSTALL_DEFAULTS.dailyRefresh);
    return lookupSchedule(cloud, token, q, choice);
  });
  const [enabled, tables, saExists, policy, dataset, job, schedule] = await Promise.all([
    cloud.enabledServices(token, projectId, REQUIRED_SERVICES),
    lookup(() => cloud.listEventsTables(token, projectId, datasetId), null),
    lookup(() => cloud.serviceAccountExists(token, projectId, sa), false),
    lookup(() => cloud.getProjectIamPolicy(token, projectId), null),
    lookup(() => cloud.getDataset(token, projectId, datasetId), null),
    jobRead,
    scheduleRead,
  ]);

  let backfill: InstallStatus['backfill'] = { state: 'none' };
  let latestRun: ExecutionInfo | null = null;
  if (job?.latestExecution) {
    latestRun = await cloud.getExecution(token, job.latestExecution);
    if (latestRun) backfill = { state: latestRun.state };
  }

  const sorted = dayTables(tables ?? []);
  const existing = job ? datasetFromArgs(job.spec.args) : null;
  // An account without its roles cannot run the job: the step is not done.
  const accountReady = saExists && policy !== null && holdsProjectRoles(policy, sa) && dataset !== null && holdsDatasetAccess(dataset, sa);
  const dailyRefresh = job && existing ? dailyRefreshOf(job.spec) : null;
  const history = historyOfInstall(dailyRefresh, latestRun);
  const needed = requiredServices(dailyRefresh ?? q.dailyRefresh ?? INSTALL_DEFAULTS.dailyRefresh);

  return {
    apisEnabled: needed.every((s) => enabled.has(s)) ? 'done' : 'missing',
    dataset: tables === null ? 'missing' : 'done',
    serviceAccount: accountReady ? 'done' : 'missing',
    job: job === null ? 'missing' : job.condition === 'failed' ? 'error' : 'done',
    schedule: schedule ? 'done' : 'missing',
    backfill,
    tables: { count: sorted.length, first: sorted[0] ?? null, last: sorted[sorted.length - 1] ?? null },
    existingDataset: existing ? existingDatasetName(existing, projectId) : null,
    existingType: job && existing ? typeFromArgs(job.spec.args) : null,
    dailyRefresh,
    historyDays: history.days,
    historyEnd: history.end,
  };
}

/**
 * The period of the history of an install, as far as it can be read. Only
 * an install without the daily refresh tells it: there, the latest run of
 * the job is the one that generated the history.
 */
export function historyOfInstall(dailyRefresh: boolean | null, latestRun: Pick<ExecutionInfo, 'args'> | null): { days: number | null; end: string | null } {
  if (dailyRefresh !== false || !latestRun) return { days: null, end: null };
  return historyFromArgs(latestRun.args ?? []);
}
