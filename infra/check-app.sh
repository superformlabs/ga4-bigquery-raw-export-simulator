#!/usr/bin/env bash
#
# Check the hosted app of one environment from the outside. Changes nothing,
# needs no sign-in to the app, and can be run at any time.
#
#   ./infra/check-app.sh                          # dev
#   ENV=stg ./infra/check-app.sh                  # staging
#   ENV=stg EXPECT_VERSION=f1b9c87dda7e ./infra/check-app.sh
#
# It reads the two URLs from infra/URLS (dev) or infra/URLS.<ENV>, written
# by deploy-app.sh, and checks:
#
#    1. GET  <api>/api/health                      200
#    2. GET  <web>/api/health                      200, so the proxy works
#    3. GET  <web>/                                200, the sign-in page
#    4. GET  <web>/api/me without a cookie         401
#    5. GET  <web>/auth/login                      redirects to Google with
#                                                  redirect_uri=<web>/auth/callback
#    6. GET  <web>/auth/callback?error=...         redirects to
#                                                  <web>/?error=PERMISSION_DENIED
#    7. GET  <web>/install                         200, the install page
#    8. POST <web>/api/install/preflight           401. A 404 means the
#                                                  backend is older than the
#                                                  preflight check (api.md v1.5)
#    9. POST <web>/api/install/uninstall           404. The uninstall is switched
#                                                  off for now (decision D-30,
#                                                  api.md v1.13). A 401 means the
#                                                  setting UNINSTALL_ENABLED is on.
#   10. GET  <web>/api/install/existing            401. A 404 means the
#                                                  backend is older than the
#                                                  new design (api.md v1.8)
#   11. the version /api/health reports is the tag of the image the api
#       service runs, the web service runs the same tag (web and api must go
#       out together), and it equals EXPECT_VERSION when that is given
#   12. the sign-in allowlist on the api service is the one of the
#       environment (infra/env/<ENV>.env)
#   13. the generator image the api service gives to new installs is the one
#       named in infra/IMAGE (dev) or infra/IMAGE.<ENV>, and that image holds
#       the two types of dataset (read from the registry, no credentials)
#
# Ends with exit code 0 when every check passes, 1 otherwise.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Sets PROJECT, REGION, ALLOWED_EMAIL_DOMAINS, ALLOWED_EMAILS, URLS_PATH and
# IMAGE_PATH.
. "${HERE}/lib/env.sh"
# Reads an image's settings from the registry, without credentials.
. "${HERE}/lib/image.sh"

API_SERVICE="${API_SERVICE:-ga4fake-api}"
WEB_SERVICE="${WEB_SERVICE:-ga4fake-web}"
EXPECT_VERSION="${EXPECT_VERSION:-}"

pin_gcloud "${PROJECT}"

if [[ ! -s "${URLS_PATH}" ]]; then
  echo "${URLS_PATH} does not exist yet. Deploy first: ENV=${ENV} ./infra/deploy-app.sh" >&2
  exit 2
fi
API_URL="$(grep -E '^API_URL=' "${URLS_PATH}" | tail -n1 | cut -d= -f2-)"
WEB_URL="$(grep -E '^WEB_URL=' "${URLS_PATH}" | tail -n1 | cut -d= -f2-)"

echo "env=${ENV} project=${PROJECT} region=${REGION}"
echo "api=${API_URL}"
echo "web=${WEB_URL}"

FAILED=0
ok()   { echo "  ok   $*"; }
fail() { echo "  FAIL $*" >&2; FAILED=$(( FAILED + 1 )); }

# check NAME METHOD URL EXPECTED_STATUS
check() {
  local what="$1" method="$2" url="$3" expect="$4" code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X "${method}" \
    -H 'Content-Type: application/json' "${url}")"
  if [[ "${code}" == "${expect}" ]]; then
    ok "${code} ${what}: ${method} ${url}"
  else
    fail "${code} (wanted ${expect}) ${what}: ${method} ${url}"
  fi
}

# Follows no redirects: a 302's Location header is what is being checked.
check_location() {
  local what="$1" url="$2" expect="$3" location
  location="$(curl -sS -o /dev/null -D - "${url}" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
  if [[ "${location}" == *"${expect}"* ]]; then
    ok "302 ${what}: ${url}"
  else
    fail "${what}: ${url} redirected to '${location}', wanted it to contain '${expect}'"
  fi
}

echo "--- pages and routes"
check "api health, direct"                 GET  "${API_URL}/api/health" 200
check "api health, via web proxy"          GET  "${WEB_URL}/api/health" 200
check "web sign-in page"                   GET  "${WEB_URL}/"           200
check "/api/me without a cookie, via web"  GET  "${WEB_URL}/api/me"     401
check_location "sign-in redirect names the web callback" "${WEB_URL}/auth/login" \
  "redirect_uri=$(printf '%s' "${WEB_URL}/auth/callback" | sed 's,:,%3A,g; s,/,%2F,g')"
check_location "cancelled sign-in lands on the web home page" \
  "${WEB_URL}/auth/callback?error=access_denied&state=x" "${WEB_URL}/?error=PERMISSION_DENIED"
check "install page"                       GET  "${WEB_URL}/install"                200
check "preflight exists and wants a sign-in" POST "${WEB_URL}/api/install/preflight" 401
check "uninstall is switched off (D-30)"     POST "${WEB_URL}/api/install/uninstall" 404
check "existing exists and wants a sign-in"  GET  "${WEB_URL}/api/install/existing"  401

echo "--- version"
HEALTH_VERSION="$(curl -sS "${WEB_URL}/api/health" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("version", ""))
except Exception:
    print("")
')"
# The image tag is what follows the last colon of the image name.
service_tag() {
  local image
  image="$(gcloud run services describe "$1" --region="${REGION}" --project="${PROJECT}" \
    --format='value(spec.template.spec.containers[0].image)' 2>/dev/null)"
  printf '%s' "${image##*:}"
}
API_TAG="$(service_tag "${API_SERVICE}")"
WEB_TAG="$(service_tag "${WEB_SERVICE}")"
# deploy-app.sh adds "-dirty" to the tag when it deployed uncommitted changes.
if [[ -n "${HEALTH_VERSION}" && "${HEALTH_VERSION}" == "${API_TAG}" ]]; then
  ok "/api/health reports ${HEALTH_VERSION}, the image the api service runs"
elif [[ -n "${HEALTH_VERSION}" && "${HEALTH_VERSION}-dirty" == "${API_TAG}" ]]; then
  fail "the api service runs ${API_TAG}: commit ${HEALTH_VERSION} plus changes that were never committed"
else
  fail "/api/health reports '${HEALTH_VERSION}', the api service runs image tag '${API_TAG}'"
fi
if [[ -n "${WEB_TAG}" && "${WEB_TAG}" == "${API_TAG}" ]]; then
  ok "web and api run the same version, ${WEB_TAG}"
else
  fail "web runs '${WEB_TAG}', api runs '${API_TAG}': deploy both together"
fi
if [[ -n "${EXPECT_VERSION}" ]]; then
  if [[ "${HEALTH_VERSION}" == "${EXPECT_VERSION}" ]]; then
    ok "version is the expected ${EXPECT_VERSION}"
  else
    fail "version is '${HEALTH_VERSION}', expected '${EXPECT_VERSION}'"
  fi
fi

echo "--- sign-in allowlist on the api service"
SERVICE_ENV="$(gcloud run services describe "${API_SERVICE}" --region="${REGION}" --project="${PROJECT}" --format=json 2>/dev/null)"
for name in ALLOWED_EMAIL_DOMAINS ALLOWED_EMAILS; do
  actual="$(printf '%s' "${SERVICE_ENV}" | python3 -c '
import json, sys
try:
    env = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env", [])
except Exception:
    env = []
print(next((e.get("value", "") for e in env if e["name"] == sys.argv[1]), ""))
' "${name}")"
  wanted="${!name}"
  if [[ "${actual}" == "${wanted}" ]]; then
    ok "${name}='${actual}' (empty = not set)"
  else
    fail "${name} is '${actual}' on the service, the environment says '${wanted}'"
  fi
done

# Every job the backend installs names /app/config/<type>/ (api.md v1.8), so
# the image it hands out must hold the types, or the jobs stop at start.
echo "--- generator image given to new installs"
SERVICE_IMAGE="$(printf '%s' "${SERVICE_ENV}" | python3 -c '
import json, sys
try:
    env = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env", [])
except Exception:
    env = []
print(next((e.get("value", "") for e in env if e["name"] == "GENERATOR_IMAGE"), ""))
')"
WANTED_IMAGE=""
if [[ -s "${IMAGE_PATH}" ]]; then WANTED_IMAGE="$(tr -d '[:space:]' < "${IMAGE_PATH}")"; fi
if [[ -n "${SERVICE_IMAGE}" && "${SERVICE_IMAGE}" == "${WANTED_IMAGE}" ]]; then
  ok "GENERATOR_IMAGE is ${SERVICE_IMAGE}, as in ${IMAGE_PATH##*/}"
else
  fail "GENERATOR_IMAGE is '${SERVICE_IMAGE}' on the service, ${IMAGE_PATH##*/} says '${WANTED_IMAGE}'"
fi
if [[ -n "${SERVICE_IMAGE}" ]] && image_read "${SERVICE_IMAGE}" \
    && image_holds_type default && image_holds_type ecommerce; then
  ok "that image holds the types ${IMAGE_TYPES}"
else
  fail "the image '${SERVICE_IMAGE}' does not name the types default and ecommerce (it names '${IMAGE_TYPES:-}')"
fi

echo
if (( FAILED > 0 )); then
  echo "${FAILED} check(s) failed." >&2
  exit 1
fi
echo "All checks passed."
