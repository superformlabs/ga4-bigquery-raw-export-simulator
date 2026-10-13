// The install as the visitor sees it: one line per step that sets something up, how each step reads
// its result back from GET /api/install/status, and the address of the page.

import type { ExistingInstall, ExistingResult, InstallSpec, InstallStatus, StepName } from "./contract";
import { draftFromParams, paramsFromDraft, specFromDraft, type Draft } from "./flow";
import { hourOfSchedule } from "./wording";

export type StepInfo = {
  name: StepName;
  /** The line shown on the installing page. */
  line: (spec: InstallSpec) => string;
  /**
   * The technical detail of the line (decision D-76): the Google service the
   * step uses and the exact names it creates, as the Google Cloud console
   * shows them. Shown plainly under the line, with no button and no window
   * (decision D-66). The names are those of `docs/contracts/api.md`, section
   * "v2.0" and section "Install".
   */
  detail: (spec: InstallSpec) => string;
  /** True when the status endpoint says this step's result already exists. */
  isDone: (status: InstallStatus) => boolean;
  /** True when the status endpoint reports the step's result as broken. */
  isError: (status: InstallStatus) => boolean;
};

/** The Google services an install can switch on, in the order the backend asks for them (api.md, section "Install"). */
const SERVICES = ["run", "cloudscheduler", "bigquery", "iam", "cloudresourcemanager"] as const;

/** The one service that only the daily schedule needs (api.md v1.14). */
const SCHEDULER_SERVICE = "cloudscheduler";

/**
 * The services `enable-apis` switches on for this install: the five, or the
 * four without Cloud Scheduler when there is no daily refresh (api.md v1.14,
 * `requiredServices` in the backend's `src/install.ts`). Without the daily
 * refresh Cloud Scheduler is never switched on, so the line must not name it.
 */
const servicesOf = (spec: Pick<InstallSpec, "dailyRefresh">) =>
  spec.dailyRefresh ? SERVICES : SERVICES.filter((s) => s !== SCHEDULER_SERVICE);

/** The service account of a project, shared by its installs (api.md v2.0). */
const accountOf = (spec: Pick<InstallSpec, "projectId">) => `ga4synth@${spec.projectId}.iam.gserviceaccount.com`;

export const STEP_INFO: StepInfo[] = [
  {
    name: "enable-apis",
    line: () => "Switching on the Google services",
    detail: (spec) => `${servicesOf(spec).join(", ")} in project ${spec.projectId}`,
    isDone: (s) => s.apisEnabled === "done",
    isError: (s) => s.apisEnabled === "error",
  },
  {
    name: "create-dataset",
    line: (spec) => `Creating the dataset ${spec.datasetId}`,
    detail: (spec) => `BigQuery dataset ${spec.datasetId}, location ${spec.location}`,
    isDone: (s) => s.dataset === "done",
    isError: (s) => s.dataset === "error",
  },
  {
    name: "create-service-account",
    line: () => "Creating the service account",
    // The roles are those the step grants (api.md, section "Install"). The account is one for the project,
    // shared by its installs, and each install gives it the right to write into its own dataset (api.md v2.0).
    detail: (spec) =>
      `${accountOf(spec)}, with roles/bigquery.jobUser and roles/run.invoker on the project and WRITER on ${spec.datasetId}`,
    isDone: (s) => s.serviceAccount === "done",
    isError: (s) => s.serviceAccount === "error",
  },
  {
    name: "deploy-job",
    // Without the daily refresh the job is not daily: it fills the dataset once (design notes, P-10).
    line: (spec) => (spec.dailyRefresh ? "Creating the daily job" : "Creating the job"),
    detail: (spec) => `Cloud Run job ${jobNameOf(spec)}, region ${spec.region}`,
    isDone: (s) => s.job === "done",
    isError: (s) => s.job === "error",
  },
  {
    name: "create-schedule",
    line: (spec) => {
      const hour = hourOfSchedule(spec.schedule);
      return hour ? `Scheduling the daily refresh at ${hour} UTC` : `Scheduling the daily refresh (${spec.schedule}, UTC)`;
    },
    detail: (spec) => `Cloud Scheduler job ${jobNameOf(spec)}, region ${spec.region}, cron ${spec.schedule} UTC`,
    isDone: (s) => s.schedule === "done",
    isError: (s) => s.schedule === "error",
  },
  {
    // The last step, which starts the run that fills the dataset. It is the
    // last line of the list since decision D-90, which gives it the line
    // decision D-32 withheld. Its words follow how far the run has got, so
    // they are not written here but in `runLine` (lib/wording.ts), and the
    // page chooses between them (`components/Install.tsx`); the words below
    // are the first of the four, the one shown before the run starts.
    name: "run-backfill",
    line: () => "Starting the Cloud Run job",
    // The same detail as the job's own line, which is the job this run starts. The page adds the days
    // of history to it when it knows them (decision D-90).
    detail: (spec) => `Cloud Run job ${jobNameOf(spec)}, region ${spec.region}`,
    // The backfill state comes from the job's latest execution. Only count it
    // as done for this dataset when a run is in progress or tables have landed.
    isDone: (s) => s.backfill.state === "running" || (s.backfill.state === "succeeded" && s.tables.count > 0),
    isError: (s) => s.backfill.state === "failed",
  },
];

/**
 * The steps of an install, in order. Without the daily refresh the schedule
 * is left out: no line is shown for it and no request is sent (decision
 * D-31, api.md v1.14).
 */
export function stepsOf(spec: Pick<InstallSpec, "dailyRefresh">): StepInfo[] {
  return spec.dailyRefresh ? STEP_INFO : STEP_INFO.filter((s) => s.name !== "create-schedule");
}

/**
 * The choice of the daily refresh of an install: what its job says, and the
 * choice of the request while no job exists. An install made before v1.14
 * says nothing and has the daily refresh.
 */
export function refreshOf(status: InstallStatus, spec: Pick<InstallSpec, "dailyRefresh">): boolean {
  if (status.job === "done") return status.dailyRefresh !== false;
  return status.dailyRefresh ?? spec.dailyRefresh;
}

/**
 * True when everything an install sets up is in the project, for this
 * dataset: the services, the dataset, the service account, the job, and the
 * schedule unless the install has no daily refresh (api.md v1.14).
 *
 * It does not read `backfill` or `tables`, so it says nothing about the
 * data: it answers true for an install whose dataset is empty, and for one
 * whose run stopped. True here is not "complete". A caller that means "this
 * install is finished" must read the state of the run as well, the way
 * `begin` of `components/Install.tsx` does on each of its three ways out, or
 * ask `historyToRun` below. Without that guard a page would call an install
 * done and never send `run-backfill` (decision D-44, section D of
 * `tests/qa-7-staging.md`, task UI-27).
 */
export function isInPlace(status: InstallStatus, spec: InstallSpec): boolean {
  return (
    status.apisEnabled === "done" &&
    status.dataset === "done" &&
    status.serviceAccount === "done" &&
    status.job === "done" &&
    (status.schedule === "done" || status.dailyRefresh === false) &&
    status.existingDataset === spec.datasetId
  );
}

const HISTORY = STEP_INFO[STEP_INFO.length - 1];

/** True when the history of this install would be generated by the last step: none has arrived, or the last run stopped. */
export function historyToRun(status: InstallStatus): boolean {
  return !HISTORY.isDone(status) || HISTORY.isError(status);
}

/** The install page reads the same parameters as the questions, and needs all of a spec. */
export function installFromParams(q: { get(name: string): string | null }): { spec: InstallSpec; draft: Draft } | null {
  const draft = draftFromParams(q);
  const spec = specFromDraft(draft);
  return spec ? { spec, draft } : null;
}

/**
 * The address of the install page. `key` names the visitor's wish kept in
 * the browser tab, when there is one.
 */
export function installUrl(draft: Draft, spec: InstallSpec, key: string | null): string {
  const p = paramsFromDraft({
    ...draft,
    projectId: spec.projectId,
    datasetId: spec.datasetId,
    datasetType: spec.datasetType,
    location: spec.location,
    region: spec.region,
    historyDays: spec.historyDays,
    schedule: spec.schedule,
    dailyRefresh: spec.dailyRefresh,
    historyEnd: spec.historyEnd ?? null,
    installId: spec.installId ?? "",
  });
  if (key) p.set("go", key);
  return `/install?${p}`;
}

/** The name of the job and of the schedule of an install (api.md v2.0). Without a number: the name of before v2.0. */
export function jobNameOf(spec: Pick<InstallSpec, "installId">): string {
  return spec.installId ? `ga4synth-${spec.installId}` : "ga4synth-daily";
}

/**
 * The installs of a project, from the answer of `existing`. Since api.md v2.0
 * `installs` lists them all. A backend of before v2.0 lists them only when
 * there are several, and names the only one in `install`.
 */
export function installsOf(found: Pick<ExistingResult, "install" | "installs">): ExistingInstall[] {
  if (found.installs.length > 0) return found.installs;
  return found.install ? [found.install] : [];
}

/**
 * The install of the project that an address names, or null (api.md v2.0): the
 * one of its number, in its region, that writes into its dataset. An address
 * without a number names an install made before v2.0. An install of that
 * number that writes elsewhere is not this one: its name is taken.
 */
export function installOfAddress(found: Pick<ExistingResult, "install" | "installs">, spec: Pick<InstallSpec, "installId" | "region" | "datasetId">): ExistingInstall | null {
  return installsOf(found).find((i) => (i.installId ?? "") === (spec.installId ?? "") && i.region === spec.region && i.datasetId === spec.datasetId) ?? null;
}
