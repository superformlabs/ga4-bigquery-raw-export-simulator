"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, getInstallStatus, toApiError } from "@/lib/api";
import { checkFor, existingFor, projectsOnce } from "@/lib/cache";
import { REGIONS, type DatasetType, type ExistingResult, type Project } from "@/lib/contract";
import { installsOf } from "@/lib/install";
import { DEFAULT_DAYS, EARLIEST_DAY, addDays, dayOfTable, daysBetween, daysWithEnd, leavesHole, periodProblem, startOfPeriod, yesterdayUtc } from "@/lib/dates";
import {
  DATASET_ID_RE,
  DEFAULTS,
  HOURS,
  LOCATIONS,
  PLACES,
  REFRESH_CHOICES,
  TYPE_CHOICES,
  chooseInstall,
  draftFromParams,
  isNameTaken,
  placeOf,
  questionsUrl,
  randomDatasetName,
  randomInstallId,
  numberOfName,
  wrongValues,
  screenFor,
  specFromDraft,
  type Draft,
  type Mode,
  type Screen as ScreenName,
} from "@/lib/flow";
import { installUrl } from "@/lib/install";
import { useSession } from "@/lib/session";
import { LABELS, SUBTITLES, TITLES, hourOfSchedule, installWording, periodSubtitle, plural, scheduleOfHour } from "@/lib/wording";
import { keepWish } from "@/lib/wish";
import Choices from "./Choices";
import Fix from "./Fix";
import Forward from "./Forward";
import ProjectPicker from "./ProjectPicker";
import Screen, { Waiting } from "./Screen";
import Welcome from "./Welcome";

// Long enough to see the choice taken.
const MOVE_ON_MS = 320;

const MODES = [
  { id: "guided", icon: "🧭", label: "Guided", hint: "A few questions, one at a time." },
  { id: "auto", icon: "⚡", label: "Automated", hint: "Just choose your project. We take care of the rest." },
  { id: "pro", icon: "🎛️", label: "Pro", hint: "Every setting, on one page." },
] as const;

type ScreenProps = {
  draft: Draft;
  /** Shows another screen of questions, with what was answered on this one. */
  go: (screen: ScreenName, answers?: Partial<Draft>) => void;
  /** Leaves the questions for the install. */
  install: (draft: Draft) => void;
  /** The backend said that nobody is signed in. */
  signedOut: () => void;
  /** What the visitor comes back to change: "name" after a dataset name was refused. */
  fix: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads the list of projects once. A failure leaves an empty list, so that an ID can still be typed. */
function useProjects(signedOut: () => void) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [problem, setProblem] = useState<ApiRequestError | null>(null);
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    let cancelled = false;
    projectsOnce()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setProblem(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = toApiError(e);
        if (error.status === 401) return signedOut();
        setProjects([]);
        setProblem(error);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn]);
  return {
    projects,
    problem,
    again: () => {
      setProjects(null);
      setProblem(null);
      setTurn((t) => t + 1);
    },
  };
}

/** The check before an install, asked ahead of time. Its answer is read later; a failure here is nobody's concern. */
function checkAhead(draft: Draft) {
  const spec = specFromDraft(draft);
  if (spec) void checkFor(spec).catch(() => undefined);
}

/**
 * The first question. It is the one screen that keeps the entry animations of
 * the design (`entry`, decision D-75): the title falls into place, the
 * subtitle appears while it lands, and the choices follow. Every other screen
 * of the app appears at once.
 */
function ModeScreen({ draft, go }: ScreenProps) {
  return (
    <Screen title="Choose your experience" subtitle={SUBTITLES.mode} entry signOut>
      <Choices
        look="modes"
        label="Choose your experience"
        items={MODES}
        onPick={(id) => go(id === "pro" ? "pro" : "project", { mode: id as Mode })}
      />
    </Screen>
  );
}

// The project. The list always opens on "Select a project", even for a
// visitor who comes back. There is no sentence: choosing moves on.
//   Guided     to the type of dataset
//   Automated  to the install, since the project is the only question
// Whatever the project holds: a project can hold several installs, and
// choosing it starts a new one (decision D-42). Both look at the project
// first, for the names: the name the app proposes is never the name of a
// dataset the project holds (decision D-33), and the number of the install is
// never the number of an install the project holds.
function ProjectScreen({ draft, go, install, signedOut }: ScreenProps) {
  const { projects, problem, again } = useProjects(signedOut);
  const [chosen, setChosen] = useState<Project | null>(null);
  const [refusal, setRefusal] = useState<ApiRequestError | null>(null);
  const [looking, setLooking] = useState(false);
  const turn = useRef(0);
  useEffect(() => () => void ++turn.current, []);

  async function choose(project: Project) {
    const mine = ++turn.current;
    const started = Date.now();
    setChosen(project);
    setRefusal(null);
    const answers = { projectId: project.projectId, datasetId: "", generated: false, installId: "" };

    // What the project holds, for the names. Asked anew: another install may have been made since.
    const asked = existingFor(project.projectId, true);

    setLooking(true);
    let found: ExistingResult | null = null;
    try {
      found = await asked;
    } catch (e) {
      if (turn.current !== mine) return;
      const error = toApiError(e);
      if (error.status === 401) return signedOut();
      // A project that cannot be read is said now. Anything else is left to the check before the install.
      if ([400, 403, 404].includes(error.status)) {
        setLooking(false);
        setChosen(null);
        setRefusal(error);
        return;
      }
    }
    const left = MOVE_ON_MS - (Date.now() - started);
    if (left > 0) await sleep(left);
    if (turn.current !== mine) return;

    // The name and the number of the new install, drawn together (api.md v2.0).
    const drawn = chooseInstall({
      current: "",
      currentId: "",
      generated: true,
      location: DEFAULTS.location,
      datasets: found?.datasets ?? [],
      installs: found ? installsOf(found) : [],
      names: found?.datasetNames ?? [],
    });
    if (draft.mode === "auto") {
      // Automated installs no daily refresh (decision D-31).
      install({ ...draft, ...answers, ...drawn, generated: true, datasetType: DEFAULTS.datasetType, location: DEFAULTS.location, region: DEFAULTS.region, historyDays: DEFAULT_DAYS, schedule: DEFAULTS.schedule, dailyRefresh: false });
      return;
    }
    const next = { ...draft, ...answers, ...drawn, generated: true };
    checkAhead(next);
    go("type", next);
  }

  return (
    <Screen title="Choose your GCP project" subtitle={SUBTITLES.project} signOut onBack={() => go("mode")}>
      <div className="col narrow">
        <label className="sr" htmlFor="project">
          Google Cloud project
        </label>
        <ProjectPicker id="project" projects={projects} chosen={chosen} onChoose={choose} focus describedBy="note" />
        <div id="note" className="under">
          {looking ? (
            <p className="note calm" role="status">
              <span className="spin" aria-hidden="true" />
              <span className="sr">Looking at your project</span>
            </p>
          ) : refusal ? (
            <div className="advice" role="alert">
              <Fix text={refusal.message} advice={refusal.hint} link={refusal.link} />
            </div>
          ) : problem ? (
            <div className="advice" role="alert">
              <Fix text={problem.message} advice={`${problem.hint} You can also type the ID of your project`} />
            </div>
          ) : null}
          {problem && !refusal && !looking ? (
            <Forward show close onGo={again} enter={false}>
              Try again
            </Forward>
          ) : null}
        </div>
      </div>
    </Screen>
  );
}

// Guided, after the project: which type of dataset? Four choices since decisions D-96 and D-97, in place
// of two. Each is a full-width button with its name and, under it, the line of decision D-97.
function TypeScreen({ draft, go }: ScreenProps) {
  return (
    <Screen title="Choose your type of dataset" subtitle={SUBTITLES.type} signOut onBack={() => go("project")}>
      <Choices
        look="types"
        label="Choose your type of dataset"
        items={TYPE_CHOICES}
        current={draft.datasetType}
        onPick={(id) => go("location", { datasetType: id as DatasetType })}
      />
    </Screen>
  );
}

// Location: no sentence. Choosing moves on. One choice sets the data location and the job region together.
// The title is the owner's words of decision D-82, text B. The subtitle is one sentence since decision
// D-90, and each choice reads its BigQuery location code alone; what the choice sends is unchanged.
function LocationScreen({ draft, go }: ScreenProps) {
  const title = "Where should your synthetic dataset live?";
  return (
    <Screen title={title} subtitle={SUBTITLES.location} signOut onBack={() => go("type")}>
      <Choices
        look="places"
        label={title}
        items={PLACES}
        current={placeOf(draft.location, draft.region)?.id ?? null}
        onPick={(id) => {
          const place = PLACES.find((p) => p.id === id);
          if (!place) return;
          const next = { ...draft, location: place.location, region: place.region };
          // The check made when the project was chosen was for the usual location.
          checkAhead(next);
          go("refresh", next);
        }}
      />
    </Screen>
  );
}

// A daily refresh, or not (decision D-31). Asked before the period: the app
// must know the answer before it offers the end date (decision D-34). No
// sentence: choosing moves on. The title is the owner's words of decision
// D-82, text C. The subtitle is one sentence since decision D-90: it no
// longer names the Cloud Scheduler job, the hour, the last 3 days, nor what
// No does.
function RefreshScreen({ draft, go }: ScreenProps) {
  const title = "Do you want a daily refresh?";
  return (
    <Screen title={title} subtitle={SUBTITLES.refresh} signOut onBack={() => go("location")}>
      <Choices
        label={title}
        items={REFRESH_CHOICES}
        current={draft.dailyRefresh === null ? null : draft.dailyRefresh ? "yes" : "no"}
        onPick={(id) => {
          const on = id === "yes";
          // A visitor who chose two dates and asks for the daily refresh after all: the end
          // becomes yesterday, so the end chosen is dropped, and the start chosen is kept.
          const kept = on && draft.historyEnd ? { historyDays: daysWithEnd(draft.historyDays ?? DEFAULT_DAYS, draft.historyEnd, yesterdayUtc()), historyEnd: null } : {};
          const next = { ...draft, ...kept, dailyRefresh: on };
          // The check depends on the choice: without the daily refresh it asks for fewer permissions.
          checkAhead(next);
          go("history", next);
        }}
      />
    </Screen>
  );
}

// The period of the history (decisions D-34 and D-41). It is asked by the
// answer to the question before it. With new data every day the dataset stays
// up to date: no end date is offered, and only the start is asked. Without,
// the visitor chooses both dates.
function HistoryScreen({ draft, go, install }: ScreenProps) {
  const refresh = draft.dailyRefresh !== false;
  const [end, setEnd] = useState(() => (refresh ? yesterdayUtc() : (draft.historyEnd ?? yesterdayUtc())));
  const [start, setStart] = useState(() => startOfPeriod(draft.historyDays ?? DEFAULT_DAYS, refresh ? yesterdayUtc() : (draft.historyEnd ?? yesterdayUtc())));
  const [sentence] = useState(() => installWording(draft.variant));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus({ preventScroll: true }), []);

  const problem = periodProblem(start, end);
  const days = daysBetween(start, end);
  // With the daily refresh the history ends yesterday, and the request carries no end date (api.md v1.16).
  const answers = { historyDays: days, historyEnd: refresh ? null : end };

  const startField = (
    <input
      type="date"
      id="start"
      ref={input}
      value={start}
      min={EARLIEST_DAY}
      max={yesterdayUtc()}
      aria-describedby="note"
      aria-invalid={problem !== ""}
      onChange={(e) => setStart(e.target.value)}
    />
  );

  return (
    <Screen
      title={refresh ? TITLES.periodStart : TITLES.period}
      // How many days were chosen, and how long the install takes (decision D-79). It follows the
      // dates; while a date is wrong there are no days to speak of, and the line under them says why.
      subtitle={periodSubtitle(problem ? null : days, refresh)}
      liveSubtitle
      signOut
      onBack={() => go("refresh", problem ? {} : answers)}
    >
      <div className="col narrow">
        {refresh ? (
          <>
            {/* One date: the title asks for it, so its name is for screen readers only. */}
            <label className="sr" htmlFor="start">
              Start date
            </label>
            {startField}
          </>
        ) : (
          <div className="dates">
            <div>
              <label htmlFor="start">Start date</label>
              {startField}
            </div>
            <div>
              <label htmlFor="end">End date</label>
              <input
                type="date"
                id="end"
                value={end}
                min={EARLIEST_DAY}
                max={yesterdayUtc()}
                aria-describedby="note"
                aria-invalid={problem !== ""}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
        )}
        {/* Only what is wrong with a date stands here: the count moved into the subtitle (decision D-79). */}
        <p className="note" id="note" role="status">
          {problem}
        </p>
        <Forward show={!problem} filled onGo={() => install({ ...draft, ...answers })}>
          {sentence}
        </Forward>
      </div>
    </Screen>
  );
}

// Pro: every setting on one page.
function ProScreen({ draft, go, install, signedOut, fix }: ScreenProps) {
  const { projects, problem: listProblem, again } = useProjects(signedOut);
  const [projectId, setProjectId] = useState(draft.projectId);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [dataset, setDataset] = useState(() => draft.datasetId || randomDatasetName());
  const [generated, setGenerated] = useState(draft.datasetId ? draft.generated : true);
  // The number of the install (api.md v2.0). With a name the app proposes it is the nine digits of the name;
  // with a name the visitor typed it is drawn once, and kept while they type.
  const [drawnId, setDrawnId] = useState(() => draft.installId || randomInstallId());
  const [datasetType, setDatasetType] = useState<DatasetType>(draft.datasetType ?? DEFAULTS.datasetType);
  const [location, setLocation] = useState(draft.location ?? DEFAULTS.location);
  const [region, setRegion] = useState(draft.region ?? DEFAULTS.region);
  // The period of the history: a start date and an end date (decision D-34).
  const [end, setEnd] = useState(() => (draft.dailyRefresh === false ? (draft.historyEnd ?? yesterdayUtc()) : yesterdayUtc()));
  const [start, setStart] = useState(() =>
    startOfPeriod(draft.historyDays ?? DEFAULT_DAYS, draft.dailyRefresh === false ? (draft.historyEnd ?? yesterdayUtc()) : yesterdayUtc())
  );
  // The days a dataset of the installer holds, when the visitor named one: a history must touch or overlap them.
  const [heldDays, setHeldDays] = useState<{ datasetId: string; first: string; last: string } | null>(null);
  const [hour, setHour] = useState(() => hourOfSchedule(draft.schedule ?? DEFAULTS.schedule) ?? "06:00");
  // On when the page opens (owner's answer on decision D-31).
  const [refresh, setRefresh] = useState(draft.dailyRefresh ?? true);
  const [found, setFound] = useState<ExistingResult | null>(null);
  // True while the page looks at the project: the name is not checked yet, so the sentence does not show.
  const [looking, setLooking] = useState(false);
  // True once the visitor has left the field of the name: what is wrong with a typed name is said then, not while typing.
  const [nameLeft, setNameLeft] = useState(draft.datasetId !== "" && !draft.generated);
  const [refusal, setRefusal] = useState<ApiRequestError | null>(null);
  const [sentence] = useState(() => installWording(draft.variant));
  const turn = useRef(0);
  useEffect(() => () => void ++turn.current, []);

  // After a refused name the cursor lands in the name, selected, so that typing replaces it.
  const nameField = useRef<HTMLInputElement>(null);
  // Read once: the page rewrites its address, which then no longer says why the visitor came.
  const [fixName] = useState(fix === "name");
  useEffect(() => {
    if (!fixName) return;
    nameField.current?.focus({ preventScroll: true });
    nameField.current?.select();
  }, [fixName]);

  const name = dataset.trim();
  const installId = (generated && numberOfName(name)) || drawnId;
  // With new data every day the history ends yesterday, so that no day is left without data.
  const endShown = refresh ? yesterdayUtc() : end;
  const datesProblem = periodProblem(start, endShown);
  const count = datesProblem ? 0 : daysBetween(start, endShown);
  let problem = "";
  if (name && !DATASET_ID_RE.test(name)) problem = "Dataset name: use only letters, numbers and underscores.";
  else if (!name) problem = "Give your dataset a name.";

  const answers: Draft = {
    ...draft,
    mode: "pro",
    projectId,
    datasetId: DATASET_ID_RE.test(name) ? name : "",
    generated,
    installId,
    datasetType,
    location,
    region,
    historyDays: count > 0 ? count : null,
    schedule: scheduleOfHour(hour),
    dailyRefresh: refresh,
    historyEnd: refresh || datesProblem ? null : end,
  };

  // The settings travel in the address, so a reload keeps them.
  const address = questionsUrl("pro", answers);
  useEffect(() => {
    if (window.location.pathname + window.location.search !== address) window.history.replaceState(null, "", address);
  }, [address]);

  // What the project holds, for the names (decisions D-33 and D-42).
  const look = useCallback(
    async (id: string, fresh: boolean) => {
      const mine = ++turn.current;
      setFound(null);
      setRefusal(null);
      setLooking(!!id);
      if (!id) return;
      try {
        const result = await existingFor(id, fresh);
        if (turn.current === mine) setFound(result);
      } catch (e) {
        if (turn.current !== mine) return;
        const error = toApiError(e);
        if (error.status === 401) return signedOut();
        if ([400, 403, 404].includes(error.status)) setRefusal(error);
      } finally {
        // A project that could not be looked at is left to the check before the install.
        if (turn.current === mine) setLooking(false);
      }
    },
    [signedOut]
  );
  useEffect(() => {
    void look(draft.projectId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A name the app proposed gives way to the name of a dataset an earlier install left in this location,
  // and is never the name of a dataset the project holds (decision D-33). The number of the install is
  // never the number of an install the project holds (decision D-42).
  useEffect(() => {
    if (!found) return;
    const better = chooseInstall({
      current: dataset.trim(),
      currentId: installId,
      generated,
      location,
      datasets: found.datasets,
      installs: installsOf(found),
      names: found.datasetNames,
    });
    if (generated && better.datasetId !== dataset.trim()) setDataset(better.datasetId);
    if (better.installId !== installId) setDrawnId(better.installId);
    // The check is asked ahead of time once the name is settled, and not for a name that may be taken.
    if (generated) checkAhead({ ...answers, ...better });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found, location, generated]);

  // A name the visitor typed that a dataset of the project already has. A name the app proposed is replaced, never refused.
  const nameTaken = !generated && isNameTaken(name, found);

  // A name the visitor typed that is a dataset of the installer which holds days. The backend refuses a history
  // that leaves days without data between those days and the period asked (api.md v1.16). The page reads the
  // days once the field of the name is left, and says it under the dates before the install starts.
  const holdsTables = !generated && nameLeft && !!found?.datasets.some((d) => d.datasetId === name && d.tables > 0);
  useEffect(() => {
    if (!holdsTables) return setHeldDays(null);
    let cancelled = false;
    getInstallStatus({ projectId, datasetId: name, region })
      .then((s) => {
        const first = dayOfTable(s.tables.first);
        const last = dayOfTable(s.tables.last);
        if (!cancelled) setHeldDays(first && last ? { datasetId: name, first, last } : null);
      })
      // What cannot be read here is left to the last step, which looks again.
      .catch(() => !cancelled && setHeldDays(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdsTables, projectId, name]);
  const held_ = heldDays && heldDays.datasetId === name ? heldDays : null;
  const hole = !!held_ && !datesProblem && leavesHole(start, endShown, held_.first, held_.last);

  const chosen = projectId ? (projects?.find((p) => p.projectId === projectId) ?? { projectId, displayName: typedName ?? projectId }) : null;

  return (
    <Screen title="Your settings" subtitle={SUBTITLES.pro} signOut onBack={() => go("mode")}>
      <div className="col settings-col">
        <div className="settings">
          <div className="full">
            <label htmlFor="p-project">GCP project</label>
            <ProjectPicker
              id="p-project"
              projects={projects}
              chosen={chosen}
              focus={!fixName}
              describedBy="note"
              onChoose={(p) => {
                setProjectId(p.projectId);
                setTypedName(p.displayName);
                void look(p.projectId, true);
              }}
            />
          </div>
          <div className="full">
            <label htmlFor="p-dataset">Dataset name</label>
            <input
              type="text"
              id="p-dataset"
              ref={nameField}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={dataset}
              aria-describedby={nameTaken && nameLeft ? "name-note" : "note"}
              aria-invalid={nameTaken && nameLeft}
              onChange={(e) => {
                setDataset(e.target.value);
                setGenerated(false);
                setNameLeft(false);
              }}
              onBlur={() => setNameLeft(true)}
            />
            {nameTaken && nameLeft ? (
              <p className="note" id="name-note" role="alert">
                A dataset named {name} already exists in this project. Choose another name.
              </p>
            ) : null}
          </div>
          <div className="full">
            <label htmlFor="p-type">Type of dataset</label>
            <select id="p-type" value={datasetType} onChange={(e) => setDatasetType(e.target.value as DatasetType)}>
              {TYPE_CHOICES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="p-location">Data location</label>
            <select id="p-location" value={location} onChange={(e) => setLocation(e.target.value)}>
              {[...new Set([...LOCATIONS, location])].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="p-region">Job region</label>
            <select id="p-region" value={region} onChange={(e) => setRegion(e.target.value)}>
              {[...new Set([...REGIONS, region])].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="p-refresh">{LABELS.dailyRefresh}</label>
            <select
              id="p-refresh"
              value={refresh ? "yes" : "no"}
              onChange={(e) => {
                setRefresh(e.target.value === "yes");
                checkAhead({ ...answers, dailyRefresh: e.target.value === "yes" });
              }}
            >
              {REFRESH_CHOICES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="p-hour">Daily refresh (UTC)</label>
            {/* Without the daily refresh there is no hour to set. */}
            <select id="p-hour" value={hour} disabled={!refresh} onChange={(e) => setHour(e.target.value)}>
              {[...new Set([...HOURS, hour])].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
          {/* The period: two dates, and the number of days beside them, as a text. */}
          <div className="full period">
            <div>
              <label htmlFor="p-start">Start date</label>
              <input
                type="date"
                id="p-start"
                value={start}
                min={EARLIEST_DAY}
                max={yesterdayUtc()}
                aria-describedby="dates-note"
                aria-invalid={datesProblem !== "" || hole}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="p-end">End date</label>
              <input
                type="date"
                id="p-end"
                value={endShown}
                min={EARLIEST_DAY}
                max={yesterdayUtc()}
                disabled={refresh}
                aria-describedby="dates-note"
                aria-invalid={datesProblem !== "" || hole}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
            <p className="count" id="p-days" role="status">
              {count > 0 ? plural(count, "day", "days") : ""}
            </p>
            <p className={datesProblem || hole ? "note" : "note calm"} id="dates-note" role={datesProblem || hole ? "alert" : "status"}>
              {datesProblem
                ? datesProblem
                : hole && held_
                  ? `Dataset ${name} holds the days from ${held_.first} to ${held_.last}. A history from ${start} to ${endShown} would leave the days between them without data. Choose a period that touches or overlaps these days: it begins on ${addDays(held_.last, 1)} or earlier, and ends on ${addDays(held_.first, -1)} or later.`
                  : held_
                    ? `Dataset ${name} holds the days from ${held_.first} to ${held_.last}.`
                    : ""}
            </p>
          </div>
        </div>
        <div id="note">
          {refusal ? (
            <div className="advice" role="alert">
              <Fix text={refusal.message} advice={refusal.hint} link={refusal.link} />
            </div>
          ) : listProblem && !projectId ? (
            <div className="advice" role="alert">
              <Fix text={listProblem.message} advice={`${listProblem.hint} You can also type the ID of your project`}>
                {" "}
                <button type="button" className="plain" onClick={again}>
                  Try again
                </button>
              </Fix>
            </div>
          ) : (
            <p className="note" role="status">
              {problem}
            </p>
          )}
        </div>
        {/* Whatever the project holds, the sentence installs: a project can hold several installs (decision D-42). */}
        <Forward show={!!projectId && !problem && !datesProblem && !hole && !refusal && !looking && !nameTaken} close filled onGo={() => install(answers)}>
          {sentence}
        </Forward>
      </div>
    </Screen>
  );
}

const SCREENS: Record<ScreenName, (props: ScreenProps) => React.ReactNode> = {
  mode: ModeScreen,
  project: ProjectScreen,
  type: TypeScreen,
  location: LocationScreen,
  refresh: RefreshScreen,
  history: HistoryScreen,
  pro: ProScreen,
};

/**
 * The questions, from the welcome page to the last answer. Which screen is
 * shown, and what was answered so far, is read from the page address, so the
 * browser's own back button, a reload and a return from the Google sign-in
 * all land on the right screen.
 */
export default function Flow() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, again } = useSession();
  const [ended, setEnded] = useState(false);

  const draft = draftFromParams(params);
  const screen = screenFor(params.get("s"), draft);
  const rawError = params.get("error");
  const errorCode = rawError && /^[A-Z_]{1,40}$/.test(rawError) ? rawError : null;

  const go = useCallback(
    (to: ScreenName, answers: Partial<Draft> = {}) => {
      const next = { ...draft, ...answers };
      // Going back to the first screen forgets the answers; the experience is chosen anew.
      window.history.pushState(null, "", to === "mode" ? "/" : questionsUrl(to, to === "project" ? { ...next, projectId: "", datasetId: "", generated: false, installId: "" } : next));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params]
  );

  const install = useCallback(
    (answered: Draft) => {
      // Every new install carries a number (api.md v2.0). An address of the questions made before v2.0 holds
      // none: it is drawn here, from the name when the name is the app's own.
      const numbered = answered.installId ? answered : { ...answered, installId: (answered.generated && numberOfName(answered.datasetId)) || randomInstallId() };
      const spec = specFromDraft(numbered);
      if (!spec) return;
      router.push(installUrl(numbered, spec, keepWish(spec)));
    },
    [router]
  );

  const signedOut = useCallback(() => setEnded(true), []);

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

  // A link that holds a value that cannot be says which one, instead of showing the usual value in its place.
  const wrong = wrongValues(params);
  if (wrong.length > 0) {
    return (
      <Screen title="Almost there" subtitle={SUBTITLES.link} signOut={session.kind === "signed-in"}>
        <div className="advice" role="alert">
          {wrong.map((w) => (
            <Fix key={w} text={wrong.length === 1 ? "This link holds a value that cannot be" : "This link holds values that cannot be"} advice={w} />
          ))}
        </div>
        <Forward show onGo={() => window.history.pushState(null, "", "/")}>
          Start again
        </Forward>
      </Screen>
    );
  }

  if (session.kind === "signed-out" || ended) {
    // A visitor who was in the middle of the questions comes back to the same screen.
    const here = screen === "mode" ? "/" : questionsUrl(screen, draft);
    return (
      <Welcome
        returnTo={here}
        errorCode={errorCode}
        ended={ended ? "Your sign-in has ended. Sign in again to continue where you were." : null}
      />
    );
  }

  // A signed-in visitor never sees the welcome page: the first screen is the choice of experience (Phase 5, item 6).
  const Shown = SCREENS[screen];
  return <Shown key={screen} draft={draft} go={go} install={install} signedOut={signedOut} fix={params.get("fix")} />;
}
