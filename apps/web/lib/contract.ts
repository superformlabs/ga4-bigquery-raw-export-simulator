// Types copied from docs/contracts/api.md. Keep them in step with that file.

/** The two configurations of the generator (decision D-23, api.md v1.8). */
export const DATASET_TYPES = ["default", "ecommerce"] as const;
export type DatasetType = (typeof DATASET_TYPES)[number];

/**
 * The regions the app offers for the daily job. The same list as the
 * backend's: GET /api/install/existing looks in these when no region is given
 * (api.md v1.8).
 */
export const REGIONS = ["us-central1", "europe-west1", "europe-west3", "asia-northeast1", "australia-southeast1"] as const;

export type InstallSpec = {
  projectId: string;
  datasetId: string;
  location: string;
  region: string;
  historyDays: number;
  schedule: string;
  datasetType: DatasetType;
  /**
   * The daily refresh is a choice (decision D-31, api.md v1.14). The web app
   * always sends it. Without it the install has no schedule.
   */
  dailyRefresh: boolean;
  /**
   * The last day of the history, YYYY-MM-DD in UTC (decision D-34, api.md
   * v1.16). Absent, the history ends yesterday. Only an install without the
   * daily refresh may carry it: with the daily refresh the backend refuses it.
   */
  historyEnd?: string;
  /**
   * The number of the install (decision D-42, api.md v2.0): 6 to 12 digits and
   * lowercase letters. The web app draws it, and sends it with every new
   * install. The job and the schedule are named `ga4synth-<installId>`.
   * Absent, the request names an install made before v2.0, whose job is
   * `ga4synth-daily`.
   */
  installId?: string;
};

export const INSTALL_DEFAULTS: Omit<InstallSpec, "projectId"> = {
  datasetId: "analytics_770000001",
  location: "US",
  region: "us-central1",
  historyDays: 90,
  schedule: "0 6 * * *",
  datasetType: "default",
  dailyRefresh: true,
};

export const STEP_NAMES = [
  "enable-apis",
  "create-dataset",
  "create-service-account",
  "deploy-job",
  "create-schedule",
  "run-backfill",
] as const;

export type StepName = (typeof STEP_NAMES)[number];

/**
 * `regionsNotChecked` is present only when a region could not be read while
 * looking for another install (api.md v1.9). It never blocks.
 */
export type StepResponse = (
  // `skipped` is present, and true, only for `create-schedule` of an install without the daily refresh (api.md v1.14).
  | { step: StepName; state: "done"; skipped?: true }
  | { step: StepName; state: "running"; operation: string }
) & { regionsNotChecked?: string[] };

export type StepStatus = "done" | "missing" | "error";
export type BackfillState = "none" | "running" | "succeeded" | "failed";

export type InstallStatus = {
  apisEnabled: StepStatus;
  dataset: StepStatus;
  serviceAccount: StepStatus;
  job: StepStatus;
  schedule: StepStatus;
  backfill: { state: BackfillState };
  tables: { count: number; first: string | null; last: string | null };
  /**
   * The dataset the project's existing job writes to, or null when there is
   * no job (api.md v1.3, decision D-12). It is the bare dataset ID when that
   * dataset is in the same project, `project:dataset` otherwise.
   */
  existingDataset: string | null;
  /**
   * The type of the existing job, or null when there is no job or when its
   * configuration is not one this app writes (api.md v1.8).
   */
  existingType?: DatasetType | null;
  /**
   * The choice of the daily refresh the existing job carries, or null when
   * there is no job (api.md v1.14). Absent from a backend older than v1.14:
   * every install of before has the daily refresh.
   */
  dailyRefresh?: boolean | null;
  /**
   * The days and the last day of the history, read from the latest run of an
   * install without the daily refresh (api.md v1.16). Null with the daily
   * refresh, without a run, and, for `historyEnd`, when the history was asked
   * without an end date.
   */
  historyDays?: number | null;
  historyEnd?: string | null;
};

/** One install found in a project by GET /api/install/existing (api.md v1.8). */
export type ExistingInstall = {
  /** Since api.md v2.0. Null for an install made before v2.0; absent from a backend of before. */
  installId?: string | null;
  region: string;
  datasetId: string;
  /** Null when the job's configuration paths are not ours. */
  datasetType: DatasetType | null;
  location: string | null;
  /** Null when the schedule does not exist yet. */
  schedule: string | null;
  /** Since api.md v1.14. An install made before has the daily refresh. */
  dailyRefresh?: boolean;
  /** Since api.md v1.16, as in the status. */
  historyDays?: number | null;
  historyEnd?: string | null;
};

/** A dataset that carries the installer's ownership label (decision D-19). */
export type LabelledDataset = {
  datasetId: string;
  location: string;
  tables: number;
  /** Since api.md v1.11. The app does not depend on it: it takes a dataset again only when it holds no table. */
  datasetType?: DatasetType | null;
};

export type ExistingResult = {
  /** The first of the installs found, or null when there is none. Kept for the clients of before v2.0. */
  install: ExistingInstall | null;
  /**
   * Every install of the project that the backend can find in the offered
   * regions (api.md v2.0). A backend of before v2.0 leaves it empty when the
   * project holds one install: `installsOf` in lib/install.ts reads both.
   */
  installs: ExistingInstall[];
  datasets: LabelledDataset[];
  /**
   * The name of every dataset of the project, whoever created it (api.md
   * v1.15). Empty when BigQuery is switched off or the list is refused: the
   * app then proposes a name as before, and the guard of the backend holds.
   */
  datasetNames: string[];
  /** Regions that answered an error other than "not switched on". */
  regionsNotChecked: string[];
};

/** Body of POST /api/install/uninstall (api.md v1.4, decision D-17). */
export type UninstallRequest = {
  projectId: string;
  region: string;
  datasetId: string;
  /** When true the dataset and all its tables are deleted too. */
  deleteDataset: boolean;
  /** The number of the install to remove (api.md v2.0). Absent for an install made before v2.0. */
  installId?: string;
};

export type UninstallResponse = {
  state: "done";
  datasetDeleted: boolean;
  /** The installs the project still holds in other regions. Present only when not empty (api.md v1.9). */
  remainingInstalls?: { region: string; datasetId: string }[];
  regionsNotChecked?: string[];
};

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  // Only ever seen as /?error=ACCOUNT_NOT_ALLOWED after a refused sign-in (D-16).
  | "ACCOUNT_NOT_ALLOWED"
  | "BILLING_DISABLED"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

/**
 * `link` and `missing` are optional and mean the same as in a preflight
 * check (api.md v1.6): a console page where the problem can be fixed, and
 * the names of missing permissions.
 */
export type ApiErrorBody = {
  error: { code: ErrorCode; message: string; hint: string; link?: string; missing?: string[]; taken?: string[] };
};

/** Preflight, POST /api/install/preflight (api.md v1.5, decision D-18). */
export type CheckState = "pass" | "fail" | "warn" | "unknown";

export type PreflightCheck = {
  /** `session`, `project`, `billing`, `permissions`, `names`, `dataset`, `apis`, `image` or `org-policy`. */
  id: string;
  title: string;
  state: CheckState;
  message?: string;
  hint?: string;
  link?: string;
  missing?: string[];
  /**
   * Only on the check `names`, when it fails (api.md v2.0): the names of the
   * install that something else holds, `"job"` and `"schedule"`.
   */
  taken?: string[];
};

export type PreflightResult = {
  /** True when no check is `fail`. `warn` and `unknown` never block the install. */
  ok: boolean;
  checks: PreflightCheck[];
};

export type Me = { email: string; expiresAt: string };
export type Project = { projectId: string; displayName: string };
export type ProjectList = { projects: Project[] };
