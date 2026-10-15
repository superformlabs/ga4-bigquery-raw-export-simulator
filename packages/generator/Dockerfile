# Container for running the generator as a scheduled Cloud Run job.
#
# This is operational scaffolding, not part of the generator's supported
# surface. How you choose to run ga4synth is up to you; this is simply how we
# happen to run it.
#
# Built by infra/build.sh, which copies the files below into a temp folder and
# submits that folder to Cloud Build (infra/cloudbuild-generator.yaml). The
# tests, uv.lock and the virtual environment are not part of that copy, so
# they are not in the image.
#
# Contract: docs/contracts/generator-cli.md ("Container contract").
#
# Python 3.12 rather than the 3.10 floor declared in pyproject.toml, because
# google-cloud-bigquery has dropped support for 3.9 and 3.12 is what the app
# tests with.
FROM python:3.12-slim

WORKDIR /app

# Dependencies first, so edits to the source do not invalidate the layer.
# README.md and LICENSE are copied because pyproject.toml names them
# (`readme` and `license`); the build fails without them.
COPY pyproject.toml README.md LICENSE ./
COPY src/ ./src/
RUN pip install --no-cache-dir '.[bigquery]'

# The config is user-owned and lives outside the package, so it is copied in
# and pointed at explicitly. Without this the CLI would look in the working
# directory and fail.
#
# The app holds one folder per type of dataset (decisions D-23, D-96 and
# D-97), and the image holds all four: /app/config/default/,
# /app/config/ecommerce/, /app/config/eu-consent/ and
# /app/config/lead-generation/, each with property.yaml and mixer.yaml. There
# is nothing at /app/config/property.yaml. A job names its configuration with
# the generator's options --property and --mixer.
COPY config/ ./config/

# The two variables name the ecommerce pair, so a job that names no
# configuration produces the Ecommerce type. That is the fallback for the
# installs made before the types existed, whose jobs name no configuration.
ENV GA4SYNTH_PROPERTY=/app/config/ecommerce/property.yaml \
    GA4SYNTH_MIXER=/app/config/ecommerce/mixer.yaml

# Which types the image holds, so infra/install.sh and the API can refuse an
# image that lacks the type they are asked for. The name of the label is
# IMAGE_TYPES_LABEL in infra/lib/image.sh, which reads it back without
# credentials.
LABEL ga4fake.dataset-types="default,ecommerce,eu-consent,lead-generation"

# Unbuffered output so Cloud Logging shows progress rather than one burst at
# exit.
ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["ga4synth"]
CMD ["publish"]
