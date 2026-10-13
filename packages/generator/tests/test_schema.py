"""GEN-2: the schema the installed generator loads with is the agreed one.

The table schema is the file events.json inside the generator
(docs/contracts/ga4-export-schema.md). Two checks: the installed file matches
the column table written in the contract, and generated rows carry exactly
those columns, with each of the app's two configurations.
"""

from __future__ import annotations

import gzip
import json
import re
from pathlib import Path

import pytest

from conftest import (
    CONFIGURATIONS,
    CONTRACTS_DIR,
    FIXED_DATE,
    installed_schema_file,
)

SCHEMA_CONTRACT = CONTRACTS_DIR / "ga4-export-schema.md"


def field_paths(fields: list[dict]) -> int:
    return sum(1 + field_paths(field.get("fields", [])) for field in fields)


def contract_columns() -> list[tuple[str, str, str]]:
    """The rows of the column table in the contract: name, type, mode."""
    rows = re.findall(
        r"^\| (\w+) \| (\S+(?: \(.*?\))?) \| (\w+) \|$",
        SCHEMA_CONTRACT.read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    return [row for row in rows if row[0] != "Column"]


def test_installed_schema_matches_the_contract() -> None:
    schema = json.loads(installed_schema_file().read_text(encoding="utf-8"))
    contract = SCHEMA_CONTRACT.read_text(encoding="utf-8")

    counts = re.search(r"(\d+) top-level columns, (\d+) field paths", contract)
    assert counts, "the contract no longer states the number of columns"
    assert len(schema) == int(counts.group(1))
    assert field_paths(schema) == int(counts.group(2))

    columns = contract_columns()
    assert [name for name, _, _ in columns] == [field["name"] for field in schema]
    for (name, kind, mode), field in zip(columns, schema):
        assert kind.split(" ")[0] == field["type"], name
        assert mode == field.get("mode", "NULLABLE"), name
        sub_fields = re.search(r"\((\d+) fields?\)", kind)
        if sub_fields:
            assert int(sub_fields.group(1)) == len(field["fields"]), name


@pytest.mark.parametrize("configuration", CONFIGURATIONS)
def test_generated_rows_carry_the_schema_columns(
    configuration: str, generated_shard: Callable[[str], Path]
) -> None:
    """Gzipped newline-delimited JSON, one row per line, every column present."""
    schema = json.loads(installed_schema_file().read_text(encoding="utf-8"))
    columns = [field["name"] for field in schema]
    event_date = FIXED_DATE.strftime("%Y%m%d")
    rows = 0
    with gzip.open(generated_shard(configuration), "rt", encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            assert sorted(row) == sorted(columns)
            assert row["event_date"] == event_date
            rows += 1
    assert rows > 0
