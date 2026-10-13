// The only place the browser talks to the backend. Every path is same-origin:
// next.config.ts forwards /api/* and /auth/* to API_URL, so the session cookie
// set by the backend belongs to this origin.

import type {
  ApiErrorBody,
  ErrorCode,
  ExistingResult,
  InstallSpec,
  InstallStatus,
  Me,
  PreflightResult,
  ProjectList,
  StepName,
  StepResponse,
  UninstallRequest,
  UninstallResponse,
} from "./contract";

export class ApiRequestError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly status: number;
  /** A console page where the problem can be fixed, when the backend names one. */
  readonly link?: string;
  /** Names of the permissions that are missing, when that is the problem. */
  readonly missing?: string[];
  /** The names of the install that something else holds, "job" and "schedule" (api.md v2.0). Empty when none is. */
  readonly taken: string[];
  /** True when the answer was not one of the backend: nothing in it is about the visitor or their project. */
  readonly unread: boolean;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    hint: string,
    extra: { link?: string; missing?: string[]; unread?: boolean; taken?: string[] } = {}
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.link = extra.link;
    this.missing = extra.missing;
    this.taken = extra.taken ?? [];
    this.unread = extra.unread === true;
  }

  /**
   * True for a failure that says nothing about the visitor or the project:
   * no answer at all, an answer nobody could read, or an error on the side of
   * the server or of Google (500 and above). Asking again is likely to work.
   */
  get passing(): boolean {
    return this.status === 0 || this.unread || this.status >= 500;
  }
}

function isErrorBody(x: unknown): x is ApiErrorBody {
  return (
    typeof x === "object" &&
    x !== null &&
    "error" in x &&
    typeof (x as ApiErrorBody).error?.code === "string"
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiRequestError(0, "INTERNAL", "The app got no answer", "Check your internet connection, then try again");
  }

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    if (isErrorBody(body)) {
      const { code, message, hint, link, missing, taken } = body.error;
      throw new ApiRequestError(res.status, code, message, hint, {
        link: typeof link === "string" ? link : undefined,
        missing: Array.isArray(missing) ? missing.filter((m) => typeof m === "string") : undefined,
        taken: Array.isArray(taken) ? taken.filter((t) => typeof t === "string") : undefined,
      });
    }
    // An answer that is not the backend's own, from something between the browser and it.
    throw new ApiRequestError(res.status, "INTERNAL", "The app got an answer it could not read", "Try again in a moment", { unread: true });
  }
  return body as T;
}

export function toApiError(e: unknown): ApiRequestError {
  return e instanceof ApiRequestError
    ? e
    : new ApiRequestError(0, "INTERNAL", "Something unexpected went wrong in the browser.", "Reload the page and try again.");
}

export function getMe(): Promise<Me> {
  return request<Me>("/api/me");
}

export function getProjects(): Promise<ProjectList> {
  return request<ProjectList>("/api/projects");
}

/** What "Sign out" calls (decision D-41). */
export function logout(): Promise<void> {
  return request<void>("/auth/logout", { method: "POST" });
}

/**
 * What the status is asked for. `dailyRefresh` is the choice of the request: the backend reads it only while no job
 * exists (api.md v1.14). `installId` names the install whose job and schedule are read (api.md v2.0); without it
 * the backend reads those of an install made before v2.0.
 */
export type StatusQuery = Pick<InstallSpec, "projectId" | "datasetId" | "region"> & Partial<Pick<InstallSpec, "dailyRefresh" | "installId">>;

export function getInstallStatus(spec: StatusQuery): Promise<InstallStatus> {
  const q = new URLSearchParams({
    projectId: spec.projectId,
    datasetId: spec.datasetId,
    region: spec.region,
  });
  if (typeof spec.dailyRefresh === "boolean") q.set("dailyRefresh", String(spec.dailyRefresh));
  if (spec.installId) q.set("installId", spec.installId);
  return request<InstallStatus>(`/api/install/status?${q}`);
}

export function runInstallStep(step: StepName, spec: InstallSpec): Promise<StepResponse> {
  return request<StepResponse>(`/api/install/steps/${step}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
}

/**
 * Read-only: what the installer left in a project, found without a dataset
 * name. No region is sent, so the backend looks in every region the app
 * offers (api.md v1.8). Since api.md v2.0 the app uses the answer for the
 * names, and opens no install from it.
 */
export async function getExisting(projectId: string): Promise<ExistingResult> {
  const raw = await request<Partial<ExistingResult>>(`/api/install/existing?${new URLSearchParams({ projectId })}`);
  return {
    install: raw?.install ?? null,
    installs: Array.isArray(raw?.installs) ? raw.installs : [],
    datasets: Array.isArray(raw?.datasets) ? raw.datasets : [],
    datasetNames: Array.isArray(raw?.datasetNames) ? raw.datasetNames.filter((n) => typeof n === "string") : [],
    regionsNotChecked: Array.isArray(raw?.regionsNotChecked) ? raw.regionsNotChecked : [],
  };
}

// How long to wait before asking again, after a request for the status that failed in passing.
const ASK_AGAIN_AFTER_MS = [1500, 3000, 6000];

/**
 * The status, asked with patience (task UI-10). Over a history of 38 minutes
 * the page asks some 230 times, and one request that fails in passing is
 * likely. So it asks again, three times, before it says anything. A refusal
 * that is about the visitor (sign-in ended, no permission) is said at once.
 */
export async function getInstallStatusPatiently(
  spec: StatusQuery,
  waits: readonly number[] = ASK_AGAIN_AFTER_MS
): Promise<InstallStatus> {
  for (let n = 0; ; n++) {
    try {
      return await getInstallStatus(spec);
    } catch (e) {
      const error = toApiError(e);
      if (!error.passing || n >= waits.length) throw error;
      await new Promise((r) => setTimeout(r, waits[n]));
    }
  }
}

/** Read-only: asks the backend whether the install can work. Changes nothing in the project. */
export function preflight(spec: InstallSpec): Promise<PreflightResult> {
  return request<PreflightResult>("/api/install/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
}

export function uninstall(req: UninstallRequest): Promise<UninstallResponse> {
  return request<UninstallResponse>("/api/install/uninstall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
}
