"""Structural validation of generated rows against the captured export schema.

``bq load`` is the slowest possible place to discover a misspelled field name, so
every row is checked against ``schema/events.json`` locally first. The check is
strict in both directions: a field the schema does not define is an error, and a
field the schema defines but the row omits is an error too. Loading tolerates
omissions, but silence about them is how a column quietly becomes NULL across a
whole dataset.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).resolve().parent / "data" / "events.json"

_PYTHON_TYPES: dict[str, tuple[type, ...]] = {
    "STRING": (str,),
    "INTEGER": (int,),
    "FLOAT": (float, int),
    "BOOLEAN": (bool,),
}


def load_schema(path: Path | None = None) -> list[dict[str, Any]]:
    with open(path or SCHEMA_PATH) as handle:
        return json.load(handle)


def _check_value(field: dict[str, Any], value: Any, path: str, errors: list[str]) -> None:
    if value is None:
        return

    if field["type"] == "RECORD":
        if not isinstance(value, dict):
            errors.append(f"{path}: expected an object for RECORD, got {type(value).__name__}")
            return
        _check_record(field["fields"], value, path, errors)
        return

    expected = _PYTHON_TYPES.get(field["type"])
    if expected is None:
        return  # types this generator does not emit
    # bool is a subclass of int in Python, so exclude it explicitly for numbers.
    if field["type"] in ("INTEGER", "FLOAT") and isinstance(value, bool):
        errors.append(f"{path}: bool where {field['type']} expected")
        return
    if not isinstance(value, expected):
        errors.append(
            f"{path}: expected {field['type']}, got {type(value).__name__} ({value!r})"
        )


def _check_record(
    fields: list[dict[str, Any]], record: dict[str, Any], prefix: str, errors: list[str]
) -> None:
    defined = {field["name"]: field for field in fields}

    for name in record:
        if name not in defined:
            errors.append(f"{prefix}.{name}" if prefix else name)

    for name, field in defined.items():
        path = f"{prefix}.{name}" if prefix else name
        if name not in record:
            errors.append(f"{path}: missing from row")
            continue
        value = record[name]
        if field.get("mode") == "REPEATED":
            if value is None:
                continue
            if not isinstance(value, list):
                errors.append(f"{path}: expected a list for REPEATED, got {type(value).__name__}")
                continue
            for index, element in enumerate(value):
                _check_value(field, element, f"{path}[{index}]", errors)
        else:
            _check_value(field, value, path, errors)


def validate_row(row: dict[str, Any], schema: list[dict[str, Any]] | None = None) -> list[str]:
    """Return a list of structural problems with one row. Empty means valid."""
    errors: list[str] = []
    _check_record(schema or load_schema(), row, "", errors)
    return errors


def validate_rows(rows: list[dict[str, Any]], limit: int = 20) -> list[str]:
    """Validate every row, returning up to ``limit`` distinct problems."""
    schema = load_schema()
    seen: dict[str, int] = {}
    for index, row in enumerate(rows):
        for error in validate_row(row, schema):
            seen.setdefault(error, index)
            if len(seen) >= limit:
                break
    return [f"{error} (first seen row {index})" for error, index in seen.items()]
