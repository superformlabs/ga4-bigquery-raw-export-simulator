// What the browser tab remembers between two screens, in memory only: the
// list of projects, what a project holds, and the answer of a check made in
// the background. A reload forgets all of it and asks again.

import { getExisting, getProjects, preflight } from "./api";
import type { ExistingResult, InstallSpec, PreflightResult, Project } from "./contract";

const EXISTING_MAX_AGE_MS = 60_000;
const CHECK_MAX_AGE_MS = 5 * 60_000;

type Kept<T> = { at: number; promise: Promise<T> };

let projects: Promise<Project[]> | null = null;
const existing = new Map<string, Kept<ExistingResult>>();
const checks = new Map<string, Kept<PreflightResult>>();

/** Keeps an answer, and forgets a request that failed so that the next one asks again. */
function keep<T>(map: Map<string, Kept<T>>, key: string, promise: Promise<T>): Promise<T> {
  const kept = { at: Date.now(), promise };
  map.set(key, kept);
  promise.catch(() => {
    if (map.get(key) === kept) map.delete(key);
  });
  return promise;
}

export function projectsOnce(): Promise<Project[]> {
  if (!projects) {
    const asked = getProjects().then((r) => (Array.isArray(r?.projects) ? r.projects : []));
    projects = asked;
    asked.catch(() => {
      if (projects === asked) projects = null;
    });
  }
  return projects;
}

/** What the installer left in a project (api.md v1.8). `fresh` asks again. */
export function existingFor(projectId: string, fresh = false): Promise<ExistingResult> {
  const kept = existing.get(projectId);
  if (!fresh && kept && Date.now() - kept.at < EXISTING_MAX_AGE_MS) return kept.promise;
  return keep(existing, projectId, getExisting(projectId));
}

/** Forgets everything the tab remembers. For a visitor who signs out. */
export function forgetAll(): void {
  projects = null;
  existing.clear();
  checks.clear();
}

export function forgetProject(projectId: string): void {
  existing.delete(projectId);
  for (const key of checks.keys()) if (key.startsWith(`${projectId}|`)) checks.delete(key);
}

// The days of history and the refresh time play no part in a check. The choice of the daily refresh does
// (api.md v1.14), and so does the number of the install, whose names the check looks at (api.md v2.0).
const checkKey = (s: InstallSpec) => [s.projectId, s.datasetId, s.location, s.region, s.datasetType, s.dailyRefresh, s.installId ?? ""].join("|");

/**
 * The check before an install (decision D-18). It is asked in the background
 * as soon as the project is chosen, so the answer is usually there when the
 * visitor starts the install. `fresh` asks again: after "Try again", an
 * earlier answer says nothing about what the visitor has fixed since.
 */
export function checkFor(spec: InstallSpec, fresh = false): Promise<PreflightResult> {
  const key = checkKey(spec);
  const kept = checks.get(key);
  if (!fresh && kept && Date.now() - kept.at < CHECK_MAX_AGE_MS) return kept.promise;
  return keep(checks, key, preflight(spec));
}
