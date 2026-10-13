/**
 * The uninstall, exactly as in docs/contracts/api.md
 * ("POST /api/install/uninstall", v1.4, D-17). It mirrors infra/uninstall.sh.
 *
 * Removed in this order: the Cloud Scheduler job, the Cloud Run job, the
 * service account's project roles and dataset access entry, the service
 * account, and the dataset only when `deleteDataset` is true. APIs stay
 * enabled. A resource that is not there counts as already removed, so the
 * call is safe to repeat after a failure halfway.
 *
 * The service account and its project roles belong to the project, not to
 * a region. While another region holds an install, they are kept, or that
 * install would stop working.
 *
 * Taken out of the app for now (D-30, api.md v1.13): the route exists only
 * while the setting `UNINSTALL_ENABLED` is `true`. Every text that names the
 * uninstall lives in this file, so that none is met while the setting is off.
 */
import { ApiError } from './errors.js';
import { consoleLinks } from './permissions.js';
import {
  OFFERED_REGIONS,
  PROJECT_ROLES,
  isOwnedDataset,
  datasetFromArgs,
  existingDatasetName,
  jobId,
  jobName,
  lookForInstalls,
  parseInstallSpec,
  schedulerJobName,
  serviceAccountEmail,
  type CloudGateway,
  type IamPolicy,
  type InstallSpec,
  type JobInfo,
  type RegionOptions,
} from './install.js';

/** `installId` names the job and the schedule to remove (api.md v2.0). Null: those of an install made before v2.0. */
export interface UninstallSpec extends Pick<InstallSpec, 'projectId' | 'region' | 'datasetId' | 'installId'> {
  deleteDataset: boolean;
}

export interface UninstallResult {
  state: 'done';
  /**
   * The end state: true when `deleteDataset` was asked for and the dataset
   * does not exist after the call, whether this call deleted it or it was
   * already gone. False in every other case.
   */
  datasetDeleted: boolean;
  /**
   * The other installs the project still holds, in any offered region.
   * Present only when there is one. The service account and its roles are
   * shared (api.md v2.0) and were kept for them.
   */
  remainingInstalls?: { installId: string | null; region: string; datasetId: string }[];
  /** Regions where no install could be looked for. Present only when there is one. */
  regionsNotChecked?: string[];
}

export interface UninstallOptions extends RegionOptions {
  /** Wait between two looks at a job that is being deleted. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long to wait for Cloud Run to finish deleting the job. The web app
 * forwards requests with a 30 second limit (the Next.js proxy default), so
 * the whole uninstall has to fit well inside that.
 */
export const JOB_DELETE_POLL_MS = 1500;
export const JOB_DELETE_MAX_POLLS = 10;

/** The two sentences of the preflight check `permissions` that speak of the uninstall. */
export const cannotUninstallMessage = (missing: number, total: number) =>
  `You can install, but you will not be able to uninstall: ${missing} of ${total} permissions for that are missing.`;
export const canUninstallMessage = (install: number, uninstall: number) => `You hold all ${install} permissions, and the ${uninstall} needed to uninstall.`;

const invalid = (message: string) => new ApiError('INVALID_ARGUMENT', message, 'This is a bug in the app. Reload the page and try again.');

/**
 * Validate the request body. `projectId`, `region` and `datasetId` follow the
 * same rules as an install. `datasetId` has no default here: an uninstall
 * only ever touches a dataset the visitor named. `deleteDataset` must be a
 * real boolean, because a loosely read "false" must never delete data.
 */
export function parseUninstallSpec(input: Record<string, unknown>): UninstallSpec {
  if (typeof input.datasetId !== 'string' || !input.datasetId.trim()) {
    throw invalid('datasetId is required: the uninstall must name the dataset of the install to remove.');
  }
  if (input.deleteDataset !== undefined && typeof input.deleteDataset !== 'boolean') {
    throw invalid('deleteDataset must be true or false.');
  }
  // Every well-formed region: an install made outside the offered regions must stay removable.
  const { projectId, region, datasetId, installId } = parseInstallSpec(
    { projectId: input.projectId, region: input.region, datasetId: input.datasetId, installId: input.installId },
    { regions: 'any' },
  );
  return { projectId, region, datasetId, installId, deleteDataset: input.deleteDataset === true };
}

/**
 * Same rule as the install (D-12): the visitor names a dataset, and a job
 * that writes to another one is not theirs to remove by that name.
 */
function assertNamedInstall(job: JobInfo, spec: UninstallSpec): void {
  const existing = datasetFromArgs(job.spec.args);
  if (!existing) return;
  if (existing.projectId === spec.projectId && existing.datasetId === spec.datasetId) return;
  const name = existingDatasetName(existing, spec.projectId);
  throw new ApiError(
    'CONFLICT',
    `The install in project ${spec.projectId} writes to dataset ${name}, not ${spec.datasetId}.`,
    `Nothing was removed. To remove that install, uninstall with dataset ${name} instead.`,
    { link: consoleLinks.runJobs(spec.projectId) },
  );
}

/**
 * Remove the service account from `role`, in both forms Google uses: the
 * live member and the `deleted:` member left behind by an account that was
 * deleted earlier. Conditional bindings are left alone, as in the install.
 * Returns true when the policy changed.
 */
export function removeBinding(policy: IamPolicy, role: string, email: string): boolean {
  const live = `serviceAccount:${email}`;
  const deletedPrefix = `deleted:serviceAccount:${email}?uid=`;
  let changed = false;
  for (const binding of policy.bindings) {
    if (binding.role !== role || binding.condition) continue;
    const kept = binding.members.filter((m) => m !== live && !m.startsWith(deletedPrefix));
    if (kept.length !== binding.members.length) {
      binding.members = kept;
      changed = true;
    }
  }
  if (changed) policy.bindings = policy.bindings.filter((b) => b.members.length > 0);
  return changed;
}

export async function uninstall(
  cloud: CloudGateway,
  token: string,
  spec: UninstallSpec,
  opts: UninstallOptions = {},
): Promise<UninstallResult> {
  const { projectId, datasetId } = spec;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sa = serviceAccountEmail(projectId);
  const job = jobName(spec);
  const schedule = schedulerJobName(spec);

  // Refuse before anything is removed. The installs of the project are
  // listed beside the read of the job: the service account is shared, and
  // is kept while another install remains. The region of the request is
  // listed too, since it can hold other installs (api.md v2.0).
  const regions = [...new Set([...OFFERED_REGIONS, spec.region])];
  const [existingJob, found] = await Promise.all([cloud.getJob(token, job), lookForInstalls(cloud, token, projectId, regions, opts)]);
  if (existingJob) assertNamedInstall(existingJob, spec);
  const others = { ...found, installs: found.installs.filter((i) => !(i.region === spec.region && i.installId === spec.installId)) };

  const usesNamedDataset = others.installs.find((i) => i.target.projectId === projectId && i.target.datasetId === datasetId);
  const namedHere = existingJob !== null && datasetFromArgs(existingJob.spec.args) !== null;
  // The same install number and the same dataset, elsewhere: the visitor named the wrong region.
  const elsewhere = others.installs.find((i) => i.installId === spec.installId && i.target.projectId === projectId && i.target.datasetId === datasetId);
  if (elsewhere && !namedHere) {
    throw new ApiError(
      'CONFLICT',
      `The install in project ${projectId} that writes to dataset ${datasetId} is in region ${elsewhere.region}, not ${spec.region}.`,
      `Nothing was removed. To remove that install, uninstall with region ${elsewhere.region} instead.`,
      { link: consoleLinks.runJobs(projectId) },
    );
  }
  if (usesNamedDataset && spec.deleteDataset) {
    throw new ApiError(
      'CONFLICT',
      `Dataset ${datasetId} in project ${projectId} is still used by the install in region ${usesNamedDataset.region}, so it will not be deleted.`,
      `Nothing was removed. Uninstall again without deleting the dataset, or remove the install in region ${usesNamedDataset.region} first.`,
      { link: consoleLinks.runJobs(projectId) },
    );
  }
  const installsRemain = others.installs.length > 0;

  // Dataset ownership (D-19): only a dataset the installer created is ever
  // deleted. Also refused before anything is removed, so the visitor can
  // untick the box and uninstall the rest.
  const dataset = await cloud.getDataset(token, projectId, datasetId);
  if (dataset && spec.deleteDataset && !isOwnedDataset(dataset)) {
    throw new ApiError(
      'CONFLICT',
      `Dataset ${datasetId} in project ${projectId} was not created by this installer, so it will not be deleted.`,
      'Nothing was removed. Uninstall again without deleting the dataset. If you really mean to delete that dataset, do it by hand in the BigQuery console.',
      { link: consoleLinks.bigquery(projectId) },
    );
  }

  // 1. The schedule first, so nothing starts the job while it is going away.
  if (await cloud.getSchedule(token, schedule)) await cloud.deleteSchedule(token, schedule);

  // 2. The Cloud Run job. Google deletes it in the background; "done" must
  // mean gone, or an install started right after would find a job that is
  // about to disappear and report it as ready.
  if (existingJob) {
    await cloud.deleteJob(token, job);
    let gone = false;
    for (let i = 0; i < JOB_DELETE_MAX_POLLS && !gone; i++) {
      if (i > 0) await sleep(JOB_DELETE_POLL_MS);
      gone = (await cloud.getJob(token, job)) === null;
    }
    if (!gone) {
      throw new ApiError(
        'UPSTREAM_ERROR',
        `Google is still deleting the Cloud Run job ${jobId(spec)} in ${projectId}.`,
        'Wait a minute and try again. It continues where it stopped.',
      );
    }
  }

  // 3. Project roles: read-modify-write, keeping the etag so a concurrent
  // change elsewhere makes Google reject ours instead of silently losing it.
  // Done before the account is deleted so the policy holds no dangling member.
  // Kept while another region holds an install, which runs as this account.
  if (!installsRemain) {
    const policy = await cloud.getProjectIamPolicy(token, projectId);
    let changed = false;
    for (const role of PROJECT_ROLES) changed = removeBinding(policy, role, sa) || changed;
    if (changed) await cloud.setProjectIamPolicy(token, projectId, policy);
  }

  // 4. The WRITER entry on the dataset. Pointless when the dataset goes too.
  // Kept when an install elsewhere writes to this very dataset.
  if (dataset && !spec.deleteDataset && !usesNamedDataset) {
    const kept = dataset.access.filter((e) => !(e.role === 'WRITER' && e.userByEmail === sa));
    if (kept.length !== dataset.access.length) {
      await cloud.setDatasetAccess(token, projectId, datasetId, kept, dataset.etag);
    }
  }

  // 5. The service account, unless an install elsewhere still runs as it.
  if (!installsRemain && (await cloud.serviceAccountExists(token, projectId, sa))) await cloud.deleteServiceAccount(token, projectId, sa);

  // 6. The dataset and its tables, only on request.
  if (dataset && spec.deleteDataset) await cloud.deleteDataset(token, projectId, datasetId);

  // Reaching this line with deleteDataset means the dataset is gone: it was
  // missing already, or the deletion above did not throw.
  return {
    state: 'done',
    datasetDeleted: spec.deleteDataset,
    ...(installsRemain
      ? { remainingInstalls: others.installs.map((i) => ({ installId: i.installId, region: i.region, datasetId: existingDatasetName(i.target, projectId) })) }
      : {}),
    ...(others.notChecked.length > 0 ? { regionsNotChecked: others.notChecked } : {}),
  };
}
