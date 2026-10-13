/**
 * What the installer left in a project, exactly as in docs/contracts/api.md
 * ("GET /api/install/existing", v1.8).
 *
 * The app generates the dataset name, so a visitor who comes back does not
 * know it, nor the region. This lookup needs neither: it lists the jobs of
 * every region the app offers, keeps those of the installer, and lists the
 * datasets that carry the ownership label (D-19). Read-only.
 *
 * Since v2.0 (D-42) a project can hold several installs. `installs` names
 * every one that was found.
 *
 * Since v1.15 (D-33) it also gives the name of every dataset of the
 * project, so that a name the app proposes is never a name that is taken.
 * One list of BigQuery serves both.
 */
import { ApiError } from './errors.js';
import {
  OFFERED_REGIONS,
  datasetTypeOf,
  dayTables,
  dailyRefreshOf,
  existingDatasetName,
  historyOfInstall,
  installsIn,
  isOwnedDataset,
  locationFromArgs,
  lookInRegions,
  lookup,
  lookupSchedule,
  parseInstallSpec,
  typeFromArgs,
  type CloudGateway,
  type DatasetType,
  type LabelledDataset,
  type RegionOptions,
} from './install.js';

export interface ExistingQuery {
  projectId: string;
  /** Null: look in every region the app offers. */
  region: string | null;
}

export interface ExistingInstall {
  /** The number of the install (api.md v2.0). Null for an install made before v2.0, whose job is `ga4synth-daily`. */
  installId: string | null;
  /** Where the job and the schedule live. */
  region: string;
  /** The dataset the job writes to, as in `status.existingDataset`. */
  datasetId: string;
  /** Null when the job's configuration paths are not a pair this app writes. */
  datasetType: DatasetType | null;
  /** Null when neither the job's arguments nor the dataset tell it. */
  location: string | null;
  /** The cron expression of the daily refresh, or null when the schedule does not exist. */
  schedule: string | null;
  /** The choice made at the install, read from the label of the job (api.md v1.14). A job without the label: true. */
  dailyRefresh: boolean;
  /** The period of the history, as in the status (api.md v1.16). Null when it cannot be read. */
  historyDays: number | null;
  historyEnd: string | null;
}

export interface OwnedDataset {
  datasetId: string;
  /** The type of the days it holds (api.md v1.11). Null for an empty dataset that carries no type yet. */
  datasetType: DatasetType | null;
  location: string;
  /** How many `events_YYYYMMDD` tables the dataset holds. */
  tables: number;
}

export interface ExistingResult {
  /** The first of `installs`, or null. It stays for the clients of before v2.0. */
  install: ExistingInstall | null;
  /**
   * Every install of the project that was found (api.md v2.0), in the order
   * of the regions. In a region, the install made before v2.0 comes first,
   * the others in the order of their numbers.
   */
  installs: ExistingInstall[];
  datasets: OwnedDataset[];
  /**
   * The name of every dataset of the project, whoever created it, in the
   * order of the names. Hidden datasets are left out. Empty when BigQuery is
   * not switched on or refuses the list (api.md v1.15).
   */
  datasetNames: string[];
  /** Regions where Google did not answer, or answered with an error of its own. An install may be there. */
  regionsNotChecked: string[];
}

export type ExistingOptions = RegionOptions;

/**
 * `projectId` follows the rule of an install. `region` is optional and has
 * no default here: without it, every offered region is looked at. With it,
 * every well-formed region is accepted: this call only reads.
 */
export function parseExistingQuery(input: Record<string, unknown>): ExistingQuery {
  const named = typeof input.region === 'string' && input.region.trim() !== '';
  const { projectId, region } = parseInstallSpec({ projectId: input.projectId, region: named ? input.region : undefined }, { regions: 'any' });
  return { projectId, region: named ? region : null };
}

/** A refusal that is about the visitor, not about one region: it is answered as an error. */
const aboutTheVisitor = (err: unknown) => err instanceof ApiError && (err.code === 'PERMISSION_DENIED' || err.code === 'UNAUTHENTICATED');

/** BigQuery hides a dataset whose name begins with an underscore, for example the one of its cached results. */
export const isHiddenDataset = (datasetId: string) => datasetId.startsWith('_');

/**
 * Every dataset of the project, hidden ones left out. BigQuery switched
 * off, or a list that is refused, reads as no dataset: the app then
 * proposes a name as before, and the guards of the steps still hold.
 */
async function visibleDatasets(cloud: CloudGateway, token: string, projectId: string): Promise<LabelledDataset[]> {
  let all: LabelledDataset[];
  try {
    all = await lookup(() => cloud.listDatasets(token, projectId), []);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PERMISSION_DENIED') return [];
    throw err;
  }
  return all.filter((d) => !isHiddenDataset(d.datasetId)).sort((a, b) => a.datasetId.localeCompare(b.datasetId));
}

/** A service that is not switched on reads as "nothing there", as in the status. */
export async function getExisting(cloud: CloudGateway, token: string, q: ExistingQuery, opts: ExistingOptions = {}): Promise<ExistingResult> {
  const { projectId } = q;
  const regions: readonly string[] = q.region ? [q.region] : OFFERED_REGIONS;

  // The jobs of a region, their schedules and their runs count together
  // against the time limit of the region. The installs are read side by side.
  const inRegion = async (region: string) => {
    const installs = await installsIn(cloud, token, projectId, region);
    return Promise.all(
      installs.map(async (found) => {
        const dailyRefresh = dailyRefreshOf(found.job.spec);
        const schedule = await lookupSchedule(cloud, token, { projectId, region, installId: found.installId }, dailyRefresh);
        // The run is read only where it can tell the period: an install without the daily refresh.
        const latestRun = !dailyRefresh && found.job.latestExecution ? await cloud.getExecution(token, found.job.latestExecution) : null;
        return { ...found, schedule: schedule?.schedule ?? null, history: historyOfInstall(dailyRefresh, latestRun) };
      }),
    );
  };

  // One list for both: the names of all, and the datasets of the installer among them.
  const listDatasets = async (): Promise<{ datasets: OwnedDataset[]; datasetNames: string[] }> => {
    const visible = await visibleDatasets(cloud, token, projectId);
    const datasets = await Promise.all(
      visible.filter(isOwnedDataset).map(async (d): Promise<OwnedDataset> => {
        const tables = await lookup(() => cloud.listEventsTables(token, projectId, d.datasetId), null);
        const found = tables ?? [];
        return { datasetId: d.datasetId, datasetType: datasetTypeOf(d, found.length), location: d.location, tables: dayTables(found).length };
      }),
    );
    return { datasets, datasetNames: visible.map((d) => d.datasetId) };
  };

  const [outcomes, { datasets, datasetNames }] = await Promise.all([lookInRegions(regions, inRegion, opts), listDatasets()]);

  const failures = outcomes.flatMap((o) => (o.ok ? [] : [o.error]));
  // Only errors the contract knows are sorted by region. Anything else is a fault on our side.
  const fatal = failures.find((err) => aboutTheVisitor(err) || !(err instanceof ApiError));
  if (fatal !== undefined) throw fatal;
  // No region answered: there is nothing to report but the error.
  if (failures.length === regions.length) throw failures[0];

  const found: ExistingInstall[] = [];
  const regionsNotChecked: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      regionsNotChecked.push(outcome.region);
      continue;
    }
    for (const here of outcome.value) found.push(describe(here));
  }

  function describe(here: Awaited<ReturnType<typeof inRegion>>[number]): ExistingInstall {
    const ownDataset = here.target.projectId === projectId ? datasets.find((d) => d.datasetId === here.target.datasetId) : undefined;
    return {
      installId: here.installId,
      region: here.region,
      datasetId: existingDatasetName(here.target, projectId),
      datasetType: typeFromArgs(here.job.spec.args),
      location: locationFromArgs(here.job.spec.args) ?? ownDataset?.location ?? null,
      schedule: here.schedule,
      dailyRefresh: dailyRefreshOf(here.job.spec),
      historyDays: here.history.days,
      historyEnd: here.history.end,
    };
  }

  return { install: found[0] ?? null, installs: found, datasets, datasetNames, regionsNotChecked };
}
