// The sentences of the app that are not tied to one screen.

import type { InstallStatus } from "./contract";

/**
 * The address a visitor writes to (decision D-35). The backend has a setting
 * of its own, `SUPPORT_EMAIL`, with the same value; this one serves the lines
 * that are the web app's own.
 */
export const SUPPORT_EMAIL = "support@superformlabs.eu";

/**
 * Where "Report a bug" leads (decision D-77). One setting, meant for the
 * new-issue page of a public GitHub repository. That repository does not
 * exist yet, so the setting is empty, and while it is empty the link opens an
 * email to `SUPPORT_EMAIL` instead.
 *
 * When it is set, the link opens that address and **nothing is added to it**.
 * An issue of a public repository is readable by everyone, so a project ID or
 * a dataset name put there would be published. What a GitHub issue is
 * pre-filled with is decided when the repository exists (decision D-77).
 */
export const BUG_REPORT_URL: string = "";

/** Where the visitor is when they report a bug. The project and the dataset are there when the app knows them. */
export type BugPlace = { page: string; projectId?: string | null; datasetId?: string | null };

/**
 * The address "Report a bug" opens (decision D-77): `BUG_REPORT_URL` as it
 * is, when it is set; otherwise an email to `SUPPORT_EMAIL`, pre-filled with
 * what helps act on a report. The email carries the project and the dataset
 * because only we read it.
 */
export function bugReportHref(place: BugPlace): string {
  if (BUG_REPORT_URL) return BUG_REPORT_URL;
  // Two questions for the visitor to answer, then where they were, which saves us asking.
  const lines = ["What happened:", "", "What you expected:", "", `Page: ${place.page}`];
  if (place.projectId) lines.push(`Project: ${place.projectId}`);
  if (place.datasetId) lines.push(`Dataset: ${place.datasetId}`);
  const subject = encodeURIComponent("Bug report: GA4 BigQuery Raw Export Simulator");
  const body = encodeURIComponent(`${lines.join("\n")}\n`);
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

const MAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * A text cut where it holds an email address, so that the address can be
 * shown as a link. The full stop that ends a sentence is not part of the
 * address. The name of a service account looks like an address and is none:
 * nobody reads mail there. The texts come from the backend or from the app,
 * never from a link.
 */
export function mailParts(text: string): { text: string; mail: boolean }[] {
  const parts: { text: string; mail: boolean }[] = [];
  let from = 0;
  for (const m of text.matchAll(MAIL_RE)) {
    if (/\.gserviceaccount\.com$/i.test(m[0])) continue;
    const at = m.index ?? 0;
    if (at > from) parts.push({ text: text.slice(from, at), mail: false });
    parts.push({ text: m[0], mail: true });
    from = at + m[0].length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), mail: false });
  return parts;
}

/**
 * The titles that depend on an answer (decision D-41). The period of Guided
 * is asked by the answer to the question before it: with new data every day
 * the dataset stays up to date, so only its start is asked.
 */
export const TITLES = {
  period: "Which period should your dataset cover?",
  periodStart: "When should your data start?",
} as const;

/** The names of the fields that the owner chose himself (decision D-41). */
export const LABELS = {
  dailyRefresh: "Daily Scheduler",
} as const;

/**
 * The welcome title (decision D-93): the full name of the app, on two lines.
 * Line one, then line two. "Welcome to GA4BQRES!" of decision D-90 is gone,
 * and the full name is the title again, as it was under decisions D-81 and
 * D-83.
 *
 * Both lines are drawn at one font size, the size that makes the longer of
 * them fill the width of the text column, and the shorter line is spread with
 * wider letter spacing until it reaches the right edge too
 * (`components/FitTitle.tsx`). So both edges of the title are straight: its
 * left edge is the left edge of the text under it, and so is its right edge.
 *
 * The break is after "Raw", and not after "BigQuery", because it is the one
 * that needs the least spreading of the shorter line: about 0.07 em of extra
 * spacing per letter, against about 0.32 em for the other (measured on the
 * app's font stack, decision D-93).
 *
 * The full name also stays in the browser tab title (`app/layout.tsx`) and in
 * the first words of the welcome text below.
 */
export const WELCOME_TITLE = ["GA4 BigQuery Raw", "Export Simulator"] as const;

/**
 * The welcome text, in the owner's words (decision D-82, text A). Two
 * paragraphs, word for word, in the place of the three of decision D-74. One
 * sentence was written twice: his "We don't collect any data" was first
 * written "We don't store any of your data." by the orchestrator, because the
 * request logs of our own Cloud Run service hold the visitor's IP address and
 * project ID; on 2026-10-12 he replaced that sentence with the one below,
 * which is his own wording.
 *
 * A screen whose subtitle is a list of sentences shows one paragraph for each
 * (`components/Screen.tsx`).
 */
export const WELCOME = [
  "GA4 BigQuery Raw Export Simulator (GA4BQRES) is a free online app that generates a synthetic GA4 raw export dataset in a Google Cloud project you own. The data is designed to mirror GA4 BigQuery export as closely as possible. A step-by-step wizard guides you through the setup.",
  "We don't keep any database or analytics of your data. The app requests only the permissions it needs to run. Sign in with Google to get your synthetic dataset in a few clicks, read the documentation, or check the open source code.",
] as const;

/**
 * The words of the welcome text that are a link to the documentation
 * (decision D-82). They open `DOCS_PATH` in a new tab, as the book in the
 * top-right corner does (decision D-87).
 */
export const WELCOME_DOCS_LINK = "read the documentation";

/**
 * The words of the welcome text that are a link to the public repository
 * (decision D-90). They open `SOURCE_CODE_URL` in a new tab, as the words
 * above do.
 */
export const WELCOME_SOURCE_LINK = "open source code";

/**
 * The subtitle of each screen (decision D-37, design notes N-5 to N-15).
 * `mode`, `location` and `refresh` are the owner's words of decision D-90,
 * which shortened the three of decisions D-41 and D-82. The two period
 * screens are not here: theirs follows the dates (decision D-79,
 * `periodSubtitle`). The last block holds the screens the mock-up does not
 * have; their words are the app's, in the same spirit.
 */
export const SUBTITLES = {
  // Two paragraphs since decision D-82, and the only subtitle that is not one sentence.
  welcome: WELCOME,
  // Decision D-90, in the place of "Guided asks you a few questions. …" of decision D-41.
  mode: "Guided walks you step by step. Automated decides for you. Pro shows every setting.",
  project: "Your dataset is created in the project you choose.",
  type: "Default is a site without a shop. Ecommerce is a site with a shop.",
  // Decision D-90: one sentence, in the place of the three of decision D-82, text B.
  location: "Choose the Google Cloud location of your BigQuery dataset.",
  // Decision D-90: one sentence, in the place of the three of decision D-82, text C. It no
  // longer names the job, the hour, the last 3 days, nor what No does.
  refresh: "With Yes, a Cloud Scheduler job starts your Cloud Run job every day to generate new data.",
  // The two period screens have no fixed subtitle since decision D-79: theirs
  // follows the dates, and is made by `periodSubtitle` below.
  pro: "Every setting, on one page.",
  installing: "We set up everything in your project.",
  nothingInstalled: "Nothing is installed yet.",
  // The end of the install, one sentence for every case (decision D-90): whether the data is
  // still arriving or has arrived, and for an install the address found already in place. It
  // replaces the two wordings of decision D-52 and everything that followed them.
  installed: "Your synthetic dataset has been installed.",

  // Said while the check runs, which is the first line of the installing page (decisions D-18 and D-80).
  check: "Nothing is installed until every check passes.",
  ready: "Nothing is installed until you ask.",
  found: "Nothing is changed until you ask.",
  stopped: "The install stopped before its end.",
  waits: "The install waits for you.",
  onlyLooked: "Nothing was changed in your project.",
  link: "This link cannot be followed as it is.",
  session: "We could not see whether you are signed in.",
} as const;

/**
 * The sentence that starts the install. A visitor sees one wording, "Install it now" (decision D-65). The two
 * others stay reachable by the `v` of the address, which the browser checks use to fix a wording.
 */
export const INSTALL_WORDINGS = ["Install my dataset", "All set, install it", "Install it now"] as const;

/**
 * The wording of the install sentence: the one of decision D-65, unless `variant` names another (the `v` of
 * the address, for tests and screenshots).
 */
export function installWording(variant: number | null): string {
  return INSTALL_WORDINGS[variant === null ? 2 : Math.abs(variant) % INSTALL_WORDINGS.length];
}

/**
 * The pace of the history, in minutes: about 133 seconds to start, then about
 * 2.45 seconds per day. Measured by DEP-10 on staging with the job as the app
 * creates it, 8 CPU, 16 GiB and `--workers 8` (infra/README.md, "The job at
 * 8 CPU, 16 GiB and `--workers 8`", measurement 1).
 *
 * The straight line is too long on purpose. The 90 days of that measurement
 * took 5m17s and the line gives 5m54s, about 11 percent more: 2.45 seconds is
 * the pace of the 82 tables that follow the first eight, and those eight land
 * together. Too long is the safe side for a promise about waiting.
 *
 * The 133 seconds are Cloud Run making the instance ready. They ran from
 * 1m18s to 2m34s across the four executions of that day: a middle value, not
 * a floor.
 */
const historyMinutes = (days: number) => (133 + 2.45 * days) / 60;

/**
 * The minutes of the steps that come before the run that fills the dataset:
 * the check, the Google services, the dataset, the service account, the job
 * and the schedule. One minute, from the "Typical time" column of
 * `docs/contracts/api.md`, not from a measurement. Counted in the time the
 * period screens promise (decision D-79).
 */
const SETUP_MINUTES = 1;

/**
 * How long an install takes, in words: the pace of `historyMinutes` for the
 * days of history, plus the minutes of whatever comes before the run.
 * `extraMinutes` is `SETUP_MINUTES` where a screen promises the whole install
 * (decision D-79), and 0 for the run alone, which the last line of the
 * install's step list promises (decision D-90, `runLine` below; until then no
 * screen showed it, decision D-32). Under an hour the answer is a number of
 * minutes; above, hours and minutes rounded to five minutes.
 *
 * 221 days of history read "about 12 minutes" with the setup minute and
 * "about 11 minutes" without it; 2,188 days, the longest a visitor can ask
 * for on 2026-10-11, read "about 1 hour 35 minutes". Since decision D-78
 * there is no maximum number of days, so the hours are reached for the first
 * time.
 */
export function estimate(days: number, extraMinutes = 0): string {
  const m = Math.round(historyMinutes(days) + extraMinutes);
  if (m <= 1) return "about 1 minute";
  if (m < 60) return `about ${m} minutes`;
  const rounded = Math.round(m / 5) * 5;
  const h = Math.floor(rounded / 60);
  const rest = rounded % 60;
  const hours = h === 1 ? "1 hour" : `${h} hours`;
  return rest === 0 ? `about ${hours}` : `about ${hours} ${rest} minutes`;
}

/**
 * The subtitle of the two period screens (decision D-79): how many days the
 * visitor chose, and how long the install takes. It follows the dates as they
 * change. With the daily refresh the dataset then stays up to date, and the
 * line says so; the line under the dates is used only to say what is wrong.
 *
 * `days` is null while a date is wrong: there are no days to count then, and
 * the screen still needs its one sentence, so the line says what the screen
 * asks for. Nothing here speaks of a limit (decision D-78).
 */
export function periodSubtitle(days: number | null, dailyRefresh: boolean): string {
  if (days === null) {
    return dailyRefresh
      ? "Your data starts on the day you choose, and then stays up to date every morning."
      : "Your dataset covers the period you choose.";
  }
  const chosen = `${plural(days, "day", "days")} of history, ready in ${estimate(days, SETUP_MINUTES)}.`;
  return dailyRefresh ? `${chosen} Your dataset then stays up to date every morning.` : chosen;
}

/**
 * How far the run that fills the dataset has got, as the last line of the
 * install's step list says it (decision D-90). Until then that step had no
 * line at all: the installing page said nothing of the generation of the
 * events (decision D-32).
 *
 *   starting  the steps before it are still running, or nothing has started
 *   running   the run is going
 *   filled    the run succeeded and the dataset holds tables
 *   stopped   the run stopped before the dataset was filled
 */
export type RunState = "starting" | "running" | "filled" | "stopped";

/**
 * The words of that line. While the run is going the line promises a
 * duration: the pace of `estimate` for the days of history, **without** the
 * setup minute, because the steps before the run are done. So 221 days read
 * "about 11 minutes", and a long history reads in hours, the same calculation
 * as the two period screens.
 *
 * `days` is null for an install this tab did not ask for whose status carries
 * no `historyDays`: there is no duration to promise, so the line says only
 * that the dataset is being filled.
 *
 * The page reads the project once and does not follow the run (decision D-52,
 * option b), so this line does not change while the visitor watches. On a
 * reload during the run the duration is counted again from the start, so it
 * overshoots; that is the safe side and is accepted (decision D-90).
 */
export function runLine(state: RunState, days: number | null): string {
  switch (state) {
    case "starting":
      return "Starting the Cloud Run job";
    case "running":
      return days === null
        ? "Cloud Run job is running. Your dataset is being filled."
        : `Cloud Run job is running. Your dataset will be filled in ${estimate(days)}.`;
    case "filled":
      return "Cloud Run job has finished. Your dataset is filled.";
    case "stopped":
      return "Cloud Run job stopped before your dataset was filled.";
  }
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** "06:00" for the cron expression "0 6 * * *"; null for a schedule that is not a plain hour. */
export function hourOfSchedule(schedule: string): string | null {
  const m = /^0 (\d{1,2}) \* \* \*$/.exec(schedule.trim());
  if (!m || Number(m[1]) > 23) return null;
  return `${m[1].padStart(2, "0")}:00`;
}

/** The cron expression for a daily refresh at "HH:00" UTC. */
export function scheduleOfHour(hour: string): string {
  return `0 ${Number(hour.slice(0, 2))} * * *`;
}

/** Only links to the Google Cloud console are shown as links; anything else the backend sends is ignored. */
export function consoleUrl(link: string | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "console.cloud.google.com" ? url.href : null;
  } catch {
    return null;
  }
}

const CONSOLE_PAGES: [RegExp, string][] = [
  [/^\/billing/, "Open Billing"],
  [/^\/iam-admin\/iam/, "Open IAM"],
  [/^\/iam-admin\/serviceaccounts/, "Open Service accounts"],
  [/^\/iam-admin\/orgpolicies/, "Open Organisation policies"],
  [/^\/run/, "Open Cloud Run"],
  [/^\/cloudscheduler/, "Open Cloud Scheduler"],
  [/^\/bigquery/, "Open BigQuery"],
  [/^\/apis/, "Open APIs and services"],
  [/^\/cloud-resource-manager/, "Open your projects"],
];

/** The words of a link to the console, from the page it leads to. */
export function consoleLabel(href: string): string {
  const path = new URL(href).pathname;
  return CONSOLE_PAGES.find(([re]) => re.test(path))?.[1] ?? "Open the Google Cloud console";
}

/** One part of an install, as the project holds it. `stopped` is a part that is there and reports an error. */
export type Part = { key: string; text: string; state: "there" | "missing" | "stopped" };

/**
 * What the project holds of an install, part by part, in plain words (task
 * UI-12). Shown for an install that this browser tab did not ask for and that
 * is not complete: the page says what is there and what is missing, and waits.
 * An install without the daily refresh misses no schedule (decision D-31).
 */
export function partsOf(status: InstallStatus, datasetId: string, dailyRefresh = true): Part[] {
  // Without the daily refresh the job is not daily: it fills the dataset once (design notes, P-10).
  const job = dailyRefresh ? "daily job" : "job";
  const part = (key: string, name: string, now: InstallStatus["job"]): Part => {
    if (now === "done") return { key, text: `${name} is in your project`, state: "there" };
    if (now === "missing") return { key, text: `${name} is missing`, state: "missing" };
    return { key, text: `${name} is in your project, and reports an error`, state: "stopped" };
  };
  const days = status.dataset === "done" ? status.tables.count : 0;
  const parts = [
    part("dataset", `The dataset ${datasetId}`, status.dataset),
    part("account", "The service account", status.serviceAccount),
    part("job", `The ${job}`, status.job),
    dailyRefresh || status.schedule !== "missing"
      ? part("schedule", "The daily schedule", status.schedule)
      : { key: "schedule", text: "No daily schedule, as chosen at the install", state: "there" as const },
  ];
  parts.push(
    days > 0
      ? { key: "history", text: `${plural(days, "day", "days")} of history ${days === 1 ? "is" : "are"} in the dataset`, state: "there" }
      : { key: "history", text: "The history is missing", state: "missing" }
  );
  if (status.job === "done" && status.backfill.state === "failed") {
    parts.push({ key: "run", text: `The last run of the ${job} stopped with an error`, state: "stopped" });
  }
  return parts;
}

