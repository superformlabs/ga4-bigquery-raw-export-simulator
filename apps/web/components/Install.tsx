"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiRequestError, getInstallStatusPatiently as getInstallStatus, runInstallStep, toApiError } from "@/lib/api";
import { loginUrl } from "@/lib/auth";
import { checkFor, existingFor, forgetProject, projectsOnce } from "@/lib/cache";
import { UNINSTALL } from "@/lib/features";
import type { InstallSpec, InstallStatus, PreflightCheck, PreflightResult } from "@/lib/contract";
import { chooseInstall, questionsBeforeInstall, wrongValues, type Draft } from "@/lib/flow";
import {
  historyToRun,
  installFromParams,
  installOfAddress,
  installsOf,
  installUrl,
  isInPlace,
  jobNameOf,
  refreshOf,
  stepsOf,
} from "@/lib/install";
import { bigQueryUrl } from "@/lib/links";
import { useSession } from "@/lib/session";
import { SUBTITLES, SUPPORT_EMAIL, installWording, partsOf, plural, runLine, type RunState } from "@/lib/wording";
import Mailed from "./Mailed";
import { dropWish, holdsWish, keepWish } from "@/lib/wish";
import CheckList, { type Line, type LineState } from "./CheckList";
import Fix from "./Fix";
import Forward, { ForwardLink } from "./Forward";
import Screen, { Waiting } from "./Screen";
import Uninstall, { type UninstallDone } from "./Uninstall";
import Welcome from "./Welcome";

// Every status poll makes the backend ask the visitor's project several
// questions, so poll gently while a step is running.
const STEP_POLL_MS = 3000;
// How often the app draws another name or another number when the one it chose is taken.
const NAME_TRIES = 3;
// Long enough to see the last tick before the page changes.
const LAST_TICK_MS = 650;

type Phase =
  // The page came from a link. It reads the project before it shows anything.
  | { kind: "looking" }
  // The page came from a link and the project holds nothing of this install: it waits for a click.
  | { kind: "confirm" }
  // The project holds a part of this install, and this tab did not ask for it:
  // the page says what is there and what is missing, and waits for a click (task UI-12).
  | { kind: "found" }
  // The check before the install runs, as the first line of the installing page (decision D-80). Nothing is created.
  | { kind: "checking" }
  // The check found something to fix, or could not be made. Nothing was created. The page stays.
  | { kind: "blocked"; problems: PreflightCheck[]; error: ApiRequestError | null }
  | { kind: "running"; step: number }
  | { kind: "failed"; step: number; error: ApiRequestError }
  // The page lost track: the sign-in ended, the backend did not answer, or the project could not be
  // looked at for a moment (`unread`). No step failed, so no line turns red (task UI-19).
  | { kind: "paused"; step: number; error: ApiRequestError; unread?: boolean }
  // Everything is in place. The installing page stays and becomes the last page (decision D-76): the title and
  // the subtitle become those of the end, the list keeps its ticks, and the way out appears under it.
  | { kind: "done" }
  // Not reached while the uninstall is switched off (lib/features.ts, decision D-30).
  | { kind: "uninstalled"; result: UninstallDone };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const asSentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** The answer in a form the page can trust. A state the page does not know counts as "not checked", never as a pass. */
function readChecks(raw: PreflightResult): PreflightResult | null {
  if (!raw || typeof raw.ok !== "boolean" || !Array.isArray(raw.checks) || raw.checks.length === 0) return null;
  return {
    ok: raw.ok,
    checks: raw.checks.map((c) => ({ ...c, state: c.state === "pass" || c.state === "fail" || c.state === "warn" ? c.state : "unknown" })),
  };
}

/** The last run of the job of this install stopped. The hint names the job, which carries the number of the install (api.md v2.0). */
const historyStopped = (spec: Pick<InstallSpec, "installId">) =>
  new ApiRequestError(
    502,
    "UPSTREAM_ERROR",
    "The run that fills your dataset stopped with an error",
    `Try again starts a new run. To see what happened, open the job ${jobNameOf(spec)} in Cloud Run`
  );

/** The name of the project, for the first line. The ID until the name is known, and for a project that is not listed. */
function useProjectName(projectId: string): string {
  const [name, setName] = useState(projectId);
  useEffect(() => {
    let cancelled = false;
    projectsOnce()
      .then((list) => {
        const found = list.find((p) => p.projectId === projectId);
        if (!cancelled && found) setName(found.displayName);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return name;
}

type InstallerProps = {
  spec: InstallSpec;
  draft: Draft;
  wishKey: string | null;
};

function Installer({ spec: asked, draft: answered, wishKey }: InstallerProps) {
  const router = useRouter();
  const projectName = useProjectName(asked.projectId);
  const [spec, setSpec] = useState(asked);
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [wished] = useState(() => holdsWish(wishKey, asked));
  const [phase, setPhase] = useState<Phase>(wished ? { kind: "checking" } : { kind: "looking" });
  // True once every check has passed on this page: the first line of the list keeps its tick while the
  // steps run, and the list has no such line before that (decision D-80, `showCheck` below). It stays
  // false wherever the check does not run: a page that only reads the project, and an install the address
  // names that is already in place, which this page reads and does not check.
  const checked = useRef(false);
  const [sentence] = useState(() => installWording(answered.variant));

  // What the page works with. Kept outside the state so that a step that is
  // running reads the present values and not those of an earlier drawing.
  const work = useRef({ spec: asked, draft: answered, key: wishKey });
  // True when this page has just started the run that fills the dataset: the data is still arriving, which
  // the last line of the list says (decision D-90).
  const [started, setStarted] = useState(false);
  const run = useRef(0);
  // Dataset names the backend refused in this install. None of them is sent again.
  const refused = useRef<string[]>([]);
  // The numbers the backend said are taken (api.md v2.0). None of them is sent again.
  const refusedIds = useRef<string[]>([]);
  // How often a step met a name that is taken, and the page went on under another number.
  const redrawn = useRef(0);
  // The name of every dataset of the project (api.md v1.15). None of them is proposed.
  const names = useRef<string[]>([]);
  // True once a step of this page has been answered: from then on something of the install is in the project.
  const created = useRef(false);
  // True once this tab asked for this install: it held the wish when the page
  // opened, or the visitor clicked the sentence. Without it the page only
  // reads: no step is sent (task UI-12).
  const mayWrite = useRef(wished);

  /** The address of this page: the install, and the key of the visitor's wish when there is one. */
  const here = () => installUrl(work.current.draft, work.current.spec, work.current.key);

  /** The install travels in the address. The dataset name is there before anything is created. */
  function keep(next: InstallSpec, draft: Draft = work.current.draft, key: string | null = work.current.key) {
    work.current = { ...work.current, spec: next, draft, key };
    setSpec(next);
    const address = here();
    if (window.location.pathname + window.location.search !== address) window.history.replaceState(null, "", address);
  }

  /** Runs the steps in order, from the one given. Each is safe to repeat. */
  async function steps(mine: number, from: number) {
    const stale = () => run.current !== mine;
    const s = work.current.spec;
    // Without the daily refresh the schedule is no step of the install (decision D-31).
    const list = stepsOf(s);
    let i = from;
    setPhase({ kind: "running", step: i });
    // True while the page looks at the project. What goes wrong then is not the step's doing (task UI-19).
    let looking = false;
    const look = async () => {
      looking = true;
      const now = await getInstallStatus(s);
      looking = false;
      return now;
    };
    try {
      // What already exists, so that a run that fills the dataset is not started twice.
      let current = await look();
      if (stale()) return;
      setStatus(current);
      let startedNow = false;
      for (; i < list.length; i++) {
        const info = list[i];
        setPhase({ kind: "running", step: i });
        // Only the history is skipped when its result exists: calling it
        // again would start another run. Every other step is called anyway:
        // it changes nothing when nothing is missing, and repairs what is.
        if (info.name === "run-backfill" && info.isDone(current) && !info.isError(current)) continue;
        const res = await runInstallStep(info.name, s);
        created.current = true;
        if (stale()) return;
        if (info.name === "run-backfill") startedNow = true;
        if (res.state === "running") {
          // Long operation: ask the project until the result of this step appears.
          for (;;) {
            await sleep(STEP_POLL_MS);
            if (stale()) return;
            current = await look();
            if (stale()) return;
            setStatus(current);
            if (info.isError(current)) {
              throw new ApiRequestError(
                502,
                "UPSTREAM_ERROR",
                "This step did not finish correctly",
                "Try again. If it fails again, look at the project in the Google Cloud console"
              );
            }
            if (info.isDone(current)) break;
          }
        }
      }
      // The last step has answered: the page moves to the last page. The run
      // goes on in the visitor's project, and the page does not follow it
      // (decision D-52, option b). It reads the status once, to say what is
      // true; since decision D-90 the last line of the list says where the
      // run stands, from that one reading.
      try {
        current = await getInstallStatus(s);
        if (stale()) return;
        setStatus(current);
      } catch {
        if (stale()) return;
      }
      if (current.backfill.state === "failed") return setPhase({ kind: "failed", step: list.length - 1, error: historyStopped(s) });
      // A run that has just started can take a moment to show up in the status.
      setStarted(startedNow && !(current.backfill.state === "succeeded" && current.tables.count >= s.historyDays));
      setPhase({ kind: "running", step: list.length });
      await sleep(LAST_TICK_MS);
      if (stale()) return;
      setPhase({ kind: "done" });
    } catch (e) {
      if (stale()) return;
      const error = toApiError(e);
      const step = Math.min(i, list.length - 1);
      const generated = work.current.draft.generated;
      // The name of the job or of the schedule is taken by something else (api.md v2.0). The app draws another
      // number, and another dataset name when the name was its own, and goes on without a word: the first
      // line runs again, then the steps. A name the visitor typed stays.
      const numberTaken = error.code === "CONFLICT" && error.taken.length > 0;
      if (numberTaken) {
        if (s.installId) refusedIds.current.push(s.installId);
        if (generated) refused.current.push(s.datasetId);
        const next = chooseInstall({ current: generated ? "" : s.datasetId, currentId: "", generated, location: s.location, datasets: [], taken: refused.current, takenIds: refusedIds.current, names: names.current });
        work.current = { ...work.current, spec: { ...s, ...next }, draft: { ...work.current.draft, ...next } };
        window.history.replaceState(null, "", here());
        if (redrawn.current < NAME_TRIES) {
          redrawn.current++;
          return void begin("redraw");
        }
      }
      // A name the app chose was refused: the dataset exists and is not ours.
      // The address takes another name at once, with its number, so that
      // neither "Try again" nor a reload sends the refused one (task UI-9).
      // The line on the screen keeps the name that was refused.
      else if (error.code === "CONFLICT" && generated) {
        refused.current.push(s.datasetId);
        const next = chooseInstall({ current: "", currentId: "", generated: true, location: s.location, datasets: [], taken: refused.current, takenIds: refusedIds.current, names: names.current });
        work.current = { ...work.current, spec: { ...s, ...next }, draft: { ...work.current.draft, ...next } };
        window.history.replaceState(null, "", here());
      }
      // A sign-in that ended, or a backend that cannot be reached, is not a failure of the step. Nor is a look
      // at the project that failed in passing, after it was asked again three times (task UI-19): the step did
      // what it had to, or has not run yet. A refusal that is about the visitor, such as a project they may not
      // read, stays a failure: the install cannot go on there.
      const unread = looking && error.passing;
      if (error.status === 401 || error.status === 0 || unread) setPhase({ kind: "paused", step, error, unread });
      else setPhase({ kind: "failed", step, error });
    }
  }

  /** The visitor asks for the install with a click. The tab keeps the wish, so that a reload goes on. */
  function ask() {
    mayWrite.current = true;
    const { spec: s, draft, key } = work.current;
    if (!holdsWish(key, s)) keep(s, draft, keepWish(s));
  }

  /**
   * The first line: what the project holds, which name the dataset takes, and
   * the check before an install (decision D-18). Nothing is created here.
   *   open       the page opens: from the questions, a link, a reload or a bookmark
   *   wish       the visitor clicked the sentence that installs
   *   again      the visitor clicked "Try again"
   *   redraw     a step met a name that is taken: the install goes on under another number
   * Whether the steps may follow is not a matter of `how`, but of the wish of
   * this tab (`mayWrite`): choosing a project never writes (task UI-12).
   */
  async function begin(how: "open" | "wish" | "again" | "redraw") {
    const mine = ++run.current;
    const stale = () => run.current !== mine;
    // The check runs again from here, so its line goes back to waiting.
    checked.current = false;
    if (how === "open") mayWrite.current = holdsWish(work.current.key, work.current.spec);
    if (how === "wish") ask();
    if (how !== "open") setPhase(mayWrite.current ? { kind: "checking" } : { kind: "looking" });
    try {
      let s = work.current.spec;
      const generated = work.current.draft.generated;

      const found = await existingFor(s.projectId, how === "again" || how === "redraw");
      if (stale()) return;
      names.current = found.datasetNames;
      // The install this address names, when the project holds it: the one of its number, in its region, that
      // writes into its dataset (api.md v2.0). Whatever else the project holds is another install, and is
      // left alone: a project can hold several (decision D-42).
      const ours = installOfAddress(found, s);

      let current: InstallStatus | null = null;
      if (ours) {
        current = await getInstallStatus(s);
        if (stale()) return;
        setStatus(current);
        // Where an install that is in place leads. The one place that decides it. While its data is
        // still arriving the last line of the list says so (decision D-90); the page reads the project
        // once and does not follow the run (decision D-52, option b).
        // `isInPlace` does not read the run, so each way out below reads it. With no run yet
        // (`backfill.state` is "none") none of the three matches, and the steps go on to `run-backfill`.
        if (isInPlace(current, s)) {
          if (current.backfill.state === "running") return setPhase({ kind: "done" });
          if (current.backfill.state === "succeeded" && current.tables.count > 0) return setPhase({ kind: "done" });
          if (current.backfill.state === "failed" && mayWrite.current) return setPhase({ kind: "failed", step: stepsOf(s).length - 1, error: historyStopped(s) });
        }
      }

      // Without the wish of this tab nothing is sent that writes (task UI-12).
      // The project holds a part of this install, its job or its dataset while
      // still empty: the page says what is there and waits. A dataset that
      // holds tables and has no job is what was kept of an install that was
      // removed by hand: like a project that holds nothing, it reads "Ready to install".
      if (!mayWrite.current) {
        const begun = ours !== null || found.datasets.some((d) => d.datasetId === s.datasetId && d.tables === 0);
        if (!begun) return setPhase({ kind: "confirm" });
        if (!current) {
          current = await getInstallStatus(s);
          if (stale()) return;
          setStatus(current);
        }
        return setPhase({ kind: "found" });
      }
      setPhase({ kind: "checking" });

      // The name and the number of a new install (api.md v2.0). A name the app chose gives way to a dataset
      // an earlier install left behind (Phase 5, item 2), and neither is one the project already uses. An
      // install that is in the project keeps both.
      const others = installsOf(found);
      const choose = (current: string, currentId: string) =>
        chooseInstall({ current, currentId, generated, location: s.location, datasets: found.datasets, installs: others, taken: refused.current, takenIds: refusedIds.current, names: found.datasetNames });
      // An address without a number names an install of before v2.0. Only a new install is given one: when the
      // project holds nothing under the names of before, in this region.
      const before = !s.installId && others.some((i) => !i.installId && i.region === s.region);
      if (!ours && !before) s = { ...s, ...choose(s.datasetId, s.installId ?? "") };

      let result: PreflightResult | null = null;
      for (let tries = 0; ; tries++) {
        result = readChecks(await checkFor(s, how === "again" || how === "redraw" || tries > 0));
        if (stale()) return;
        if (!result) {
          throw new ApiRequestError(
            502,
            "UPSTREAM_ERROR",
            "The check of your project came back in a form this page cannot read",
            `Try again. If it keeps happening, please report it to ${SUPPORT_EMAIL}`
          );
        }
        // The number meets a job or a schedule that belongs to something else (the check `names`, api.md
        // v2.0), or the name the app drew meets a dataset that exists: the app draws again, and says nothing.
        // A name the visitor typed stays, and only the number is drawn again.
        const numberTaken = result.checks.some((c) => c.id === "names" && c.state === "fail" && (c.taken?.length ?? 0) > 0);
        const nameTaken = generated && result.checks.some((c) => c.id === "dataset" && c.state === "fail");
        if ((!numberTaken && !nameTaken) || tries >= NAME_TRIES) break;
        if (numberTaken && s.installId) refusedIds.current.push(s.installId);
        if (generated) refused.current.push(s.datasetId);
        s = { ...s, ...choose(generated ? "" : s.datasetId, numberTaken ? "" : (s.installId ?? "")) };
      }

      keep(s, { ...work.current.draft, datasetId: s.datasetId, installId: s.installId ?? "" });
      const problems = result.checks.filter((c) => c.state === "fail");
      // A check that fails stops the page: it stays until the visitor acts (decisions D-18 and D-80).
      if (!result.ok || problems.length > 0) return setPhase({ kind: "blocked", problems, error: null });
      // Every check passed: the first line takes its tick and the next step starts at once, with no pause
      // (decision D-80). Until then the back arrow cancels: a click makes this run stale, and no step is sent.
      checked.current = true;
      await steps(mine, 0);
    } catch (e) {
      if (stale()) return;
      const error = toApiError(e);
      if (error.status === 401) setPhase({ kind: "paused", step: 0, error });
      else setPhase({ kind: "blocked", problems: [], error });
    }
  }

  useEffect(() => {
    void begin("open");
    // Stops whatever is in flight when the page goes away.
    return () => void ++run.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The arrow: back to the answers. */
  function back() {
    ++run.current;
    dropWish(work.current.key);
    const to = questionsBeforeInstall({ ...work.current.draft, ...{ projectId: spec.projectId, datasetId: spec.datasetId, installId: spec.installId ?? "" } });
    // In Pro the visitor set the name: the settings open with the name to change.
    router.push(nameRefused && work.current.draft.mode === "pro" ? `${to}&fix=name` : to);
  }

  /**
   * The circular arrow of the last page (task UI-32): the flow starts again at the first question, the choice
   * of experience. The sign-in is kept, so the welcome page is not shown. The install just made is left
   * alone: a project can hold several (decision D-42).
   */
  function startAgain() {
    ++run.current;
    router.push("/");
  }

  function uninstalled(result: UninstallDone) {
    ++run.current;
    // The wish is forgotten: a reload of this address must not install again by itself.
    dropWish(work.current.key);
    mayWrite.current = false;
    forgetProject(spec.projectId);
    keep(work.current.spec, work.current.draft, null);
    setPhase({ kind: "uninstalled", result });
  }

  // The dataset was refused, by the check or by a step. A number that is taken is not about the dataset.
  const nameRefused =
    (phase.kind === "failed" && phase.error.code === "CONFLICT" && phase.error.taken.length === 0) ||
    (phase.kind === "blocked" && phase.problems.some((c) => c.id === "dataset"));

  if (phase.kind === "looking") return <Waiting label="Looking at your project" />;

  // Only an uninstall leads here, and none can start while it is switched off.
  if (phase.kind === "uninstalled") {
    return UNINSTALL ? <Uninstalled done={phase.result} returnTo={here()} onDone={uninstalled} onStart={() => router.push("/")} /> : null;
  }

  // ---------- An install found in the project, not complete, that this tab did not ask for ----------

  if (phase.kind === "found") {
    const parts = status ? partsOf(status, spec.datasetId, refreshOf(status, spec)) : [];
    const history = !status || historyToRun(status) ? ` and generates ${plural(spec.historyDays, "day", "days")} of history` : "";
    return (
      <Screen key="found" title="Install not complete" subtitle={SUBTITLES.found} onBack={back} signOut>
        <div aria-live="polite">
          <CheckList
            label="What your project holds of this install"
            lines={parts.map((p) => ({ key: p.key, text: p.text, state: p.state === "there" ? "ok" : p.state === "stopped" ? "bad" : "skip", plain: true }))}
          />
          <p className="advice" role="status">
            Your project {projectName} holds an install that is not complete. Continuing creates what is missing{history}.
          </p>
        </div>
        <Forward show onGo={() => void begin("wish")}>
          Continue the install
        </Forward>
      </Screen>
    );
  }

  // One sentence, one fact (decision D-37). "Nothing is installed yet" is said only while it is true.
  const somethingThere = created.current || (!!status && [status.dataset, status.serviceAccount, status.job].includes("done"));

  // ---------- The check before the install: the first line of the installing page (decision D-80) ----------
  // The check screen is gone: its one line is the first line of the list below, and the page is titled
  // "Installing" from the start. Checks that pass, warn or could not be made are not listed. A check that
  // fails says what is missing and what to do, in the words of the backend, and the page stays until the
  // visitor acts. When every check passes the line takes its tick and the next step starts at once
  // (`begin`). Nothing is created before that (decision D-18).
  //
  // The line is shown while the check runs, when it failed, and once it has passed on this page. A page
  // where it never ran shows the steps alone, and says nothing of a check: "Ready to install" and "Install
  // not complete", which check nothing until the visitor asks, and an install the address names that is
  // already in place, which this page reads and does not check (decision D-76). `checked` is never set
  // outside the check itself: the line would claim a check that did not run.
  const showCheck = phase.kind === "checking" || phase.kind === "blocked" || checked.current;
  const problems = phase.kind === "blocked" ? phase.problems : [];
  const checkLine: Line = {
    key: "check",
    text:
      phase.kind === "blocked"
        ? problems.length > 0
          ? `Your project needs ${problems.length === 1 ? "one thing" : `${problems.length} things`} first`
          : "Your project could not be checked"
        : phase.kind === "checking"
          ? `Looking at ${projectName}`
          : `${projectName} passed every check`,
    state: phase.kind === "blocked" ? "bad" : phase.kind === "checking" ? "wait" : "ok",
    now: phase.kind === "checking",
    // What to fix is not in the line since decision D-85: the lines scroll in a box of their own, and what
    // the visitor has to act on stands under that box, always in sight (the `blocked` block of the page).
  };

  // ---------- The list: one line per step, in a box of its own that scrolls ----------
  // The lines are what the installer sets up, and, since decision D-90, the
  // run that fills the dataset as the last of them: decision D-32 had kept
  // that step out of the list, and D-90 puts it back, with the time the run
  // takes. When it stops, the page still says what to do under the box. Each
  // line also says, plainly, the technical detail of what it creates: the
  // Google service, and the exact names the console shows (decision D-76,
  // `STEP_INFO` in lib/install.ts). No button, no overlay, no window: the
  // question mark does not come back (decision D-66). The check before the
  // install is the first line of the same list (decision D-80).
  //
  // Since decision D-85 the lines sit in a box that scrolls, capped in height
  // by the height of the screen (`ul.checks.box` in app/globals.css), and what
  // the visitor has to act on is never inside it: what a failed check or a
  // failed step says, with "Try again", stands under the box, and so do "Open
  // it in BigQuery" and the arrow that starts again.
  //
  // When the install finishes this page stays and becomes the end of the
  // install (decision D-76): the subtitle becomes that of the end, the list
  // keeps its green ticks, and the link to BigQuery and the arrow that starts
  // again appear under it. There is no separate page any more. An install
  // found by the address, already complete, ends here in the same way.

  const finished = phase.kind === "done";
  const list = stepsOf(spec);
  // The install the lines speak of. For a finished install this tab did not ask for it is the one the project
  // holds: its daily refresh is read from its job, which is all such an install knows of that choice
  // (`refreshOf`, api.md v1.14), as for the lines of an install found. Everywhere else it is the install that
  // was asked for, so the numbers of `phase.step` keep their meaning. Which lines there are, the words of each
  // and its detail all follow this one spec: without the daily refresh there is no schedule, the job is not
  // called daily, and Cloud Scheduler is never switched on (api.md v1.14).
  const held = finished && status && !mayWrite.current ? { ...spec, dailyRefresh: refreshOf(status, spec) } : spec;
  const shown = stepsOf(held);

  const stateOf = (i: number): LineState => {
    switch (phase.kind) {
      // No step has run: the check comes first (decision D-80), or the visitor has not asked yet.
      case "checking":
      case "blocked":
      case "confirm":
        return "skip";
      case "done":
        return "ok";
      case "running":
        return i < phase.step ? "ok" : "wait";
      case "failed":
        return i < phase.step ? "ok" : i === phase.step ? "bad" : "skip";
      case "paused":
        return i < phase.step ? "ok" : "skip";
    }
  };

  const signInEnded = phase.kind === "paused" && phase.error.status === 401;

  // How many days of history the line that fills the dataset promises. Those this tab asked for, or those
  // the project says the install was asked for (api.md v1.16); null when neither is known, which is an
  // install this tab did not ask for whose status carries no `historyDays`.
  const days = mayWrite.current ? spec.historyDays : typeof status?.historyDays === "number" ? status.historyDays : null;

  // ---------- The last line: the run that fills the dataset (decision D-90) ----------
  // Where the run stands, read once with the rest of the page. No polling is added: the page reads the
  // project once (decision D-52, option b), so this line does not change while the visitor watches. On a
  // reload during the run the duration is counted again from the start of the run, so it overshoots; that
  // is the safe side and is accepted (decision D-90).
  // The project's "failed" is the run of **before** while this page is checking or running its steps: the
  // status was read at the start of `steps` and still carries the last run, which "Try again" and
  // "Continue the install" are there to replace. Reading it then would show the line as stopped through
  // the whole install, until the next read. So while the page works, only a step that has just failed
  // stops this line (decision D-90).
  const working = phase.kind === "checking" || phase.kind === "running";
  const runStopped = (phase.kind === "failed" && phase.step === list.length - 1) || (!working && status?.backfill.state === "failed");
  // `started` is this page's own run, set when the last step answered; the project's own word is read for
  // an install this page did not start, such as one the address found with its run still going.
  const runGoing = !runStopped && (started || status?.backfill.state === "running");
  // The last tick of the list, then the end of the install: by then the run has answered one way or another.
  const runFilled = !runStopped && !runGoing && (finished || (phase.kind === "running" && phase.step >= list.length));
  const runState: RunState = runStopped ? "stopped" : runGoing ? "running" : runFilled ? "filled" : "starting";
  // The mark of that line: stopped, ticked, or the spinner of a step that is being worked on. Before the
  // run starts it waits like the lines before it, so it takes the mark of its place in the list.
  const runMark = (i: number): Pick<Line, "state" | "now"> =>
    runStopped ? { state: "bad" } : runFilled ? { state: "ok" } : runGoing ? { state: "wait", now: true } : { state: stateOf(i), now: phase.kind === "running" && phase.step === i };

  const steppedLines: Line[] = shown.map((info, i): Line => {
    const fills = info.name === "run-backfill";
    return {
      key: info.name,
      text: fills ? runLine(runState, days) : info.line(held),
      ...(fills ? runMark(i) : { state: stateOf(i), now: phase.kind === "running" && phase.step === i }),
      // The technical detail of the step (decision D-76) and nothing else: since decision D-85 what a failed
      // step says stands under the box, not in the line, so it is never scrolled out of sight. The run that
      // fills the dataset adds the days of history to the job it starts (decision D-90).
      more: <span className="detail">{fills && days !== null ? `${info.detail(held)}, ${plural(days, "day", "days")} of history` : info.detail(held)}</span>,
    };
  });
  // The check of the project, then the steps (decision D-80).
  const lines: Line[] = showCheck ? [checkLine, ...steppedLines] : steppedLines;

  // A page that only looked at the project, and could not, is installing nothing: this tab never asked for
  // this install, so no step was sent and nothing was created. Decision D-85 fixes the title of the install
  // itself; such a page is none of the states it names, so it keeps the title "Almost there".
  const onlyLooked = (phase.kind === "paused" || phase.kind === "blocked" || phase.kind === "failed") && !mayWrite.current;
  // ---------- The end of the install, on this same page (decision D-76) ----------
  // One sentence since decision D-90, the same whether the data is still arriving or has arrived, and for
  // an install the address found already in place. The two wordings of decision D-52, how long the data
  // takes and the sentence about new data every morning are gone from this page; where the run stands is
  // said by the last line of the list instead.

  // "Installing" from the first line to the last, whatever the install is doing (decision D-85): the check,
  // the steps, a failed check, a failed step, the run that fills the dataset, the end, and an install that
  // stopped. The title no longer changes under the visitor's eyes, and the subtitle carries the state.
  // Two titles are not of the install and stay: "Ready to install", before the visitor has asked for
  // anything, and "Almost there" on a page that only read the project and could not.
  const title = phase.kind === "confirm" ? "Ready to install" : onlyLooked ? "Almost there" : "Installing";
  const subtitle = finished
    ? SUBTITLES.installed
    : phase.kind === "confirm"
      ? SUBTITLES.ready
      : phase.kind === "failed" || phase.kind === "blocked"
        ? !mayWrite.current
          ? SUBTITLES.onlyLooked
          : somethingThere
            ? SUBTITLES.stopped
            : SUBTITLES.nothingInstalled
        : phase.kind === "paused"
          ? mayWrite.current
            ? SUBTITLES.waits
            : SUBTITLES.onlyLooked
          : // While the check runs nothing is created yet, and the subtitle says so (decision D-18).
            phase.kind === "checking"
            ? SUBTITLES.check
            : SUBTITLES.installing;
  // A name the visitor typed in Pro was refused by a step: only they can set another one.
  const typedNameRefused = phase.kind === "failed" && phase.error.code === "CONFLICT" && phase.error.taken.length === 0 && !work.current.draft.generated;
  // Before the first step nothing has been created yet: the arrow cancels (Phase 5, item 11). While the
  // check runs it cancels too, and a click makes that run stale, so no step is sent (decision D-18).
  const canGoBack = phase.kind === "confirm" || phase.kind === "checking" || phase.kind === "blocked" || typedNameRefused;
  // The sign-out is not shown while the check and the steps run: they are sent by this page, and leaving
  // would stop them halfway (decision D-41). Nor once the sign-in has ended.
  const canSignOut = phase.kind !== "running" && phase.kind !== "checking" && !signInEnded;

  return (
    <Screen
      key="installing"
      title={title}
      subtitle={subtitle}
      onBack={canGoBack ? back : null}
      // The install is finished: the bottom-left corner holds the circular arrow that starts the flow again
      // (task UI-32, decision D-64), on this same page (decision D-76).
      onAgain={finished ? startAgain : null}
      signOut={canSignOut}
    >
      <div aria-live="polite">
        {/* The lines in a box of their own that scrolls (decision D-85), so that a long list never pushes
            what the visitor has to act on out of sight. */}
        <CheckList label="The install, step by step" lines={lines} scroll />
        {/* Under the box, always in sight: what a failed check says, what a failed step says, and what the
            page could not read (decision D-85). A failed check can name several things to fix. */}
        {phase.kind === "blocked" ? (
          <div className="advice" role="alert">
            {problems.map((c) => (
              <Fix key={c.id} text={c.message || c.title || c.id} advice={c.hint} missing={c.missing} link={c.link}>
                {c.id === "session" ? (
                  <>
                    {" "}
                    <a href={loginUrl(here())}>Sign in again</a>
                  </>
                ) : null}
              </Fix>
            ))}
            {phase.error ? <Fix text={phase.error.message} advice={phase.error.hint} missing={phase.error.missing} link={phase.error.link} /> : null}
          </div>
        ) : null}
        {phase.kind === "failed" ? (
          <div className="advice" role="alert">
            <Fix text={phase.error.message} advice={phase.error.hint} missing={phase.error.missing} link={phase.error.link} />
          </div>
        ) : null}
        {phase.kind === "paused" ? (
          <p className="advice" role="status">
            {signInEnded
              ? mayWrite.current
                ? "Your sign-in has ended before the install was complete. Sign in again and the install continues where it stopped."
                : "Your sign-in has ended. Sign in again to see what your project holds."
              : phase.unread
                ? "This page could not look at your project for a moment. No step has failed."
                : <Mailed text={`${asSentence(phase.error.message)} ${asSentence(phase.error.hint)}`} />}
          </p>
        ) : null}
      </div>
      {finished ? (
        <>
          {/* The link opens BigQuery on the dataset itself, so that a visitor of Guided or Automated needs no
              name to find it (task UI-24). A filled button, as before (task UI-32). No query and no line
              under it (decision D-41). */}
          <div className="forward">
            <ForwardLink href={bigQueryUrl(spec.projectId, spec.datasetId)} newTab filled>
              Open it in BigQuery
            </ForwardLink>
          </div>
          {UNINSTALL ? (
            <Uninstall
              target={{ projectId: spec.projectId, region: spec.region, datasetId: spec.datasetId, installId: spec.installId }}
              tableCount={status ? status.tables.count : null}
              returnTo={here()}
              onDone={uninstalled}
            />
          ) : null}
        </>
      ) : signInEnded ? (
        <div className="forward">
          <ForwardLink href={loginUrl(here())}>Sign in again</ForwardLink>
        </div>
      ) : phase.kind === "confirm" ? (
        <Forward show filled onGo={() => void begin("wish")}>
          {sentence}
        </Forward>
      ) : (
        <Forward
          show={phase.kind === "failed" || phase.kind === "paused" || phase.kind === "blocked"}
          onGo={() => {
            // A failed line offers to run its step again: that click asks for the install.
            if (phase.kind === "failed") ask();
            if (phase.kind === "failed" && phase.error.code !== "CONFLICT") void steps(++run.current, phase.step);
            // The page could not look at the project for a moment: the install goes on from the step where it waited.
            else if (phase.kind === "paused" && phase.unread) void steps(++run.current, phase.step);
            // After a check that failed, or a refusal of the dataset by a step, the check runs again: it
            // looks at the project and settles the name.
            else void begin("again");
          }}
        >
          Try again
        </Forward>
      )}
    </Screen>
  );
}

/** What the uninstall did, read from the project afterwards. */
function Uninstalled({
  done,
  returnTo,
  onDone,
  onStart,
}: {
  done: UninstallDone;
  returnTo: string;
  onDone: (done: UninstallDone) => void;
  onStart: () => void;
}) {
  const { status, target } = done;

  const part = (key: string, name: string, now: InstallStatus["job"] | undefined): Line => {
    if (!status) return { key, text: `${name} removed`, state: "ok" };
    if (now === "missing") return { key, text: `${name} removed`, state: "ok" };
    if (now === "done") return { key, text: `${name} still in the project`, state: "bad" };
    return { key, text: `${name} could not be checked`, state: "skip" };
  };

  const dataset = (): Line => {
    const key = "dataset";
    const name = `Dataset ${target.datasetId}`;
    if (!status) return { key, text: done.datasetDeleted ? `${name} deleted, with all its tables` : `${name} kept`, state: "ok" };
    if (status.dataset === "done") {
      return done.deleteRequested
        ? { key, text: `${name} still in the project, although you asked to delete it`, state: "bad" }
        : { key, text: `${name} kept, with ${plural(status.tables.count, "table", "tables")}`, state: "ok" };
    }
    if (status.dataset === "missing") {
      return done.deleteRequested || done.datasetDeleted
        ? { key, text: `${name} deleted, with all its tables`, state: "ok" }
        : { key, text: `${name} is not in the project`, state: "skip" };
    }
    return { key, text: `${name} could not be checked`, state: "skip" };
  };

  const lines = [
    part("schedule", "Daily schedule", status?.schedule),
    part("job", "Daily job", status?.job),
    part("account", "Service account", status?.serviceAccount),
    dataset(),
  ];
  const leftovers = lines.some((l) => l.state === "bad");

  return (
    <Screen key="uninstalled" title={leftovers ? "Uninstall not complete" : "Uninstalled"}>
      <div aria-live="polite">
        <CheckList label="What the uninstall did" lines={lines} />
        {!status ? (
          <p className="advice" role="status">
            This page could not look at your project afterwards, so it repeats what the uninstall reported.
          </p>
        ) : null}
        {done.remaining.map((r) => (
          <p className="advice" role="status" key={r.region}>
            This project holds another install, in region {r.region}, which writes to dataset {r.datasetId}. Its service account was kept.
            Start again and choose the project to see it.
          </p>
        ))}
      </div>
      {leftovers ? (
        <Uninstall target={target} tableCount={status?.tables.count ?? null} returnTo={returnTo} label="Try again" look="sentence" onDone={onDone} />
      ) : (
        <Forward show onGo={onStart}>
          Start again
        </Forward>
      )}
    </Screen>
  );
}

/**
 * The install page: installing, ready to install, install not complete, done. The install travels in the
 * page address, and its progress is read from the project, so a reload or a
 * return from the Google sign-in resumes where things are.
 */
export default function Install() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, again } = useSession();
  const parsed = installFromParams(params);

  if (session.kind === "loading") return <Waiting label="Checking whether you are signed in" />;

  if (session.kind === "error") {
    return (
      <Screen title="Almost there" subtitle={SUBTITLES.session}>
        <div className="advice" role="alert">
          <Fix text={session.error.message} advice={session.error.hint} />
        </div>
        <Forward show onGo={again}>
          Try again
        </Forward>
      </Screen>
    );
  }

  const wrong = wrongValues(params);
  if (wrong.length > 0 || !parsed) {
    return (
      <Screen title="Almost there" subtitle={SUBTITLES.link} signOut={session.kind === "signed-in"}>
        <div className="advice" role="alert">
          {wrong.length > 0 ? (
            wrong.map((w) => <Fix key={w} text={wrong.length === 1 ? "This link holds a value that cannot be" : "This link holds values that cannot be"} advice={w} />)
          ) : (
            <Fix text="This link is incomplete" advice="Start again and choose your project" />
          )}
        </div>
        <Forward show onGo={() => router.push("/")}>
          Start again
        </Forward>
      </Screen>
    );
  }

  const go = params.get("go");
  if (session.kind === "signed-out") {
    return <Welcome returnTo={installUrl(parsed.draft, parsed.spec, go)} ended="Sign in to come back to your install." />;
  }

  // The page rewrites its own address when the dataset takes its name and the
  // install its number. The install goes on: only another project is another
  // install for this page.
  return <Installer key={parsed.spec.projectId} spec={parsed.spec} draft={parsed.draft} wishKey={go} />;
}
