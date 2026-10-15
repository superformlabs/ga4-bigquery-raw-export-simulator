#!/usr/bin/env bash
#
# Build the ga4synth generator container with Cloud Build and publish it to
# Artifact Registry in OUR project, readable by anyone (decision D-10).
#
# Repeatable: every step is idempotent, so running it twice is safe.
# No Docker is needed on this machine; Cloud Build does the build.
#
#   ./infra/build.sh                      # dev project
#   ENV=stg ./infra/build.sh              # staging project, its own repository
#   PLAN=1 ENV=stg ./infra/build.sh       # print the settings and stop
#
# ENV names the environment (default dev); its settings come from
# infra/env/<ENV>.env. Each environment builds its own image in its own
# project: nothing is shared between environments except the code (D-13).
#
# The generator is built from this repository (decision D-91): its code,
# its Dockerfile and its four configurations all live in packages/generator/.
# Nothing is cloned and nothing is downloaded. Before D-91 the code came from
# one pinned commit of another repository; packages/generator/ORIGIN.md says
# where that code came from.
#
# The image holds the app's four configurations (decisions D-23, D-96 and
# D-97), one per type of dataset: /app/config/default/,
# /app/config/ecommerce/, /app/config/eu-consent/ and
# /app/config/lead-generation/, each with property.yaml and mixer.yaml. A job
# names its configuration with the generator's options --property and
# --mixer. The two environment variables of the image name the ecommerce
# pair, as a fallback for the installs made before the types existed, whose
# jobs name no configuration.
#
# THE TAG: "src-" and twelve characters.
#
#   src-<12 characters>     for example src-9f3c1a7b52de
#
# The twelve characters are the start of a SHA-256 checksum of every file
# that goes into the image, with its name: the Dockerfile, pyproject.toml,
# README.md, LICENSE, every file of src/ga4synth/, and the configuration
# files of the four types, eight files. So the same files give the same tag
# on every machine, and a change
# to any one of them gives a new tag. An image that an install already uses
# is therefore never replaced. The prefix "src-" keeps the new tags apart
# from the old ones, which began with the commit of the other repository.
# Nothing in apps/ or infra/ reads the tag apart from this script: install.sh
# and the API read the whole image name verbatim, and the types from the
# image's label.
#
# What it does:
#   1. enables the Google Cloud APIs the app needs in PROJECT
#   2. creates the Artifact Registry repository REPO if missing
#   3. grants allUsers read on that repository
#   4. copies the files the image needs from packages/generator/ into a temp
#      folder, which is deleted when the script ends
#   5. checks that the copy holds exactly those files
#   6. builds the image with Cloud Build, checks it (cloudbuild-generator.yaml)
#      and publishes it under its tag, and latest
#   7. writes the exact image name to infra/IMAGE (dev) or infra/IMAGE.<ENV>
#   8. checks that the tag is visible without authentication, and that the
#      published image names its types and the fallback configuration
#
# Contract: docs/contracts/generator-cli.md ("Container contract").

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Sets PROJECT, REGION, GENERATOR_REPO and IMAGE_PATH from infra/env/<ENV>.env.
. "${HERE}/lib/env.sh"
# Reads an image's settings from the registry, without credentials.
. "${HERE}/lib/image.sh"

REPO="${REPO:-${GENERATOR_REPO}}"                  # Artifact Registry repository
IMAGE_NAME="${IMAGE_NAME:-ga4synth}"               # image inside the repository

ROOT="${ROOT_DIR}"
GENERATOR_DIR="${GENERATOR_DIR:-${ROOT}/packages/generator}"
APP_CONFIG="${APP_CONFIG:-${GENERATOR_DIR}/config}"

# --- What goes into the image ----------------------------------------------
# The types of dataset, one folder each, as in docs/contracts/api.md
# (`datasetType`) and infra/install.sh (DATASET_TYPE).
CONFIG_TYPES=(default ecommerce eu-consent lead-generation)
CONFIG_FILES=(property.yaml mixer.yaml)
# The type a job without --property and --mixer produces.
FALLBACK_TYPE="ecommerce"
# Where the image holds the configurations (generator-cli.md).
CONFIG_DIR="/app/config"
# The day the build generates to check the image. Any past day would do.
CHECK_DATE="${CHECK_DATE:-2026-09-01}"
CONFIG_TYPES_LIST="$(IFS=,; printf '%s' "${CONFIG_TYPES[*]}")"

# The files the Dockerfile copies, beside src/ and config/. README.md and
# LICENSE are in the list because pyproject.toml names them, so the image
# does not build without them.
TOP_FILES=(Dockerfile pyproject.toml README.md LICENSE)

# Everything that goes into the image, as paths under GENERATOR_DIR. The
# order is sorted below, so the tag does not depend on how the list was
# built. Nothing outside this list is uploaded: step 4 copies these files
# and only these.
IMAGE_PATHS=()

for _file in "${TOP_FILES[@]}"; do
  if [[ ! -s "${GENERATOR_DIR}/${_file}" ]]; then
    echo "${GENERATOR_DIR}/${_file} does not exist. The image is built from the generator in this repository (D-91)." >&2
    exit 2
  fi
  IMAGE_PATHS+=("${_file}")
done
unset _file

# The generator itself. Found rather than listed, so a file added to the
# package is built in and changes the tag. __pycache__ and anything else git
# ignores is left out.
while IFS= read -r _found; do
  IMAGE_PATHS+=("${_found#"${GENERATOR_DIR}/"}")
done < <(find "${GENERATOR_DIR}/src/ga4synth" \
           -name '__pycache__' -prune -o \
           -type f ! -name '*.pyc' -print | sort)
unset _found
for _needed in src/ga4synth/__init__.py src/ga4synth/cli.py src/ga4synth/data/events.json; do
  if [[ ! -s "${GENERATOR_DIR}/${_needed}" ]]; then
    echo "${GENERATOR_DIR}/${_needed} does not exist, so there is no generator to build." >&2
    exit 2
  fi
done
unset _needed

# The image must carry the app's config: one folder per type, each with the
# two files, and nothing else.
for _type in "${CONFIG_TYPES[@]}"; do
  for _file in "${CONFIG_FILES[@]}"; do
    if [[ ! -s "${APP_CONFIG}/${_type}/${_file}" ]]; then
      echo "${APP_CONFIG}/${_type}/${_file} does not exist. The image is built with the app's own config:" >&2
      echo "  one folder per type of dataset (${CONFIG_TYPES[*]}), each with ${CONFIG_FILES[*]}." >&2
      exit 2
    fi
    IMAGE_PATHS+=("config/${_type}/${_file}")
  done
done
unset _type _file

mapfile -t IMAGE_PATHS < <(printf '%s\n' "${IMAGE_PATHS[@]}" | sort -u)

# The Dockerfile is ours now, so a careless edit to it would reach a
# visitor's project. These three lines are what install.sh and the API rely
# on; the build checks them again on the finished image
# (cloudbuild-generator.yaml), and this says so before anything is built.
_dockerfile="${GENERATOR_DIR}/Dockerfile"
for _wanted in \
    "ENV GA4SYNTH_PROPERTY=${CONFIG_DIR}/${FALLBACK_TYPE}/property.yaml" \
    "    GA4SYNTH_MIXER=${CONFIG_DIR}/${FALLBACK_TYPE}/mixer.yaml" \
    "LABEL ${IMAGE_TYPES_LABEL}=\"${CONFIG_TYPES_LIST}\""; do
  if ! grep -qF -- "${_wanted}" "${_dockerfile}"; then
    echo "${_dockerfile} no longer holds the line:" >&2
    echo "  ${_wanted}" >&2
    echo "  install.sh and the API read the label and the two variables from the image" >&2
    echo "  (docs/contracts/generator-cli.md, \"Container contract\"). Nothing was built." >&2
    exit 1
  fi
done
unset _dockerfile _wanted

# Twelve characters that identify the files above: each name, its length and
# its content. The same input gives the same characters on every machine.
SOURCE_PART="$(python3 -c '
import hashlib, sys
root, names = sys.argv[1], sys.argv[2:]
digest = hashlib.sha256()
for name in sorted(names):
    with open(root + "/" + name, "rb") as handle:
        content = handle.read()
    digest.update(name.encode() + b"\0" + str(len(content)).encode() + b"\0" + content)
print(digest.hexdigest()[:12])
' "${GENERATOR_DIR}" "${IMAGE_PATHS[@]}")"
if ! [[ "${SOURCE_PART}" =~ ^[0-9a-f]{12}$ ]]; then
  echo "Could not work out the tag from ${GENERATOR_DIR}." >&2
  exit 1
fi

# The image tag: what the image is made of. See "THE TAG" in the header.
TAG="src-${SOURCE_PART}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${IMAGE_NAME}"

# Pin every gcloud call to PROJECT (see infra/lib/env.sh for why).
pin_gcloud "${PROJECT}"

echo "env=${ENV} project=${PROJECT} region=${REGION} image=${IMAGE}:${TAG}"
echo "generator=${GENERATOR_DIR} (${#IMAGE_PATHS[@]} files in the image)"
echo "config=${APP_CONFIG} types=${CONFIG_TYPES[*]} without options=${FALLBACK_TYPE}"
echo "writes ${IMAGE_PATH}"
if [[ "${PLAN:-0}" == "1" ]]; then echo "PLAN=1: nothing was changed."; exit 0; fi

# --- 1. APIs ---------------------------------------------------------------
# run, cloudscheduler: what the visitor's project will need (the API mirrors
# these calls later). artifactregistry, cloudbuild: this build. iam,
# cloudresourcemanager: service accounts and project IAM in later tasks.
# Remember whether Cloud Build was already on: a build submitted right after
# the API is enabled is refused for a few minutes (see retry_new_api).
SUBMIT=""
if ! api_enabled "${PROJECT}" cloudbuild.googleapis.com; then SUBMIT="retry_new_api"; fi
echo "--- enabling APIs"
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="${PROJECT}" --quiet

# --- 2. Repository ---------------------------------------------------------
echo "--- repository ${REPO} in ${REGION}"
if ! gcloud artifacts repositories describe "${REPO}" \
      --location="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --project="${PROJECT}" \
    --description="ga4synth generator image, pulled by visitors' Cloud Run jobs" \
    --quiet
else
  echo "  already exists"
fi

# --- 3. Public read --------------------------------------------------------
# The visitor's Cloud Run job pulls this image with the visitor's own service
# account, which we never see. Public read is the only grant that works
# without any action on their side (D-10). Reader cannot push or delete.
echo "--- allUsers -> roles/artifactregistry.reader on ${REPO}"
gcloud artifacts repositories add-iam-policy-binding "${REPO}" \
  --location="${REGION}" \
  --project="${PROJECT}" \
  --member="allUsers" \
  --role="roles/artifactregistry.reader" \
  --quiet >/dev/null

# --- 4. Source -------------------------------------------------------------
# A copy, not the folder itself: the upload must hold what the image needs
# and nothing else. tests/, uv.lock, .venv/ and ORIGIN.md stay behind,
# because the list built above does not name them.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ga4synth-build.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
echo "--- copying ${#IMAGE_PATHS[@]} files from ${GENERATOR_DIR}"
for _path in "${IMAGE_PATHS[@]}"; do
  mkdir -p "${WORK}/src.d/$(dirname "${_path}")"
  cp "${GENERATOR_DIR}/${_path}" "${WORK}/src.d/${_path}"
done
unset _path
mv "${WORK}/src.d" "${WORK}/src"

# --- 5. Check the copy -----------------------------------------------------
# What is about to be uploaded is exactly the list, no more and no less. A
# file that slipped in would end up in a public image.
echo "--- checking the copy"
_found="$(cd "${WORK}/src" && find . -type f | sed 's|^\./||' | sort)"
_wanted="$(printf '%s\n' "${IMAGE_PATHS[@]}" | sort)"
if [[ "${_found}" != "${_wanted}" ]]; then
  echo "The copy in ${WORK}/src is not the list of files to build. Nothing was built." >&2
  diff <(printf '%s\n' "${_wanted}") <(printf '%s\n' "${_found}") >&2 || true
  exit 1
fi
unset _found _wanted

# --- 6. Build --------------------------------------------------------------
# Build, check, publish: the recipe runs the image before it publishes it,
# and publishes nothing when a check fails.
echo "--- Cloud Build -> ${IMAGE}:${TAG}"
# Started without waiting and followed by its id, because the recipe keeps
# its logs in Cloud Logging, which gcloud shows only once the build has
# ended. About three minutes: the checks generate seven days, one per type
# and three for the fallback.
BUILD_ID="$(${SUBMIT} gcloud builds submit "${WORK}/src" \
  --config="${HERE}/cloudbuild-generator.yaml" \
  --substitutions="_IMAGE=${IMAGE}:${TAG},_CHECK_DATE=${CHECK_DATE}" \
  --project="${PROJECT}" \
  --async --format='value(id)' \
  --quiet)"
echo "  build ${BUILD_ID}, waiting for it to end"
BUILD_STATUS="QUEUED"
_looks=0
while [[ "${BUILD_STATUS}" == "QUEUED" || "${BUILD_STATUS}" == "WORKING" || "${BUILD_STATUS}" == "PENDING" ]]; do
  if (( _looks >= 240 )); then
    echo "The build ${BUILD_ID} has not ended after 20 minutes. ${IMAGE_PATH} was not changed." >&2
    exit 1
  fi
  _looks=$(( _looks + 1 ))
  sleep 5
  BUILD_STATUS="$(gcloud builds describe "${BUILD_ID}" --project="${PROJECT}" --format='value(status)')"
done
unset _looks
# The output of the checks, without the lines of the image build itself.
gcloud builds log "${BUILD_ID}" --project="${PROJECT}" 2>/dev/null \
  | grep -E '^(Step #[1-9]|Finished Step|ERROR|BUILD FAILURE)' || true
if [[ "${BUILD_STATUS}" != "SUCCESS" ]]; then
  echo "The build ended with ${BUILD_STATUS}. Nothing was published and ${IMAGE_PATH} was not changed." >&2
  echo "  Read it again with: gcloud builds log ${BUILD_ID} --project=${PROJECT}" >&2
  exit 1
fi

gcloud artifacts docker tags add "${IMAGE}:${TAG}" "${IMAGE}:latest" \
  --project="${PROJECT}" --quiet

DIGEST="$(gcloud artifacts docker images describe "${IMAGE}:${TAG}" \
  --project="${PROJECT}" --format='value(image_summary.digest)')"

# --- 7. Record -------------------------------------------------------------
# One line, no newline noise: install.sh and the API read this verbatim.
printf '%s\n' "${IMAGE}:${TAG}" > "${IMAGE_PATH}"
echo "--- wrote ${IMAGE_PATH}: ${IMAGE}:${TAG} (${DIGEST})"

# --- 8. Public check -------------------------------------------------------
# Anonymous pull is the whole point. Fail loudly if the tag is not visible.
echo "--- anonymous tag list"
TAGS_URL="https://${REGION}-docker.pkg.dev/v2/${PROJECT}/${REPO}/${IMAGE_NAME}/tags/list"
if curl -fsS "${TAGS_URL}" | grep -q "\"${TAG}\""; then
  echo "  ok: ${TAG} is visible without authentication"
else
  echo "  FAIL: ${TAG} not visible at ${TAGS_URL}" >&2
  exit 1
fi

# What the registry hands out is what was meant to be built.
echo "--- anonymous read of the image settings"
if ! image_read "${IMAGE}:${TAG}"; then
  echo "  FAIL: the settings of ${IMAGE}:${TAG} cannot be read" >&2
  exit 1
fi
WANTED_PROPERTY="${CONFIG_DIR}/${FALLBACK_TYPE}/property.yaml"
WANTED_MIXER="${CONFIG_DIR}/${FALLBACK_TYPE}/mixer.yaml"
if [[ "${IMAGE_TYPES}" != "${CONFIG_TYPES_LIST}" ||
      "${IMAGE_PROPERTY}" != "${WANTED_PROPERTY}" ||
      "${IMAGE_MIXER}" != "${WANTED_MIXER}" ]]; then
  echo "  FAIL: types '${IMAGE_TYPES}', GA4SYNTH_PROPERTY '${IMAGE_PROPERTY}', GA4SYNTH_MIXER '${IMAGE_MIXER}'" >&2
  echo "  expected '${CONFIG_TYPES_LIST}', '${WANTED_PROPERTY}', '${WANTED_MIXER}'" >&2
  exit 1
fi
echo "  ok: types ${IMAGE_TYPES}; without options ${IMAGE_PROPERTY}"

echo
echo "Done. Image: ${IMAGE}:${TAG}"
echo "Tear down with: ENV=${ENV} ./infra/build-teardown.sh"
