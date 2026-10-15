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

## The sync of 2026-10-14 (decision D-95)

On 2026-10-14 the owner asked whether the generator here was still up to
date, and asked for it to be brought up to date if it was not. It was not:
the same repository the first copy came from had moved on by 14 commits, to
commit `c2e6cf92b1e66b7e2e364836946c555d63c84638`. This package was synced to
that commit. The repository is still named nowhere here, for the same reason
as above; it is named in `docs/DECISIONS.md` (D-95), which never goes public.

**Unlike the first copy, this one changes the data.** Same configuration,
same date, different rows: the seed of the `ecommerce` configuration has a new
name, and many of its dials moved. What a visitor sees change is written in
the pull request of issue #310. The export columns do **not** change:
`src/ga4synth/data/events.json` is identical at both commits.

### What was synced

| Path at `c2e6cf92b1e6` | Synced to | Notes |
|---|---|---|
| `src/ga4synth/` (12 `.py` files and `data/events.json`) | `src/ga4synth/`, byte for byte but for one line | Six files changed upstream: `cli.py`, `invariants.py`, `serialize.py`, `simulate.py`, `values.py`, `world.py`. The one line is below |
| `tests/test_ga4synth.py` | `tests/test_ga4synth.py` | +550 lines. The three lines of the first copy are kept, and one test was adapted; both are below |
| `config/scenarios/ecommerce/` | `config/ecommerce/` | The Ecommerce type of dataset. Rebranded by D-96; see below |
| `config/scenarios/eu-consent/` | `config/eu-consent/` | Not offered by the app; see below. Rebranded by D-96 |
| `config/scenarios/lead-generation/` | `config/lead-generation/` | Not offered by the app; see below. Rebranded by D-96 |
| `LICENSE`, `LICENSE-DATA`, `pyproject.toml`, `Dockerfile` | nothing to do | Unchanged upstream between the two commits. `LICENSE` and `LICENSE-DATA` here still equal theirs, checked with `cmp` |

### The one line changed under `src/`

`scenarios_dir()` in `world.py` looks for the folder `config/`, where
upstream looks for `config/scenarios/`. Upstream keeps its own configuration
at `config/property.yaml` and its scenarios one folder deeper; the app has no
configuration at that path and keeps one folder per type of dataset directly
in `config/` (decision D-23). With the line changed, `--scenario default`,
`--scenario ecommerce`, `--scenario eu-consent` and `--scenario
lead-generation` name the app's own folders, and the tests that came with the
code find them. `diff -r` against the upstream folder shows this hunk and
nothing else.

One wording follows from it and was left alone: the `--help` text of
`--scenario`, in `cli.py`, still says "a shipped scenario under
config/scenarios". Changing it would be a second difference under `src/`, and
every later sync would have to carry it. `docs/contracts/generator-cli.md`
says where the folders really are.

### The lines changed in `tests/test_ga4synth.py`

The three lines of the first copy are unchanged in substance; only their
numbers moved (now 468, 482 and 483). On top of them, one test was adapted:

| Test | Change |
|---|---|
| `test_default_scenario_is_a_basic_install` | It described upstream's `default` scenario, which the app does not take (below). It now describes the app's `default`: no event of a shop, no lead event, no item, and the consent banner and the sign-in still on |

### What was not taken

| Path at `c2e6cf92b1e6` | Why not |
|---|---|
| `config/scenarios/default/` | Another site altogether: a studio, about 300 new visitors a day, a contact form, no consent banner, no sign-in, no campaign. The app's `default` is fixed by decision D-23: the same site as `ecommerce` without its shop. It is rebuilt from the new `config/ecommerce/` by the five changes listed in `README.md` |
| `config/property.yaml`, `config/mixer.yaml` (top level) | That repository's own demo configuration, with its hostname and a one-off campaign. The app's `ecommerce` is the `ecommerce` scenario instead |
| `README.md` | Same reason as the first copy. `README.md` here is written for the app |
| `docs/generator.md`, `docs/showcases/` | Design notes and report walk-throughs of that repository. Not used by the app |
| `deploy/deploy.sh`, `scripts/`, `.dockerignore`, `.gitignore` | Same reasons as the first copy |

### One site for all four: decision D-96

The owner asked, on 2026-10-14, while this sync was being done: "I want all
these scenario to be build around https://ga4dataform.com/" and "I mean that
I want the hostname to be https://ga4dataform.com/ and any other reference
needed should also be around https://ga4dataform.com/". That is decision
D-96. So the four configurations are **not** byte for byte with the ones they
came from: each one's invented company and hostname are replaced by
GA4Dataform on `ga4dataform.com`.

| Place | Before, per configuration | After, in all four |
|---|---|---|
| `property.hostname` | `www.northmoor-supply.example`, `www.lindqvist-home.example`, `www.tallyframe.example` | `ga4dataform.com` |
| `property.brand` | `Northmoor Supply`, `Lindqvist Home`, `Tallyframe` | `GA4Dataform` |
| the branded paid-search term | `northmoor supply`, `lindqvist home`, `tallyframe` | `ga4dataform` |
| `outbound_links`, the brand's own profiles and status page | `instagram.com/northmoorsupply`, `instagram.com/lindqvisthome`, `pinterest.com/lindqvisthome`, `linkedin.com/company/tallyframe`, `status.tallyframe.example` | the same sites with `ga4dataform`, and `status.ga4dataform.com` |
| the brand's path on a review site | `gearjournal.example/reviews/northmoor` | `gearjournal.example/reviews/ga4dataform` |
| `ecommerce.transaction_id_prefix` | `NM-`, `LH-` | `GD-` |
| the first comment line of each file | the old company and what it sells | `GA4Dataform` and the same description |

Everything else of each configuration is untouched: its own pages, its
catalogue and prices, its funnel, its currency, its countries, its seed name,
and every third-party site it refers to (`google.com`, `bing.com`,
`chatgpt.com`, `www.ecosia.org`, `l.facebook.com` and the `.example` review
sites and forums, whose own names are not ours to rename).

Two things D-96 did not reach, left as they are on purpose:

- **The catalogue item ids**, `NM-1001` and the like in `ecommerce` and
  `default`, `LH-301` and the like in `eu-consent`. The owner's message keeps
  "each scenario's own ... products", and an item id is part of a product.
  They are product codes, not addresses, and no grep for an old brand name
  finds them.
- **The seed names**, `scenario-ecommerce-v1` and so on. The owner asked for
  them to be left unless a test required a change; none did.

Three assertions in `tests/test_ga4synth.py` named the old brand or the old
hostname and were brought in line: the Google Ads account name (`{brand} Ads`
resolves to `GA4Dataform Ads`), the order-number prefix of the base
configuration, and the `form_destination` of the lead funnel
(`https://ga4dataform.com/demo/thank-you`).

### The two configurations the app does not offer

`config/eu-consent/` and `config/lead-generation/` sit here, as they are
upstream but for the rebranding of D-96 above, and the generator's own tests
exercise them. **The app
offers neither.** The two types of dataset a visitor can pick are still
`default` and `ecommerce` (D-23): they are the only values of `datasetType`
in `docs/contracts/api.md`, and `infra/build.sh` puts only those two folders
in the image, so these two change no image tag. Whether to offer them is an
open question for the owner (D-95).

**That question was answered the same day: the app has offered all four types
since issues #317, #318 and #316 (pull requests #320, #321 and #322), which
built decision D-96.** Every folder of `config/` is a `datasetType` and goes
into the image, so a change to any of the four now gives a new image tag. The
paragraph above is the record of the sync, as it stood when it was written.

## The configurations become the app's own: decision D-97

On 2026-10-14, after the sync above, the owner decided that the four types of
dataset become **one invented business software website, GA4Dataform's own,
seen from four angles** (decision D-97 in `docs/DECISIONS.md`). Issue #313
rewrote the four configurations in `config/` to match: their pages, items,
categories, search terms, campaigns and sales seasons are the app's own
invention from then on, and no longer those of the scenarios they came from.
Each type keeps its traffic shape, its currency, its time zone, its consent
split and its own part of a GA4 export.

**What that means for the next sync.** A sync from the owner's repository
takes its code (`src/ga4synth/`) and its tests, and **not** these four
configurations, unless the owner says otherwise for that sync. Where a test
that comes with the code asserts the content of an upstream scenario, the
sync adapts it to the app's configuration and records the adaptation here.

Everything written above about the sync of 2026-10-14 is the record of that
sync, as it was done: the four folders were copied from upstream's scenarios
and then rebranded by D-96. They have since been rewritten, so they no longer
match the ones they came from, and `config/default/` never did (D-23).

Three more tests in `tests/test_ga4synth.py` were adapted by #313, because
they asserted the content of the configuration that came with the code:

| Test | Change |
|---|---|
| `test_calendar_campaign_reaches_the_export` | The campaign of 25 August is `q3-prospecting`, where upstream's is `summer-prospecting`: the app's configuration runs one prospecting campaign a quarter |
| `test_calendar_campaign_can_replace_the_always_on_ones` | The same campaign name, for the same reason |
| `test_defaults_match_the_shipped_config` | `shipping_tier`, `payment_type` and `view_item_list_name` are compared with the code's own defaults (`Standard`, `Credit Card`, `Product detail`) in place of the app's values, which differ now: the site sells software and posts nothing. The guarantee is unchanged, that a configuration leaving those keys out gets the values it always got |
