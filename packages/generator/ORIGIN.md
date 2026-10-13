# Where this code came from

The generator, the Python package `ga4synth` in `src/ga4synth/`, was copied
on 2026-10-13 from commit `99028e8ffe4a804220bc9832245b6cc1ee87918f` of an
earlier private repository. It is maintained here since (decision D-91 in
`docs/DECISIONS.md`).

The copy changed no line of the generator, so the same configuration and the
same date give the same rows as before. This was checked by running `verify`,
`summary`, `generate`, `publish --dry-run` and the two `--help` screens with
both configurations before and after the copy: every output, every exit code
and the SHA-256 checksum of the generated day were identical.

No file of `packages/generator/`, this one included, names the repository the
code came from. That repository is private, and this package is public
(D-88, D-91), so the note gives the date and the commit and stops there.
`tests/test_old_repository.py` keeps it that way. The name is written down
once, in `docs/DECISIONS.md` (D-91), which never goes public. The generator
had an earlier home still, before that commit; it is named in
`docs/DECISIONS.md` (D-21) and nowhere here, because no code was copied from
it.

## What was copied

| Path at that commit | Copied to | Why |
|---|---|---|
| `src/ga4synth/` (12 `.py` files and `data/events.json`) | `src/ga4synth/`, byte for byte | The generator |
| `tests/test_ga4synth.py` | `tests/test_ga4synth.py` | The generator's own tests. Three lines changed, for the app's layout; see below |
| `LICENSE` (MIT, "Copyright (c) 2026 Superform Labs") | `LICENSE` | `pyproject.toml` names it. Identical to the licence of the public copy of the app |
| `LICENSE-DATA` (CC0 1.0 for the generated data) | `LICENSE-DATA` | The licence of the data the generator produces. The code is MIT; the data it writes is CC0 |
| `pyproject.toml` | merged into `pyproject.toml` | Its build settings: setuptools, the `src` layout, the entry point `ga4synth = "ga4synth.cli:main"`, the package data `data/*.json`, `PyYAML>=6.0` and the extra `bigquery` |
| `Dockerfile` | adapted into `Dockerfile` | With the lines `infra/build.sh` used to add written in |
| `config/property.yaml`, `config/mixer.yaml` | not copied | Already here, byte for byte, as `config/ecommerce/` |

## What was not copied, and why

| Path at that commit | Why not |
|---|---|
| `README.md` | It names an address, local credential paths and a Google Cloud project that are not ours to publish. `README.md` here is written for the app |
| `deploy/deploy.sh` | It deploys to another project. The app has `infra/` |
| `docs/generator.md` | Design notes of that repository. Not used by the app |
| `scripts/capture_schema.py`, `scripts/ddl_to_schema.py`, `scripts/session_shape.py` | Tuning helpers. Not used by the app |
| `.dockerignore` | Its job is done by the `.gcloudignore` that `infra/build.sh` writes |
| `.gitignore` | The app's own `.gitignore` files cover the same output |

## The three lines changed in `tests/test_ga4synth.py`

That file was written where the one configuration sat at
`config/property.yaml`. Here there is one folder per type of dataset
(decision D-23), so there is no file at that path. The `ecommerce` pair is
that repository's configuration, byte for byte, so the tests read it:

| Line | Change |
|---|---|
| 445 | added `from conftest import BASE_MIXER_FILE, BASE_PROPERTY_FILE  # noqa: E402` |
| 459 | `yaml.safe_load(open("config/property.yaml"))` became `yaml.safe_load(open(BASE_PROPERTY_FILE))` |
| 460 | `yaml.safe_load(open("config/mixer.yaml"))` became `yaml.safe_load(open(BASE_MIXER_FILE))` |

Nothing under `src/` was changed. The file also calls `load_world()` with no
argument, in two places; a fixture in `tests/conftest.py` sets
`GA4SYNTH_PROPERTY` and `GA4SYNTH_MIXER` to the same two files, which is how
the container is pointed at its configuration too.
