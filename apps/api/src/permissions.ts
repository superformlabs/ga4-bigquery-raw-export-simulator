/**
 * The permissions the install and the uninstall need, the predefined roles
 * that carry them, and the console pages where a visitor fixes what is
 * missing. Names as listed in docs/contracts/api.md ("preflight", v1.5).
 */
import type { StepName } from './install.js';

/** Predefined roles, smallest first, as named in the Google Cloud console. */
export const ROLES = {
  projectIamAdmin: 'Project IAM Admin',
  serviceUsageAdmin: 'Service Usage Admin',
  bigQueryAdmin: 'BigQuery Admin',
  serviceAccountAdmin: 'Service Account Admin',
  serviceAccountUser: 'Service Account User',
  cloudRunAdmin: 'Cloud Run Admin',
  cloudSchedulerAdmin: 'Cloud Scheduler Admin',
} as const;

/**
 * Every permission the install needs on the project, mapped to the smallest
 * predefined role that carries it.
 *
 * `bigquery.tables.list` is not here although the status lists tables. The
 * Owner role does not carry it, so testing it would block every Owner
 * (checked against roles/owner on 2026-09-26). Access to the tables comes
 * from the dataset's own access list, which names the project owners and
 * whoever created the dataset.
 */
export const INSTALL_PERMISSIONS: Readonly<Record<string, string>> = {
  'resourcemanager.projects.get': ROLES.projectIamAdmin,
  'resourcemanager.projects.getIamPolicy': ROLES.projectIamAdmin,
  'resourcemanager.projects.setIamPolicy': ROLES.projectIamAdmin,
  'serviceusage.services.enable': ROLES.serviceUsageAdmin,
  'serviceusage.services.get': ROLES.serviceUsageAdmin,
  'serviceusage.services.list': ROLES.serviceUsageAdmin,
  'bigquery.datasets.create': ROLES.bigQueryAdmin,
  'bigquery.datasets.get': ROLES.bigQueryAdmin,
  'bigquery.datasets.update': ROLES.bigQueryAdmin,
  'bigquery.datasets.setIamPolicy': ROLES.bigQueryAdmin,
  'iam.serviceAccounts.create': ROLES.serviceAccountAdmin,
  'iam.serviceAccounts.get': ROLES.serviceAccountAdmin,
  'iam.serviceAccounts.actAs': ROLES.serviceAccountUser,
  'run.jobs.create': ROLES.cloudRunAdmin,
  'run.jobs.get': ROLES.cloudRunAdmin,
  'run.jobs.update': ROLES.cloudRunAdmin,
  'run.jobs.run': ROLES.cloudRunAdmin,
  'run.jobs.runWithOverrides': ROLES.cloudRunAdmin,
  'run.executions.get': ROLES.cloudRunAdmin,
  'cloudscheduler.jobs.create': ROLES.cloudSchedulerAdmin,
  'cloudscheduler.jobs.get': ROLES.cloudSchedulerAdmin,
  'cloudscheduler.jobs.update': ROLES.cloudSchedulerAdmin,
};

/** The permissions that only the daily schedule needs. */
export const SCHEDULE_PERMISSIONS: readonly string[] = Object.keys(INSTALL_PERMISSIONS).filter((p) => p.startsWith('cloudscheduler.'));

/** What an install needs: every permission, or all but those of Cloud Scheduler without the daily refresh (api.md v1.14). */
export const installPermissions = (dailyRefresh: boolean): string[] =>
  Object.keys(INSTALL_PERMISSIONS).filter((p) => dailyRefresh || !SCHEDULE_PERMISSIONS.includes(p));

/** What the uninstall needs on top. Missing ones are a warning at install time. */
export const UNINSTALL_PERMISSIONS: Readonly<Record<string, string>> = {
  'run.jobs.delete': ROLES.cloudRunAdmin,
  'cloudscheduler.jobs.delete': ROLES.cloudSchedulerAdmin,
  'iam.serviceAccounts.delete': ROLES.serviceAccountAdmin,
  'bigquery.datasets.delete': ROLES.bigQueryAdmin,
};

const ROLE_OF: Readonly<Record<string, string>> = { ...INSTALL_PERMISSIONS, ...UNINSTALL_PERMISSIONS };
const ROLE_ORDER: readonly string[] = Object.values(ROLES);

/**
 * The permissions each install step uses, for explaining a refusal by Google.
 * Every step reads the Cloud Run job first, for the one-install-per-project
 * rule (D-12).
 */
export const STEP_PERMISSIONS: Readonly<Record<StepName, readonly string[]>> = {
  'enable-apis': ['run.jobs.get', 'serviceusage.services.get', 'serviceusage.services.list', 'serviceusage.services.enable'],
  'create-dataset': ['run.jobs.get', 'bigquery.datasets.get', 'bigquery.datasets.create', 'bigquery.datasets.update'],
  'create-service-account': [
    'run.jobs.get',
    'iam.serviceAccounts.get',
    'iam.serviceAccounts.create',
    'resourcemanager.projects.getIamPolicy',
    'resourcemanager.projects.setIamPolicy',
    'bigquery.datasets.get',
    'bigquery.datasets.update',
    'bigquery.datasets.setIamPolicy',
  ],
  'deploy-job': ['run.jobs.get', 'run.jobs.create', 'run.jobs.update', 'iam.serviceAccounts.actAs', 'bigquery.datasets.get'],
  'create-schedule': ['run.jobs.get', 'cloudscheduler.jobs.get', 'cloudscheduler.jobs.create', 'cloudscheduler.jobs.update', 'iam.serviceAccounts.actAs'],
  'run-backfill': ['run.jobs.get', 'run.jobs.run', 'run.jobs.runWithOverrides', 'run.executions.get', 'bigquery.datasets.get'],
};

/**
 * What the last step does, in the words of the web app ("The run that fills
 * your dataset ..."). A visitor never reads the word of the trade for it
 * (D-32, API-25).
 */
export const FILL_ACTION = 'start the run that fills your dataset';

/** What each step does, to finish the sentence "You do not have permission to ...". */
export const STEP_ACTIONS: Readonly<Record<StepName, string>> = {
  'enable-apis': 'enable APIs',
  'create-dataset': 'create the dataset',
  'create-service-account': 'create the service account and grant it its roles',
  'deploy-job': 'create the Cloud Run job',
  'create-schedule': 'create the daily schedule',
  'run-backfill': FILL_ACTION,
};

/** The distinct roles that carry `permissions`, in a stable order. */
export function rolesFor(permissions: readonly string[]): string[] {
  const wanted = new Set(permissions.map((p) => ROLE_OF[p]).filter((r): r is string => Boolean(r)));
  return ROLE_ORDER.filter((r) => wanted.has(r));
}

/** "Ask a project Owner to grant you the Owner role, or these roles: A, B." */
export function roleHint(permissions: readonly string[]): string {
  const roles = rolesFor(permissions);
  if (roles.length === 0) return 'Ask a project Owner to grant you the Owner role.';
  if (roles.length === 1) return `Ask a project Owner to grant you the Owner role, or this role: ${roles[0]}.`;
  return `Ask a project Owner to grant you the Owner role, or these roles: ${roles.join(', ')}.`;
}

// ---- Console pages ------------------------------------------------------------

const CONSOLE = 'https://console.cloud.google.com';
const q = (projectId: string) => `project=${encodeURIComponent(projectId)}`;

export const consoleLinks = {
  iam: (projectId: string) => `${CONSOLE}/iam-admin/iam?${q(projectId)}`,
  billing: (projectId: string) => `${CONSOLE}/billing/linkedaccount?${q(projectId)}`,
  apis: (projectId: string) => `${CONSOLE}/apis/dashboard?${q(projectId)}`,
  bigquery: (projectId: string) => `${CONSOLE}/bigquery?${q(projectId)}`,
  runJobs: (projectId: string) => `${CONSOLE}/run/jobs?${q(projectId)}`,
  scheduler: (projectId: string) => `${CONSOLE}/cloudscheduler?${q(projectId)}`,
  orgPolicies: (projectId: string) => `${CONSOLE}/iam-admin/orgpolicies/list?${q(projectId)}`,
  projects: () => `${CONSOLE}/cloud-resource-manager`,
} as const;

/** Where the result of each step can be seen in the console. */
export const STEP_LINKS: Readonly<Record<StepName, (projectId: string) => string>> = {
  'enable-apis': consoleLinks.apis,
  'create-dataset': consoleLinks.bigquery,
  'create-service-account': consoleLinks.iam,
  'deploy-job': consoleLinks.runJobs,
  'create-schedule': consoleLinks.scheduler,
  'run-backfill': consoleLinks.runJobs,
};
