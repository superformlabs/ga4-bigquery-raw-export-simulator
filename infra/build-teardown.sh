#!/usr/bin/env bash
#
# Undo what infra/build.sh created in OUR project: the Artifact Registry
# repository (with every image in it) and the Cloud Build staging bucket.
# APIs stay enabled; disabling them is a separate, heavier operation.
#
#   ./infra/build-teardown.sh             # dev
#   ENV=stg ./infra/build-teardown.sh     # staging
#
# Safe to run when nothing exists. Never touches any other project.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Sets PROJECT, REGION, GENERATOR_REPO and IMAGE_PATH from infra/env/<ENV>.env.
. "${HERE}/lib/env.sh"

REPO="${REPO:-${GENERATOR_REPO}}"

pin_gcloud "${PROJECT}"

echo "env=${ENV} project=${PROJECT} region=${REGION} repo=${REPO}"
if [[ "${PLAN:-0}" == "1" ]]; then echo "PLAN=1: nothing was changed."; exit 0; fi

if gcloud artifacts repositories describe "${REPO}" \
     --location="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "--- deleting repository ${REPO} and all its images"
  gcloud artifacts repositories delete "${REPO}" \
    --location="${REGION}" --project="${PROJECT}" --quiet
else
  echo "--- repository ${REPO} not found; nothing to delete"
fi

BUCKET="gs://${PROJECT}_cloudbuild"
if gcloud storage buckets describe "${BUCKET}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "--- deleting Cloud Build staging bucket ${BUCKET}"
  gcloud storage rm -r "${BUCKET}" --project="${PROJECT}" --quiet
else
  echo "--- bucket ${BUCKET} not found; nothing to delete"
fi

if [[ -f "${IMAGE_PATH}" ]]; then
  echo "--- note: ${IMAGE_PATH} still names the deleted image; run build.sh to rebuild"
fi

echo "Done."
