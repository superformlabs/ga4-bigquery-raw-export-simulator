# shellcheck shell=bash
#
# Shared by every script in infra/. Sourced, never run.
#
# Picks the environment named by ENV (default: dev) and reads its settings
# from infra/env/<ENV>.env. An environment is one Google Cloud project of
# ours plus everything that belongs to it (decision D-13).
#
#   ./infra/deploy-app.sh              # dev, as before
#   ENV=stg ./infra/deploy-app.sh      # staging
#
# A variable that is already set when the script starts wins over the file,
# so a single value can be changed for one run without editing anything:
#
#   ENV=stg REGION=europe-west1 ./infra/build.sh
#
# The files hold settings only, never secrets. Secrets live in the file named
# by API_ENV_FILE (apps/api/.env, apps/api/.env.stg), which is not committed.
#
# After sourcing, these are set: ENV, INFRA_DIR, ROOT_DIR, ENV_CONFIG, every
# key of the environment file, and IMAGE_PATH and URLS_PATH (full paths of
# the two output files).

ENV="${ENV:-dev}"
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "${INFRA_DIR}/.." && pwd)"
ENV_CONFIG="${INFRA_DIR}/env/${ENV}.env"

if ! [[ "${ENV}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "ENV must be a short lowercase name like dev or stg, got '${ENV}'" >&2
  exit 2
fi
if [[ ! -f "${ENV_CONFIG}" ]]; then
  echo "No environment '${ENV}': ${ENV_CONFIG} does not exist." >&2
  echo "Available: $(cd "${INFRA_DIR}/env" && ls *.env 2>/dev/null | sed 's/\.env$//' | tr '\n' ' ')" >&2
  exit 2
fi

# Reads KEY=value lines. Not `source`: the file is data, so nothing in it can
# run a command, and values already set by the caller are left alone.
while IFS= read -r _line || [[ -n "${_line}" ]]; do
  _line="${_line%%#*}"
  _line="${_line#"${_line%%[![:space:]]*}"}"   # ltrim
  _line="${_line%"${_line##*[![:space:]]}"}"   # rtrim
  [[ -z "${_line}" ]] && continue
  if ! [[ "${_line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
    echo "${ENV_CONFIG}: cannot read the line '${_line}' (expected KEY=value)" >&2
    exit 2
  fi
  _key="${BASH_REMATCH[1]}"
  _value="${BASH_REMATCH[2]}"
  if [[ -z "${!_key+set}" ]]; then
    printf -v "${_key}" '%s' "${_value}"
  fi
done < "${ENV_CONFIG}"
unset _line _key _value

IMAGE_PATH="${INFRA_DIR}/${IMAGE_FILE:-IMAGE}"
URLS_PATH="${INFRA_DIR}/${URLS_FILE:-URLS}"

# Pin gcloud and bq to one project (and one Google account, when ACCOUNT is
# set) for the rest of the script. `--project` alone is not enough: Cloud
# Build and quota are attributed to the configuration's core/project and
# billing/quota_project, and this machine's default configuration points at
# another project and holds several accounts.
pin_gcloud() {
  export CLOUDSDK_CORE_PROJECT="$1"
  export CLOUDSDK_BILLING_QUOTA_PROJECT="$1"
  if [[ -n "${ACCOUNT:-}" ]]; then
    export CLOUDSDK_CORE_ACCOUNT="${ACCOUNT}"
  fi
}

# True when API $2 (for example cloudbuild.googleapis.com) is enabled in
# project $1.
api_enabled() {
  [[ -n "$(gcloud services list --enabled --project="$1" \
    --filter="config.name=$2" --format='value(config.name)' 2>/dev/null)" ]]
}

# retry ATTEMPTS SECONDS COMMAND...
# Runs the command. When it fails, waits SECONDS and tries again, ATTEMPTS
# times in all. Only for calls known to fail for a short while and then work.
retry() {
  local attempts="$1" pause="$2" attempt=1
  shift 2
  until "$@"; do
    if (( attempt >= attempts )); then return 1; fi
    echo "  attempt ${attempt} of ${attempts} failed; trying again in ${pause} s" >&2
    sleep "${pause}"
    attempt=$(( attempt + 1 ))
  done
}

# For the first call to an API that this run has just enabled: Google reports
# the API as enabled at once, but the API refuses calls with
# PERMISSION_DENIED for a few minutes (seen on the staging project on
# 2026-09-26: about three minutes for Cloud Build).
retry_new_api() { retry 6 60 "$@"; }
