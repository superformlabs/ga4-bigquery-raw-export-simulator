/**
 * The real CloudGateway: every call the install makes in the visitor's
 * project, through the official Google API client libraries, authenticated
 * with the visitor's own access token.
 *
 *   @googleapis/serviceusage      enable APIs (Service Usage v1)
 *   @googleapis/bigquery          dataset, dataset list, access list, table list (BigQuery v2)
 *   @googleapis/iam               service account (IAM v1)
 *   @google-cloud/resource-manager project IAM policy (Resource Manager v3)
 *   @googleapis/run               Cloud Run Jobs v2: job, run, execution
 *   @googleapis/cloudscheduler    Cloud Scheduler v1
 *   @googleapis/cloudbilling      billing state of the project (Cloud Billing v1)
 *   @googleapis/orgpolicy         effective organisation policies (Org Policy v2)
 *
 * One call uses no client library and no token: the anonymous read of our
 * own public generator image, which is a plain Docker registry request.
 *
 * Each method maps one "not there" answer (404) to null/false so install.ts
 * can decide, and turns every other failure into a contract ApiError. The
 * delete methods treat a 404 as "already gone".
 */
import { bigquery } from '@googleapis/bigquery';
import { cloudbilling } from '@googleapis/cloudbilling';
import { orgpolicy } from '@googleapis/orgpolicy';
import { cloudscheduler } from '@googleapis/cloudscheduler';
import { iam } from '@googleapis/iam';
import { run, type run_v2 } from '@googleapis/run';
import { serviceusage } from '@googleapis/serviceusage';
import { ProjectsClient } from '@google-cloud/resource-manager';
import { OAuth2Client } from 'google-auth-library';
import { ApiError, fromGoogleError, isAlreadyExists } from './errors.js';
import { FILL_ACTION } from './permissions.js';
import {
  JOB_CPU,
  JOB_MAX_RETRIES,
  JOB_MEMORY,
  type CloudGateway,
  type DatasetAccessEntry,
  type ExecutionInfo,
  type IamPolicy,
  type ImageState,
  type OrgPolicyInfo,
  type JobInfo,
  type JobSpec,
  type LabelledDataset,
  type NamedJob,
  type ScheduleSpec,
  qualifyExecutionName,
} from './install.js';

function authFor(accessToken: string): OAuth2Client {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

function httpStatus(err: unknown): number | undefined {
  const e = (err ?? {}) as { status?: unknown; response?: { status?: unknown } };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.response?.status === 'number') return e.response.status;
  return undefined;
}

const isNotFound = (err: unknown) => httpStatus(err) === 404;

/** Run `fn`; a 404 becomes null, anything else becomes an ApiError. */
async function orNull<T>(action: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw fromGoogleError(err, action);
  }
}

/** Run `fn`; a 404 ("already gone") is success, anything else becomes an ApiError. */
async function idempotentDelete(action: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (isNotFound(err)) return;
    throw fromGoogleError(err, action);
  }
}

/**
 * Run `fn`; "already exists" is success, anything else becomes an ApiError.
 * Google also answers 409 when it is still busy with an earlier change
 * (ABORTED). That is not success: nothing was created.
 */
export async function idempotentCreate(action: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (isAlreadyExists(err)) return;
    throw fromGoogleError(err, action);
  }
}

function errorMessage(err: unknown): string {
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : '';
}

/** What is sent to Cloud Run for a job. The labels are those of the job itself, not of its runs. */
export function jobBody(job: JobSpec): run_v2.Schema$GoogleCloudRunV2Job {
  return {
    labels: { ...job.labels },
    template: {
      taskCount: 1,
      template: {
        containers: [{ image: job.image, args: job.args, resources: { limits: { cpu: JOB_CPU, memory: JOB_MEMORY } } }],
        serviceAccount: job.serviceAccountEmail,
        timeout: `${job.timeoutSeconds}s`,
        maxRetries: JOB_MAX_RETRIES,
      },
    },
  };
}

function scheduleBody(name: string, s: ScheduleSpec) {
  return {
    name,
    schedule: s.schedule,
    timeZone: 'UTC',
    httpTarget: { uri: s.uri, httpMethod: 'POST', oauthToken: { serviceAccountEmail: s.serviceAccountEmail } },
  };
}

function executionState(e: run_v2.Schema$GoogleCloudRunV2Execution): ExecutionInfo['state'] {
  const completed = e.conditions?.find((c) => c.type === 'Completed');
  if (completed?.state === 'CONDITION_SUCCEEDED') return 'succeeded';
  if (completed?.state === 'CONDITION_FAILED') return 'failed';
  if (!e.completionTime) return 'running';
  return (e.succeededCount ?? 0) > 0 && !(e.failedCount ?? 0) && !(e.cancelledCount ?? 0) ? 'succeeded' : 'failed';
}

/** Seconds from a protobuf duration string such as "1800s" (0 when absent). */
function seconds(duration: string | null | undefined): number {
  const m = /^(\d+)(?:\.\d+)?s$/.exec(duration ?? '');
  return m ? Number(m[1]) : 0;
}

export function currentJobSpec(j: run_v2.Schema$GoogleCloudRunV2Job): JobSpec {
  const task = j.template?.template;
  const container = task?.containers?.[0];
  return {
    image: container?.image ?? '',
    args: [...(container?.args ?? [])],
    serviceAccountEmail: task?.serviceAccount ?? '',
    timeoutSeconds: seconds(task?.timeout),
    labels: { ...(j.labels ?? {}) },
  };
}

function jobCondition(j: run_v2.Schema$GoogleCloudRunV2Job): JobInfo['condition'] {
  const state = j.terminalCondition?.state;
  if (state === 'CONDITION_SUCCEEDED') return 'succeeded';
  if (state === 'CONDITION_FAILED') return 'failed';
  return 'pending';
}

/**
 * The list of the datasets comes in pages. One call reads up to 1000
 * datasets; the look stops after 10 calls, so that a project with more than
 * 10000 datasets cannot hold the request longer than the web app waits.
 */
export const DATASETS_PER_PAGE = 1000;
export const DATASET_PAGES_MAX = 10;

/**
 * The list of the jobs of a region comes in pages too. One call reads up to
 * 100 jobs; the look stops after 10 calls, so 1000 jobs a region.
 */
export const JOBS_PER_PAGE = 100;
export const JOB_PAGES_MAX = 10;

/** How long the anonymous look at our image may take. */
const IMAGE_CHECK_TIMEOUT_MS = 5000;

/**
 * `host/path:tag` or `host/path@sha256:...` to the registry URL of its
 * manifest (Docker Registry HTTP API v2). Null when the name has no such form.
 */
export function imageManifestUrl(image: string): string | null {
  const m = /^([a-z0-9.-]+)\/([A-Za-z0-9._\/-]+?)(?::([A-Za-z0-9._-]+)|@(sha256:[0-9a-f]{64}))$/.exec(image);
  if (!m) return null;
  const [, host, path, tag, digest] = m;
  return `https://${host}/v2/${path}/manifests/${tag ?? digest}`;
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export function createCloudGateway(fetchImpl: typeof fetch = fetch): CloudGateway {
  return {
    // ---- Service Usage --------------------------------------------------

    async enabledServices(token, projectId, serviceIds) {
      const api = serviceusage({ version: 'v1', auth: authFor(token) });
      try {
        const res = await api.services.batchGet({
          parent: `projects/${projectId}`,
          names: serviceIds.map((id) => `projects/${projectId}/services/${id}`),
        });
        const enabled = new Set<string>();
        for (const s of res.data.services ?? []) {
          // Google answers with the project *number* in `name`; match on the service id only.
          const id = s.name?.split('/services/')[1];
          if (id && s.state === 'ENABLED') enabled.add(id);
        }
        return enabled;
      } catch (err) {
        throw fromGoogleError(err, `check which APIs are enabled on ${projectId}`);
      }
    },

    async enableServices(token, projectId, serviceIds) {
      const api = serviceusage({ version: 'v1', auth: authFor(token) });
      try {
        const res = await api.services.batchEnable({ parent: `projects/${projectId}`, requestBody: { serviceIds: [...serviceIds] } });
        return { done: res.data.done === true, operation: res.data.name ?? '' };
      } catch (err) {
        if (/billing/i.test(errorMessage(err))) {
          throw new ApiError(
            'BILLING_DISABLED',
            `Project ${projectId} has no billing account, so Cloud Run cannot be enabled.`,
            'Link a billing account to the project in the Google Cloud console, then try again. The dataset itself costs a few cents a month.',
          );
        }
        throw fromGoogleError(err, `enable APIs on ${projectId}`);
      }
    },

    // ---- BigQuery ---------------------------------------------------------

    async getDataset(token, projectId, datasetId) {
      const api = bigquery({ version: 'v2', auth: authFor(token) });
      return orNull(`read dataset ${datasetId}`, async () => {
        const res = await api.datasets.get({ projectId, datasetId });
        return {
          location: res.data.location ?? '',
          etag: res.data.etag ?? undefined,
          access: (res.data.access ?? []) as DatasetAccessEntry[],
          labels: { ...(res.data.labels ?? {}) },
        };
      });
    },

    async createDataset(token, projectId, datasetId, location, labels) {
      const api = bigquery({ version: 'v2', auth: authFor(token) });
      await idempotentCreate(`create dataset ${datasetId} in ${projectId}`, () =>
        api.datasets.insert({
          projectId,
          requestBody: {
            datasetReference: { projectId, datasetId },
            location,
            labels: { ...labels },
            description: 'Fake GA4 export generated by ga4synth. Safe to delete.',
          },
        }),
      );
    },

    async setDatasetAccess(token, projectId, datasetId, access, etag) {
      const api = bigquery({ version: 'v2', auth: authFor(token) });
      try {
        await api.datasets.patch(
          { projectId, datasetId, requestBody: { access } },
          etag ? { headers: { 'If-Match': etag } } : undefined,
        );
      } catch (err) {
        throw fromGoogleError(err, `grant the service account access to dataset ${datasetId}`);
      }
    },

    async setDatasetLabels(token, projectId, datasetId, labels, etag) {
      const api = bigquery({ version: 'v2', auth: authFor(token) });
      try {
        await api.datasets.patch(
          { projectId, datasetId, requestBody: { labels: { ...labels } } },
          etag ? { headers: { 'If-Match': etag } } : undefined,
        );
      } catch (err) {
        throw fromGoogleError(err, `write the type of dataset ${datasetId}`);
      }
    },

    async listEventsTables(token, projectId, datasetId) {
      const api = bigquery({ version: 'v2', auth: authFor(token) });
      return orNull(`list the tables in ${datasetId}`, async () => {
        const names: string[] = [];
        let pageToken: string | undefined;
        do {
          const res = await api.tables.list({ projectId, datasetId, maxResults: 1000, pageToken });
          for (const t of res.data.tables ?? []) {
            const id = t.tableReference?.tableId;
            if (id?.startsWith('events_')) names.push(id);
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        return names;
      });
    },

    async listDatasets(token, projectId) {
      const api = bigquery({ version: 'v2', auth: authFor(token) });
      try {
        const found: LabelledDataset[] = [];
        let pageToken: string | undefined;
        let pages = 0;
        do {
          // Without `all`, BigQuery leaves the hidden datasets out.
          const res = await api.datasets.list({ projectId, maxResults: DATASETS_PER_PAGE, pageToken });
          for (const d of res.data.datasets ?? []) {
            const datasetId = d.datasetReference?.datasetId;
            if (datasetId) found.push({ datasetId, location: d.location ?? '', labels: { ...(d.labels ?? {}) } });
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken && ++pages < DATASET_PAGES_MAX);
        return found;
      } catch (err) {
        throw fromGoogleError(err, `list the datasets of ${projectId}`);
      }
    },

    // ---- IAM --------------------------------------------------------------

    async serviceAccountExists(token, projectId, email) {
      const api = iam({ version: 'v1', auth: authFor(token) });
      const sa = await orNull(`look up service account ${email}`, () =>
        api.projects.serviceAccounts.get({ name: `projects/${projectId}/serviceAccounts/${email}` }),
      );
      return sa !== null;
    },

    async createServiceAccount(token, projectId, accountId, displayName) {
      const api = iam({ version: 'v1', auth: authFor(token) });
      await idempotentCreate(`create service account ${accountId} in ${projectId}`, () =>
        api.projects.serviceAccounts.create({
          name: `projects/${projectId}`,
          requestBody: { accountId, serviceAccount: { displayName } },
        }),
      );
    },

    async getProjectIamPolicy(token, projectId) {
      const client = new ProjectsClient({ authClient: authFor(token) });
      try {
        const [policy] = await client.getIamPolicy({ resource: `projects/${projectId}`, options: { requestedPolicyVersion: 3 } });
        return {
          bindings: (policy.bindings ?? []).map((b) => ({
            role: b.role ?? '',
            members: [...(b.members ?? [])],
            ...(b.condition ? { condition: b.condition } : {}),
          })),
          etag: typeof policy.etag === 'string' ? policy.etag : policy.etag ? Buffer.from(policy.etag).toString('base64') : undefined,
          version: policy.version ?? undefined,
        };
      } catch (err) {
        throw fromGoogleError(err, `read the permissions of ${projectId}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    },

    async setProjectIamPolicy(token, projectId, policy: IamPolicy) {
      const client = new ProjectsClient({ authClient: authFor(token) });
      try {
        const hasConditions = policy.bindings.some((b) => b.condition);
        await client.setIamPolicy({
          resource: `projects/${projectId}`,
          policy: {
            bindings: policy.bindings.map((b) => ({
              role: b.role,
              members: b.members,
              ...(b.condition ? { condition: b.condition as object } : {}),
            })),
            etag: policy.etag ? Buffer.from(policy.etag, 'base64') : undefined,
            version: hasConditions ? 3 : (policy.version ?? 1),
          },
        });
      } catch (err) {
        throw fromGoogleError(err, `grant the service account roles on ${projectId}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    },

    // ---- Cloud Run Jobs ---------------------------------------------------

    async getJob(token, name) {
      const api = run({ version: 'v2', auth: authFor(token) });
      return orNull(`read the Cloud Run job`, async () => {
        const res = await api.projects.locations.jobs.get({ name });
        return {
          condition: jobCondition(res.data),
          latestExecution: res.data.latestCreatedExecution?.name ? qualifyExecutionName(name, res.data.latestCreatedExecution.name) : null,
          spec: currentJobSpec(res.data),
        };
      });
    },

    async listJobs(token, projectId, region) {
      const api = run({ version: 'v2', auth: authFor(token) });
      try {
        const found: NamedJob[] = [];
        let pageToken: string | undefined;
        let pages = 0;
        do {
          const res = await api.projects.locations.jobs.list({ parent: `projects/${projectId}/locations/${region}`, pageSize: JOBS_PER_PAGE, pageToken });
          for (const j of res.data.jobs ?? []) {
            if (!j.name) continue;
            found.push({
              name: j.name,
              job: {
                condition: jobCondition(j),
                latestExecution: j.latestCreatedExecution?.name ? qualifyExecutionName(j.name, j.latestCreatedExecution.name) : null,
                spec: currentJobSpec(j),
              },
            });
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken && ++pages < JOB_PAGES_MAX);
        return found;
      } catch (err) {
        throw fromGoogleError(err, `list the Cloud Run jobs of ${projectId} in ${region}`);
      }
    },

    async createJob(token, name, job) {
      const api = run({ version: 'v2', auth: authFor(token) });
      const slash = name.lastIndexOf('/jobs/');
      const parent = name.slice(0, slash);
      const jobId = name.slice(slash + '/jobs/'.length);
      try {
        const res = await api.projects.locations.jobs.create({ parent, jobId, requestBody: jobBody(job) });
        return { done: res.data.done === true, operation: res.data.name ?? '' };
      } catch (err) {
        if (isAlreadyExists(err)) return { done: true, operation: '' };
        throw fromGoogleError(err, 'create the Cloud Run job');
      }
    },

    async updateJob(token, name, job) {
      const api = run({ version: 'v2', auth: authFor(token) });
      try {
        const res = await api.projects.locations.jobs.patch({ name, requestBody: jobBody(job) });
        return { done: res.data.done === true, operation: res.data.name ?? '' };
      } catch (err) {
        throw fromGoogleError(err, 'update the Cloud Run job');
      }
    },

    async runJob(token, name, args, timeoutSeconds) {
      const api = run({ version: 'v2', auth: authFor(token) });
      try {
        await api.projects.locations.jobs.run({
          name,
          requestBody: { overrides: { containerOverrides: [{ args }], timeout: `${timeoutSeconds}s` } },
        });
      } catch (err) {
        throw fromGoogleError(err, FILL_ACTION);
      }
    },

    async getExecution(token, name) {
      const api = run({ version: 'v2', auth: authFor(token) });
      return orNull('read the latest job run', async () => {
        const res = await api.projects.locations.jobs.executions.get({ name });
        return { state: executionState(res.data), args: [...(res.data.template?.containers?.[0]?.args ?? [])] };
      });
    },

    // ---- Cloud Scheduler --------------------------------------------------

    async getSchedule(token, name) {
      const api = cloudscheduler({ version: 'v1', auth: authFor(token) });
      return orNull('read the schedule', async () => {
        const res = await api.projects.locations.jobs.get({ name });
        return {
          schedule: res.data.schedule ?? '',
          uri: res.data.httpTarget?.uri ?? '',
          serviceAccountEmail: res.data.httpTarget?.oauthToken?.serviceAccountEmail ?? '',
        };
      });
    },

    async createSchedule(token, name, schedule) {
      const api = cloudscheduler({ version: 'v1', auth: authFor(token) });
      const parent = name.slice(0, name.lastIndexOf('/jobs/'));
      await idempotentCreate('create the daily schedule', () =>
        api.projects.locations.jobs.create({ parent, requestBody: scheduleBody(name, schedule) }),
      );
    },

    async updateSchedule(token, name, schedule) {
      const api = cloudscheduler({ version: 'v1', auth: authFor(token) });
      try {
        await api.projects.locations.jobs.patch({
          name,
          updateMask: 'schedule,timeZone,httpTarget',
          requestBody: scheduleBody(name, schedule),
        });
      } catch (err) {
        throw fromGoogleError(err, 'update the daily schedule');
      }
    },

    // ---- Uninstall --------------------------------------------------------

    async deleteSchedule(token, name) {
      const api = cloudscheduler({ version: 'v1', auth: authFor(token) });
      await idempotentDelete('delete the daily schedule', () => api.projects.locations.jobs.delete({ name }));
    },

    async deleteJob(token, name) {
      const api = run({ version: 'v2', auth: authFor(token) });
      // Answers with a long-running operation; uninstall.ts waits by polling getJob.
      await idempotentDelete('delete the Cloud Run job', () => api.projects.locations.jobs.delete({ name }));
    },

    async deleteServiceAccount(token, projectId, email) {
      const api = iam({ version: 'v1', auth: authFor(token) });
      await idempotentDelete(`delete service account ${email}`, () =>
        api.projects.serviceAccounts.delete({ name: `projects/${projectId}/serviceAccounts/${email}` }),
      );
    },

    async deleteDataset(token, projectId, datasetId) {
      const api = bigquery({ version: 'v2', auth: authFor(token) });
      await idempotentDelete(`delete dataset ${datasetId} in ${projectId}`, () =>
        api.datasets.delete({ projectId, datasetId, deleteContents: true }),
      );
    },

    // ---- Preflight (read-only) --------------------------------------------

    async getProject(token, projectId) {
      const client = new ProjectsClient({ authClient: authFor(token) });
      try {
        const [project] = await client.getProject({ name: `projects/${projectId}` });
        // The client library reports the state as a name or as its number (ACTIVE = 1).
        const state: unknown = project.state;
        return {
          projectId: project.projectId ?? projectId,
          displayName: project.displayName || project.projectId || projectId,
          active: state === 'ACTIVE' || state === 1,
        };
      } catch (err) {
        if (isNotFound(err) || (err as { code?: unknown } | null)?.code === 5) return null;
        throw fromGoogleError(err, `read project ${projectId}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    },

    async billingEnabled(token, projectId) {
      const api = cloudbilling({ version: 'v1', auth: authFor(token) });
      try {
        const res = await api.projects.getBillingInfo({ name: `projects/${projectId}` });
        return res.data.billingEnabled === true;
      } catch (err) {
        throw fromGoogleError(err, `read the billing state of ${projectId}`);
      }
    },

    async testPermissions(token, projectId, permissions) {
      const client = new ProjectsClient({ authClient: authFor(token) });
      try {
        const [res] = await client.testIamPermissions({ resource: `projects/${projectId}`, permissions: [...permissions] });
        return [...(res.permissions ?? [])];
      } catch (err) {
        throw fromGoogleError(err, `check your permissions on ${projectId}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    },

    async getOrgPolicy(token, projectId, constraint) {
      const api = orgpolicy({ version: 'v2', auth: authFor(token) });
      const id = constraint.replace(/^constraints\//, '');
      return orNull(`read the organisation policy ${id}`, async (): Promise<OrgPolicyInfo> => {
        const res = await api.projects.policies.getEffectivePolicy({ name: `projects/${projectId}/policies/${id}` });
        const rules = res.data.spec?.rules ?? [];
        return {
          enforced: rules.some((r) => r.enforce === true),
          allowAll: rules.some((r) => r.allowAll === true),
          denyAll: rules.some((r) => r.denyAll === true),
          allowedValues: rules.flatMap((r) => r.values?.allowedValues ?? []),
          deniedValues: rules.flatMap((r) => r.values?.deniedValues ?? []),
        };
      });
    },

    async imageState(image): Promise<ImageState> {
      const url = imageManifestUrl(image);
      if (!url) throw new ApiError('INTERNAL', `The generator image name "${image}" cannot be read.`, 'This is a fault on our side.', { report: true });
      let status: number;
      try {
        const res = await fetchImpl(url, {
          method: 'HEAD',
          headers: { accept: MANIFEST_TYPES },
          redirect: 'follow',
          signal: AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS),
        });
        status = res.status;
      } catch (err) {
        throw new ApiError(
          'UPSTREAM_ERROR',
          `The registry that holds the generator image did not answer: ${errorMessage(err) || 'no response'}`,
          'Wait a minute and try again.',
        );
      }
      if (status >= 200 && status < 300) return 'readable';
      if (status === 404) return 'missing';
      // The registry answers 401 or 403 to an anonymous reader for a private
      // image, and also for a repository that does not exist.
      if (status === 401 || status === 403) return 'private';
      throw new ApiError('UPSTREAM_ERROR', `The registry that holds the generator image answered ${status}.`, 'Wait a minute and try again.');
    },
  };
}
