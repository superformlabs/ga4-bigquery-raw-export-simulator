// Mock of the backend API described in docs/contracts/api.md.
//
// Stands in for apps/api until it exists. Every endpoint in the contract is
// implemented, with fake delays and the exact error body shape. State is kept
// in memory per project and dataset, so "status" is derived the same way the
// real API derives it: from what the earlier steps created.
//
// Environment:
//   MOCK_PORT   port to listen on (default 3001, the real API's dev port)
//   MOCK_SPEED  multiplier on every delay (default 1; tests use 0.01)
//   MOCK_FLAKY  "1" makes deploy-job fail once in every project, so a failed
//               step and "Try again" can be seen. Default "0": only
//               flaky-project does that
//   MOCK_MANY_PROJECTS
//               adds that many invented projects to the list (default 0), to
//               try the project list with hundreds of names
//   APP_URL     origin the sign-in callback redirects to (default: relative,
//               so it works behind the Next.js proxy on any port)
//   MOCK_EMAIL  the Google account the fake sign-in uses (default
//               you@example.com)
//   MOCK_SESSION_MINUTES
//               how long a fake sign-in lasts (default 60). Below 15 the
//               preflight check "session" fails.
//   UNINSTALL_ENABLED
//               "true" switches the uninstall on, as the setting of the same
//               name does in the real API. Off by default, as in every
//               environment (decision D-30, api.md v1.13): POST
//               /api/install/uninstall then answers 404 like a route that does
//               not exist, and the preflight does not test the permissions of
//               the uninstall
//   SUPPORT_EMAIL
//               the address a hint names when it asks the visitor to report a
//               problem (decision D-35, api.md v1.17). Default
//               support@superformlabs.eu, as in the real API
//   ALLOWED_EMAIL_DOMAINS, ALLOWED_EMAILS
//               the sign-in allowlist (decision D-16), comma separated, same
//               names as the real API. Both empty (default): everyone may
//               sign in. Set ALLOWED_EMAIL_DOMAINS=superformlabs.eu to see
//               the refusal: the default MOCK_EMAIL is outside that domain.
//
// Special project IDs (all appear in GET /api/projects):
//   flaky-project        deploy-job fails once with 502, then works
//   slow-account-project create-service-account answers 502 once, "Google has not
//                        finished creating the service account.", then works
//                        (api.md v1.7)
//   rejected-project     deploy-job answers 502 once, "Google rejected a request of
//                        the app ...", with the hint that names the address
//   no-image-project     the preflight check "image" fails: a fault on our side,
//                        with the hint that names the address
//   failing-run-project  run-backfill, the last step, answers 502 once, then works:
//                        the start of the run that fills the dataset failed
//   leftover-project     holds a labelled, empty dataset and no job: what an
//                        install that stopped early leaves behind
//   taken-name-project   the first dataset name asked for is taken: a dataset of
//                        that name exists and the installer did not create it.
//                        The app then draws another name (task UI-9)
//   two-installs-project holds an install in us-central1 and one in
//                        europe-west1, both made before api.md v2.0: their job
//                        is named ga4synth-daily and they have no installId
//   taken-number-project the first installId asked for is taken: a job of that
//                        name exists in the region and writes elsewhere. The check
//                        "names" fails with `taken`, and the app draws another
//                        number (api.md v2.0, task UI-26)
//   taken-at-step-project
//                        the check passes; when deploy-job arrives, a job of that
//                        name has appeared and writes elsewhere. The step answers
//                        409 with `taken`, once
//   no-billing-project   enable-apis answers 412 BILLING_DISABLED every time
//   forbidden-project    enable-apis answers 403 PERMISSION_DENIED every time, and
//                        so does the uninstall when it is switched on
//   installed-project    everything already exists, with 90 days of tables, like
//                        the dev project after infra/install.sh
//   lost-dataset-project holds the job, the schedule and the service account of
//                        an install whose dataset was deleted by hand. The last
//                        run of the job failed. The app must not repair it by
//                        itself (task UI-12)
//   fixable-project      the first preflight finds no billing and missing
//                        permissions. A check made three seconds later or more
//                        passes, as if the visitor had fixed both in the console
//                        meanwhile. Restart the mock to see the failure again
//   warnings-project     preflight passes with a check that could not be performed,
//                        and, when the uninstall is switched on, with a warning
//                        (no permission to uninstall)
//   existing-dataset-project
//                        holds a dataset with the default name that this
//                        installer did not create, like a real GA4 export
//                        (decision D-19). Any other dataset name is free
//   kept-dataset-project holds a dataset of the installer, analytics_770000030, with
//                        the 30 days from 120 to 91 days ago, and no job: what is kept
//                        of an install that was removed by hand
//   crowded-project      holds four datasets the installer did not create. Two of
//                        them carry names the app could draw, analytics_770000000
//                        and analytics_771111111 (decision D-33, api.md v1.15)
//   missing-project      not in the list: type it by hand. The project cannot be
//                        read, so the checks that depend on it are not performed
//
// Preflight (decision D-18): POST /api/install/preflight answers the nine
// checks, in the order of the contract, and changes nothing. On a project where
// the install has not switched on the Google Cloud services yet, the checks
// "names" and "dataset" are `unknown`, as with the real API.
//
// Dataset ownership (decision D-19, api.md v1.6): a dataset the installer
// creates is labelled. create-dataset, create-service-account, deploy-job,
// run-backfill and uninstall with `deleteDataset` refuse a dataset without the
// label with 409 CONFLICT.
//
// Several installs per project (decision D-42, api.md v2.0, which replaces
// D-12): the install spec carries `installId`, 6 to 12 digits and lowercase
// letters. The job and the schedule of an install are named
// `ga4synth-<installId>`; without `installId` they are `ga4synth-daily`, the
// names of an install made before v2.0. The service account `ga4synth` is one
// for the project. Every step looks at the name first: a job of that name that
// writes into the dataset of the request, with its type and its choice of the
// daily refresh, is this install, and the step is done. A job of that name
// that is anything else answers 409 CONFLICT with `taken`, the list of the
// names that are taken; the mock answers "job". The preflight check "names"
// says the same before anything is created. Two installs of one project never
// conflict: they have different names.
//
// Type of dataset (decision D-23, api.md v1.8): the install spec carries
// `datasetType`, "default" or "ecommerce". The job remembers it, and status
// reports it as `existingType`.
//
// One type per dataset (api.md v1.11): a dataset the installer creates carries
// the label `dataset-type`. A request of another type on a dataset that holds
// tables answers 409 CONFLICT in every step that leads to writing, and fails
// the preflight check "dataset". A dataset without the label is "ecommerce"
// when it holds tables, and takes the type of the request when it is empty.
//
// The daily refresh is a choice (decision D-31, api.md v1.14): the install
// spec carries `dailyRefresh`, true or false, default true. The job remembers
// it, as the label `daily-refresh` does in the real project; a job the mock
// starts with carries no label and reads as true. With false, create-schedule
// creates nothing and answers `skipped: true`, the preflight counts 19
// permissions and 4 APIs, and an install is complete without a schedule.
//
// The period of the history (decision D-34, api.md v1.16): the install spec
// may carry `historyEnd`, the last day of the history, only without the daily
// refresh. run-backfill refuses a period that neither touches nor overlaps the
// days the dataset holds. The status and `existing` report `historyDays` and
// `historyEnd` of an install without the daily refresh. The mock keeps the
// days a dataset holds as one range, from its first to its last day.
//
// GET /api/install/existing (api.md v1.8) finds what the installer left in a
// project without a dataset name: every install, in every region the app
// offers when no region is given, and every labelled dataset. Since api.md
// v1.15 it also names every dataset of the project, whoever created it
// (`datasetNames`). Since v2.0 `installs` lists every install found, each
// with its `installId` (null for an install made before v2.0), and `install`
// is the first of them.
//
// Regions (api.md v1.9 and v2.0): a job and its schedule live in one region.
// Status, the steps and the check "names" read the region they are given. An
// install names an offered region only.
//
// Mock only, no sign-in needed:
//   POST /mock/end-sessions  ends every session at once, to see what the app
//                            does when the sign-in ends during an install
//   POST /mock/reset         forgets every install: the mock is as it was when
//                            it started. Sessions stay
//
// Uninstall (decision D-17, api.md v1.4), only with UNINSTALL_ENABLED=true
// (decision D-30, api.md v1.13): removes the schedule, the job and the
// service account, and the dataset only when `deleteDataset` is true. A kept
// dataset keeps its tables, so a later install finds them. Calling it twice is
// harmless. It answers 409 CONFLICT when the job of the install named writes
// to another dataset than the one named. It takes `installId` (api.md v2.0),
// and keeps the shared service account while another install remains.

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 3001);
const SPEED = Number(process.env.MOCK_SPEED ?? 1);
const FLAKY = (process.env.MOCK_FLAKY ?? "0") === "1";
const MANY_PROJECTS = Number(process.env.MOCK_MANY_PROJECTS ?? 0);
// The address a visitor writes to (decision D-35). One setting, as in the real API.
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL ?? "").trim() || "support@superformlabs.eu";
const REPORT = `If it keeps failing, please report it to ${SUPPORT_EMAIL}.`;
// The image the mock pretends to install. It exists nowhere.
const MOCK_IMAGE = "registry.example/mock/ga4synth:mock";
const COOKIE = "ga4fake_session";
const STATE_COOKIE = "ga4fake_oauth_state";
// Where the browser lands after sign-in, like the real API's APP_URL. Empty
// means a relative redirect, which works on whatever port the UI is using.
const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");

const PROJECTS = [
  { projectId: "your-project-id", displayName: "My Project 5346" },
  { projectId: "northmoor-demo", displayName: "Northmoor Supply demo" },
  { projectId: "no-billing-project", displayName: "Project without billing (mock)" },
  { projectId: "forbidden-project", displayName: "Project you cannot edit (mock)" },
  { projectId: "installed-project", displayName: "Project already installed (mock)" },
  { projectId: "lost-dataset-project", displayName: "Project whose dataset was deleted (mock)" },
  { projectId: "fixable-project", displayName: "Project you fix, then try again (mock)" },
  { projectId: "warnings-project", displayName: "Project with warnings (mock)" },
  { projectId: "existing-dataset-project", displayName: "Project with a dataset of its own (mock)" },
  { projectId: "crowded-project", displayName: "Project with many datasets (mock)" },
  { projectId: "flaky-project", displayName: "Project where a step fails once (mock)" },
  { projectId: "slow-account-project", displayName: "Project where Google is slow (mock)" },
  { projectId: "failing-run-project", displayName: "Project where the last step fails once (mock)" },
  { projectId: "rejected-project", displayName: "Project where Google rejects a request (mock)" },
  { projectId: "no-image-project", displayName: "Project that meets a fault on our side (mock)" },
  { projectId: "leftover-project", displayName: "Project with a leftover dataset (mock)" },
  { projectId: "kept-dataset-project", displayName: "Project with a dataset kept from an earlier install (mock)" },
  { projectId: "two-installs-project", displayName: "Project with two installs (mock)" },
  { projectId: "taken-name-project", displayName: "Project where the first name is taken (mock)" },
  { projectId: "taken-number-project", displayName: "Project where the first number is taken (mock)" },
  { projectId: "taken-at-step-project", displayName: "Project where a number is taken at a step (mock)" },
];
for (let i = 1; i <= MANY_PROJECTS; i++) {
  const n = String(i).padStart(3, "0");
  PROJECTS.push({ projectId: `team-project-${n}`, displayName: `Team project ${n}` });
}

// The regions the app offers. The same list as the backend's (api.md v1.8).
const REGIONS = ["us-central1", "europe-west1", "europe-west3", "asia-northeast1", "australia-southeast1"];
const DATASET_TYPES = ["default", "ecommerce"];
const LEFTOVER_DATASET = "analytics_774378863";
const SECOND_DATASET = "analytics_770000002";
const LOST_DATASET = "analytics_770000010";
const KEPT_DATASET = "analytics_770000030";
// Where the job writes that holds a name the app asks for, in the two projects of a taken number.
const ELSEWHERE_DATASET = "analytics_770000099";
// The datasets of crowded-project. None was created by the installer.
const CROWDED_DATASETS = ["analytics_770000000", "analytics_771111111", "ga4_export", "sales"];

// The permissions the install needs, and the ones only an uninstall needs.
// The preflight messages count these lists; the numbers are not written anywhere else.
const INSTALL_PERMISSIONS = [
  "resourcemanager.projects.get",
  "resourcemanager.projects.getIamPolicy",
  "resourcemanager.projects.setIamPolicy",
  "serviceusage.services.enable",
  "serviceusage.services.get",
  "serviceusage.services.list",
  "bigquery.datasets.create",
  "bigquery.datasets.get",
  "bigquery.datasets.update",
  "bigquery.datasets.setIamPolicy",
  "iam.serviceAccounts.create",
  "iam.serviceAccounts.get",
  "iam.serviceAccounts.actAs",
  "run.jobs.create",
  "run.jobs.get",
  "run.jobs.update",
  "run.jobs.run",
  "run.jobs.runWithOverrides",
  "run.executions.get",
  "cloudscheduler.jobs.create",
  "cloudscheduler.jobs.get",
  "cloudscheduler.jobs.update",
];
const UNINSTALL_PERMISSIONS = [
  "run.jobs.delete",
  "cloudscheduler.jobs.delete",
  "iam.serviceAccounts.delete",
  "bigquery.datasets.delete",
];
// What the mock's visitor lacks on forbidden-project: everything that creates or changes something.
const READ_ONLY = /\.(get|list|getIamPolicy)$/;
const MISSING_AS_VIEWER = INSTALL_PERMISSIONS.filter((p) => !READ_ONLY.test(p));
// Without the daily refresh the install asks for no permission of Cloud Scheduler, and does not need its API (api.md v1.14).
const neededPermissions = (dailyRefresh) => (dailyRefresh ? INSTALL_PERMISSIONS : INSTALL_PERMISSIONS.filter((p) => !p.startsWith("cloudscheduler.")));
const neededServices = (dailyRefresh) => (dailyRefresh ? REQUIRED_SERVICES : REQUIRED_SERVICES.filter((s) => s !== "cloudscheduler.googleapis.com"));
/** The choice a job carries. Only the label `off` means no daily refresh. */
const refreshOfJob = (job) => job.refreshLabel !== "off";
const MISSING_ON_FIXABLE = ["resourcemanager.projects.setIamPolicy", "iam.serviceAccounts.create", "run.jobs.create"];
const ALL_ROLES = ["Project IAM Admin", "Service Usage Admin", "BigQuery Admin", "Service Account Admin", "Service Account User", "Cloud Run Admin", "Cloud Scheduler Admin"];

const console_ = (path, projectId) => `https://console.cloud.google.com/${path}?project=${encodeURIComponent(projectId)}`;

// Titles, messages and hints below repeat the wording of apps/api word for
// word (src/preflight.ts, src/install.ts, src/uninstall.ts, src/cloud.ts,
// src/errors.ts, src/account-retry.ts). tests/mock.test.mjs reads those files
// and fails when a text here is not found there. The UI never reads the
// wording: it shows what arrives.
const TITLES = {
  session: "Your sign-in lasts long enough",
  project: "Project exists and you can see it",
  billing: "Billing is linked",
  permissions: "You have the permissions the install needs",
  names: "The names of this install are free",
  dataset: "The dataset name is free to use",
  apis: "Google Cloud APIs",
  image: "Our generator image is available",
  "org-policy": "No organisation policy blocks the install",
};
const CHECK_IDS = Object.keys(TITLES);
const REQUIRED_SERVICES = [
  "run.googleapis.com",
  "cloudscheduler.googleapis.com",
  "bigquery.googleapis.com",
  "iam.googleapis.com",
  "cloudresourcemanager.googleapis.com",
];

const STEPS = [
  "enable-apis",
  "create-dataset",
  "create-service-account",
  "deploy-job",
  "create-schedule",
  "run-backfill",
];

const DEFAULTS = {
  datasetId: "analytics_770000001",
  location: "US",
  region: "us-central1",
  historyDays: 90,
  schedule: "0 6 * * *",
  datasetType: "default",
  dailyRefresh: true,
};

// Delays in milliseconds before SPEED is applied.
const DELAY = {
  step: {
    "enable-apis": 300, // answers 202, then takes `apisEnable` more to finish
    "create-dataset": 800,
    "create-service-account": 1200,
    "deploy-job": 1500,
    "create-schedule": 700,
    "run-backfill": 500,
  },
  apisEnable: 4000,
  preflight: 1500,
  existing: 600,
  fixableBroken: 3000, // how long fixable-project stays broken after its first preflight
  uninstall: 2500,
  perTable: 300, // backfill: one events_ table appears every 300 ms
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));

// Days are counted in UTC, as whole numbers since 1970-01-01.
const DAY_MS = 86_400_000;
const today = () => Math.floor(Date.now() / DAY_MS);
const dayOf = (text) => Date.parse(`${text}T00:00:00Z`) / DAY_MS;
const textOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
/**
 * The earliest first day of a history (api.md v2.2, decision D-78): the day
 * Google announced GA4. It replaces the maximum of 400 days, which moved with
 * the clock. The words below are those of apps/api.
 */
const EARLIEST_DAY = "2020-10-14";
/** The earliest day `YYYY-MM-DD` can write, 0000-01-01, as a day number. */
const FIRST_WRITABLE_DAY = Math.round(Date.parse("0000-01-01T00:00:00Z") / DAY_MS);

/** @type {Map<string, {email: string, expiresAt: string}>} */
const sessions = new Map();
/**
 * When each project's first preflight arrived. fixable-project is broken for a
 * short while after that. A time, not a count: in development React runs the
 * page's first check twice, and both must see the same project.
 * @type {Map<string, number>}
 */
const firstPreflightAt = new Map();
/** @type {Map<string, object>} */
const installs = new Map();
/** installed-project and the first install of two-installs-project, both in the usual region. */
const PREINSTALLED = ["installed-project", "two-installs-project"];
/** The name of the job and of the schedule of an install (api.md v2.0). Without `installId`: the name of before v2.0. */
const LEGACY_NAME = "ga4synth-daily";
const nameOf = (installId) => (installId ? `ga4synth-${installId}` : LEGACY_NAME);
const INSTALL_ID_RE = /^[a-z0-9]{6,12}$/;
/** Where a job or a schedule lives: a project, a region and a name. */
const regionKey = (projectId, region, installId = null) => `${projectId}/${region}/${nameOf(installId)}`;
const keyOf = (spec) => regionKey(spec.projectId, spec.region, spec.installId);
/**
 * The jobs of each project, by region and name: the dataset a job writes to,
 * its type, and the install it belongs to (`installId`, null for a job named
 * `ga4synth-daily`). installed-project was installed before v1.8, so its job
 * reads as "ecommerce" (api.md v1.8).
 * @type {Map<string, {projectId: string, region: string, installId: string | null, datasetId: string, datasetType: string | null}>}
 */
const jobs = new Map();
/**
 * The cron expression of the schedule of each project, region and name.
 * @type {Map<string, string>}
 */
const schedules = new Map();
/** Writes a job down with where it lives, so that it can be listed. */
function setJob(projectId, region, installId, job) {
  jobs.set(regionKey(projectId, region, installId), { projectId, region, installId: installId ?? null, ...job });
}
/** The jobs of a project in the regions given, in the order of the regions, then of their names. */
function jobsOf(projectId, regions = REGIONS) {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId && regions.includes(j.region))
    .sort((a, b) => regions.indexOf(a.region) - regions.indexOf(b.region) || nameOf(a.installId).localeCompare(nameOf(b.installId)));
}
/** Projects where the first number asked for has already been given to a job that writes elsewhere. */
const numberTaken = new Set();
/** Projects where create-service-account has already answered its one 502. */
const slowAccountTripped = new Set();
/** Projects where deploy-job has already answered its one rejected request. */
const rejectedTripped = new Set();
/** Projects where run-backfill has already answered its one 502. */
const failingRunTripped = new Set();

/** The mock as it is when it starts. */
function resetState() {
  for (const map of [firstPreflightAt, installs, jobs, schedules]) map.clear();
  slowAccountTripped.clear();
  failingRunTripped.clear();
  rejectedTripped.clear();
  numberTaken.clear();
  // The installs the mock starts with were made before v2.0: their job is named ga4synth-daily.
  for (const projectId of PREINSTALLED) {
    setJob(projectId, DEFAULTS.region, null, { datasetId: DEFAULTS.datasetId, datasetType: "ecommerce" });
    schedules.set(regionKey(projectId, DEFAULTS.region), DEFAULTS.schedule);
    getInstall(projectId, DEFAULTS.datasetId);
  }
  setJob("two-installs-project", "europe-west1", null, { datasetId: SECOND_DATASET, datasetType: "default" });
  schedules.set(regionKey("two-installs-project", "europe-west1"), DEFAULTS.schedule);
  getInstall("two-installs-project", SECOND_DATASET);
  // An install whose dataset was deleted by hand: the job, the schedule and the account are there.
  setJob("lost-dataset-project", DEFAULTS.region, null, { datasetId: LOST_DATASET, datasetType: "ecommerce", location: DEFAULTS.location });
  schedules.set(regionKey("lost-dataset-project", DEFAULTS.region), DEFAULTS.schedule);
  getInstall("lost-dataset-project", LOST_DATASET);
  // The two projects that hold a dataset and no install.
  getInstall("existing-dataset-project", DEFAULTS.datasetId);
  getInstall("leftover-project", LEFTOVER_DATASET);
  getInstall("kept-dataset-project", KEPT_DATASET);
  for (const name of CROWDED_DATASETS) getInstall("crowded-project", name);
}

function installKey(projectId, datasetId) {
  return `${projectId}/${datasetId}`;
}

function getInstall(projectId, datasetId) {
  const key = installKey(projectId, datasetId);
  if (!installs.has(key)) {
    const second = projectId === "two-installs-project" && datasetId === SECOND_DATASET;
    const preinstalled = (PREINSTALLED.includes(projectId) && datasetId === DEFAULTS.datasetId) || second;
    // A dataset that was in the project before the installer came, like a real GA4 export (D-19).
    const foreign =
      (projectId === "existing-dataset-project" && datasetId === DEFAULTS.datasetId) ||
      (projectId === "crowded-project" && CROWDED_DATASETS.includes(datasetId));
    // What an install that stopped after create-dataset leaves behind.
    const leftover = projectId === "leftover-project" && datasetId === LEFTOVER_DATASET;
    // The first name asked for in taken-name-project meets a dataset that is not ours.
    const taken = projectId === "taken-name-project" && ![...installs.keys()].some((k) => k.startsWith(`${projectId}/`));
    // The install of lost-dataset-project: everything but the dataset.
    const lost = projectId === "lost-dataset-project" && datasetId === LOST_DATASET;
    // A dataset of the installer that holds days of long ago, and nothing else of an install.
    const keptOld = projectId === "kept-dataset-project" && datasetId === KEPT_DATASET;
    const there = preinstalled || foreign || leftover || taken || keptOld;
    installs.set(key, {
      apisEnabledAt: there || lost ? 0 : null, // timestamp when enabling finishes, or null
      dataset: there,
      // The ownership label `managed-by`: only datasets the installer created carry it.
      labelled: preinstalled || leftover || keptOld,
      // The label `dataset-type` (api.md v1.11). The datasets the mock starts with were made before it.
      typeLabel: keptOld ? "default" : null,
      location: second ? "EU" : there ? DEFAULTS.location : null,
      // The account exists, holds its project roles and has its entry on this dataset.
      serviceAccount: preinstalled || lost,
      // { startedAt, historyDays }; a run that started long ago has finished.
      // `failed` is a run that stopped with an error: the daily run of a job whose dataset is gone.
      backfill: preinstalled ? { startedAt: 0, historyDays: 90 } : lost ? { startedAt: 0, historyDays: 3, failed: true } : null,
      // The days the dataset held before the latest run, as a range { first, last }: what
      // earlier runs wrote, and what an uninstall that keeps the dataset leaves behind.
      kept: foreign || taken ? { first: today() - 120, last: today() - 1 } : keptOld ? { first: today() - 120, last: today() - 91 } : null,
      flakyTripped: preinstalled || !(FLAKY || projectId === "flaky-project"),
    });
  }
  return installs.get(key);
}

resetState();

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}

/** `extra` holds the optional fields of an error body: `link` and `missing` (api.md v1.6). */
function fail(res, status, code, message, hint, extra = {}) {
  send(res, status, { error: { code, message, hint, ...extra } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.parse(s.expiresAt) < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function requireAuth(req, res) {
  const s = currentSession(req);
  if (!s) {
    fail(
      res,
      401,
      "UNAUTHENTICATED",
      "You are not signed in.",
      "Sign in with Google to continue."
    );
    return null;
  }
  return s;
}

// No `Secure` flag: the mock only ever runs on plain http://localhost.
function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`;
}
function clearedCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
function stateCookie(value) {
  return `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`;
}
function clearedStateCookie() {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** `returnTo` must be a same-origin path: starts with "/" and not with "//". Anything else is "/". */
function safeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATASET_ID_RE = /^[A-Za-z0-9_]{1,1024}$/;
const REGION_RE = /^[a-z]+-[a-z]+[0-9]$/;

/** A real boolean in a body; the words `true` and `false` in a query. Absent: the usual value. Anything else is null. */
function readDailyRefresh(value, fromQuery) {
  if (value === undefined || value === "") return DEFAULTS.dailyRefresh;
  if (typeof value === "boolean") return value;
  if (fromQuery && (value === "true" || value === "false")) return value === "true";
  return null;
}

/**
 * The first day of a history, which is never earlier than `EARLIEST_DAY`
 * (api.md v2.2). Checked with and without `historyEnd`: without it the
 * history ends yesterday. Returns a problem or null, with the words of
 * apps/api.
 */
function firstDayProblem(historyDays, historyEnd) {
  const yesterday = textOf(today() - 1);
  const last = historyEnd ?? yesterday;
  const ends = historyEnd ? `ends on ${last}` : `ends yesterday, ${yesterday} (UTC),`;
  // Counted in day numbers, not in dates: a `historyDays` of a billion would make a date
  // JavaScript cannot write, and that must be a 400 and not a crash. apps/api counts the
  // same way, and names the longest history when no first day can be written.
  const longest = dayOf(last) - dayOf(EARLIEST_DAY) + 1;
  if (historyDays <= longest) return null;
  const first = dayOf(last) + 1 - historyDays;
  if (first < FIRST_WRITABLE_DAY) {
    return { message: `historyDays is ${historyDays}. A history that ${ends} can hold at most ${longest} days. It cannot begin earlier than ${EARLIEST_DAY}, the day GA4 was launched.` };
  }
  const days = `${historyDays} ${historyDays === 1 ? "day" : "days"}`;
  return { message: `A history of ${days} that ${ends} begins on ${textOf(first)}. It cannot begin earlier than ${EARLIEST_DAY}, the day GA4 was launched.` };
}

/**
 * The end of the history (api.md v1.16), with the words of apps/api. Returns
 * [day or null, problem or null]; a problem is { message, hint } when the hint
 * is not the one of a wrong value.
 */
function readHistoryEnd(value, historyDays, dailyRefresh) {
  if (value === undefined || value === null || value === "") return [null, null];
  const day = typeof value === "string" ? value.trim() : "";
  const real = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && textOf(dayOf(day)) === day;
  if (!real) return [null, { message: "historyEnd must be a day of the calendar written as YYYY-MM-DD, for example 2026-06-30." }];
  if (dailyRefresh) {
    return [null, {
      message: "The end of the history cannot be chosen together with the daily refresh.",
      hint: "With the daily refresh the history ends yesterday, so that no day is left without data. To choose the end date, choose no daily refresh in your settings.",
    }];
  }
  const yesterday = textOf(today() - 1);
  if (day > yesterday) return [null, { message: `historyEnd is ${day}. The history cannot end later than yesterday, ${yesterday} (UTC).` }];
  const tooEarly = firstDayProblem(historyDays, day);
  if (tooEarly) return [null, tooEarly];
  return [day, null];
}

/** Validates an InstallSpec from a request body or query. Returns [spec, problem]. */
function readSpec(input, { offeredOnly = true, fromQuery = false } = {}) {
  const spec = {
    projectId: input.projectId,
    datasetId: input.datasetId ?? DEFAULTS.datasetId,
    location: input.location ?? DEFAULTS.location,
    region: input.region ?? DEFAULTS.region,
    historyDays: input.historyDays === undefined ? DEFAULTS.historyDays : Number(input.historyDays),
    schedule: input.schedule ?? DEFAULTS.schedule,
    datasetType: input.datasetType ?? DEFAULTS.datasetType,
    dailyRefresh: readDailyRefresh(input.dailyRefresh, fromQuery),
    // The number of the install (api.md v2.0). Absent: an install made before v2.0.
    installId: input.installId === undefined || input.installId === null || input.installId === "" ? null : input.installId,
  };
  if (spec.installId !== null && (typeof spec.installId !== "string" || !INSTALL_ID_RE.test(spec.installId))) {
    return [null, "installId must be 6 to 12 characters, digits and lowercase letters only."];
  }
  if (typeof spec.projectId !== "string" || !PROJECT_ID_RE.test(spec.projectId)) {
    return [null, "projectId must be a valid Google Cloud project ID (6 to 30 lowercase letters, digits or hyphens)."];
  }
  if (typeof spec.datasetId !== "string" || !DATASET_ID_RE.test(spec.datasetId)) {
    return [null, "datasetId may only contain letters, digits and underscores."];
  }
  if (!Number.isInteger(spec.historyDays) || spec.historyDays < 1) {
    return [null, "historyDays must be a whole number, 1 or more."];
  }
  if (typeof spec.schedule !== "string" || spec.schedule.trim().split(/\s+/).length !== 5) {
    return [null, "schedule must be a cron expression with five fields, for example 0 6 * * *."];
  }
  if (typeof spec.region !== "string" || !REGION_RE.test(spec.region)) {
    return [null, "region must be a Google Cloud region such as us-central1."];
  }
  // An install names an offered region only. Status and uninstall read any region (api.md v1.9).
  if (offeredOnly && !REGIONS.includes(spec.region)) {
    return [null, `region must be one of the regions the app offers: ${REGIONS.join(", ")}. Got ${spec.region}.`];
  }
  if (!DATASET_TYPES.includes(spec.datasetType)) {
    return [null, `datasetType must be one of: ${DATASET_TYPES.join(", ")}.`];
  }
  if (spec.dailyRefresh === null) return [null, "dailyRefresh must be true or false."];
  const [historyEnd, wrongEnd] = readHistoryEnd(input.historyEnd, spec.historyDays, spec.dailyRefresh);
  if (wrongEnd) return [null, wrongEnd];
  spec.historyEnd = historyEnd;
  // Without an end the history ends yesterday, and its first day is checked all the same (api.md v2.2).
  if (!historyEnd) {
    const tooEarly = firstDayProblem(spec.historyDays, null);
    if (tooEarly) return [null, tooEarly];
  }
  return [spec, null];
}

/** Answers a spec that cannot be read: 400, with the hint of a wrong value unless the problem brings its own. */
function refuseSpec(res, problem) {
  const message = typeof problem === "string" ? problem : problem.message;
  const hint = (typeof problem === "object" && problem.hint) || "Correct the value in your settings and try again.";
  return fail(res, 400, "INVALID_ARGUMENT", message, hint);
}

/**
 * The look at a name before a component is created (api.md v2.0): refuses when
 * the job of this name belongs to something else. Asked first in every step.
 */
function conflictsWithExistingJob(res, spec) {
  const conflict = takenOf(spec);
  if (!conflict) return false;
  fail(res, 409, "CONFLICT", conflict.message, conflict.hint, { link: conflict.link, taken: conflict.taken });
  return true;
}

/**
 * Why a job under the name of this install is not the job of this install, or
 * null when it is: it writes into the dataset of the request, with the type
 * and the daily refresh of the request. In the words and in the order of the
 * backend (`jobTakenBy` in apps/api/src/install.ts). A job whose type cannot
 * be read is not rewritten any more: its name is taken (api.md v2.0).
 */
function jobTakenBy(job, spec) {
  if (job.datasetId !== spec.datasetId) return `it writes to dataset ${job.datasetId}, not ${spec.datasetId}`;
  if (job.datasetType === null) return "it does not run a configuration of this installer";
  if (job.datasetType !== spec.datasetType) return `it makes data of type ${job.datasetType}, not ${spec.datasetType}`;
  const has = refreshOfJob(job);
  if (has !== spec.dailyRefresh) return has ? "it was installed with the daily refresh, not without" : "it was installed without the daily refresh, not with";
  return null;
}

/**
 * What stands in the way of this install, or null: a job under the name of
 * this install, in the region of the request, that belongs to something else.
 * `taken` lists the names that are taken. Used by every step and by the
 * preflight check "names", in the words of the backend.
 *
 * The backend also answers `"schedule"`, for a schedule of that name that
 * does not start the job of this install. In the mock a schedule always
 * starts the job of its name, so the mock answers `"job"` only.
 */
function takenOf(spec) {
  // The first number asked for in taken-number-project meets a job that writes elsewhere.
  if (spec.projectId === "taken-number-project" && spec.installId && !numberTaken.has(spec.projectId)) {
    numberTaken.add(spec.projectId);
    setJob(spec.projectId, spec.region, spec.installId, { datasetId: ELSEWHERE_DATASET, datasetType: "default", refreshLabel: "on" });
  }
  const job = jobs.get(keyOf(spec));
  const why = job ? jobTakenBy(job, spec) : null;
  if (why === null) return null;
  return {
    message: `The name ${nameOf(spec.installId)} is taken in project ${spec.projectId}, region ${spec.region}: a Cloud Run job of that name exists, and ${why}.`,
    hint: "Start the install again. It takes names that are free, and changes nothing of what exists.",
    link: console_("run/jobs", spec.projectId),
    taken: ["job"],
  };
}

/** The installs of a project other than the one given, in the offered regions. */
function otherInstalls(spec) {
  return jobsOf(spec.projectId)
    .filter((j) => !(j.region === spec.region && nameOf(j.installId) === nameOf(spec.installId)))
    .map((j) => ({ installId: j.installId, region: j.region, datasetId: j.datasetId }));
}

function notOurDataset(spec) {
  return {
    message: `Dataset ${spec.datasetId} already exists in project ${spec.projectId} and was not created by this installer. Installing would overwrite tables named events_YYYYMMDD in it.`,
    hint: "Start the install again to get another dataset name, or set another name in the Pro settings.",
    link: console_("bigquery", spec.projectId),
  };
}

/** The type of a dataset of the installer (api.md v1.11), or null for an empty one without the label. */
function typeOfDataset(inst) {
  if (inst.typeLabel) return inst.typeLabel;
  return tableCount(inst) > 0 ? "ecommerce" : null;
}

/**
 * One type per dataset (api.md v1.11), as the backend reads it: "ready" when
 * the dataset is of the type asked for, "empty" when it holds no table and is
 * not set to that type, "other" when it holds tables of another type.
 */
function typeState(spec, inst) {
  if (inst.typeLabel === spec.datasetType) return "ready";
  if (tableCount(inst) === 0) return "empty";
  return typeOfDataset(inst) === spec.datasetType ? "ready" : "other";
}

/**
 * The steps that make the job write refuse a dataset of another type (409),
 * and one that create-dataset has not set to the type yet (400). create-dataset
 * itself accepts an empty dataset and sets it. Returns true when it answered.
 */
function refusesType(res, spec, inst, { mayBeEmpty }) {
  const state = typeState(spec, inst);
  if (state === "other") {
    const { message, hint, link } = otherType(spec, inst);
    fail(res, 409, "CONFLICT", message, hint, { link });
    return true;
  }
  if (state === "empty" && !mayBeEmpty) {
    fail(
      res, 400, "INVALID_ARGUMENT",
      `Dataset ${spec.datasetId} in project ${spec.projectId} is not set to type ${spec.datasetType} yet.`,
      "Start the install again. It creates what is missing and keeps what exists.",
      { link: console_("bigquery", spec.projectId) }
    );
    return true;
  }
  return false;
}

function otherType(spec, inst) {
  return {
    message: `Dataset ${spec.datasetId} in project ${spec.projectId} holds data of type ${typeOfDataset(inst)}.`,
    hint: "Start the install again to get another dataset name, or set another name in the Pro settings.",
    link: console_("bigquery", spec.projectId),
  };
}

function otherLocation(spec, inst) {
  return {
    message: `Dataset ${spec.datasetId} already exists in ${spec.projectId} but in location ${inst.location}, not ${spec.location}.`,
    hint: `In your settings, choose ${inst.location} as the location, or use another dataset name.`,
    link: console_("bigquery", spec.projectId),
  };
}

/**
 * Dataset ownership (D-19): the steps that lead to writing into the dataset
 * refuse one the installer did not create. Returns true when it answered.
 */
function refusesDataset(res, spec, inst, { mustExist }) {
  if (!inst.dataset) {
    if (!mustExist) return false;
    fail(
      res, 400, "INVALID_ARGUMENT",
      `Dataset ${spec.datasetId} does not exist in ${spec.projectId} yet.`,
      "Start the install again. It creates what is missing and keeps what exists.",
      { link: console_("bigquery", spec.projectId) }
    );
    return true;
  }
  if (!inst.labelled) {
    const { message, hint, link } = notOurDataset(spec);
    fail(res, 409, "CONFLICT", message, hint, { link });
    return true;
  }
  // One type per dataset (api.md v1.11): checked wherever the ownership is.
  // create-dataset checks the location first, and the type after it.
  return mustExist ? refusesType(res, spec, inst, { mayBeEmpty: false }) : false;
}

/** True when an install has switched on the Google Cloud services in this project. */
function apisOn(projectId) {
  // A project that holds a dataset or a job has its services switched on.
  if (["taken-name-project", "taken-number-project", "taken-at-step-project"].includes(projectId)) return true;
  for (const [key, inst] of installs) {
    if (key.startsWith(`${projectId}/`) && inst.apisEnabledAt !== null && inst.apisEnabledAt <= Date.now()) return true;
  }
  return false;
}

/** How many events_ tables the latest run of the job has written so far. */
function tablesFromRun(inst) {
  if (!inst.backfill || inst.backfill.failed) return 0;
  const elapsed = Date.now() - inst.backfill.startedAt;
  return Math.min(inst.backfill.historyDays, Math.floor(elapsed / (DELAY.perTable * SPEED)));
}

/**
 * The days the dataset holds, from the first to the last day table, or null
 * when it holds none: what it held before the latest run, and what that run
 * has written so far. Holes inside are not looked for, as in the backend.
 */
function daysHeld(inst) {
  if (!inst.dataset) return null;
  let range = inst.kept;
  const written = tablesFromRun(inst);
  if (written > 0) {
    // The run writes its newest day first. A run made before v1.16 knows no end: it ended the day before it ran.
    const last = inst.backfill.end ?? today() - 1;
    const run = { first: last - (written - 1), last };
    range = range ? { first: Math.min(range.first, run.first), last: Math.max(range.last, run.last) } : run;
  }
  return range;
}

/** Tables in the dataset: one for each day it holds. */
function tableCount(inst) {
  const held = daysHeld(inst);
  return held ? held.last - held.first + 1 : 0;
}

function deriveStatus(inst, spec) {
  const now = Date.now();
  // The components of the install named: its job and its schedule (api.md v2.0).
  const key = keyOf(spec);
  const job = jobs.get(key) ?? null;
  let backfill = { state: "none" };
  let tables = { count: 0, first: null, last: null };
  if (inst.backfill) {
    backfill = { state: inst.backfill.failed ? "failed" : tablesFromRun(inst) >= inst.backfill.historyDays ? "succeeded" : "running" };
  }
  const held = daysHeld(inst);
  if (held) {
    const name = (day) => `events_${textOf(day).replace(/-/g, "")}`;
    tables = { count: held.last - held.first + 1, first: name(held.first), last: name(held.last) };
  }
  // What the project says of the period: the arguments of the latest run, for an install
  // without the daily refresh. With it the latest run is a daily one, and says nothing (api.md v1.16).
  const history = job && !refreshOfJob(job) && inst.backfill && !inst.backfill.failed ? inst.backfill : null;
  return {
    apisEnabled: inst.apisEnabledAt !== null && inst.apisEnabledAt <= now ? "done" : "missing",
    dataset: inst.dataset ? "done" : "missing",
    serviceAccount: inst.serviceAccount ? "done" : "missing",
    job: job ? "done" : "missing",
    schedule: schedules.has(key) ? "done" : "missing",
    backfill,
    tables,
    existingDataset: job ? job.datasetId : null,
    existingType: job ? job.datasetType : null,
    // Read from the job. Null when there is no job (api.md v1.14).
    dailyRefresh: job ? refreshOfJob(job) : null,
    historyDays: history ? history.historyDays : null,
    historyEnd: history ? (history.historyEnd ?? null) : null,
  };
}

// ---------- routes ----------

async function handleStep(req, res, step) {
  if (!requireAuth(req, res)) return;
  if (!STEPS.includes(step)) {
    return fail(res, 404, "NOT_FOUND", `There is no install step called "${step}".`, `Use one of: ${STEPS.join(", ")}.`);
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    return fail(res, 400, "INVALID_ARGUMENT", "The request body is not valid JSON.", "This is a bug in the app. Reload the page and try again.");
  }
  const [spec, problem] = readSpec(body);
  if (!spec) return refuseSpec(res, problem);

  const inst = getInstall(spec.projectId, spec.datasetId);
  await sleep(DELAY.step[step]);

  // A job that appears under the name of the install between the check and the step.
  if (step === "deploy-job" && spec.projectId === "taken-at-step-project" && spec.installId && !numberTaken.has(spec.projectId)) {
    numberTaken.add(spec.projectId);
    setJob(spec.projectId, spec.region, spec.installId, { datasetId: ELSEWHERE_DATASET, datasetType: "default", refreshLabel: "on" });
  }
  // The name first (api.md v1.7 and v2.0): asked in every step, before anything
  // is created, so a name that is taken leaves nothing behind.
  if (conflictsWithExistingJob(res, spec)) return;
  const key = keyOf(spec);

  switch (step) {
    case "enable-apis": {
      if (spec.projectId === "no-billing-project") {
        return fail(
          res, 412, "BILLING_DISABLED",
          `Project ${spec.projectId} has no billing account, so Cloud Run cannot be enabled.`,
          "Link a billing account to the project in the Google Cloud console, then try again. The dataset itself costs a few cents a month.",
          { link: console_("billing/linkedaccount", spec.projectId) }
        );
      }
      if (spec.projectId === "forbidden-project") {
        return fail(
          res, 403, "PERMISSION_DENIED",
          `You do not have permission to enable APIs on ${spec.projectId}.`,
          "Ask a project Owner to grant you the Owner role, or this role: Service Usage Admin.",
          { missing: ["serviceusage.services.enable"], link: console_("iam-admin/iam", spec.projectId) }
        );
      }
      if (inst.apisEnabledAt === null) inst.apisEnabledAt = Date.now() + DELAY.apisEnable * SPEED;
      if (inst.apisEnabledAt > Date.now()) {
        return send(res, 202, { step, state: "running", operation: `operations/enable-${randomUUID().slice(0, 8)}` });
      }
      return send(res, 200, { step, state: "done" });
    }
    case "create-dataset":
      if (refusesDataset(res, spec, inst, { mustExist: false })) return;
      if (inst.dataset && inst.location.toUpperCase() !== spec.location.toUpperCase()) {
        const { message, hint, link } = otherLocation(spec, inst);
        return fail(res, 400, "INVALID_ARGUMENT", message, hint, { link });
      }
      if (!inst.dataset) {
        inst.dataset = true;
        inst.labelled = true;
        inst.location = spec.location;
      }
      if (refusesType(res, spec, inst, { mayBeEmpty: true })) return;
      // A new dataset, or an empty one, takes the type of the request.
      if (typeState(spec, inst) === "empty") inst.typeLabel = spec.datasetType;
      return send(res, 200, { step, state: "done" });
    case "create-service-account":
      if (refusesDataset(res, spec, inst, { mustExist: true })) return;
      // A new account needs a moment before Google accepts a grant on it (api.md v1.7).
      if (spec.projectId === "slow-account-project" && !slowAccountTripped.has(spec.projectId)) {
        slowAccountTripped.add(spec.projectId);
        return fail(
          res, 502, "UPSTREAM_ERROR",
          `Google has not finished creating the service account ga4synth@${spec.projectId}.iam.gserviceaccount.com in ${spec.projectId}, so it could not be given its roles yet.`,
          "Try again in a moment. The install continues where it stopped.",
          { link: console_("iam-admin/serviceaccounts", spec.projectId) }
        );
      }
      inst.serviceAccount = true;
      return send(res, 200, { step, state: "done" });
    case "deploy-job":
      if (refusesDataset(res, spec, inst, { mustExist: true })) return;
      // A request of the app that Google refuses is a fault on our side: the hint names the address (api.md v1.17).
      if (spec.projectId === "rejected-project" && !rejectedTripped.has(spec.projectId)) {
        rejectedTripped.add(spec.projectId);
        return fail(
          res, 502, "UPSTREAM_ERROR",
          `Google rejected a request of the app while trying to create the Cloud Run job in ${spec.projectId}. Google said: Invalid value at 'job.template' (mock).`,
          `This is not about your settings. Wait a minute, then try again. ${REPORT}`,
          { link: console_("run/jobs", spec.projectId) }
        );
      }
      if (!inst.flakyTripped) {
        inst.flakyTripped = true;
        return fail(
          res, 502, "UPSTREAM_ERROR",
          `Google returned an error while trying to create the Cloud Run job in ${spec.projectId}. Google said: The service is currently unavailable.`,
          "This is usually temporary. Wait a minute, then try again.",
          { link: console_("run/jobs", spec.projectId) }
        );
      }
      // The job carries the choice of the daily refresh, as the label `daily-refresh` does (api.md v1.14).
      setJob(spec.projectId, spec.region, spec.installId, { datasetId: spec.datasetId, datasetType: spec.datasetType, refreshLabel: spec.dailyRefresh ? "on" : "off" });
      return send(res, 200, { step, state: "done" });
    case "create-schedule":
      // Without the daily refresh nothing is created, and a schedule that exists is left as it is.
      if (!spec.dailyRefresh) return send(res, 200, { step, state: "done", skipped: true });
      schedules.set(key, spec.schedule);
      return send(res, 200, { step, state: "done" });
    case "run-backfill":
      if (!jobs.has(key)) {
        // A dataset that is not ours is refused in the same words with or without a job (api.md v1.7).
        if (inst.dataset && !inst.labelled) {
          const { message, hint, link } = notOurDataset(spec);
          return fail(res, 409, "CONFLICT", message, hint, { link });
        }
        return fail(
          res, 404, "NOT_FOUND",
          `The Cloud Run job ${nameOf(spec.installId)} does not exist in ${spec.projectId} yet.`,
          "Start the install again. It creates what is missing and keeps what exists.",
          { link: console_("run/jobs", spec.projectId) }
        );
      }
      if (refusesDataset(res, spec, inst, { mustExist: true })) return;
      if (spec.projectId === "failing-run-project" && !failingRunTripped.has(spec.projectId)) {
        failingRunTripped.add(spec.projectId);
        return fail(
          res, 502, "UPSTREAM_ERROR",
          `Google returned an error while trying to start the run that fills your dataset in ${spec.projectId}. Google said: The service is currently unavailable.`,
          "This is usually temporary. Wait a minute, then try again.",
          { link: console_("run/jobs", spec.projectId) }
        );
      }
      // A history that still runs is not started twice, and the request is not judged then.
      if (inst.backfill && !inst.backfill.failed && tablesFromRun(inst) < inst.backfill.historyDays) return send(res, 200, { step, state: "done" });
      {
        // No hole by a second history (api.md v1.16, API-24): the period asked touches or overlaps the days held.
        const end = spec.historyEnd ? dayOf(spec.historyEnd) : today() - 1;
        const asked = { first: end - (spec.historyDays - 1), last: end };
        const held = daysHeld(inst);
        if (held && !(asked.first <= held.last + 1 && asked.last >= held.first - 1)) {
          return fail(
            res, 400, "INVALID_ARGUMENT",
            `Dataset ${spec.datasetId} in project ${spec.projectId} holds the days from ${textOf(held.first)} to ${textOf(held.last)}. A history from ${textOf(asked.first)} to ${textOf(asked.last)} would leave the days between them without data.`,
            `In your settings, choose a period that touches or overlaps these days: it begins on ${textOf(held.last + 1)} or earlier, and ends on ${textOf(held.first - 1)} or later.`,
            { link: console_("bigquery", spec.projectId) }
          );
        }
        // What the dataset holds stays; the new run adds its days.
        inst.kept = held;
        inst.backfill = { startedAt: Date.now(), historyDays: spec.historyDays, historyEnd: spec.historyEnd ?? null, end };
      }
      return send(res, 200, { step, state: "done" });
  }
}

async function handleUninstall(req, res) {
  if (!requireAuth(req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch {
    return fail(res, 400, "INVALID_ARGUMENT", "The request body is not valid JSON.", "This is a bug in the app. Reload the page and try again.");
  }
  const bug = "This is a bug in the app. Reload the page and try again.";
  // No default for datasetId here: an uninstall only touches a dataset the visitor named.
  if (typeof body.datasetId !== "string" || !body.datasetId.trim()) {
    return fail(res, 400, "INVALID_ARGUMENT", "datasetId is required: the uninstall must name the dataset of the install to remove.", bug);
  }
  const deleteDataset = body.deleteDataset ?? false;
  if (typeof deleteDataset !== "boolean") {
    return fail(res, 400, "INVALID_ARGUMENT", "deleteDataset must be true or false.", bug);
  }
  const [spec, problem] = readSpec({ projectId: body.projectId, datasetId: body.datasetId, region: body.region, installId: body.installId }, { offeredOnly: false });
  if (!spec) return fail(res, 400, "INVALID_ARGUMENT", problem, "Correct the value in your settings and try again.");

  await sleep(DELAY.uninstall);

  if (spec.projectId === "forbidden-project") {
    return fail(
      res, 403, "PERMISSION_DENIED",
      `You do not have permission to remove the install from ${spec.projectId}.`,
      "Ask a project Owner to uninstall, or to grant you the Owner role."
    );
  }
  // Same rule as install: a visitor cannot remove an install they did not
  // name. Refused before anything is removed, with the wording of apps/api.
  const key = keyOf(spec);
  const existing = jobs.get(key)?.datasetId;
  if (existing && existing !== spec.datasetId) {
    return fail(
      res, 409, "CONFLICT",
      `The install in project ${spec.projectId} writes to dataset ${existing}, not ${spec.datasetId}.`,
      `Nothing was removed. To remove that install, uninstall with dataset ${existing} instead.`
    );
  }
  // Since v1.9 the uninstall looks in every offered region before it removes anything.
  // Since v2.0 the others are the other installs of the project, whatever their region.
  const others = otherInstalls(spec);
  const sameDataset = others.find((o) => o.datasetId === spec.datasetId && o.region !== spec.region);
  if (!existing && sameDataset) {
    return fail(
      res, 409, "CONFLICT",
      `The install in project ${spec.projectId} that writes to dataset ${spec.datasetId} is in region ${sameDataset.region}, not ${spec.region}.`,
      `Nothing was removed. To remove that install, uninstall with region ${sameDataset.region} instead.`
    );
  }
  if (deleteDataset && sameDataset) {
    return fail(
      res, 409, "CONFLICT",
      `Dataset ${spec.datasetId} in project ${spec.projectId} is still used by the install in region ${sameDataset.region}, so it will not be deleted.`,
      `Nothing was removed. Uninstall again without deleting the dataset, or remove the install in region ${sameDataset.region} first.`
    );
  }

  const inst = getInstall(spec.projectId, spec.datasetId);
  // Dataset ownership (D-19): only a dataset the installer created is deleted. Refused before anything is removed.
  if (deleteDataset && inst.dataset && !inst.labelled) {
    return fail(
      res, 409, "CONFLICT",
      `Dataset ${spec.datasetId} in project ${spec.projectId} was not created by this installer, so it will not be deleted.`,
      "Nothing was removed. Uninstall again without deleting the dataset. If you really mean to delete that dataset, do it by hand in the BigQuery console.",
      { link: console_("bigquery", spec.projectId) }
    );
  }
  // The tables written so far stay in the dataset; the run that wrote them goes away with the job.
  inst.kept = daysHeld(inst);
  inst.backfill = null;
  jobs.delete(key);
  schedules.delete(key);
  // The service account belongs to the project and is shared by its installs. It stays while another install remains.
  if (others.length === 0) {
    for (const [k, other] of installs) {
      if (k.startsWith(`${spec.projectId}/`)) other.serviceAccount = false;
    }
  }
  if (deleteDataset) {
    inst.dataset = false;
    inst.labelled = false;
    inst.location = null;
    inst.kept = null;
    inst.typeLabel = null;
  }
  // APIs stay enabled. `datasetDeleted` says the dataset is gone because the
  // visitor asked for it, also on a repeated call.
  return send(res, 200, {
    state: "done",
    datasetDeleted: deleteDataset,
    // Present only when not empty.
    ...(others.length > 0 ? { remainingInstalls: others.map(({ region, datasetId, installId }) => ({ region, datasetId, installId })) } : {}),
  });
}

// ---------- preflight (api.md v1.5 and v1.6, decisions D-18 and D-19) ----------

const roleHint = (roles) =>
  roles.length === 1
    ? `Ask a project Owner to grant you the Owner role, or this role: ${roles[0]}.`
    : `Ask a project Owner to grant you the Owner role, or these roles: ${roles.join(", ")}.`;

/**
 * `uninstallEnabled`: the four permissions of the uninstall are tested only while it is switched on (api.md v1.13).
 * `dailyRefresh`: without it the three permissions of Cloud Scheduler are not tested (api.md v1.14).
 */
function permissionsOutcome(projectId, lacking, lackingRoles, uninstallEnabled, dailyRefresh) {
  const needed = neededPermissions(dailyRefresh);
  const missing = lacking.filter((p) => needed.includes(p));
  const roles = dailyRefresh ? lackingRoles : lackingRoles.filter((r) => r !== "Cloud Scheduler Admin");
  if (missing.length > 0) {
    return {
      state: "fail",
      message: `${missing.length} of ${needed.length} permissions are missing.`,
      missing,
      hint: roleHint(roles),
      link: console_("iam-admin/iam", projectId),
    };
  }
  if (!uninstallEnabled) return { state: "pass", message: `You hold all ${needed.length} permissions.` };
  if (projectId === "warnings-project") {
    return {
      state: "warn",
      message: `You can install, but you will not be able to uninstall: ${UNINSTALL_PERMISSIONS.length} of ${UNINSTALL_PERMISSIONS.length} permissions for that are missing.`,
      missing: UNINSTALL_PERMISSIONS,
      hint: roleHint(["BigQuery Admin", "Service Account Admin", "Cloud Run Admin", "Cloud Scheduler Admin"]),
      link: console_("iam-admin/iam", projectId),
    };
  }
  return { state: "pass", message: `You hold all ${needed.length} permissions, and the ${UNINSTALL_PERMISSIONS.length} needed to uninstall.` };
}

/** The nine checks, in the order of the contract. Reads the mock's state and changes none of it. */
function preflightChecks(spec, session, firstLook, config) {
  const { projectId, datasetId } = spec;
  const out = {};

  const minutes = Math.floor((Date.parse(session.expiresAt) - Date.now()) / 60000);
  out.session =
    minutes >= 15
      ? { state: "pass", message: `Your sign-in is valid for ${minutes} more minutes.` }
      : {
          state: "fail",
          message: `Your sign-in expires in ${Math.max(minutes, 0)} minutes. An install needs at least 15.`,
          hint: "Sign in again, then try again.",
        };

  out.image =
    spec.projectId === "no-image-project"
      ? {
          state: "fail",
          message: `The generator image ${MOCK_IMAGE} does not exist.`,
          hint: `This is a fault on our side, not in your project. Please report it to ${SUPPORT_EMAIL}. The install cannot work until we fix it.`,
        }
      : { state: "pass", message: "The generator image can be downloaded by your project." };

  if (projectId === "missing-project") {
    out.project = {
      state: "fail",
      message: `Project ${projectId} does not exist, was deleted, or your account has no access to it.`,
      hint: "Check the project ID, or choose another project.",
      link: "https://console.cloud.google.com/cloud-resource-manager",
    };
    // Without the project nothing inside it can be known.
    for (const id of ["billing", "permissions", "names", "dataset", "apis", "org-policy"]) {
      out[id] = { state: "unknown", message: `Not checked, because project ${projectId} could not be read.` };
    }
    return CHECK_IDS.map((id) => ({ id, title: TITLES[id], ...out[id] }));
  }
  const displayName = PROJECTS.find((p) => p.projectId === projectId)?.displayName ?? projectId;
  out.project = { state: "pass", message: `Project ${projectId} (${displayName}) is active.` };

  const broken = projectId === "fixable-project" && firstLook;
  out.billing =
    projectId === "no-billing-project" || broken
      ? {
          state: "fail",
          message: `Project ${projectId} has no billing account.`,
          hint: "Link a billing account in the console under Billing, then try again.",
          link: console_("billing/linkedaccount", projectId),
        }
      : { state: "pass", message: `Project ${projectId} has a billing account.` };

  const uninstallOn = config.uninstallEnabled;
  const refresh = spec.dailyRefresh;
  if (projectId === "forbidden-project") out.permissions = permissionsOutcome(projectId, MISSING_AS_VIEWER, ALL_ROLES, uninstallOn, refresh);
  else if (broken) out.permissions = permissionsOutcome(projectId, MISSING_ON_FIXABLE, ["Project IAM Admin", "Service Account Admin", "Cloud Run Admin"], uninstallOn, refresh);
  else out.permissions = permissionsOutcome(projectId, [], [], uninstallOn, refresh);

  // Both need a Google Cloud API that a brand-new project has not switched on yet.
  const on = apisOn(projectId);
  const notSwitchedOn = (api) => ({
    state: "unknown",
    message: `Not checked yet: the ${api} API is not switched on in this project. The install switches it on and checks again at that step.`,
  });
  // The names of the install (api.md v2.0), in the region of the request only.
  const taken = on ? takenOf(spec) : null;
  if (!on) {
    out.names = notSwitchedOn("Cloud Run");
  } else if (taken) {
    out.names = { state: "fail", ...taken };
  } else if (!jobs.has(keyOf(spec))) {
    out.names = { state: "pass", message: `The name ${nameOf(spec.installId)} is free in ${projectId}, region ${spec.region}.` };
  } else {
    out.names = { state: "pass", message: "This project already has this install. Installing again repairs it and changes nothing else." };
  }

  const inst = getInstall(projectId, datasetId);
  if (!on) {
    out.dataset = notSwitchedOn("BigQuery");
  } else if (!inst.dataset) {
    out.dataset = { state: "pass", message: `Dataset ${datasetId} does not exist yet. The install creates it in ${spec.location}.` };
  } else if (!inst.labelled) {
    out.dataset = { state: "fail", ...notOurDataset(spec) };
  } else if (inst.location.toUpperCase() !== spec.location.toUpperCase()) {
    out.dataset = { state: "fail", ...otherLocation(spec, inst) };
  } else if (typeState(spec, inst) === "other") {
    out.dataset = { state: "fail", ...otherType(spec, inst) };
  } else {
    const ours = `Dataset ${datasetId} already exists in ${inst.location} and was created by this installer.`;
    out.dataset =
      typeState(spec, inst) === "ready"
        ? { state: "pass", message: `${ours} It is of type ${spec.datasetType}.` }
        : { state: "pass", message: `${ours} It holds no table yet and takes the type ${spec.datasetType}.` };
  }

  const services = neededServices(spec.dailyRefresh);
  out.apis = on
    ? { state: "pass", message: `All ${services.length} APIs the install needs are already enabled.` }
    : {
        state: "pass",
        message: `The install will enable these ${services.length} APIs: ${services.join(", ")}.`,
        link: console_("apis/dashboard", projectId),
      };

  out["org-policy"] =
    projectId === "warnings-project"
      ? {
          state: "unknown",
          message: "Your account may not read the organisation policies of this project, so they could not be checked.",
          hint: "This does not block the install. If your organisation restricts service accounts or locations, the install stops at that step and says so.",
          link: console_("iam-admin/orgpolicies/list", projectId),
        }
      : { state: "pass", message: "No organisation policy restricts service accounts or locations for this project." };

  return CHECK_IDS.map((id) => ({ id, title: TITLES[id], ...out[id] }));
}

async function handlePreflight(req, res, config) {
  const session = requireAuth(req, res);
  if (!session) return;
  let body;
  try {
    body = await readBody(req);
  } catch {
    return fail(res, 400, "INVALID_ARGUMENT", "The request body is not valid JSON.", "This is a bug in the app. Reload the page and try again.");
  }
  const [spec, problem] = readSpec(body);
  if (!spec) return refuseSpec(res, problem);
  if (!firstPreflightAt.has(spec.projectId)) firstPreflightAt.set(spec.projectId, Date.now());
  const firstLook = Date.now() - firstPreflightAt.get(spec.projectId) < DELAY.fixableBroken * SPEED;
  await sleep(DELAY.preflight);
  const checks = preflightChecks(spec, session, firstLook, config);
  return send(res, 200, { ok: checks.every((c) => c.state !== "fail"), checks });
}

/** `historyDays` and `historyEnd` as the status reports them (api.md v1.16). */
function periodOf(job, inst) {
  const history = job && !refreshOfJob(job) && inst?.backfill && !inst.backfill.failed ? inst.backfill : null;
  return { historyDays: history ? history.historyDays : null, historyEnd: history ? (history.historyEnd ?? null) : null };
}

/**
 * GET /api/install/existing (api.md v1.8): what the installer left in a
 * project. Without a region, every region the app offers is looked at.
 */
function findExisting(projectId, region) {
  const found = [];
  const datasets = [];
  // The name of every dataset of the project, whoever created it (api.md v1.15).
  const datasetNames = [];
  // A project where the services are not switched on reads as "nothing there".
  if (apisOn(projectId)) {
    for (const job of jobsOf(projectId, region ? [region] : REGIONS)) {
      const key = regionKey(projectId, job.region, job.installId);
      const inst = installs.get(installKey(projectId, job.datasetId));
      found.push({
        // Null for an install made before v2.0, whose job is named ga4synth-daily.
        installId: job.installId,
        region: job.region,
        datasetId: job.datasetId,
        datasetType: job.datasetType,
        // Read from the job's arguments when the mock knows them, else from the dataset.
        location: job.location ?? (inst?.dataset ? inst.location : null),
        schedule: schedules.get(key) ?? null,
        dailyRefresh: refreshOfJob(job),
        ...periodOf(job, inst),
      });
    }
    for (const [key, inst] of installs) {
      if (!key.startsWith(`${projectId}/`) || !inst.dataset) continue;
      datasetNames.push(key.slice(projectId.length + 1));
      if (!inst.labelled) continue;
      datasets.push({ datasetId: key.slice(projectId.length + 1), location: inst.location, tables: tableCount(inst), datasetType: typeOfDataset(inst) });
    }
  }
  // `install`, the first of them, stays for the clients of before v2.0.
  return { install: found[0] ?? null, installs: found, datasets, datasetNames: datasetNames.sort(), regionsNotChecked: [] };
}

async function handleExisting(req, res, url) {
  if (!requireAuth(req, res)) return;
  const projectId = url.searchParams.get("projectId");
  const region = url.searchParams.get("region");
  const bad = "Go back and choose the project again.";
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    return fail(res, 400, "INVALID_ARGUMENT", "projectId must be a valid Google Cloud project ID (6 to 30 lowercase letters, digits or hyphens).", bad);
  }
  if (region !== null && !REGION_RE.test(region)) {
    return fail(res, 400, "INVALID_ARGUMENT", "region must be a Google Cloud region such as us-central1.", bad);
  }
  await sleep(DELAY.existing);
  if (projectId === "missing-project") {
    return fail(
      res, 404, "NOT_FOUND",
      `Project ${projectId} does not exist, was deleted, or your account has no access to it.`,
      "Check the project ID, or choose another project.",
      { link: "https://console.cloud.google.com/cloud-resource-manager" }
    );
  }
  return send(res, 200, findExisting(projectId, region));
}

/** Comma separated list from an environment variable or an option, lower-cased, blanks dropped. */
function readList(value) {
  return String(value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/** Sign-in allowlist (D-16): with both lists empty everyone may sign in; else the address or its domain must be listed. */
function emailAllowed(email, config) {
  if (config.allowedEmailDomains.length === 0 && config.allowedEmails.length === 0) return true;
  const address = email.toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return config.allowedEmails.includes(address) || config.allowedEmailDomains.includes(domain);
}

async function route(req, res, config) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { method } = req;
  const path = url.pathname;

  if (method === "GET" && path === "/api/health") {
    return send(res, 200, { ok: true, version: "mock" });
  }
  // Mock only: ends every session, as when the hour of a Google sign-in is over.
  if (method === "POST" && path === "/mock/end-sessions") {
    sessions.clear();
    res.writeHead(204);
    return res.end();
  }
  // Mock only: forgets every install.
  if (method === "POST" && path === "/mock/reset") {
    resetState();
    res.writeHead(204);
    return res.end();
  }

  // ---- auth ----
  if (method === "GET" && path === "/auth/login") {
    // The real API sends the browser to Google. The mock skips straight to the
    // callback. Like the real API (api.md v1.2), it keeps `returnTo` in the
    // state cookie, never in the URL handed to Google.
    const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
    await sleep(300);
    res.writeHead(302, {
      location: "/auth/callback?code=mock-code&state=mock-state",
      "set-cookie": stateCookie(JSON.stringify({ state: "mock-state", returnTo })),
    });
    return res.end();
  }
  if (method === "GET" && path === "/auth/callback") {
    let state = null;
    try {
      state = JSON.parse(parseCookies(req)[STATE_COOKIE] ?? "null");
    } catch {
      state = null;
    }
    const headers = { "set-cookie": [clearedStateCookie()] };
    if (url.searchParams.get("error") === "access_denied") {
      res.writeHead(302, { ...headers, location: `${APP_URL}/?error=PERMISSION_DENIED` });
      return res.end();
    }
    if (url.searchParams.get("error")) {
      res.writeHead(302, { ...headers, location: `${APP_URL}/?error=UPSTREAM_ERROR` });
      return res.end();
    }
    if (!url.searchParams.get("code") || !state || url.searchParams.get("state") !== state.state) {
      res.writeHead(302, { ...headers, location: `${APP_URL}/?error=INVALID_ARGUMENT` });
      return res.end();
    }
    if (!emailAllowed(config.email, config)) {
      // No session cookie: the visitor stays signed out.
      res.writeHead(302, { ...headers, location: `${APP_URL}/?error=ACCOUNT_NOT_ALLOWED` });
      return res.end();
    }
    const token = randomUUID();
    sessions.set(token, {
      email: config.email,
      expiresAt: new Date(Date.now() + config.sessionMinutes * 60 * 1000).toISOString(),
    });
    headers["set-cookie"].push(sessionCookie(token));
    res.writeHead(302, { ...headers, location: `${APP_URL}${safeReturnTo(state.returnTo)}` });
    return res.end();
  }
  if (method === "POST" && path === "/auth/logout") {
    const token = parseCookies(req)[COOKIE];
    if (token) sessions.delete(token);
    res.writeHead(204, { "set-cookie": clearedCookie() });
    return res.end();
  }
  if (method === "GET" && path === "/api/me") {
    const s = requireAuth(req, res);
    if (!s) return;
    return send(res, 200, { email: s.email, expiresAt: s.expiresAt });
  }

  // ---- projects ----
  if (method === "GET" && path === "/api/projects") {
    if (!requireAuth(req, res)) return;
    await sleep(900);
    return send(res, 200, { projects: PROJECTS });
  }

  // ---- install ----
  if (method === "GET" && path === "/api/install/status") {
    if (!requireAuth(req, res)) return;
    const q = Object.fromEntries(url.searchParams);
    const [spec, problem] = readSpec(q, { offeredOnly: false, fromQuery: true });
    if (!spec) return refuseSpec(res, problem);
    await sleep(400);
    return send(res, 200, deriveStatus(getInstall(spec.projectId, spec.datasetId), spec));
  }
  if (method === "GET" && path === "/api/install/existing") {
    return handleExisting(req, res, url);
  }
  const stepMatch = path.match(/^\/api\/install\/steps\/([a-z-]+)$/);
  if (method === "POST" && stepMatch) {
    return handleStep(req, res, stepMatch[1]);
  }
  if (method === "POST" && path === "/api/install/preflight") {
    return handlePreflight(req, res, config);
  }
  // Switched off, the uninstall is a route that does not exist: 404 with or
  // without a session, before the body is read (api.md v1.13).
  if (config.uninstallEnabled && method === "POST" && path === "/api/install/uninstall") {
    return handleUninstall(req, res);
  }

  return fail(res, 404, "NOT_FOUND", `No route for ${method} ${path}.`, "Check the URL against docs/contracts/api.md.");
}

/**
 * @param {{email?: string, allowedEmailDomains?: string, allowedEmails?: string, sessionMinutes?: number, uninstallEnabled?: boolean}} [options]
 *   Each defaults to its environment variable: MOCK_EMAIL, ALLOWED_EMAIL_DOMAINS, ALLOWED_EMAILS, MOCK_SESSION_MINUTES, UNINSTALL_ENABLED.
 */
export function createMockServer(options = {}) {
  const config = {
    email: options.email ?? process.env.MOCK_EMAIL ?? "you@example.com",
    allowedEmailDomains: readList(options.allowedEmailDomains ?? process.env.ALLOWED_EMAIL_DOMAINS),
    allowedEmails: readList(options.allowedEmails ?? process.env.ALLOWED_EMAILS),
    sessionMinutes: Number(options.sessionMinutes ?? process.env.MOCK_SESSION_MINUTES ?? 60),
    // On for "true" only, as in the real API. Off by default (decision D-30).
    uninstallEnabled: options.uninstallEnabled ?? (process.env.UNINSTALL_ENABLED ?? "").trim().toLowerCase() === "true",
  };
  const server = http.createServer((req, res) => {
    route(req, res, config).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        // The words of the real API for a fault on our side. What happened is in the terminal that runs the mock.
        fail(res, 500, "INTERNAL", "Something went wrong on our side.", `Try again in a moment. ${REPORT}`);
      }
    });
  });
  // The mock never closes an idle connection first (task UI-25). Next.js keeps its connections to the mock
  // open to use them again, and sets no time after which it closes them. Node closes an idle connection
  // after 6 seconds by default: a request that Next.js sent at that moment was reset ("Failed to proxy ...
  // ECONNRESET"), and the page got an answer 500. With 0 the side that asks is the only one that closes.
  server.keepAliveTimeout = 0;
  return server;
}

// Start listening when run directly (node mocks/server.mjs), not when imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createMockServer().listen(PORT, () => {
    const uninstall = (process.env.UNINSTALL_ENABLED ?? "").trim().toLowerCase() === "true" ? "on" : "off";
    console.log(`[mock api] listening on http://localhost:${PORT} (speed x${SPEED}, flaky deploy-job: ${FLAKY ? "every project" : "flaky-project only"}, uninstall: ${uninstall})`);
  });
}
