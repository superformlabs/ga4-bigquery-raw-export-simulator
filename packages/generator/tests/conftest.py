"""Shared fixtures for the generator's tests.

Two kinds of test live here (decision D-91, which brought the generator's own
code into the app):

- `test_ga4synth.py`, the generator's own unit tests. They import `ga4synth`
  and exercise it in process.
- the app's integration tests, the other files. They never import `ga4synth`:
  they run the same `ga4synth` command line the container runs (see
  `docs/contracts/generator-cli.md`), pointed at `default` or `ecommerce`,
  so they exercise the package exactly as it is deployed. Every call names
  its configuration: there is no default one.

No test reads the network.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import os
import shutil
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_DIR.parents[1]
CONTRACTS_DIR = REPO_ROOT / "docs" / "contracts"
CONFIG_DIR = PACKAGE_DIR / "config"

# The pair of types the integration tests here run: `default` is `ecommerce`
# without its shop (decision D-23). Each name is also the name of a folder
# inside the image, /app/config/default and /app/config/ecommerce, and a
# value of `datasetType` in docs/contracts/api.md.
DEFAULT = "default"
ECOMMERCE = "ecommerce"
CONFIGURATIONS = (DEFAULT, ECOMMERCE)
CONFIG_FILES = ("property.yaml", "mixer.yaml")

# The other two types. The app offers these as well, since issues #317, #318
# and #316 of 2026-10-14 (decision D-96): each is a `datasetType` and
# `infra/build.sh` puts all four folders in the image. The integration tests
# here do not run them; the generator's own tests pass every invariant on all
# four, and test_configurations.py checks that these two load.
EU_CONSENT = "eu-consent"
LEAD_GENERATION = "lead-generation"
OUTSIDE_THE_PAIR = (EU_CONSENT, LEAD_GENERATION)

# Every folder of config/.
CONFIG_FOLDERS = (*CONFIGURATIONS, *OUTSIDE_THE_PAIR)

# The schema file inside the installed package, relative to the package
# folder (docs/contracts/ga4-export-schema.md, "Source of truth"). It is the
# path SCHEMA_PATH of src/ga4synth/schema.py reads at run time.
SCHEMA_PATH_IN_PACKAGE = ("data", "events.json")

# A fixed day, so every run generates the same rows. Task GEN-1 names it.
FIXED_DATE = dt.date(2026, 9, 1)
FIXED_SHARD = f"events_{FIXED_DATE.strftime('%Y%m%d')}"

# A dataset that does not exist. `load` and `publish` only ever run with
# --dry-run in these tests, so nothing is sent to any project.
FAKE_DATASET = "example-project:analytics_770000001"


def property_file(configuration: str) -> Path:
    assert configuration in CONFIG_FOLDERS, configuration
    return CONFIG_DIR / configuration / "property.yaml"


def mixer_file(configuration: str) -> Path:
    assert configuration in CONFIG_FOLDERS, configuration
    return CONFIG_DIR / configuration / "mixer.yaml"


# test_ga4synth.py was written in the generator's own repository, where the
# one configuration sat at config/property.yaml. Here the configurations sit
# one folder down, so that file reads these two paths instead. The ecommerce
# pair is the one it was written against: it is that repository's
# configuration, byte for byte (ORIGIN.md).
BASE_PROPERTY_FILE = property_file(ECOMMERCE)
BASE_MIXER_FILE = mixer_file(ECOMMERCE)


@pytest.fixture(autouse=True, scope="session")
def base_configuration_for_unit_tests() -> Iterator[None]:
    """Point `load_world()` with no argument at the ecommerce pair.

    Same reason as the two paths above: `test_ga4synth.py` calls
    `load_world()` with no argument, which looks for `config/property.yaml`
    and `config/mixer.yaml`. The generator reads these two variables first
    (`default_config_paths` in `world.py`), which is also how the container is
    pointed at its configuration.

    The integration tests are unaffected: `run_ga4synth` either passes
    `--property` and `--mixer`, which win over the variables, or removes both
    variables from the environment of the command it runs.
    """
    before = {name: os.environ.get(name) for name in ("GA4SYNTH_PROPERTY", "GA4SYNTH_MIXER")}
    os.environ["GA4SYNTH_PROPERTY"] = str(BASE_PROPERTY_FILE)
    os.environ["GA4SYNTH_MIXER"] = str(BASE_MIXER_FILE)
    yield
    for name, value in before.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value


def ga4synth_executable() -> str:
    """The `ga4synth` console script from the active virtual environment."""
    candidate = Path(sys.executable).parent / "ga4synth"
    if candidate.exists():
        return str(candidate)
    found = shutil.which("ga4synth")
    if found is None:
        raise RuntimeError("ga4synth is not installed; run `uv sync --python 3.12` first")
    return found


def run_ga4synth(
    *args: str,
    configuration: str | None,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run `ga4synth <args>` and capture its output.

    `configuration` has no default, so every test says which one it runs.
    With a name, that configuration is passed with --property and --mixer.
    With None the flags are left out and the two GA4SYNTH_* variables are
    removed from the environment, so the caller decides through `args`, `env`
    and `cwd` where the generator finds its config.
    """
    command = [ga4synth_executable()]
    environment = dict(os.environ)
    if configuration is not None:
        command += [
            "--property", str(property_file(configuration)),
            "--mixer", str(mixer_file(configuration)),
        ]
    else:
        environment.pop("GA4SYNTH_PROPERTY", None)
        environment.pop("GA4SYNTH_MIXER", None)
    environment.update(env or {})
    return subprocess.run(
        [*command, *args],
        cwd=cwd or PACKAGE_DIR,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def installed_schema_file() -> Path:
    """events.json of the installed ga4synth, found without importing it.

    Found through the import system, which answers for any kind of install:
    `uv sync` installs this project editable, so the package folder is
    `src/ga4synth/`, while the container installs a wheel and the folder is
    inside site-packages. Either way this is the file the generator itself
    opens (`SCHEMA_PATH` in `schema.py`).

    `find_spec` locates a top-level package without running its code.
    """
    spec = importlib.util.find_spec("ga4synth")
    if spec is None or spec.origin is None:
        raise RuntimeError("ga4synth is not installed; run `uv sync --python 3.12` first")
    found = Path(spec.origin).resolve().parent.joinpath(*SCHEMA_PATH_IN_PACKAGE)
    if not found.is_file():
        raise RuntimeError(f"the installed ga4synth has no {found}")
    return found


@pytest.fixture(scope="session")
def fixed_date() -> str:
    return FIXED_DATE.isoformat()


@pytest.fixture(scope="session")
def generated_shard(
    tmp_path_factory: pytest.TempPathFactory, fixed_date: str
) -> Callable[[str], Path]:
    """The fixed day of a configuration, written once by `generate`.

    Call it with the name of the configuration. The file is shared by the
    tests that read it.
    """
    written: dict[str, Path] = {}

    def shard_of(configuration: str) -> Path:
        if configuration not in written:
            out = tmp_path_factory.mktemp(f"generated-{configuration}")
            result = run_ga4synth(
                "generate", "--date", fixed_date, "--out", str(out),
                configuration=configuration,
            )
            assert result.returncode == 0, result.stderr
            path = out / f"{FIXED_SHARD}.json.gz"
            assert path.is_file(), f"expected {path} to be written"
            written[configuration] = path
        return written[configuration]

    return shard_of
