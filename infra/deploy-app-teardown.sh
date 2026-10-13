#!/usr/bin/env bash
#
# Undo what infra/deploy-app.sh created in OUR project: the two Cloud Run
# services, the two secrets, the two service accounts and the private image
# repository. Leaves the APIs enabled and the public ga4synth repository
# alone. Safe to run when nothing exists. Running deploy-app.sh again
# restores everything (with a new SESSION_SECRET).
#
#   ./infra/deploy-app-teardown.sh             # dev
#   ENV=stg ./infra/deploy-app-teardown.sh     # staging

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Sets PROJECT, REGION, APP_REPO and URLS_PATH from infra/env/<ENV>.env.
. "${HERE}/lib/env.sh"

REPO="${REPO:-${APP_REPO}}"
API_SERVICE="${API_SERVICE:-ga4fake-api}"
WEB_SERVICE="${WEB_SERVICE:-ga4fake-web}"
API_SA_NAME="${API_SA_NAME:-ga4fake-api}"
WEB_SA_NAME="${WEB_SA_NAME:-ga4fake-web}"
CLIENT_SECRET_NAME="${CLIENT_SECRET_NAME:-ga4fake-google-client-secret}"
SESSION_SECRET_NAME="${SESSION_SECRET_NAME:-ga4fake-session-secret}"

pin_gcloud "${PROJECT}"

echo "env=${ENV} project=${PROJECT} region=${REGION}"
if [[ "${PLAN:-0}" == "1" ]]; then echo "PLAN=1: nothing was changed."; exit 0; fi

for svc in "${WEB_SERVICE}" "${API_SERVICE}"; do
  if gcloud run services describe "${svc}" --region="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "--- deleting Cloud Run service ${svc}"
    gcloud run services delete "${svc}" --region="${REGION}" --project="${PROJECT}" --quiet
  else
    echo "--- Cloud Run service ${svc} not found; nothing to delete"
  fi
done

for secret in "${CLIENT_SECRET_NAME}" "${SESSION_SECRET_NAME}"; do
  if gcloud secrets describe "${secret}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "--- deleting secret ${secret}"
    gcloud secrets delete "${secret}" --project="${PROJECT}" --quiet
  else
    echo "--- secret ${secret} not found; nothing to delete"
  fi
done

for name in "${API_SA_NAME}" "${WEB_SA_NAME}"; do
  email="${name}@${PROJECT}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "${email}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "--- deleting service account ${email}"
    gcloud iam service-accounts delete "${email}" --project="${PROJECT}" --quiet
  else
    echo "--- service account ${email} not found; nothing to delete"
  fi
done

if gcloud artifacts repositories describe "${REPO}" --location="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "--- deleting repository ${REPO} (all app images)"
  gcloud artifacts repositories delete "${REPO}" --location="${REGION}" --project="${PROJECT}" --quiet
else
  echo "--- repository ${REPO} not found; nothing to delete"
fi

echo "Done. ${URLS_PATH} still names the old URLs; the next deploy-app.sh rewrites it."
