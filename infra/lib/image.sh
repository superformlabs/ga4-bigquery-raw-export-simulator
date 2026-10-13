# shellcheck shell=bash
#
# Shared by build.sh and install.sh. Sourced, never run.
#
# Reads what a registry says about a generator image, without credentials,
# the way a visitor's project pulls it (decision D-10). Nothing is downloaded
# but two small descriptions of the image, and nothing is changed.
#
# build.sh writes on every image which types of dataset it holds, as the
# label below. An image built before the types existed has no such label and
# holds one configuration, at /app/config/.

# The label build.sh puts on the image: the types, with commas between them.
IMAGE_TYPES_LABEL="ga4fake.dataset-types"

# image_read IMAGE
# IMAGE is a full name with a tag or a digest, as in infra/IMAGE. Sets:
#   IMAGE_TYPES     the label's value, for example "default,ecommerce";
#                   empty when the image has no such label
#   IMAGE_PROPERTY  the value of GA4SYNTH_PROPERTY in the image
#   IMAGE_MIXER     the value of GA4SYNTH_MIXER in the image
# Returns 1, with one line on stderr, when the image cannot be read.
image_read() {
  local image="$1" work host path reference
  IMAGE_TYPES=""
  IMAGE_PROPERTY=""
  IMAGE_MIXER=""
  if [[ "${image}" =~ ^([a-z0-9.-]+)/([A-Za-z0-9._/-]+)@(sha256:[0-9a-f]{64})$ ]] ||
     [[ "${image}" =~ ^([a-z0-9.-]+)/([A-Za-z0-9._/-]+):([A-Za-z0-9._-]+)$ ]]; then
    host="${BASH_REMATCH[1]}"
    path="${BASH_REMATCH[2]}"
    reference="${BASH_REMATCH[3]}"
  else
    echo "Not a full image name with a tag or a digest: '${image}'" >&2
    return 1
  fi

  work="$(mktemp -d "${TMPDIR:-/tmp}/ga4synth-image.XXXXXX")"
  local verdict=0
  _image_read_into "${work}" "${host}" "${path}" "${reference}" || verdict=$?
  rm -rf "${work}"
  return "${verdict}"
}

_image_read_into() {
  local work="$1" host="$2" path="$3" reference="$4" code digest parsed
  code="$(curl -sS -o "${work}/manifest.json" -w '%{http_code}' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' \
    "https://${host}/v2/${path}/manifests/${reference}" 2>"${work}/problem.txt")" || code="000"
  if [[ "${code}" != "200" ]]; then
    echo "Could not read ${host}/${path} at ${reference} without credentials (HTTP ${code}). $(head -c 300 "${work}/problem.txt")" >&2
    return 1
  fi
  digest="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1]))["config"]["digest"])
' "${work}/manifest.json" 2>/dev/null)" || digest=""
  if ! [[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "The registry's description of ${host}/${path} at ${reference} names no image settings." >&2
    return 1
  fi
  # -L: the registry answers with the address where the description is kept.
  code="$(curl -sSL -o "${work}/config.json" -w '%{http_code}' \
    "https://${host}/v2/${path}/blobs/${digest}" 2>"${work}/problem.txt")" || code="000"
  if [[ "${code}" != "200" ]]; then
    echo "Could not read the settings of ${host}/${path} at ${reference} (HTTP ${code}). $(head -c 300 "${work}/problem.txt")" >&2
    return 1
  fi
  # Three lines: the label, then the two variables. Empty when absent.
  parsed="$(python3 -c '
import json, sys
config = json.load(open(sys.argv[1])).get("config") or {}
env = dict(item.split("=", 1) for item in (config.get("Env") or []) if "=" in item)
print((config.get("Labels") or {}).get(sys.argv[2], ""))
print(env.get("GA4SYNTH_PROPERTY", ""))
print(env.get("GA4SYNTH_MIXER", ""))
' "${work}/config.json" "${IMAGE_TYPES_LABEL}" 2>/dev/null)" || {
    echo "Could not understand the settings of ${host}/${path} at ${reference}." >&2
    return 1
  }
  IMAGE_TYPES="$(printf '%s\n' "${parsed}" | sed -n 1p)"
  IMAGE_PROPERTY="$(printf '%s\n' "${parsed}" | sed -n 2p)"
  IMAGE_MIXER="$(printf '%s\n' "${parsed}" | sed -n 3p)"
}

# image_holds_type TYPE
# True when the image last read by image_read holds the configuration of
# TYPE, according to its label.
image_holds_type() {
  [[ ",${IMAGE_TYPES}," == *",$1,"* ]]
}
