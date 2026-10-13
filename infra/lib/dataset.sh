# shellcheck shell=bash
#
# Shared by install.sh and uninstall.sh. Sourced, never run. Needs PROJECT,
# DATASET and LOCATION, and gcloud pinned by pin_gcloud (infra/lib/env.sh).
#
# The dataset ownership rule (docs/contracts/api.md "Dataset ownership",
# decision D-19). The daily job replaces tables named events_YYYYMMDD, and a
# real GA4 export dataset holds tables with exactly those names. So the
# installer never writes into, or deletes, a dataset it did not create. A
# dataset it created carries the label managed-by=ga4-fake-dataset-installer.
#
# Everything here talks to the BigQuery REST API with curl and the gcloud
# access token, not to the bq command: bq 2.1.31 crashes on `bq update` on
# this machine (seen 2026-09-26).

OWNER_LABEL_KEY="managed-by"
OWNER_LABEL_VALUE="ga4-fake-dataset-installer"
BQ_API="https://bigquery.googleapis.com/bigquery/v2"

# Exit code of a refusal under the ownership rule, so a caller can tell it
# from any other failure.
EXIT_NOT_OWNED=3

# What dataset_writer returns when Google refuses the entry because it does
# not know the service account yet. The caller may try again.
RETURN_ACCOUNT_UNKNOWN=4

# Scratch folder only this user can read: it holds the access token (kept out
# of the process list, where a command-line argument would show) and the
# last response.
DATASET_WORK="$(mktemp -d "${TMPDIR:-/tmp}/ga4synth-dataset.XXXXXX")"
trap 'rm -rf "${DATASET_WORK}"' EXIT
BQ_BODY="${DATASET_WORK}/response.json"
BQ_CODE=""

# bq_rest METHOD PATH [BODY_FILE]
# PATH is relative to the project, for example "/datasets/analytics_1".
# Leaves the HTTP status in BQ_CODE and the response in the file BQ_BODY.
bq_rest() {
  local method="$1" path="$2" body="${3:-}"
  printf 'Authorization: Bearer %s\n' "$(gcloud auth print-access-token)" > "${DATASET_WORK}/auth"
  local args=(-sS -X "${method}" -o "${BQ_BODY}" -w '%{http_code}'
    -H "@${DATASET_WORK}/auth"
    -H "x-goog-user-project: ${PROJECT}"
    -H "Content-Type: application/json")
  if [[ -n "${body}" ]]; then args+=(--data-binary "@${body}"); fi
  BQ_CODE="$(curl "${args[@]}" "${BQ_API}/projects/${PROJECT}${path}")"
}

# Google's own error text from the last response.
bq_error() {
  python3 -c '
import json, sys
try:
    print(json.load(open(sys.argv[1]))["error"]["message"])
except Exception:
    print("no error text in the response")
' "${BQ_BODY}"
}

# Reads the dataset and sets:
#   DATASET_STATE     missing | owned | foreign
#                     (owned: carries the label; foreign: exists without it)
#   DATASET_LOCATION  its location, empty when missing
# When the dataset cannot be read at all, the script stops. With the argument
# "soft" it goes on instead, with DATASET_STATE=unreadable, which the caller
# must treat like foreign: hands off.
dataset_read() {
  local mode="${1:-strict}"
  bq_rest GET "/datasets/${DATASET}"
  DATASET_LOCATION=""
  case "${BQ_CODE}" in
    200)
      local parsed
      parsed="$(python3 -c '
import json, sys
meta = json.load(open(sys.argv[1]))
owned = meta.get("labels", {}).get(sys.argv[2]) == sys.argv[3]
print("owned" if owned else "foreign", meta.get("location", ""))
' "${BQ_BODY}" "${OWNER_LABEL_KEY}" "${OWNER_LABEL_VALUE}")"
      DATASET_STATE="${parsed%% *}"
      DATASET_LOCATION="${parsed#* }"
      ;;
    404)
      DATASET_STATE="missing"
      ;;
    *)
      echo "Could not read dataset ${DATASET} in project ${PROJECT} (HTTP ${BQ_CODE}): $(bq_error)" >&2
      if [[ "${mode}" != "soft" ]]; then exit 1; fi
      DATASET_STATE="unreadable"
      ;;
  esac
}

# The refusal of the contract, word for word.
refuse_foreign_dataset() {
  echo "REFUSED: Dataset ${DATASET} already exists in project ${PROJECT} and was not created by this installer. Installing would overwrite tables named events_YYYYMMDD in it." >&2
  echo "  What to do: Choose a dataset name that does not exist yet." >&2
  exit "${EXIT_NOT_OWNED}"
}

# A dataset's location is fixed when it is created. The job is told the
# location, so a labelled dataset somewhere else is a stop, not a warning.
refuse_other_location() {
  echo "REFUSED: Dataset ${DATASET} in project ${PROJECT} is in location ${DATASET_LOCATION}, not ${LOCATION}." >&2
  echo "  What to do: Run again with LOCATION=${DATASET_LOCATION}, or choose a dataset name that does not exist yet." >&2
  exit "${EXIT_NOT_OWNED}"
}

same_location() {
  [[ "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')" == "$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]')" ]]
}

# For every step that leads to writing into the dataset: stops unless the
# dataset exists, carries the label and is in LOCATION.
require_owned_dataset() {
  dataset_read
  case "${DATASET_STATE}" in
    missing)
      echo "Dataset ${DATASET} does not exist in project ${PROJECT}." >&2
      echo "  What to do: Run the create-dataset step first." >&2
      exit 2
      ;;
    foreign)
      refuse_foreign_dataset
      ;;
  esac
  same_location "${DATASET_LOCATION}" "${LOCATION}" || refuse_other_location
}

# Creates the dataset with the ownership label. The caller has checked that
# it does not exist. When somebody else created it in the meantime (HTTP 409),
# the ownership rule decides.
dataset_create() {
  python3 -c '
import json, sys
project, dataset, location, key, value = sys.argv[1:6]
json.dump({
    "datasetReference": {"projectId": project, "datasetId": dataset},
    "location": location,
    "description": "Fake GA4 export generated by ga4synth. Safe to delete.",
    "labels": {key: value},
}, sys.stdout)
' "${PROJECT}" "${DATASET}" "${LOCATION}" "${OWNER_LABEL_KEY}" "${OWNER_LABEL_VALUE}" > "${DATASET_WORK}/create.json"
  bq_rest POST "/datasets" "${DATASET_WORK}/create.json"
  case "${BQ_CODE}" in
    200)
      echo "  created ${PROJECT}:${DATASET} in ${LOCATION}, label ${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE}"
      ;;
    409)
      require_owned_dataset
      echo "  dataset already exists, created by this installer"
      ;;
    *)
      echo "Could not create dataset ${DATASET} in project ${PROJECT} (HTTP ${BQ_CODE}): $(bq_error)" >&2
      exit 1
      ;;
  esac
}

# dataset_writer add|remove EMAIL
# Adds or removes the access entry that lets EMAIL write tables in this one
# dataset. The caller has checked ownership. Does nothing when the entry is
# already as wanted. Each call reads the dataset again, so a second try
# works on a fresh access list. Returns RETURN_ACCOUNT_UNKNOWN, and changes
# nothing, when Google does not know the account yet.
dataset_writer() {
  local action="$1" member="$2"
  bq_rest GET "/datasets/${DATASET}"
  if [[ "${BQ_CODE}" != "200" ]]; then
    echo "Could not read dataset ${DATASET} in project ${PROJECT} (HTTP ${BQ_CODE}): $(bq_error)" >&2
    exit 1
  fi
  local verdict=0
  python3 -c '
import json, sys
meta = json.load(open(sys.argv[1]))
action, member = sys.argv[2], sys.argv[3]
access = meta.get("access", [])
def is_entry(e):
    return e.get("userByEmail") == member and e.get("role") == "WRITER"
present = any(is_entry(e) for e in access)
if (action == "add") == present:
    sys.exit(3)
if action == "add":
    access.append({"role": "WRITER", "userByEmail": member})
else:
    access = [e for e in access if not is_entry(e)]
json.dump({"access": access}, sys.stdout)
' "${BQ_BODY}" "${action}" "${member}" > "${DATASET_WORK}/access.json" || verdict=$?
  case "${verdict}" in
    0)
      bq_rest PATCH "/datasets/${DATASET}" "${DATASET_WORK}/access.json"
      if [[ "${BQ_CODE}" != "200" && "${action}" == "add" ]] && account_unknown "$(bq_error)" "${member}"; then
        return "${RETURN_ACCOUNT_UNKNOWN}"
      fi
      if [[ "${BQ_CODE}" != "200" ]]; then
        echo "Could not change who may write to dataset ${DATASET} (HTTP ${BQ_CODE}): $(bq_error)" >&2
        exit 1
      fi
      echo "  done"
      ;;
    3)
      echo "  nothing to change"
      ;;
    *)
      echo "Could not work out the access list of dataset ${DATASET}" >&2
      exit 1
      ;;
  esac
}

# account_unknown TEXT EMAIL
# True when TEXT is Google's answer to a grant that names a service account
# Google does not know yet. Recognised by its words, the same way the backend
# does (apps/api/README.md, "When Google does not know the new service
# account yet"): "does not exist" together with the account's address or the
# words "service account".
account_unknown() {
  local text="$1" email="$2"
  printf '%s' "${text}" | grep -qi 'does not exist' || return 1
  printf '%s' "${text}" | grep -qiF "${email}" && return 0
  printf '%s' "${text}" | grep -qi 'service account'
}

# Deletes the dataset and every table in it. The caller has checked
# ownership.
dataset_delete() {
  bq_rest DELETE "/datasets/${DATASET}?deleteContents=true"
  case "${BQ_CODE}" in
    200|204|404) ;;
    *)
      echo "Could not delete dataset ${DATASET} in project ${PROJECT} (HTTP ${BQ_CODE}): $(bq_error)" >&2
      exit 1
      ;;
  esac
}
