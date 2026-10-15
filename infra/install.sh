#!/usr/bin/env bash
#
# Install the fake GA4 export into a target project, by hand, with gcloud and
# bq. This does exactly what the backend API does (docs/contracts/api.md,
# "Install"), step for step, so the two can be compared. It uses the prebuilt
# public image from infra/IMAGE instead of building the generator from
# packages/generator/, which is what ./infra/build.sh does.
#
#   PROJECT=your-project-id ./infra/install.sh
#   PROJECT=your-project-id DATASET_TYPE=ecommerce ./infra/install.sh
#   PROJECT=your-project-id HISTORY_DAYS=7 ./infra/install.sh
#   PROJECT=your-project-id STEPS=deploy-job,create-schedule ./infra/install.sh
#   PROJECT=your-project-id WAIT=1 ./infra/install.sh   # block until the backfill ends
#   PROJECT=<a tester's project> ENV=stg ./infra/install.sh   # use staging's image
#
# PROJECT is the TARGET project, the one that receives the dataset, and must
# always be given. ENV (default dev) only chooses which of our environments
# the install belongs to: the image comes from that environment's IMAGE file,
# and REGION and LOCATION default to its settings (infra/env/<ENV>.env).
#
# Repeatable: every step is idempotent, so running it twice is safe. Running
# it again after a partial failure resumes where it stopped.
#
# One shell function per API step, same names as the contract:
#   1. enable-apis             run, cloudscheduler, bigquery, iam, cloudresourcemanager
#   2. create-dataset          BigQuery dataset DATASET in LOCATION, with the
#                              ownership label
#   3. create-service-account  ga4synth@PROJECT, jobUser + run.invoker on the
#                              project, WRITER on the dataset; the grants are
#                              tried again while Google does not know the
#                              new account yet
#   4. deploy-job              Cloud Run Job JOB running the image with the
#                              daily args (the configuration of DATASET_TYPE,
#                              publish --days 3 --workers 8), at 8 CPU and
#                              16 GiB (decision D-43)
#   5. create-schedule         Cloud Scheduler job JOB, SCHEDULE in UTC
#   6. run-backfill            one execution of JOB with --days HISTORY_DAYS
#                              and a longer timeout; returns at once
#
# Dataset ownership (api.md v1.6, decision D-19): the script only ever writes
# into a dataset it created, which it recognises by the label
# managed-by=ga4-fake-dataset-installer. A dataset of that name without the
# label is refused in steps 2, 3, 4 and 6, with exit code 3 and nothing
# changed. A real GA4 export holds tables named events_YYYYMMDD too, and the
# daily job would overwrite them.
#
# Type of dataset (api.md v2.3, decisions D-23, D-96 and D-97): DATASET_TYPE
# is `default`, `ecommerce`, `eu-consent` or `lead-generation`: one invented
# business software website, GA4Dataform's own, from four angles. The image
# holds one configuration per type, and the job names its own in its
# arguments. The type is part of an install: when the job exists and produces
# another type, or writes to another dataset, the script stops before it
# changes anything, with exit code 5. Only the region of this run is read
# (every region: task DEP-8).
#
# Contracts: docs/contracts/api.md (steps, defaults, dataset ownership) and
# docs/contracts/generator-cli.md (container, args, timeouts, permissions).

set -euo pipefail

: "${PROJECT:?set PROJECT to the target Google Cloud project id}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# PROJECT is already set, so the environment file cannot replace it. Sets
# LOCATION (BigQuery dataset location), REGION (Cloud Run and Scheduler
# region) and IMAGE_PATH.
. "${HERE}/lib/env.sh"

DATASET="${DATASET:-analytics_770000001}"   # api.md InstallSpec default
DATASET_TYPE="${DATASET_TYPE:-default}"     # one of DATASET_TYPES below; api.md InstallSpec default
HISTORY_DAYS="${HISTORY_DAYS:-90}"          # days backfilled on first install, 1 or more; api.md InstallSpec default
SCHEDULE="${SCHEDULE:-0 6 * * *}"           # cron, UTC
JOB="${JOB:-ga4synth-daily}"                # Cloud Run Job and Scheduler job name
SA_NAME="${SA_NAME:-ga4synth}"              # service account short name
DAILY_DAYS="${DAILY_DAYS:-3}"               # rolling window republished every morning
WAIT="${WAIT:-0}"                           # 1 = wait for the backfill to finish
STEPS="${STEPS:-enable-apis,create-dataset,create-service-account,deploy-job,create-schedule,run-backfill}"

if [[ -z "${IMAGE:-}" ]]; then
  if [[ ! -s "${IMAGE_PATH}" ]]; then
    echo "${IMAGE_PATH} does not exist yet. Build the generator image first:" >&2
    echo "  ENV=${ENV} ./infra/build.sh" >&2
    exit 2
  fi
  IMAGE="$(tr -d '[:space:]' < "${IMAGE_PATH}")"
fi
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

# Reads an image's settings from the registry, without credentials.
. "${HERE}/lib/image.sh"

# HISTORY_DAYS, api.md v2.2 (decision D-78). There is no maximum number of
# days. What bounds a history is a fixed earliest first day, 2020-10-14, the
# day GA4 was launched. This script has no equivalent of the API's
# `historyEnd`, so a history always ends yesterday (UTC) and its first day is
# yesterday minus HISTORY_DAYS plus one. Both refusals happen here, before
# any step runs, so nothing is created.
EARLIEST_FIRST_DAY="2020-10-14"

if ! [[ "${HISTORY_DAYS}" =~ ^[0-9]+$ ]] || (( HISTORY_DAYS < 1 )); then
  echo "HISTORY_DAYS must be a whole number, 1 or more, got '${HISTORY_DAYS}'" >&2
  exit 2
fi

# Prints the refusal when the first day falls before EARLIEST_FIRST_DAY, and
# nothing when it does not. Same words as the API's message for a history
# without `historyEnd` (api.md v2.2).
HISTORY_REFUSAL="$(python3 -c '
import datetime, sys
days = int(sys.argv[1])
earliest = datetime.date.fromisoformat(sys.argv[2])
yesterday = datetime.datetime.now(datetime.timezone.utc).date() - datetime.timedelta(days=1)
first = yesterday - datetime.timedelta(days=days - 1)
if first < earliest:
    count = "1 day" if days == 1 else "%d days" % days
    print("A history of %s that ends yesterday, %s (UTC), begins on %s. "
          "It cannot begin earlier than %s, the day GA4 was launched."
          % (count, yesterday, first, earliest))
' "${HISTORY_DAYS}" "${EARLIEST_FIRST_DAY}")"
if [[ -n "${HISTORY_REFUSAL}" ]]; then
  echo "${HISTORY_REFUSAL}" >&2
  exit 2
fi

# The types of dataset, one configuration folder each, as in
# docs/contracts/api.md (`datasetType`) and infra/build.sh (CONFIG_TYPES).
# Named once here: the check below, the job's arguments and the reading of an
# existing job all use this list.
DATASET_TYPES=(default ecommerce eu-consent lead-generation)
DATASET_TYPES_LIST="$(IFS=,; printf '%s' "${DATASET_TYPES[*]}")"

_known_type=0
for _type in "${DATASET_TYPES[@]}"; do
  if [[ "${DATASET_TYPE}" == "${_type}" ]]; then _known_type=1; fi
done
if (( _known_type == 0 )); then
  echo "DATASET_TYPE must be one of: ${DATASET_TYPES_LIST//,/, }, got '${DATASET_TYPE}'" >&2
  exit 2
fi
unset _known_type _type

# Where the image holds the configuration of each type (generator-cli.md,
# "Container contract").
CONFIG_DIR="/app/config"
# The type of an install made before the types existed: its job names no
# configuration, and the image of that time held the ecommerce one only.
TYPE_BEFORE_V1_8="ecommerce"
# Exit code of a refusal because the project already has another install.
EXIT_CONFLICT=5

# The size of the Cloud Run job and how many days it makes at once (decision
# D-43). The three values of the backend, `JOB_CPU`, `JOB_MEMORY` and
# `JOB_WORKERS` in apps/api/src/install.ts, so an install made with this
# script is the install the app makes. Named once here and used nowhere else
# by value. Every run of the job is charged at this size, the daily run of 3
# days included: Cloud Run cannot give one execution another size.
JOB_CPU=8
JOB_MEMORY=16Gi
JOB_WORKERS=8

# publish_args DAYS
# The job's arguments, exactly as the backend writes them (`publishArgs` in
# apps/api/src/install.ts): separate arguments, in this order, `--workers`
# last. The backend reads the dataset and the type of an install back from
# them, so another order or form would make it rewrite the job at the next
# install. gcloud takes the list with commas between the arguments. The
# generator never starts more workers than the days asked for, so the daily
# run of 3 days uses 3 of the 8.
publish_args() {
  local days="$1"
  printf '%s' "--property,${CONFIG_DIR}/${DATASET_TYPE}/property.yaml"
  printf '%s' ",--mixer,${CONFIG_DIR}/${DATASET_TYPE}/mixer.yaml"
  printf '%s' ",publish,--dataset,${PROJECT}:${DATASET}"
  printf '%s' ",--days,${days},--location,${LOCATION}"
  printf '%s' ",--workers,${JOB_WORKERS}"
}

# Backfill timeout from generator-cli.md: historyDays * 10 s + 10 min, capped
# at 24 h (API-32, sized for eight workers). Cloud Run accepts seconds with an
# "s" suffix.
BACKFILL_TIMEOUT=$(( HISTORY_DAYS * 10 + 600 ))
if (( BACKFILL_TIMEOUT > 86400 )); then BACKFILL_TIMEOUT=86400; fi

# Pin every gcloud and bq call to PROJECT (see infra/lib/env.sh for why).
pin_gcloud "${PROJECT}"

# The ownership rule and every dataset call (BigQuery REST API).
. "${HERE}/lib/dataset.sh"

# --- One install per project -----------------------------------------------
# The job and the schedule have fixed names, so a project holds one install
# (decision D-12). A job that writes to another dataset is not re-pointed:
# that would silently stop the refresh of the first dataset. A job of another
# type is not re-pointed either, or one dataset would hold days of two of the
# four types.
# Same rules and same words as the backend (`assertSameInstall`). Run before
# the first step, so a refusal leaves nothing behind.
require_same_install() {
  local answer="${DATASET_WORK}/job.json" problem="${DATASET_WORK}/job.txt"
  if ! gcloud run jobs describe "${JOB}" \
      --region="${REGION}" --project="${PROJECT}" --format=json >"${answer}" 2>"${problem}"; then
    # No job, or a project where Cloud Run is not switched on yet, which
    # cannot hold a job: nothing to compare with.
    if grep -qiE 'cannot find job|not_found|could not be found|has not been used|is disabled|service_disabled' "${problem}"; then
      return 0
    fi
    echo "Could not read the job ${JOB} in project ${PROJECT}, region ${REGION}:" >&2
    cat "${problem}" >&2
    exit 1
  fi

  local verdict=0
  python3 -c '
import json, sys
job = json.load(open(sys.argv[1]))
project, dataset, wanted, config_dir, before, types = sys.argv[2:8]
containers = job["spec"]["template"]["spec"]["template"]["spec"]["containers"]
args = containers[0].get("args") or []

def value(flag):
    return args[args.index(flag) + 1] if flag in args and args.index(flag) + 1 < len(args) else None

# The dataset, written as --dataset <project>:<dataset>. A job without it is
# not one the installer wrote: no conflict, deploy-job rewrites it.
ref = value("--dataset")
if not ref or ":" not in ref.strip(":"):
    sys.exit(0)
ref_project, ref_dataset = ref.split(":", 1)
if (ref_project, ref_dataset) != (project, dataset):
    print(ref_dataset if ref_project == project else ref)
    sys.exit(10)

# The type, from the two configuration paths. None named: an install made
# before the types existed. Paths that are not a pair of the installer: no
# type, no conflict.
if "--property" not in args and "--mixer" not in args:
    existing = before
else:
    existing = None
    for kind in types.split(","):
        pair = ("%s/%s/property.yaml" % (config_dir, kind), "%s/%s/mixer.yaml" % (config_dir, kind))
        if (value("--property"), value("--mixer")) == pair:
            existing = kind
if existing and existing != wanted:
    print(existing)
    sys.exit(11)
' "${answer}" "${PROJECT}" "${DATASET}" "${DATASET_TYPE}" "${CONFIG_DIR}" "${TYPE_BEFORE_V1_8}" \
    "${DATASET_TYPES_LIST}" \
    >"${problem}" || verdict=$?
  local existing
  existing="$(cat "${problem}")"
  case "${verdict}" in
    0) ;;
    10)
      echo "REFUSED: Project ${PROJECT} already has an install that writes to dataset ${existing}, not ${DATASET}." >&2
      echo "  What to do: Run again with DATASET=${existing}, or remove the existing install first:" >&2
      echo "    PROJECT=${PROJECT} ENV=${ENV} REGION=${REGION} DATASET=${existing} ./infra/uninstall.sh" >&2
      exit "${EXIT_CONFLICT}"
      ;;
    11)
      echo "REFUSED: Project ${PROJECT} already has an install of type ${existing}." >&2
      echo "  What to do: Run again with DATASET_TYPE=${existing}, or remove the existing install first:" >&2
      echo "    PROJECT=${PROJECT} ENV=${ENV} REGION=${REGION} DATASET=${DATASET} ./infra/uninstall.sh" >&2
      exit "${EXIT_CONFLICT}"
      ;;
    *)
      echo "Could not read the arguments of the job ${JOB} in project ${PROJECT}." >&2
      exit 1
      ;;
  esac
}

# --- The image holds the type ----------------------------------------------
# A job that names a configuration the image does not hold stops at start,
# every morning. build.sh writes the types an image holds on the image; an
# image built before the types existed holds none of the four folders, and an
# image built before D-96 holds the first two only. Read
# without credentials, as the target project will pull it.
require_image_with_type() {
  if ! image_read "${IMAGE}"; then
    echo "  The target project pulls the image the same way, so the job could not start." >&2
    echo "  What to do: Build the generator image: ENV=${ENV} ./infra/build.sh" >&2
    exit 2
  fi
  if ! image_holds_type "${DATASET_TYPE}"; then
    echo "The image ${IMAGE} does not hold the configuration of type ${DATASET_TYPE}" >&2
    echo "(types it names: '${IMAGE_TYPES}'; an image built before the types existed names none)." >&2
    echo "  What to do: Build the generator image: ENV=${ENV} ./infra/build.sh" >&2
    exit 2
  fi
}

# --- 1. enable-apis --------------------------------------------------------
# bigquery: the dataset and the load jobs. run: the job. cloudscheduler: the
# trigger. iam: the service account. cloudresourcemanager: project IAM.
step_enable_apis() {
  gcloud services enable \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    bigquery.googleapis.com \
    iam.googleapis.com \
    cloudresourcemanager.googleapis.com \
    --project="${PROJECT}" --quiet
}

# --- 2. create-dataset -----------------------------------------------------
# ga4synth publish does not create the dataset (generator-cli.md, gap 1), so
# the installer does, and labels it as its own. Location is fixed at creation
# and cannot be changed. An existing dataset is accepted only with the label
# and in LOCATION.
step_create_dataset() {
  dataset_read
  case "${DATASET_STATE}" in
    missing)
      dataset_create
      ;;
    foreign)
      refuse_foreign_dataset
      ;;
    owned)
      same_location "${DATASET_LOCATION}" "${LOCATION}" || refuse_other_location
      echo "  dataset already exists, created by this installer"
      ;;
  esac
}

# --- 3. create-service-account ---------------------------------------------
# One account does both things: it runs the job (so it needs to load into
# BigQuery) and it is the identity Cloud Scheduler uses to start the job.
#
# Google creates a service account at once, but its other services need some
# seconds before they know it. Until then a grant that names the account is
# answered with "Service account ... does not exist" (seen on staging in 3 of
# 4 installs, longest wait 14 seconds; QA-4, 2026-09-26). So the grants are
# tried again on that answer, and on that answer only. The waits are the
# backend's (API-9): 1, 2, 3, 4, 5 and 5 seconds, 20 seconds in all, shared
# by the three grants.
ACCOUNT_WAITS=(1 2 3 4 5 5)
ACCOUNT_WAITS_USED=0

# Sleeps for the next wait. Stops the script when every wait is used.
wait_for_account() {
  if (( ACCOUNT_WAITS_USED >= ${#ACCOUNT_WAITS[@]} )); then
    echo "Google has not finished creating the service account ${SA}, so it could not be given its roles yet." >&2
    echo "  What to do: Run the same command again in a moment. The install continues where it stopped." >&2
    exit 1
  fi
  local pause="${ACCOUNT_WAITS[ACCOUNT_WAITS_USED]}"
  ACCOUNT_WAITS_USED=$(( ACCOUNT_WAITS_USED + 1 ))
  echo "  Google does not know the new service account yet; trying again in ${pause} s"
  sleep "${pause}"
}

# grant_project_role ROLE
grant_project_role() {
  local role="$1" answer="${DATASET_WORK}/grant.txt"
  until gcloud projects add-iam-policy-binding "${PROJECT}" \
      --member="serviceAccount:${SA}" \
      --role="${role}" \
      --condition=None --quiet >/dev/null 2>"${answer}"; do
    if ! account_unknown "$(cat "${answer}")" "${SA}"; then
      cat "${answer}" >&2
      exit 1
    fi
    wait_for_account
  done
}

# WRITER for the account on the dataset.
grant_dataset_writer() {
  local verdict
  while true; do
    verdict=0
    dataset_writer add "${SA}" || verdict=$?
    if (( verdict == 0 )); then return 0; fi
    if (( verdict != RETURN_ACCOUNT_UNKNOWN )); then exit "${verdict}"; fi
    wait_for_account
  done
}

step_create_service_account() {
  # This step grants write access to the dataset, so ownership comes first.
  require_owned_dataset

  if gcloud iam service-accounts describe "${SA}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "  service account already exists"
  else
    gcloud iam service-accounts create "${SA_NAME}" \
      --project="${PROJECT}" \
      --display-name="ga4synth daily refresh (fake GA4 export)" \
      --quiet
  fi

  # jobUser is project level by nature: a BigQuery load job runs in the
  # project. run.invoker lets Cloud Scheduler, acting as this account, start
  # the Cloud Run Job. Neither role can read any data.
  local role
  for role in roles/bigquery.jobUser roles/run.invoker; do
    echo "  ${role} on project"
    grant_project_role "${role}"
  done

  # WRITER on the dataset only, not dataEditor on the project, so the job can
  # touch nothing else.
  echo "  WRITER on dataset ${DATASET}"
  grant_dataset_writer
}

# --- 4. deploy-job ---------------------------------------------------------
# Daily args and limits from generator-cli.md "Container contract". The image
# is public (D-10), so the visitor's project pulls it with no grant.
# `deploy` creates or updates, so it is idempotent by itself.
step_deploy_job() {
  # The job's args name the dataset it will write to every morning.
  require_owned_dataset

  gcloud run jobs deploy "${JOB}" \
    --image="${IMAGE}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --service-account="${SA}" \
    --task-timeout=30m \
    --max-retries=1 \
    --memory="${JOB_MEMORY}" \
    --cpu="${JOB_CPU}" \
    --args="$(publish_args "${DAILY_DAYS}")" \
    --quiet
}

# --- 5. create-schedule ----------------------------------------------------
# HTTP job that POSTs to the Cloud Run Jobs v1 run endpoint with an OAuth
# token for SA (which has run.invoker). "update" keeps the same name and
# changes only what differs, so re-running with a new SCHEDULE is safe.
step_create_schedule() {
  local verb=create
  if gcloud scheduler jobs describe "${JOB}" --location="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
    verb=update
  fi
  gcloud scheduler jobs "${verb}" http "${JOB}" \
    --project="${PROJECT}" \
    --location="${REGION}" \
    --schedule="${SCHEDULE}" \
    --time-zone="UTC" \
    --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run" \
    --http-method=POST \
    --oauth-service-account-email="${SA}" \
    --description="Adds yesterday's fake GA4 export table every morning" \
    --quiet
}

# --- 6. run-backfill -------------------------------------------------------
# One execution with the args and timeout overridden. Returns as soon as the
# execution has started (WAIT=1 blocks instead); the tables land over the
# next minutes. Idempotent in effect: loads replace, so a second backfill
# rewrites the same tables.
step_run_backfill() {
  require_owned_dataset

  # Bash 3.2 (macOS) rejects an empty array under set -u, hence the string.
  local wait_flag=""
  if [[ "${WAIT}" == "1" ]]; then wait_flag="--wait"; fi
  local execution
  execution="$(gcloud run jobs execute "${JOB}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --args="$(publish_args "${HISTORY_DAYS}")" \
    --task-timeout="${BACKFILL_TIMEOUT}s" \
    --format='value(metadata.name)' \
    ${wait_flag} \
    --quiet)"
  echo "  execution ${execution} (timeout ${BACKFILL_TIMEOUT}s, ${HISTORY_DAYS} days)"
  echo "  follow it with:"
  echo "    gcloud run jobs executions describe ${execution} --region=${REGION} --project=${PROJECT}"
  echo "    gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=${JOB}' --project=${PROJECT} --limit=50 --order=asc"
}

# --- Run the requested steps in contract order -----------------------------
echo "env=${ENV} project=${PROJECT} dataset=${DATASET} type=${DATASET_TYPE} location=${LOCATION} region=${REGION}"
echo "job=${JOB} sa=${SA} schedule='${SCHEDULE}' history_days=${HISTORY_DAYS}"
echo "image=${IMAGE}"
echo "daily args=$(publish_args "${DAILY_DAYS}" | tr ',' ' ')"
if [[ "${PLAN:-0}" == "1" ]]; then echo "PLAN=1: nothing was changed."; exit 0; fi

require_image_with_type
require_same_install

ALL_STEPS=(enable-apis create-dataset create-service-account deploy-job create-schedule run-backfill)
n=0
for step in "${ALL_STEPS[@]}"; do
  n=$(( n + 1 ))
  if [[ ",${STEPS}," != *",${step},"* ]]; then continue; fi
  echo "--- [${n}/6] ${step}"
  "step_${step//-/_}"
done

echo
echo "Done. Count the tables with:"
echo "  bq --project_id=${PROJECT} ls --max_results=500 ${PROJECT}:${DATASET} | grep -c events_"
echo "Tear down with:"
echo "  PROJECT=${PROJECT} ENV=${ENV} ./infra/uninstall.sh"
