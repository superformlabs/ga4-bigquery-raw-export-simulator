#!/usr/bin/env bash
#
# Host the app (apps/api and apps/web) on Cloud Run in OUR project.
#
#   ./infra/deploy-app.sh                 # dev: build both images and deploy both services
#   ENV=stg ./infra/deploy-app.sh         # the same, in the staging project
#   SKIP_BUILD=1 ./infra/deploy-app.sh    # redeploy the images already tagged with this commit
#   ROTATE_SESSION_SECRET=1 ./infra/deploy-app.sh   # new SESSION_SECRET (signs everyone out)
#   PLAN=1 ENV=stg ./infra/deploy-app.sh  # print the settings and URLs, change nothing
#
# ENV names the environment (default dev); its settings come from
# infra/env/<ENV>.env. Each environment has its own project, OAuth client,
# secrets and images (D-13).
#
# Repeatable: every step is idempotent, so running it twice is safe. No Docker
# is needed on this machine; Cloud Build builds the images.
#
# What it does:
#   1. enables the APIs the hosting needs (run, cloudbuild, artifactregistry,
#      secretmanager, iam) and the APIs the API calls with a visitor's token
#      (cloudresourcemanager, cloudbilling, serviceusage, bigquery,
#      cloudscheduler, orgpolicy)
#   2. creates the private Artifact Registry repository REPO if missing
#   3. creates two service accounts with no project roles: one per service
#   4. puts GOOGLE_CLIENT_SECRET (from API_ENV_FILE) and SESSION_SECRET
#      (generated once) into Secret Manager; grants the API's account read
#      access to those two secrets only
#   5. builds apps/api/Dockerfile with Cloud Build and deploys API_SERVICE,
#      telling it the web URL (APP_URL, GOOGLE_REDIRECT_URI) and the sign-in
#      allowlist (ALLOWED_EMAIL_DOMAINS, ALLOWED_EMAILS) when one is set
#   6. builds apps/web/Dockerfile with API_URL baked in and deploys WEB_SERVICE
#   7. writes both URLs to infra/URLS (dev) or infra/URLS.<ENV> and checks
#      health through both hosts
#
# Both URLs are known before anything is deployed: Cloud Run's deterministic
# form is https://<service>-<project number>.<region>.run.app.
#
# How the two services fit together: the browser only ever talks to the web
# service. Next.js forwards /api/* and /auth/* to the API service (API_URL),
# so the API's session cookie is set on the WEB origin. That is why the OAuth
# redirect URI is <web url>/auth/callback and not <api url>/auth/callback.
#
# Secrets are read from ENV_FILE (default: API_ENV_FILE of the environment,
# apps/api/.env for dev) or from the environment (GOOGLE_CLIENT_ID,
# GOOGLE_CLIENT_SECRET). They are never printed
# and never written into an image. Contract: docs/contracts/api.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Sets PROJECT, REGION, APP_REPO, ALLOWED_EMAIL_DOMAINS, ALLOWED_EMAILS,
# API_ENV_FILE, IMAGE_PATH and URLS_PATH from infra/env/<ENV>.env.
. "${HERE}/lib/env.sh"

REPO="${REPO:-${APP_REPO}}"                        # private repository for the app images
API_SERVICE="${API_SERVICE:-ga4fake-api}"          # Cloud Run service names
WEB_SERVICE="${WEB_SERVICE:-ga4fake-web}"
API_SA_NAME="${API_SA_NAME:-ga4fake-api}"          # service account short names
WEB_SA_NAME="${WEB_SA_NAME:-ga4fake-web}"
CLIENT_SECRET_NAME="${CLIENT_SECRET_NAME:-ga4fake-google-client-secret}"
SESSION_SECRET_NAME="${SESSION_SECRET_NAME:-ga4fake-session-secret}"
SKIP_BUILD="${SKIP_BUILD:-0}"
ROTATE_SESSION_SECRET="${ROTATE_SESSION_SECRET:-0}"

PLAN="${PLAN:-0}"

ROOT="${ROOT_DIR}"
ENV_FILE="${ENV_FILE:-${ROOT}/${API_ENV_FILE}}"
if [[ -z "${GENERATOR_IMAGE:-}" ]]; then
  if [[ ! -s "${IMAGE_PATH}" ]]; then
    echo "${IMAGE_PATH} does not exist yet. Build the generator image first:" >&2
    echo "  ENV=${ENV} ./infra/build.sh" >&2
    exit 2
  fi
  GENERATOR_IMAGE="$(tr -d '[:space:]' < "${IMAGE_PATH}")"
fi

API_SA="${API_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
WEB_SA="${WEB_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"

# Image tag: the commit being deployed, "-dirty" when the tree has changes.
GIT_SHA="$(git -C "${ROOT}" rev-parse --short=12 HEAD)"
TAG="${TAG:-${GIT_SHA}}"
if [[ -n "$(git -C "${ROOT}" status --porcelain --untracked-files=no)" ]]; then
  TAG="${TAG}-dirty"
fi
API_IMAGE="${REGISTRY}/${API_SERVICE}:${TAG}"
WEB_IMAGE="${REGISTRY}/${WEB_SERVICE}:${TAG}"

# Pin every gcloud call to PROJECT (see infra/lib/env.sh for why).
pin_gcloud "${PROJECT}"

# --- Secrets from the .env file (never echoed) -----------------------------
# Reads KEY=value lines, strips one layer of matching quotes. Environment
# variables of the same name win, so a different OAuth client can be used
# without editing the file.
env_value() {
  local key="$1" line
  if [[ -n "${!key:-}" ]]; then printf '%s' "${!key}"; return; fi
  [[ -f "${ENV_FILE}" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" | tail -n1 || true)"
  line="${line#*=}"
  line="${line%%[[:space:]]#*}"
  line="${line#"${line%%[![:space:]]*}"}"   # ltrim
  line="${line%"${line##*[![:space:]]}"}"   # rtrim
  if [[ "${line}" == \"*\" && "${line}" == *\" ]]; then line="${line:1:${#line}-2}"; fi
  if [[ "${line}" == \'*\' && "${line}" == *\' ]]; then line="${line:1:${#line}-2}"; fi
  printf '%s' "${line}"
}

GOOGLE_CLIENT_ID_VALUE="$(env_value GOOGLE_CLIENT_ID)"
GOOGLE_CLIENT_SECRET_VALUE="$(env_value GOOGLE_CLIENT_SECRET)"
if [[ -z "${GOOGLE_CLIENT_ID_VALUE}" || -z "${GOOGLE_CLIENT_SECRET_VALUE}" ]]; then
  echo "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are needed. Put them in ${ENV_FILE}" >&2
  echo "(see apps/api/.env.example) or export them in the environment." >&2
  exit 2
fi

# Cloud Run gives every service two hostnames: an older one with a random
# hash and a deterministic one, https://<service>-<project number>.<region>.run.app.
# Both are served. The scripts use the deterministic one because it can be
# known before the service exists and survives a teardown and redeploy,
# which matters for the URL registered on the OAuth client.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
service_url() { printf 'https://%s-%s.%s.run.app' "$1" "${PROJECT_NUMBER}" "${REGION}"; }
API_URL="$(service_url "${API_SERVICE}")"
WEB_URL="$(service_url "${WEB_SERVICE}")"

echo "env=${ENV} project=${PROJECT} (${PROJECT_NUMBER}) region=${REGION} tag=${TAG}"
echo "api=${API_SERVICE} (${API_SA})  web=${WEB_SERVICE} (${WEB_SA})"
echo "api url=${API_URL}"
echo "web url=${WEB_URL}"
echo "generator image=${GENERATOR_IMAGE}"
echo "allowlist: domains='${ALLOWED_EMAIL_DOMAINS}' emails='${ALLOWED_EMAILS}' (both empty = anyone may sign in)"
echo "oauth client and secret from ${ENV_FILE}; writes ${URLS_PATH}"

# The OAuth client only accepts the exact redirect URI registered on it. When
# ENV_FILE describes a hosted environment (its APP_URL is https), that value
# is what was registered, so it must be the URL this script deploys to.
REGISTERED_APP_URL="$(APP_URL= env_value APP_URL)"
if [[ "${REGISTERED_APP_URL}" == https://* && "${REGISTERED_APP_URL%/}" != "${WEB_URL}" ]]; then
  echo "WARNING: ${ENV_FILE} says APP_URL=${REGISTERED_APP_URL}, but this deploys the web app to" >&2
  echo "  ${WEB_URL}. Sign-in fails until the OAuth client lists the second one." >&2
fi

if [[ "${PLAN}" == "1" ]]; then echo "PLAN=1: nothing was changed."; exit 0; fi

# --- 1. APIs ---------------------------------------------------------------
# First five: the hosting itself. The other six: calls the API makes with a
# visitor's token are counted against the project that owns the OAuth client,
# which is this one, so every Google API the install and the preflight check
# use must be enabled here too (docs/contracts/api.md, "Requirement on our
# side"). Enabling an API costs nothing.
# Remember whether Cloud Build was already on: a build submitted right after
# the API is enabled is refused for a few minutes (see retry_new_api).
SUBMIT=""
if ! api_enabled "${PROJECT}" cloudbuild.googleapis.com; then SUBMIT="retry_new_api"; fi
echo "--- enabling APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com \
  cloudbilling.googleapis.com \
  serviceusage.googleapis.com \
  bigquery.googleapis.com \
  cloudscheduler.googleapis.com \
  orgpolicy.googleapis.com \
  --project="${PROJECT}" --quiet

# --- 2. Repository (private) -----------------------------------------------
# Separate from the public `ga4synth` repository: these images are ours to
# run, nobody else needs to pull them. Cloud Run in the same project pulls
# from Artifact Registry with no extra grant.
echo "--- repository ${REPO} in ${REGION}"
if ! gcloud artifacts repositories describe "${REPO}" \
      --location="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --project="${PROJECT}" \
    --description="GA4 fake dataset installer: web and api images run on Cloud Run" \
    --quiet
else
  echo "  already exists"
fi

# --- 3. Service accounts (no project roles) --------------------------------
# The API acts on the visitor's project with the VISITOR's token, never with
# its own identity, so its account needs no role on any project. The only
# grant it gets is read access to its two secrets (step 4). The web service
# just serves pages and forwards requests; its account has nothing at all.
# Using dedicated accounts keeps the Editor-level default compute account
# out of the picture.
ensure_service_account() {
  local name="$1" display="$2" email="${1}@${PROJECT}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "${email}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "  ${email} already exists"
  else
    gcloud iam service-accounts create "${name}" \
      --project="${PROJECT}" --display-name="${display}" --quiet
  fi
}
echo "--- service accounts"
ensure_service_account "${API_SA_NAME}" "GA4 fake installer: api service (Cloud Run)"
ensure_service_account "${WEB_SA_NAME}" "GA4 fake installer: web service (Cloud Run)"

# --- 4. Secrets ------------------------------------------------------------
# One Secret Manager secret per value. A new version is added only when the
# value differs from the current one, so re-running changes nothing. The
# API's account gets secretAccessor on each secret, not on the project.
ensure_secret() {
  local name="$1"
  if gcloud secrets describe "${name}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "  secret ${name} already exists"
  else
    gcloud secrets create "${name}" \
      --project="${PROJECT}" --replication-policy=automatic --quiet
  fi
  gcloud secrets add-iam-policy-binding "${name}" \
    --project="${PROJECT}" \
    --member="serviceAccount:${API_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet >/dev/null
}
# Adds a version holding $2 unless the latest version already holds it.
ensure_secret_version() {
  local name="$1" value="$2" current=""
  current="$(gcloud secrets versions access latest --secret="${name}" --project="${PROJECT}" 2>/dev/null || true)"
  if [[ "${current}" == "${value}" ]]; then
    echo "  ${name}: current version is up to date"
  else
    printf '%s' "${value}" | gcloud secrets versions add "${name}" \
      --project="${PROJECT}" --data-file=- --quiet >/dev/null
    echo "  ${name}: new version added"
  fi
}
echo "--- secrets"
ensure_secret "${CLIENT_SECRET_NAME}"
ensure_secret_version "${CLIENT_SECRET_NAME}" "${GOOGLE_CLIENT_SECRET_VALUE}"

# The hosted SESSION_SECRET is generated here once and never read back into
# a file. Rotating it invalidates every session cookie in circulation.
ensure_secret "${SESSION_SECRET_NAME}"
if [[ "${ROTATE_SESSION_SECRET}" == "1" ]] \
   || ! gcloud secrets versions access latest --secret="${SESSION_SECRET_NAME}" --project="${PROJECT}" >/dev/null 2>&1; then
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add "${SESSION_SECRET_NAME}" \
    --project="${PROJECT}" --data-file=- --quiet >/dev/null
  echo "  ${SESSION_SECRET_NAME}: new version generated"
else
  echo "  ${SESSION_SECRET_NAME}: keeping the current version"
fi

# --- Helpers ---------------------------------------------------------------
build_image() {
  local dockerfile="$1" image="$2" api_url="${3:-http://localhost:3001}"
  if [[ "${SKIP_BUILD}" == "1" ]]; then
    echo "  SKIP_BUILD=1: using ${image} as is"
    return
  fi
  ${SUBMIT} gcloud builds submit "${ROOT}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --config="${HERE}/cloudbuild-app.yaml" \
    --ignore-file="infra/app.gcloudignore" \
    --substitutions="_DOCKERFILE=${dockerfile},_IMAGE=${image},_GIT_SHA=${GIT_SHA},_API_URL=${api_url}" \
    --quiet
}

# Common Cloud Run shape: public HTTPS endpoint, scales to zero, small.
# A revision holds up to 80 concurrent requests, so 3 instances is plenty
# for a tool used by a few people at a time. Nothing costs money when idle.
RUN_FLAGS=(
  --project="${PROJECT}"
  --region="${REGION}"
  --platform=managed
  --allow-unauthenticated
  --ingress=all
  --cpu=1
  --memory=512Mi
  --min-instances=0
  --max-instances=3
  --concurrency=80
  --timeout=120
  --quiet
)

# --- 5. API ----------------------------------------------------------------
echo "--- building ${API_IMAGE}"
build_image "apps/api/Dockerfile" "${API_IMAGE}"

# The allowlist values are comma-separated lists, and a comma is also what
# gcloud splits --set-env-vars on. "^##^" at the start tells gcloud to split
# on "##" instead. The two allowlist variables are left out when empty.
API_ENV_VARS="NODE_ENV=production##GIT_SHA=${GIT_SHA}##GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID_VALUE}"
API_ENV_VARS="${API_ENV_VARS}##GOOGLE_REDIRECT_URI=${WEB_URL}/auth/callback##APP_URL=${WEB_URL}"
API_ENV_VARS="${API_ENV_VARS}##GENERATOR_IMAGE=${GENERATOR_IMAGE}"
if [[ -n "${ALLOWED_EMAIL_DOMAINS}" ]]; then
  API_ENV_VARS="${API_ENV_VARS}##ALLOWED_EMAIL_DOMAINS=${ALLOWED_EMAIL_DOMAINS}"
fi
if [[ -n "${ALLOWED_EMAILS}" ]]; then
  API_ENV_VARS="${API_ENV_VARS}##ALLOWED_EMAILS=${ALLOWED_EMAILS}"
fi

echo "--- deploying ${API_SERVICE} (APP_URL=${WEB_URL})"
gcloud run deploy "${API_SERVICE}" \
  --image="${API_IMAGE}" \
  --service-account="${API_SA}" \
  --set-env-vars="^##^${API_ENV_VARS}" \
  --set-secrets="GOOGLE_CLIENT_SECRET=${CLIENT_SECRET_NAME}:latest,SESSION_SECRET=${SESSION_SECRET_NAME}:latest" \
  "${RUN_FLAGS[@]}"

# --- 6. Web ----------------------------------------------------------------
echo "--- building ${WEB_IMAGE} (API_URL=${API_URL})"
build_image "apps/web/Dockerfile" "${WEB_IMAGE}" "${API_URL}"

echo "--- deploying ${WEB_SERVICE}"
gcloud run deploy "${WEB_SERVICE}" \
  --image="${WEB_IMAGE}" \
  --service-account="${WEB_SA}" \
  --set-env-vars="NODE_ENV=production,API_URL=${API_URL}" \
  "${RUN_FLAGS[@]}"

# --- 7. Record and check ---------------------------------------------------
printf 'API_URL=%s\nWEB_URL=%s\n' "${API_URL}" "${WEB_URL}" > "${URLS_PATH}"
echo "--- wrote ${URLS_PATH}"

check() {
  local what="$1" url="$2" expect="$3" code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "${url}")"
  if [[ "${code}" == "${expect}" ]]; then
    echo "  ok   ${code} ${what}: ${url}"
  else
    echo "  FAIL ${code} (wanted ${expect}) ${what}: ${url}" >&2
    return 1
  fi
}
# Follows no redirects: a 302's Location header is what is being checked.
check_location() {
  local what="$1" url="$2" expect="$3" location
  location="$(curl -sS -o /dev/null -D - "${url}" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
  if [[ "${location}" == *"${expect}"* ]]; then
    echo "  ok   302 ${what}: ${url}"
  else
    echo "  FAIL ${what}: ${url} redirected to '${location}', wanted it to contain '${expect}'" >&2
    return 1
  fi
}
echo "--- checks"
check "api health, direct"                  "${API_URL}/api/health" 200
check "api health, via web proxy"           "${WEB_URL}/api/health" 200
check "web sign-in page"                    "${WEB_URL}/"           200
check "/api/me without a cookie, via web"   "${WEB_URL}/api/me"     401
# The sign-in redirect must tell Google to come back to the WEB host, and a
# cancelled sign-in must land on the web home page with the error code.
check_location "sign-in redirect names the web callback" "${WEB_URL}/auth/login" \
  "redirect_uri=$(printf '%s' "${WEB_URL}/auth/callback" | sed 's,:,%3A,g; s,/,%2F,g')"
check_location "cancelled sign-in lands on the web home page" \
  "${WEB_URL}/auth/callback?error=access_denied&state=x" "${WEB_URL}/?error=PERMISSION_DENIED"

echo
echo "Done."
echo "  web: ${WEB_URL}"
echo "  api: ${API_URL}"
echo
echo "Sign-in works only when the OAuth client of this environment lists:"
echo "  authorised JavaScript origin: ${WEB_URL}"
echo "  authorised redirect URI:      ${WEB_URL}/auth/callback"
echo "Tear down with: ENV=${ENV} ./infra/deploy-app-teardown.sh"
