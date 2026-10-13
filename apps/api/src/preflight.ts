/**
 * The preflight check, exactly as in docs/contracts/api.md
 * ("POST /api/install/preflight", v1.5 and v1.6, D-18 and D-19).
 *
 * Since v2.0 (D-42) the check `conflict` is the check `names`: a project can
 * hold several installs, so only the names of this install are looked at.
 *
 * Read-only: it creates and changes nothing. Nine checks, each `pass`,
 * `fail`, `warn` or `unknown`. Only `fail` blocks the install. A check that
 * could not be performed reports `unknown` with the reason, never `pass`.
 */
import { ApiError, DEFAULT_SUPPORT_EMAIL, isApiNotEnabled } from './errors.js';
import {
  NOT_OURS_HINT,
  OTHER_TYPE_HINT,
  TAKEN_HINT,
  countEventsTables,
  datasetTypeOf,
  isOwnedDataset,
  jobId,
  jobName,
  jobTakenBy,
  jobTakenMessage,
  labelledType,
  lookupSchedule,
  notOursMessage,
  otherTypeMessage,
  requiredServices,
  scheduleIsOurs,
  scheduleTakenMessage,
  wrongLocationHint,
  wrongLocationMessage,
  type CloudGateway,
  type InstallSpec,
  type TakenName,
} from './install.js';
import { UNINSTALL_PERMISSIONS, consoleLinks, installPermissions, roleHint } from './permissions.js';
import { canUninstallMessage, cannotUninstallMessage } from './uninstall.js';

export const CHECK_IDS = ['session', 'project', 'billing', 'permissions', 'names', 'dataset', 'apis', 'image', 'org-policy'] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export type CheckState = 'pass' | 'fail' | 'warn' | 'unknown';

export interface Check {
  id: CheckId;
  title: string;
  state: CheckState;
  message?: string;
  hint?: string;
  link?: string;
  missing?: string[];
  /** Check `names` only: the names of the install that something else holds (api.md v2.0). */
  taken?: string[];
}

export interface PreflightResult {
  /** True when no check is `fail`. */
  ok: boolean;
  checks: Check[];
}

export interface PreflightOptions {
  /** Full generator image name, from infra/IMAGE (D-10). */
  generatorImage: string;
  now: Date;
  /**
   * Whether the uninstall is switched on (D-30, api.md v1.13). Off by
   * default: its four permissions are then neither tested nor named.
   */
  uninstallEnabled?: boolean;
  /** The address a visitor writes to (api.md v1.17). The setting `SUPPORT_EMAIL`. */
  supportEmail?: string;
}

export interface PreflightSession {
  accessToken: string;
  /** ISO 8601. */
  expiresAt: string;
}

export const TITLES: Readonly<Record<CheckId, string>> = {
  session: 'Your sign-in lasts long enough',
  project: 'Project exists and you can see it',
  billing: 'Billing is linked',
  permissions: 'You have the permissions the install needs',
  names: 'The names of this install are free',
  dataset: 'The dataset name is free to use',
  apis: 'Google Cloud APIs',
  image: 'Our generator image is available',
  'org-policy': 'No organisation policy blocks the install',
};

/** The session must outlive the clicks of an install. */
export const MIN_SESSION_MINUTES = 15;

/** The two organisation policy constraints that can stop an install. */
export const SERVICE_ACCOUNT_CONSTRAINT = 'constraints/iam.disableServiceAccountCreation';
export const LOCATIONS_CONSTRAINT = 'constraints/gcp.resourceLocations';

type Outcome = Omit<Check, 'id' | 'title'>;

/**
 * Google says the API is not enabled in the project. A job or a dataset can
 * outlive a disabled API, so nothing was seen and the answer is `unknown`.
 */
const notSwitchedOn = (api: string): Outcome => ({
  state: 'unknown',
  message: `Not checked yet: the ${api} API is not switched on in this project. The install switches it on and checks again at that step.`,
});

const reason = (err: unknown) => (err instanceof ApiError ? err.message : 'An unexpected error occurred on our side.');

/** Run one check. Whatever goes wrong inside becomes `unknown`, with the reason. */
async function attempt(what: string, fn: () => Promise<Outcome> | Outcome): Promise<Outcome> {
  try {
    return await fn();
  } catch (err) {
    return {
      state: 'unknown',
      message: `Could not check ${what}. ${reason(err)}`,
      hint: 'This does not block the install. If the install then fails at this point, the step explains what to do.',
    };
  }
}

export async function preflight(
  cloud: CloudGateway,
  session: PreflightSession,
  spec: InstallSpec,
  opts: PreflightOptions,
): Promise<PreflightResult> {
  const { projectId, datasetId } = spec;
  const token = session.accessToken;

  const sessionCheck = (): Outcome => {
    const minutes = Math.floor((new Date(session.expiresAt).getTime() - opts.now.getTime()) / 60_000);
    if (Number.isNaN(minutes)) throw new ApiError('INTERNAL', 'The session carries no readable expiry time.', 'Sign in again.');
    if (minutes >= MIN_SESSION_MINUTES) return { state: 'pass', message: `Your sign-in is valid for ${minutes} more minutes.` };
    return {
      state: 'fail',
      message: `Your sign-in expires in ${Math.max(minutes, 0)} minutes. An install needs at least ${MIN_SESSION_MINUTES}.`,
      hint: 'Sign in again, then try again.',
    };
  };

  const projectCheck = async (): Promise<Outcome> => {
    const cannotSee: Outcome = {
      state: 'fail',
      message: `Project ${projectId} does not exist, was deleted, or your account has no access to it.`,
      hint: 'Check the project ID, or choose another project.',
      link: consoleLinks.projects(),
    };
    let project;
    try {
      project = await cloud.getProject(token, projectId);
    } catch (err) {
      // Google answers "permission denied" for a project that does not exist
      // as well, so that nobody can probe for project IDs.
      if (err instanceof ApiError && (err.code === 'PERMISSION_DENIED' || err.code === 'NOT_FOUND') && !isApiNotEnabled(err)) return cannotSee;
      throw err;
    }
    if (!project) return cannotSee;
    if (!project.active) {
      return {
        state: 'fail',
        message: `Project ${projectId} is scheduled for deletion.`,
        hint: 'Restore the project in the console, or pick another project.',
        link: consoleLinks.projects(),
      };
    }
    return { state: 'pass', message: `Project ${projectId} (${project.displayName}) is active.` };
  };

  const billingCheck = async (): Promise<Outcome> => {
    if (await cloud.billingEnabled(token, projectId)) return { state: 'pass', message: `Project ${projectId} has a billing account.` };
    return {
      state: 'fail',
      message: `Project ${projectId} has no billing account.`,
      hint: 'Link a billing account in the console under Billing, then try again.',
      link: consoleLinks.billing(projectId),
    };
  };

  const permissionsCheck = async (): Promise<Outcome> => {
    // Without the daily refresh, the permissions of Cloud Scheduler are not asked for (api.md v1.14).
    const install = installPermissions(spec.dailyRefresh);
    const uninstall = opts.uninstallEnabled ? Object.keys(UNINSTALL_PERMISSIONS) : [];
    const granted = new Set(await cloud.testPermissions(token, projectId, [...install, ...uninstall]));
    const missing = install.filter((p) => !granted.has(p));
    if (missing.length > 0) {
      return {
        state: 'fail',
        message: `${missing.length} of ${install.length} permissions are missing.`,
        missing,
        hint: roleHint(missing),
        link: consoleLinks.iam(projectId),
      };
    }
    if (uninstall.length === 0) return { state: 'pass', message: `You hold all ${install.length} permissions.` };
    const missingToUninstall = uninstall.filter((p) => !granted.has(p));
    if (missingToUninstall.length > 0) {
      return {
        state: 'warn',
        message: cannotUninstallMessage(missingToUninstall.length, uninstall.length),
        missing: missingToUninstall,
        hint: roleHint(missingToUninstall),
        link: consoleLinks.iam(projectId),
      };
    }
    return { state: 'pass', message: canUninstallMessage(install.length, uninstall.length) };
  };

  /**
   * The names of the install (api.md v2.0): the job, and the schedule when
   * the daily refresh is chosen. It looks in the region of the request
   * only, and for no other install: each has names of its own.
   */
  const namesCheck = async (): Promise<Outcome> => {
    let job;
    try {
      job = await cloud.getJob(token, jobName(spec));
    } catch (err) {
      if (isApiNotEnabled(err)) return notSwitchedOn('Cloud Run');
      throw err;
    }
    // Without the daily refresh the install has no schedule, and Cloud Scheduler is not asked.
    const schedule = spec.dailyRefresh ? await lookupSchedule(cloud, token, spec, true) : null;

    const taken: TakenName[] = [];
    const messages: string[] = [];
    const why = job ? jobTakenBy(job, spec) : null;
    if (why !== null) {
      taken.push('job');
      messages.push(jobTakenMessage(spec, why));
    }
    if (schedule && !scheduleIsOurs(schedule, spec)) {
      taken.push('schedule');
      messages.push(scheduleTakenMessage(spec));
    }
    if (taken.length > 0) {
      const link = taken[0] === 'job' ? consoleLinks.runJobs(projectId) : consoleLinks.scheduler(projectId);
      return { state: 'fail', message: messages.join(' '), hint: TAKEN_HINT, link, taken };
    }
    if (job) return { state: 'pass', message: 'This project already has this install. Installing again repairs it and changes nothing else.' };
    return { state: 'pass', message: `The name ${jobId(spec)} is free in ${projectId}, region ${spec.region}.` };
  };

  const datasetCheck = async (): Promise<Outcome> => {
    let dataset;
    try {
      dataset = await cloud.getDataset(token, projectId, datasetId);
    } catch (err) {
      if (isApiNotEnabled(err)) return notSwitchedOn('BigQuery');
      throw err;
    }
    if (!dataset) return { state: 'pass', message: `Dataset ${datasetId} does not exist yet. The install creates it in ${spec.location}.` };
    if (!isOwnedDataset(dataset)) {
      return { state: 'fail', message: notOursMessage(spec), hint: NOT_OURS_HINT, link: consoleLinks.bigquery(projectId) };
    }
    if (dataset.location.toUpperCase() !== spec.location.toUpperCase()) {
      return {
        state: 'fail',
        message: wrongLocationMessage(spec, dataset.location),
        hint: wrongLocationHint(dataset.location),
        link: consoleLinks.bigquery(projectId),
      };
    }
    // One type per dataset (api.md v1.11). A dataset set to the type of the request costs no call.
    const ours = `Dataset ${datasetId} already exists in ${dataset.location} and was created by this installer.`;
    if (labelledType(dataset) === spec.datasetType) return { state: 'pass', message: `${ours} It is of type ${spec.datasetType}.` };
    let tables;
    try {
      tables = await countEventsTables(cloud, token, spec);
    } catch (err) {
      if (isApiNotEnabled(err)) return notSwitchedOn('BigQuery');
      if (!(err instanceof ApiError)) throw err;
      return {
        state: 'unknown',
        message: `${ours} Its type could not be checked: ${err.message}`,
        hint: 'This does not block the install. If the dataset holds data of another type, the install stops at the first step and says so.',
        link: consoleLinks.bigquery(projectId),
      };
    }
    const type = datasetTypeOf(dataset, tables);
    if (tables > 0 && type !== spec.datasetType) {
      return { state: 'fail', message: otherTypeMessage(spec, type!), hint: OTHER_TYPE_HINT, link: consoleLinks.bigquery(projectId) };
    }
    if (tables === 0) return { state: 'pass', message: `${ours} It holds no table yet and takes the type ${spec.datasetType}.` };
    return { state: 'pass', message: `${ours} It is of type ${spec.datasetType}.` };
  };

  const apisCheck = async (): Promise<Outcome> => {
    const needed = requiredServices(spec.dailyRefresh);
    let enabled;
    try {
      enabled = await cloud.enabledServices(token, projectId, needed);
    } catch (err) {
      // Google answers once per API, in words meant for its own support.
      if (err instanceof ApiError && err.code === 'PERMISSION_DENIED' && !isApiNotEnabled(err)) {
        return {
          state: 'unknown',
          message: 'Your account may not see which APIs are switched on in this project, so this could not be checked.',
          hint: 'This does not block the install. The permissions check says what your account is missing.',
        };
      }
      throw err;
    }
    const toEnable = needed.filter((s) => !enabled.has(s));
    if (toEnable.length === 0) return { state: 'pass', message: `All ${needed.length} APIs the install needs are already enabled.` };
    return {
      state: 'pass',
      message: `The install will enable ${toEnable.length === 1 ? 'this API' : `these ${toEnable.length} APIs`}: ${toEnable.join(', ')}.`,
      link: consoleLinks.apis(projectId),
    };
  };

  const imageCheck = async (): Promise<Outcome> => {
    const state = await cloud.imageState(opts.generatorImage);
    if (state === 'readable') return { state: 'pass', message: 'The generator image can be downloaded by your project.' };
    return {
      state: 'fail',
      message:
        state === 'missing'
          ? `The generator image ${opts.generatorImage} does not exist.`
          : `The generator image ${opts.generatorImage} is not public, or its repository does not exist.`,
      hint: `This is a fault on our side, not in your project. Please report it to ${opts.supportEmail ?? DEFAULT_SUPPORT_EMAIL}. The install cannot work until we fix it.`,
    };
  };

  const orgPolicyCheck = async (): Promise<Outcome> => {
    let serviceAccounts;
    let locations;
    try {
      [serviceAccounts, locations] = await Promise.all([
        cloud.getOrgPolicy(token, projectId, SERVICE_ACCOUNT_CONSTRAINT),
        cloud.getOrgPolicy(token, projectId, LOCATIONS_CONSTRAINT),
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PERMISSION_DENIED' && !isApiNotEnabled(err)) {
        return {
          state: 'unknown',
          message: 'Your account may not read the organisation policies of this project, so they could not be checked.',
          hint: 'This does not block the install. If your organisation restricts service accounts or locations, the install stops at that step and says so.',
          link: consoleLinks.orgPolicies(projectId),
        };
      }
      throw err;
    }

    const problems: string[] = [];
    if (serviceAccounts?.enforced) {
      problems.push('Your organisation forbids creating service accounts (policy iam.disableServiceAccountCreation). The install needs to create one.');
    }
    if (locations && !locations.allowAll) {
      if (locations.denyAll) {
        problems.push('Your organisation allows no resource location at all (policy gcp.resourceLocations).');
      } else if (locations.allowedValues.length > 0 || locations.deniedValues.length > 0) {
        const allowed = locations.allowedValues.length > 0 ? ` Allowed: ${locations.allowedValues.join(', ')}.` : '';
        const denied = locations.deniedValues.length > 0 ? ` Denied: ${locations.deniedValues.join(', ')}.` : '';
        problems.push(
          `Your organisation restricts where resources may be created (policy gcp.resourceLocations).${allowed}${denied} Check that region ${spec.region} and location ${spec.location} are permitted.`,
        );
      }
    }
    if (problems.length === 0) return { state: 'pass', message: 'No organisation policy restricts service accounts or locations for this project.' };
    return {
      state: 'warn',
      message: problems.join(' '),
      hint: 'Ask the administrator of your Google Cloud organisation, choose a permitted region and location, or pick another project.',
      link: consoleLinks.orgPolicies(projectId),
    };
  };

  const [session_, project, billing, permissions, names, dataset, apis, image, orgPolicy] = await Promise.all([
    attempt('your sign-in', sessionCheck),
    attempt(`project ${projectId}`, projectCheck),
    attempt('the billing state', billingCheck),
    attempt('your permissions', permissionsCheck),
    attempt('the names of this install', namesCheck),
    attempt(`dataset ${datasetId}`, datasetCheck),
    attempt('which APIs are enabled', apisCheck),
    attempt('the generator image', imageCheck),
    attempt('the organisation policies', orgPolicyCheck),
  ]);

  const outcomes: Record<CheckId, Outcome> = {
    session: session_,
    project,
    billing,
    permissions,
    names,
    dataset,
    apis,
    image,
    'org-policy': orgPolicy,
  };

  // Without the project nothing inside it can be known. Saying so is more
  // useful than seven copies of Google's refusal.
  if (project.state === 'fail') {
    for (const id of ['billing', 'permissions', 'names', 'dataset', 'apis', 'org-policy'] as const) {
      outcomes[id] = { state: 'unknown', message: `Not checked, because project ${projectId} could not be read.` };
    }
  }

  const checks = CHECK_IDS.map((id): Check => ({ id, title: TITLES[id], ...outcomes[id] }));
  return { ok: checks.every((c) => c.state !== 'fail'), checks };
}
