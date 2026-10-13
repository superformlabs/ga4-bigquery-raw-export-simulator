# packages/generator

The data generator, the Python package `ga4synth`. **The code is here.** It
is what writes the synthetic GA4 export the app installs, and what the
container image in a visitor's project runs every morning.

No private access is needed for any of it. `uv sync` installs the package
from this folder, and `./infra/build.sh` builds the container image from
these same files.

| Path | What it is |
|---|---|
| `src/ga4synth/` | The generator: 11 Python files and `data/events.json`, the export schema it writes against |
| `pyproject.toml` | Builds `ga4synth` from `src/`, with its optional `bigquery` extra |
| `uv.lock` | The resolved lock file |
| `Dockerfile` | The image a visitor's Cloud Run job runs. `infra/build.sh` builds it |
| `LICENSE` | MIT, for the code |
| `LICENSE-DATA` | CC0 1.0, for the data the generator produces |
| `ORIGIN.md` | Where this code was copied from, and what was and was not copied |
| `config/ecommerce/` | The configuration of the Ecommerce kind of dataset: an invented site with a shop |
| `config/default/` | The configuration of the Default kind: the same site without the shop |
| `tests/` | The generator's own tests, and tests that run its command line against both configurations |

Each configuration folder holds two files. `property.yaml` says what the
invented property is: hostname, channels, catalogue, pages, tracked events.
`mixer.yaml` says how much traffic it gets: volume, weights, rates,
durations.

## Two licences

The code and the data it writes are different things, so they carry
different licences:

- **The code is MIT** (`LICENSE`), like the rest of this repository. Use it,
  change it, ship it; keep the notice.
- **The data is CC0 1.0** (`LICENSE-DATA`): public domain. Any dataset this
  generator produces, including one installed in your own Google Cloud
  project, is yours to copy, change, publish and sell, with no permission and
  no attribution. The data is entirely invented. It describes a made-up
  property and made-up visitors, and is not derived from any real person's
  behaviour.

## Setup

Needs [uv](https://docs.astral.sh/uv/). `ga4synth` itself runs on Python
3.9, but its `bigquery` extra needs 3.10 or newer, so `requires-python` is
`>=3.10`. Pass the version when the system Python is older:

```sh
cd packages/generator
uv sync --python 3.12
```

That installs the package from this folder, editable, with the `bigquery`
extra and pytest.

## The commands

There is no configuration at a default path. Every command names its two
files with `--property` and `--mixer`, placed **before** the name of the
command. Run them from this folder.

```sh
# Does a day hold together? The schema check plus the invariants. Exit 0 = pass.
uv run ga4synth --property config/default/property.yaml --mixer config/default/mixer.yaml verify --date 2026-09-01

# What does a day look like? Rows, users, sessions, purchases, revenue, channels.
uv run ga4synth --property config/ecommerce/property.yaml --mixer config/ecommerce/mixer.yaml summary --date 2026-09-01

# Run the tests. About ten minutes.
uv run pytest
```

Without the two options, and without the environment variables
`GA4SYNTH_PROPERTY` and `GA4SYNTH_MIXER` that stand in for them, the command
stops with exit code 2. The options win over the variables. The tests always
pass the paths, so they work from anywhere.

The full command line is `generate`, `verify`, `summary`, `backfill`, `load`
and `publish`. The container a visitor's project runs calls `publish`.
**From this folder, never run `load` or `publish` without `--dry-run`:** both
write into a BigQuery dataset.

## The container image

`../../infra/build.sh` builds the image from this folder and publishes it to
Artifact Registry in your own Google Cloud project. It copies the files the
`Dockerfile` names into a temp folder and submits that to Cloud Build:
`pyproject.toml`, `README.md`, `LICENSE`, `src/ga4synth/` and the two
configuration folders. The tests, the lock file and the virtual environment
stay behind.

The image tag is `src-` and twelve characters of a checksum of exactly those
files, so the same files give the same tag on any machine, and a change to
any of them gives a new tag. An image an install already uses is never
replaced.

The image holds both configurations, at `/app/config/default/` and
`/app/config/ecommerce/`, and carries a label saying so. Its
`GA4SYNTH_PROPERTY` and `GA4SYNTH_MIXER` name the ecommerce pair, so a run
that names no configuration produces the Ecommerce kind.

`PLAN=1 ./infra/build.sh` prints the settings and the tag and builds nothing.

## The two kinds of dataset

The folder names are fixed. The image holds them at
`/app/config/default/` and `/app/config/ecommerce/`, and the install names
one of them.

| | `ecommerce` | `default` |
|---|---|---|
| What it is | The invented site with its shop | The same company and site, without the shop |
| Where it comes from | The generator's own configuration, byte for byte | The `ecommerce` pair with the four changes below |
| Events of a shop | Yes | None. `items` is an empty array and every `ecommerce` field is null, on every row |

The four changes that make `default`, and nothing else:

| File | Place | Change |
|---|---|---|
| `property.yaml` | `ecommerce.enabled` | `false` |
| `property.yaml` | `pages` | `pdp`, `cart`, `checkout` and `purchased` are removed. `home`, `plp`, `search` and `blog` stay |
| `property.yaml` | `tracking.events` | The nine events of a shop are `false`: `view_item_list`, `select_item`, `view_item`, `add_to_cart`, `view_cart`, `begin_checkout`, `add_shipping_info`, `add_payment_info`, `purchase` |
| `mixer.yaml` | `journey.entry_weights`, `journey.transitions` | The shop pages are removed, and the weight that went to them is shared between the pages left, in proportion |

Every other value is the same in both, the seed included. So the two kinds
hold the same visitors and the same sessions, starting at the same second and
arriving from the same source, medium and campaign. Only what the visitors do
on the site differs.

Some values of `default` speak of buying and have no effect, because no page
leads to a purchase: the amounts under `ecommerce` and the catalogue prices
in `property.yaml`, and several conversion factors and dwell ranges in
`mixer.yaml`. They are kept so the two pairs differ only where the table
above says, and the generator requires some of them.

## Changing the generator

It is deterministic: the same configuration and the same date give the same
rows. So a change to `src/` or to a configuration file can change what every
later install contains. Treat it as a decision, not a chore.

After any change here, build the image again with `./infra/build.sh`. Until
you do, installs keep getting the image you built last.

## What the tests check

| File | What it checks |
|---|---|
| `tests/test_ga4synth.py` | The generator's own tests: that each invariant fails when it is broken, and that rare situations such as a session crossing midnight are exercised on purpose. The only tests here that import `ga4synth` |
| `tests/test_verify.py` | For each configuration: `verify` passes; `generate` writes the same rows twice; `backfill` writes the same rows as `generate`. The two configurations write different rows |
| `tests/test_configurations.py` | `config/` holds the two folders and nothing else; `default` differs from `ecommerce` only in the four places above; the journey follows the rule of proportion; a `default` day holds no event of a shop, no item and no ecommerce value |
| `tests/test_cli_contract.py` | Every command, option, default and exit code the app relies on exists, with the configuration read from the options and from the two environment variables |
| `tests/test_schema.py` | The `events.json` of the installed package matches the agreed column list, and generated rows carry exactly those columns |
| `tests/test_old_repository.py` | No file here points a reader at a repository this app does not use |

No test reads the network, and none asserts a number of rows or a rate.

One test in `test_schema.py` compares the schema with a written specification
that is not part of this snapshot, so it fails here with a missing file. It
passes where it is maintained. Every other test passes from this copy alone.
