#!/usr/bin/env bash
#
# Undo what infra/install.sh created in a target project, in reverse order:
# the Cloud Scheduler job, the Cloud Run Job, the service account's project
# roles, the service account itself, and (only when asked) the dataset.
#
#   PROJECT=your-project-id ./infra/uninstall.sh
#   PROJECT=your-project-id CONFIRM_DELETE_DATASET=1 ./infra/uninstall.sh
#
# PROJECT is the TARGET project and must always be given. ENV (default dev)
# only supplies the default REGION, from infra/env/<ENV>.env.
#
# Without CONFIRM_DELETE_DATASET=1 the dataset and its tables are kept, so a
# mistaken run cannot destroy data. APIs stay enabled. Safe to run when
# nothing exists. Never touches any other project.
#
# Dataset ownership (api.md v1.6, decision D-19): even with
# CONFIRM_DELETE_DATASET=1, only a dataset created by the installer is
# deleted, which the script recognises by the label
# managed-by=ga4-fake-dataset-installer. A dataset without the label is left
# exactly as it is and the script ends with exit code 3.

set -euo pipefail

: "${PROJECT:?set PROJECT to the target Google Cloud project id}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# PROJECT is already set, so the environment file cannot replace it.
. "${HERE}/lib/env.sh"

DATASET="${DATASET:-analytics_770000001}"
JOB="${JOB:-ga4synth-daily}"
SA_NAME="${SA_NAME:-ga4synth}"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
CONFIRM_DELETE_DATASET="${CONFIRM_DELETE_DATASET:-0}"

pin_gcloud "${PROJECT}"

# The ownership rule and every dataset call (BigQuery REST API).
. "${HERE}/lib/dataset.sh"

echo "env=${ENV} project=${PROJECT} dataset=${DATASET} region=${REGION} job=${JOB} sa=${SA}"
if [[ "${PLAN:-0}" == "1" ]]; then echo "PLAN=1: nothing was changed."; exit 0; fi

# --- Schedule --------------------------------------------------------------
if gcloud scheduler jobs describe "${JOB}" --location="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "--- deleting scheduler job ${JOB}"
  # Cloud Scheduler refuses a delete for a short while after the job was
  # created or changed ("ABORTED: sync mutate calls cannot be queued", seen
  # 2026-09-26), so an uninstall right after an install needs a second try.
  retry 6 20 gcloud scheduler jobs delete "${JOB}" --location="${REGION}" --project="${PROJECT}" --quiet
else
  echo "--- scheduler job ${JOB} not found; nothing to delete"
fi

# --- Cloud Run Job ---------------------------------------------------------
# Deleting the job also removes its executions and their logs' index entries.
if gcloud run jobs describe "${JOB}" --region="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "--- deleting Cloud Run job ${JOB}"
  gcloud run jobs delete "${JOB}" --region="${REGION}" --project="${PROJECT}" --quiet
else
  echo "--- Cloud Run job ${JOB} not found; nothing to delete"
fi

# --- Service account -------------------------------------------------------
# Remove the project roles and the dataset's WRITER entry first, so neither
# policy holds a dangling member. The dataset entry is only touched on a
# dataset the installer created. A dataset that cannot be read (BigQuery
# switched off, no access) does not stop the rest of the uninstall.
dataset_read soft
if gcloud iam service-accounts describe "${SA}" --project="${PROJECT}" >/dev/null 2>&1; then
  if [[ "${DATASET_STATE}" == "owned" ]]; then
    echo "--- removing WRITER on dataset ${DATASET} from ${SA}"
    dataset_writer remove "${SA}"
  fi
  for role in roles/bigquery.jobUser roles/run.invoker; do
    echo "--- removing ${role} from ${SA}"
    gcloud projects remove-iam-policy-binding "${PROJECT}" \
      --member="serviceAccount:${SA}" \
      --role="${role}" \
      --condition=None --quiet >/dev/null 2>&1 || echo "  (binding was not present)"
  done
  echo "--- deleting service account ${SA}"
  gcloud iam service-accounts delete "${SA}" --project="${PROJECT}" --quiet
else
  echo "--- service account ${SA} not found; nothing to delete"
fi

# --- Dataset (opt-in) ------------------------------------------------------
if [[ "${DATASET_STATE}" == "missing" ]]; then
  echo "--- dataset ${PROJECT}:${DATASET} not found; nothing to delete"
elif [[ "${CONFIRM_DELETE_DATASET}" != "1" ]]; then
  echo "--- keeping dataset ${PROJECT}:${DATASET}"
  echo "    (re-run with CONFIRM_DELETE_DATASET=1 to delete it and all its tables)"
elif [[ "${DATASET_STATE}" == "owned" ]]; then
  echo "--- deleting dataset ${PROJECT}:${DATASET} and every table in it"
  dataset_delete
elif [[ "${DATASET_STATE}" == "unreadable" ]]; then
  echo "--- dataset ${PROJECT}:${DATASET} could not be read (see above); left as it is" >&2
  exit 1
else
  echo "REFUSED: Dataset ${DATASET} in project ${PROJECT} was not created by this installer, so it is not deleted." >&2
  echo "  What to do: Delete it by hand in the console if that is really intended:" >&2
  echo "  https://console.cloud.google.com/bigquery?project=${PROJECT}" >&2
  exit "${EXIT_NOT_OWNED}"
fi

echo "Done."
