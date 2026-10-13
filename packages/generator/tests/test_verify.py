"""ga4synth produces a valid day with each of the app's configurations."""

from __future__ import annotations

import gzip
import hashlib
import re
from collections.abc import Callable
from pathlib import Path

import pytest

from conftest import CONFIGURATIONS, FIXED_SHARD, run_ga4synth


def sha256_of_rows(path: Path) -> str:
    """Digest of the rows, not of the gzip file, which also stores a timestamp."""
    with gzip.open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


@pytest.mark.parametrize("configuration", CONFIGURATIONS)
def test_verify_passes_on_fixed_date(configuration: str, fixed_date: str) -> None:
    """`ga4synth verify` checks schema conformance and the invariants.

    Exit code 0 means every check passed; 1 means a check failed; 2 means the
    config could not be loaded (docs/contracts/generator-cli.md). The number
    of invariants belongs to the generator and changes between versions, so
    the test reads the result lines instead of counting to a fixed number.
    """
    result = run_ga4synth("verify", "--date", fixed_date, configuration=configuration)
    assert result.returncode == 0, (
        f"ga4synth verify exited {result.returncode}\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    checks = re.findall(r"^\s*\[(pass|FAIL)\] (\w+)$", result.stdout, re.MULTILINE)
    failed = [name for status, name in checks if status == "FAIL"]
    assert not failed, f"failed checks: {failed}"
    names = [name for _, name in checks]
    assert "schema_conformance" in names
    assert len(names) > 1, "verify reported no invariant"
    assert "invariant checks passed" in result.stdout


@pytest.mark.parametrize("configuration", CONFIGURATIONS)
def test_generate_is_deterministic(
    configuration: str,
    tmp_path: Path,
    fixed_date: str,
    generated_shard: Callable[[str], Path],
) -> None:
    """Same config, same date, same rows: two runs must be byte-identical.

    The daily refresh relies on this. `publish --days 3` regenerates and
    replaces the last three days, which is only safe if regenerating a day
    yields exactly the rows that were there before.
    """
    result = run_ga4synth(
        "generate", "--date", fixed_date, "--out", str(tmp_path),
        configuration=configuration,
    )
    assert result.returncode == 0, result.stderr
    second = tmp_path / f"{FIXED_SHARD}.json.gz"
    assert second.is_file(), f"expected {second} to be written"
    assert sha256_of_rows(second) == sha256_of_rows(generated_shard(configuration)), (
        "generate produced different rows on a second run"
    )


@pytest.mark.parametrize("configuration", CONFIGURATIONS)
def test_backfill_writes_the_same_rows_as_generate(
    configuration: str,
    tmp_path: Path,
    fixed_date: str,
    generated_shard: Callable[[str], Path],
) -> None:
    """A day is the same whichever command wrote it."""
    result = run_ga4synth(
        "backfill", "--from", fixed_date, "--to", fixed_date,
        "--out", str(tmp_path), "--verify",
        configuration=configuration,
    )
    assert result.returncode == 0, result.stderr
    assert "[FAIL]" not in result.stdout + result.stderr
    written = tmp_path / f"{FIXED_SHARD}.json.gz"
    assert written.is_file(), f"expected {written} to be written"
    assert sha256_of_rows(written) == sha256_of_rows(generated_shard(configuration))


def test_the_two_configurations_write_different_rows(
    generated_shard: Callable[[str], Path],
) -> None:
    """A guard against both names reaching the same files."""
    digests = {sha256_of_rows(generated_shard(name)) for name in CONFIGURATIONS}
    assert len(digests) == len(CONFIGURATIONS)
