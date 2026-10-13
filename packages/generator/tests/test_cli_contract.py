"""GEN-2: ga4synth offers the command line the app relies on.

The backend and the container only ever run the command line described in
docs/contracts/generator-cli.md. These tests check that every command, option,
default and exit code written there exists in the pinned version. `load` and
`publish` run with --dry-run only, so nothing reaches any project.

GEN-3: the tests that generate rows run once per configuration, because the
job of an install runs one or the other (docs/contracts/api.md, `datasetType`).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

import pytest

from conftest import (
    CONFIGURATIONS,
    ECOMMERCE,
    FAKE_DATASET,
    FIXED_SHARD,
    mixer_file,
    property_file,
    run_ga4synth,
)

CONFIG_OPTIONS = {"--property", "--mixer"}

# The "Commands" table of docs/contracts/generator-cli.md.
CONTRACT_OPTIONS = {
    "generate": {"--date", "--out"},
    "verify": {"--date"},
    "summary": {"--date"},
    "backfill": {"--from", "--to", "--out", "--verify"},
    "load": {"--date", "--out", "--dataset", "--location", "--dry-run"},
    "publish": {"--dataset", "--date", "--days", "--location", "--dry-run", "--workers"},
}

# The target table as the generator prints it for FAKE_DATASET.
FAKE_TABLE_PREFIX = FAKE_DATASET.replace(":", ".") + ".events_"


def options_in_help(*command: str) -> tuple[set[str], str]:
    result = run_ga4synth(*command, "--help", configuration=None)
    assert result.returncode == 0, result.stderr
    return set(re.findall(r"--[a-z][a-z-]*", result.stdout)), result.stdout


def test_global_options_and_commands_exist() -> None:
    options, text = options_in_help()
    assert CONFIG_OPTIONS <= options
    for command in CONTRACT_OPTIONS:
        assert re.search(rf"\b{command}\b", text), f"command {command} is missing"


@pytest.mark.parametrize("command", sorted(CONTRACT_OPTIONS))
def test_command_has_the_contract_options(command: str) -> None:
    options, _ = options_in_help(command)
    missing = (CONTRACT_OPTIONS[command] | CONFIG_OPTIONS) - options
    assert not missing, f"`ga4synth {command}` lacks {sorted(missing)}"


def test_documented_defaults() -> None:
    """`publish` republishes 3 days with 1 worker unless told otherwise."""
    _, text = options_in_help("publish")
    text = " ".join(text.split())
    assert re.search(r"--days DAYS\b.*?\(default: 3\)", text)
    assert re.search(r"--workers WORKERS\b.*?\(default: 1\)", text)


def assert_is_a_summary(text: str) -> None:
    assert f"shard {FIXED_SHARD}" in text
    for label in ("rows", "users", "sessions", "purchases", "revenue"):
        assert label in text


@pytest.mark.parametrize("configuration", CONFIGURATIONS)
def test_summary_with_config_from_the_options(
    configuration: str, tmp_path: Path, fixed_date: str
) -> None:
    """--property and --mixer, placed before the sub-command.

    This is how the job of an install names its configuration
    (docs/contracts/api.md, "Added in v1.8"). The working directory is empty,
    so the two options are the only way the generator can find the config.
    """
    result = run_ga4synth(
        "summary", "--date", fixed_date, cwd=tmp_path, configuration=configuration
    )
    assert result.returncode == 0, result.stderr
    assert_is_a_summary(result.stdout)


@pytest.mark.parametrize("configuration", CONFIGURATIONS)
def test_summary_with_config_from_the_environment(
    configuration: str, tmp_path: Path, fixed_date: str
) -> None:
    """The container passes the config through GA4SYNTH_PROPERTY and GA4SYNTH_MIXER.

    The working directory is empty, so the two variables are the only way the
    generator can find the config.
    """
    result = run_ga4synth(
        "summary", "--date", fixed_date,
        cwd=tmp_path,
        configuration=None,
        env={
            "GA4SYNTH_PROPERTY": str(property_file(configuration)),
            "GA4SYNTH_MIXER": str(mixer_file(configuration)),
        },
    )
    assert result.returncode == 0, result.stderr
    assert_is_a_summary(result.stdout)


def test_the_options_win_over_the_environment(tmp_path: Path, fixed_date: str) -> None:
    """An image that sets the two variables can still run the other configuration.

    The variables name a file that does not exist; the options name a real
    configuration. The command succeeds, so the options were used.
    """
    missing = tmp_path / "nowhere.yaml"
    result = run_ga4synth(
        "summary", "--date", fixed_date,
        cwd=tmp_path,
        configuration=ECOMMERCE,
        env={"GA4SYNTH_PROPERTY": str(missing), "GA4SYNTH_MIXER": str(missing)},
    )
    assert result.returncode == 0, result.stderr
    assert_is_a_summary(result.stdout)


def test_without_any_config_exits_2(tmp_path: Path, fixed_date: str) -> None:
    """No option, no variable, no config/ folder in the working directory.

    Since GEN-3 the app has no configuration at config/property.yaml: a
    command must name `default` or `ecommerce`.
    """
    result = run_ga4synth("verify", "--date", fixed_date, cwd=tmp_path, configuration=None)
    assert result.returncode == 2
    assert "error:" in result.stderr


def test_missing_config_exits_2(tmp_path: Path, fixed_date: str) -> None:
    missing = tmp_path / "nowhere" / "property.yaml"
    result = run_ga4synth(
        "--property", str(missing), "--mixer", str(mixer_file(ECOMMERCE)),
        "verify", "--date", fixed_date,
        configuration=None,
    )
    assert result.returncode == 2
    assert str(missing) in result.stderr


def test_missing_config_from_the_environment_exits_2(tmp_path: Path, fixed_date: str) -> None:
    missing = tmp_path / "nowhere" / "property.yaml"
    result = run_ga4synth(
        "verify", "--date", fixed_date,
        cwd=tmp_path,
        configuration=None,
        env={
            "GA4SYNTH_PROPERTY": str(missing),
            "GA4SYNTH_MIXER": str(mixer_file(ECOMMERCE)),
        },
    )
    assert result.returncode == 2
    assert str(missing) in result.stderr


def test_config_without_a_mapping_exits_2(tmp_path: Path, fixed_date: str) -> None:
    empty = tmp_path / "mixer.yaml"
    empty.write_text("", encoding="utf-8")
    result = run_ga4synth(
        "--property", str(property_file(ECOMMERCE)), "--mixer", str(empty),
        "verify", "--date", fixed_date,
        configuration=None,
    )
    assert result.returncode == 2
    assert "error:" in result.stderr


def test_load_without_a_generated_file_exits_1(tmp_path: Path, fixed_date: str) -> None:
    result = run_ga4synth(
        "load", "--date", fixed_date, "--out", str(tmp_path),
        "--dataset", FAKE_DATASET, "--dry-run",
        configuration=ECOMMERCE,
    )
    assert result.returncode == 1
    assert "run generate first" in result.stderr


@pytest.mark.parametrize("configuration", CONFIGURATIONS)
def test_load_dry_run_names_the_day_table(
    configuration: str, generated_shard: Callable[[str], Path], fixed_date: str
) -> None:
    result = run_ga4synth(
        "load", "--date", fixed_date,
        "--out", str(generated_shard(configuration).parent),
        "--dataset", FAKE_DATASET, "--location", "US", "--dry-run",
        configuration=configuration,
    )
    assert result.returncode == 0, result.stderr
    assert "[dry run] would load" in result.stdout
    assert FAKE_TABLE_PREFIX + FIXED_SHARD.removeprefix("events_") in result.stdout
    assert "loaded" not in result.stdout


@pytest.mark.parametrize("configuration", CONFIGURATIONS)
def test_publish_dry_run_with_two_workers(configuration: str, fixed_date: str) -> None:
    """The backfill arguments of the container contract, plus --workers.

    Two days ending on the fixed date, published by two processes. `publish`
    verifies each day before it loads it, so this also shows that the
    configuration passes on a second date.
    """
    result = run_ga4synth(
        "publish", "--dataset", FAKE_DATASET, "--date", fixed_date,
        "--days", "2", "--location", "US", "--workers", "2", "--dry-run",
        configuration=configuration,
    )
    assert result.returncode == 0, result.stderr
    tables = re.findall(
        rf"\[dry run\] would load [\d,]+ rows into {re.escape(FAKE_TABLE_PREFIX)}(\d{{8}})",
        result.stdout,
    )
    assert sorted(tables) == ["20260831", "20260901"]
    assert "published 2 shard(s)" in result.stdout
    assert "loaded" not in result.stdout
