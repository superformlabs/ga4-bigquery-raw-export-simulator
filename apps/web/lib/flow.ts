// The answers of the visitor travel in the page address, under the names of
// the install spec (docs/contracts/api.md). Nothing here touches the browser,
// so it can be tested with node alone.

import type { DatasetType, InstallSpec, LabelledDataset } from "./contract";

export type Mode = "guided" | "auto" | "pro";
export type Screen = "mode" | "project" | "type" | "location" | "refresh" | "history" | "pro";

const MODES: readonly string[] = ["guided", "auto", "pro"];
const SCREENS: readonly string[] = ["mode", "project", "type", "location", "refresh", "history", "pro"];
const TYPES: readonly string[] = ["default", "ecommerce"];

export const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const DATASET_ID_RE = /^[A-Za-z0-9_]{1,1024}$/;
/** The number of an install: 6 to 12 digits and lowercase letters (api.md v2.0). */
export const INSTALL_ID_RE = /^[a-z0-9]{6,12}$/;
const REGION_RE = /^[a-z]+-[a-z]+[0-9]$/;
const LOCATION_RE = /^[A-Za-z0-9-]{2,40}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real day of the calendar. Written here and not read from dates.ts, so that node can load this file alone. */
const isDay = (v: string) => DAY_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// Written here and not read from contract.ts, so that node can load this file
// without resolving an import. tests/lib.test.mjs checks that they are equal.
export const DEFAULTS = {
  location: "US",
  region: "us-central1",
  historyDays: 90,
  schedule: "0 6 * * *",
  datasetType: "default" as DatasetType,
  dailyRefresh: true,
};

/**
 * One choice sets the BigQuery location and the job region together. Each pair
 * was checked on 2026-09-26: Cloud Run and Cloud Scheduler are both offered in
 * the job region (docs/TASKS.md, third version of the design).
 *
 * Since decision D-90 a button reads the BigQuery location code and nothing
 * else, so `label` is that code and a screen reader hears the same. The
 * names of the places, "United States", "Europe", "Asia" and "Australia",
 * and the hints of decision D-82, text B, are gone from the screen. **What
 * each choice sends is unchanged**: the same location and the same region as
 * before. The Cloud Run region is still shown, in the detail of the job's
 * line on the installing page.
 */
export const PLACES = [
  { id: "us", label: "US", location: "US", region: "us-central1" },
  { id: "eu", label: "EU", location: "EU", region: "europe-west1" },
  { id: "asia", label: "asia-northeast1", location: "asia-northeast1", region: "asia-northeast1" },
  { id: "au", label: "australia-southeast1", location: "australia-southeast1", region: "australia-southeast1" },
] as const;

/** The answers to "Do you want a daily refresh?" (decisions D-31 and D-82). Words approved by the owner. */
export const REFRESH_CHOICES = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
] as const;

export const TYPE_CHOICES = [
  { id: "default", label: "Default" },
  { id: "ecommerce", label: "Ecommerce" },
] as const;

/** Pro: the data locations offered. */
export const LOCATIONS = ["US", "EU", "europe-west1", "us-central1", "asia-northeast1", "australia-southeast1"] as const;
/** Pro: the hours offered for the daily refresh, UTC. */
export const HOURS = ["04:00", "05:00", "06:00", "07:00", "08:00", "09:00"] as const;

/** What the visitor has answered so far. Null means "not answered yet". */
export type Draft = {
  mode: Mode | null;
  projectId: string;
  datasetId: string;
  /** True when the app chose the dataset name. The app may then choose another one. */
  generated: boolean;
  /**
   * The number of the install (decision D-42, api.md v2.0). The app draws it
   * with the dataset name and may draw another one. Empty in an address made
   * before v2.0, which names an install of before.
   */
  installId: string;
  datasetType: DatasetType | null;
  location: string | null;
  region: string | null;
  historyDays: number | null;
  schedule: string | null;
  /** New data every day, or not (decision D-31). */
  dailyRefresh: boolean | null;
  /** The last day of the history, YYYY-MM-DD (decision D-34). Null: yesterday. */
  historyEnd: string | null;
  /** Fixes which wording of a sentence is shown. For tests and screenshots. */
  variant: number | null;
};

type Params = { get(name: string): string | null };

export function draftFromParams(q: Params): Draft {
  const text = (name: string, re: RegExp) => {
    const v = q.get(name);
    return v && re.test(v) ? v : null;
  };
  const mode = q.get("mode");
  const type = q.get("datasetType");
  const days = Number(q.get("historyDays"));
  const schedule = q.get("schedule");
  const refresh = q.get("dailyRefresh");
  const v = q.get("v");
  const datasetId = text("datasetId", DATASET_ID_RE) ?? "";
  return {
    mode: mode && MODES.includes(mode) ? (mode as Mode) : null,
    projectId: text("projectId", PROJECT_ID_RE) ?? "",
    datasetId,
    generated: datasetId !== "" && q.get("gen") === "1",
    // The number travels with the name: without a name there is nothing to number.
    installId: datasetId !== "" ? (text("installId", INSTALL_ID_RE) ?? "") : "",
    datasetType: type && TYPES.includes(type) ? (type as DatasetType) : null,
    location: text("location", LOCATION_RE),
    region: text("region", REGION_RE),
    // A whole number, 1 or more (api.md v2.2). There is no maximum: the earliest first day bounds it, and
    // that is a date, said under the date field (decision D-78, `periodProblem` in lib/dates.ts).
    historyDays: q.get("historyDays") !== null && Number.isInteger(days) && days >= 1 ? days : null,
    schedule: schedule && schedule.trim().split(/\s+/).length === 5 ? schedule.trim() : null,
    dailyRefresh: refresh === "true" ? true : refresh === "false" ? false : null,
    historyEnd: isDay(q.get("historyEnd") ?? "") ? q.get("historyEnd") : null,
    variant: v !== null && /^\d{1,3}$/.test(v) ? Number(v) : null,
  };
}

/**
 * The values of an address that cannot be, each in one sentence (task UI-10).
 * A value that is absent is not wrong: the usual one is taken. A value that
 * is present and cannot be is said, and not replaced by the usual one in
 * silence: the visitor would install something else than the link says.
 */
export function wrongValues(q: Params): string[] {
  const wrong: string[] = [];
  const given = (name: string) => {
    const v = q.get(name);
    return v === null || v === "" ? null : v;
  };
  const say = (name: string, rule: string) => wrong.push(`${name} is "${String(given(name)).slice(0, 60)}". ${rule}`);
  const d = draftFromParams(q);
  if (given("projectId") !== null && !d.projectId) say("projectId", "A project ID has 6 to 30 lowercase letters, digits or hyphens.");
  if (given("datasetId") !== null && !d.datasetId) say("datasetId", "A dataset name has only letters, numbers and underscores.");
  if (given("installId") !== null && !INSTALL_ID_RE.test(String(given("installId")))) say("installId", "The number of an install has 6 to 12 digits or lowercase letters.");
  if (given("datasetType") !== null && !d.datasetType) say("datasetType", "The type is default or ecommerce.");
  if (given("location") !== null && !d.location) say("location", "The location is a BigQuery location such as US, EU or europe-west1.");
  if (given("region") !== null && !d.region) say("region", "The region is a Google Cloud region such as us-central1.");
  if (given("historyDays") !== null && d.historyDays === null) say("historyDays", "The days of history are a whole number, 1 or more.");
  if (given("schedule") !== null && !d.schedule) say("schedule", "The schedule has five fields, for example 0 6 * * *.");
  if (given("dailyRefresh") !== null && d.dailyRefresh === null) say("dailyRefresh", "The daily refresh is true or false.");
  if (given("historyEnd") !== null && !d.historyEnd) say("historyEnd", "The end of the history is a day of the calendar written as YYYY-MM-DD.");
  else if (d.historyEnd && d.dailyRefresh !== false) wrong.push(`historyEnd is "${d.historyEnd}". The end of the history cannot be chosen together with the daily refresh.`);
  if (given("mode") !== null && !d.mode) say("mode", "The experience is guided, auto or pro.");
  return wrong;
}

/** The address parameters of a draft. Only what was answered is written. */
export function paramsFromDraft(d: Draft): URLSearchParams {
  const p = new URLSearchParams();
  if (d.mode) p.set("mode", d.mode);
  if (d.projectId) p.set("projectId", d.projectId);
  if (d.datasetId) p.set("datasetId", d.datasetId);
  if (d.datasetId && d.generated) p.set("gen", "1");
  if (d.datasetId && d.installId) p.set("installId", d.installId);
  if (d.datasetType) p.set("datasetType", d.datasetType);
  if (d.location) p.set("location", d.location);
  if (d.region) p.set("region", d.region);
  if (d.historyDays !== null) p.set("historyDays", String(d.historyDays));
  if (d.schedule) p.set("schedule", d.schedule);
  if (d.dailyRefresh !== null) p.set("dailyRefresh", String(d.dailyRefresh));
  if (d.historyEnd) p.set("historyEnd", d.historyEnd);
  if (d.variant !== null) p.set("v", String(d.variant));
  return p;
}

/** The address of a screen of questions. */
export function questionsUrl(screen: Screen, d: Draft): string {
  const p = paramsFromDraft(d);
  // The name the app chose travels with the project; without a project there is nothing to keep.
  if (screen === "mode") return "/";
  const q = new URLSearchParams({ s: screen });
  p.forEach((v, k) => q.set(k, v));
  return `/?${q}`;
}

/**
 * The screen to show for an address. A screen whose earlier answers are
 * missing falls back to the first question that has no answer.
 */
export function screenFor(s: string | null, d: Draft): Screen {
  const asked = s && SCREENS.includes(s) ? (s as Screen) : "mode";
  if (asked === "mode" || !d.mode) return "mode";
  if (d.mode === "pro") return "pro";
  if (asked === "pro") return "project";
  if (d.mode === "auto" || asked === "project" || !d.projectId) return "project";
  if (asked === "type" || !d.datasetType) return "type";
  if (asked === "location" || !d.location || !d.region) return "location";
  // The app must know whether the dataset grows before it asks for the period (decision D-34).
  if (asked === "refresh" || d.dailyRefresh === null) return "refresh";
  return "history";
}

/** The install a draft describes. What was not answered takes the usual value. Null without a project. */
export function specFromDraft(d: Draft): InstallSpec | null {
  if (!d.projectId || !d.datasetId) return null;
  return {
    projectId: d.projectId,
    datasetId: d.datasetId,
    location: d.location ?? DEFAULTS.location,
    region: d.region ?? DEFAULTS.region,
    historyDays: d.historyDays ?? DEFAULTS.historyDays,
    schedule: d.schedule ?? DEFAULTS.schedule,
    datasetType: d.datasetType ?? DEFAULTS.datasetType,
    dailyRefresh: d.dailyRefresh ?? DEFAULTS.dailyRefresh,
    // With the daily refresh the history ends yesterday, and the request carries no end date (api.md v1.16).
    ...(d.dailyRefresh === false && d.historyEnd ? { historyEnd: d.historyEnd } : {}),
    // Without a number the request names an install made before v2.0 (api.md v2.0).
    ...(d.installId ? { installId: d.installId } : {}),
  };
}

/** The screen the back arrow of the installing page leads to. */
export function questionsBeforeInstall(d: Draft): string {
  if (d.mode === "auto") return questionsUrl("project", { ...d, projectId: "", datasetId: "", generated: false, installId: "" });
  if (d.mode === "pro") return questionsUrl("pro", d);
  if (d.mode === "guided") return questionsUrl("history", d);
  return "/";
}

/** The place whose location and region are the ones given, or null. */
export function placeOf(location: string | null, region: string | null) {
  return PLACES.find((p) => p.location === location && p.region === region) ?? null;
}

/** `analytics_77` followed by seven digits, like the property ID of a GA4 export. */
export function randomDatasetName(random: () => number = Math.random): string {
  let n = "";
  for (let i = 0; i < 7; i++) n += Math.floor(random() * 10);
  return `analytics_77${n}`;
}

/** The nine digits of a name the app proposes, `analytics_77` and seven digits, or "" for any other name. */
export function numberOfName(name: string): string {
  return /^analytics_77\d{7}$/.test(name) ? name.slice("analytics_".length) : "";
}

/** A number for an install whose name is not the app's own: `77` and seven digits, as in a name the app proposes. */
export function randomInstallId(random: () => number = Math.random): string {
  return numberOfName(randomDatasetName(random));
}

const sameLocation = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/**
 * The dataset name of an install whose name the app chooses (Phase 5, item 2;
 * task UI-9). The one place where that name is decided.
 *
 * A labelled dataset in the wanted location that holds no table is a
 * leftover of an install that stopped early: it is used again, so that no
 * second dataset is created. A dataset that holds tables is never taken
 * again: it was kept by an uninstall, and its days may be of another type.
 * A name that is taken, by any labelled dataset or by one in `taken` (the
 * names the backend refused), is replaced by a new one.
 *
 * `names` holds the name of every dataset of the project, whoever created it
 * (decision D-33, api.md v1.15): no name of that list is proposed, except the
 * empty dataset of the installer of the first rule.
 */
export function chooseDatasetName(args: {
  current: string;
  location: string;
  datasets: LabelledDataset[];
  taken?: string[];
  names?: string[];
  draw?: () => string;
}): string {
  const { current, location, datasets } = args;
  const taken = [...(args.taken ?? []), ...(args.names ?? [])];
  const draw = args.draw ?? randomDatasetName;
  // The names the backend refused are never taken again, not even for an empty dataset of the installer.
  const here = datasets.filter((d) => sameLocation(d.location, location) && d.tables === 0 && !(args.taken ?? []).includes(d.datasetId));
  if (current && here.some((d) => d.datasetId === current)) return current;
  if (here.length > 0) return here[0].datasetId;
  const used = new Set([...datasets.map((d) => d.datasetId), ...taken]);
  if (current && !used.has(current)) return current;
  for (let i = 0; i < 50; i++) {
    const name = draw();
    if (!used.has(name)) return name;
  }
  return draw();
}

/** What the app knows of an install of the project: its number, and the dataset it writes into. */
export type KnownInstall = { installId?: string | null; datasetId: string };

/**
 * The name and the number of a new install (decision D-42, api.md v2.0). The
 * one place where both are decided.
 *
 * The number is drawn with the name. For a name the app proposes it is the
 * nine digits of that name, so that a visitor who looks at their project sees
 * which components belong together. For a name the visitor typed, the name
 * stays and the number is drawn, `77` and seven digits.
 *
 * Neither is one the project already uses:
 * - `installs`, the installs of the project: their numbers are taken, and
 *   their datasets are theirs, also while they are still empty;
 * - `takenIds`, the numbers the backend refused: a name whose digits are one
 *   of them is not proposed either;
 * - `taken` and `names`, as in `chooseDatasetName`.
 */
export function chooseInstall(args: {
  current: string;
  currentId: string;
  generated: boolean;
  location: string;
  datasets: LabelledDataset[];
  installs?: KnownInstall[];
  taken?: string[];
  takenIds?: string[];
  names?: string[];
  draw?: () => string;
  drawId?: () => string;
}): { datasetId: string; installId: string } {
  const installs = args.installs ?? [];
  const usedIds = new Set([...(args.takenIds ?? []), ...installs.map((i) => i.installId ?? "").filter(Boolean)]);
  const drawId = args.drawId ?? randomInstallId;
  const freeId = (wanted: string) => {
    if (wanted && INSTALL_ID_RE.test(wanted) && !usedIds.has(wanted)) return wanted;
    for (let i = 0; i < 50; i++) {
      const id = drawId();
      if (!usedIds.has(id)) return id;
    }
    return drawId();
  };
  // A name the visitor typed stays as it is: what is wrong with it is said under its field.
  if (!args.generated) return { datasetId: args.current, installId: freeId(args.currentId) };

  // The dataset of an install is not a leftover, and a name whose number is taken is no name to propose.
  const theirs = new Set(installs.map((i) => i.datasetId));
  const numbered = (name: string) => usedIds.has(numberOfName(name));
  const datasets = args.datasets.filter((d) => !theirs.has(d.datasetId) && !numbered(d.datasetId));
  const draw = args.draw ?? randomDatasetName;
  const name = chooseDatasetName({
    current: args.current && !theirs.has(args.current) && !numbered(args.current) ? args.current : "",
    location: args.location,
    datasets,
    taken: args.taken,
    names: [...(args.names ?? []), ...theirs],
    draw: () => {
      for (let i = 0; i < 50; i++) {
        const drawn = draw();
        if (!numbered(drawn)) return drawn;
      }
      return draw();
    },
  });
  // The number of the name. A leftover under a name that is not the app's own takes a number that is drawn.
  return { datasetId: name, installId: freeId(numberOfName(name) || (name === args.current ? args.currentId : "")) };
}

/**
 * What identifies the visitor's wish to install: everything but the dataset
 * name and the number, which the app may change. Kept in the browser tab next
 * to a random key, so that a link alone cannot start an install.
 */
/**
 * True when a name the visitor typed is taken: a dataset of that name is in
 * the project, and the installer did not create it (decision D-33). A dataset
 * of the installer may be named again: it is the visitor's to use.
 */
export function isNameTaken(name: string, found: { datasets: LabelledDataset[]; datasetNames: string[] } | null): boolean {
  if (!found || !name) return false;
  return found.datasetNames.includes(name) && !found.datasets.some((d) => d.datasetId === name);
}

export function wishOf(spec: InstallSpec): string {
  return [spec.projectId, spec.location, spec.region, spec.historyDays, spec.schedule, spec.datasetType, spec.dailyRefresh, spec.historyEnd ?? ""].join("|");
}
