"""Loading generated shards into BigQuery.

This uses the ``google-cloud-bigquery`` client rather than shelling out to the
``bq`` CLI. ``bq`` ships as part of the Google Cloud SDK, which would add
roughly a gigabyte to a container image for the sake of one command, and a
subprocess exit code is a poor substitute for a real error.

The dependency is optional. Install it with::

    pip install 'ga4synth[bigquery]'

Loads are idempotent: each shard is written with ``WRITE_TRUNCATE``, so
re-running a day replaces it rather than appending. Combined with deterministic
generation, re-running any day produces byte-identical content, which is what
makes a scheduled job safe to retry.
"""

from __future__ import annotations

import datetime as dt
import gzip
import io
import json
from pathlib import Path
from typing import Any, Iterable

SCHEMA_PATH = Path(__file__).resolve().parent / "data" / "events.json"


class BigQueryUnavailable(RuntimeError):
    """Raised when the optional BigQuery dependency is not installed."""


def _client_module():
    try:
        from google.cloud import bigquery
    except ImportError as error:  # pragma: no cover - environment dependent
        raise BigQueryUnavailable(
            "google-cloud-bigquery is not installed. "
            "Install it with: pip install 'ga4synth[bigquery]'"
        ) from error
    return bigquery


def parse_dataset(reference: str) -> tuple[str | None, str]:
    """Split a dataset reference into ``(project, dataset)``.

    Accepts both the ``bq`` CLI style ``project:dataset`` and the API style
    ``project.dataset``, plus a bare ``dataset`` which defers to the client's
    default project.
    """
    if ":" in reference:
        project, _, dataset = reference.partition(":")
        return project or None, dataset
    if "." in reference:
        project, _, dataset = reference.rpartition(".")
        return project or None, dataset
    return None, reference


def table_id(reference: str, day: dt.date) -> tuple[str | None, str, str]:
    """Return ``(project, dataset, table)`` for a shard."""
    project, dataset = parse_dataset(reference)
    return project, dataset, f"events_{day.strftime('%Y%m%d')}"


def rows_to_ndjson(rows: Iterable[dict[str, Any]]) -> io.BytesIO:
    """Serialise rows to an in-memory, gzipped NDJSON buffer.

    The upload, not the load job, dominates the time a shard takes: a shard is
    tens of megabytes of highly repetitive JSON, and gzip shrinks it about
    thirtyfold in a fraction of a second. BigQuery detects the compression
    itself. ``load_shard`` compares the loaded row count with the generated one,
    so a load that silently read nothing cannot pass.
    """
    buffer = io.BytesIO()
    # mtime=0 keeps the bytes identical between runs, like the rows themselves.
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as compressed:
        for row in rows:
            compressed.write(json.dumps(row, separators=(",", ":")).encode("utf-8"))
            compressed.write(b"\n")
    buffer.seek(0)
    return buffer


def load_shard(
    rows: list[dict[str, Any]],
    dataset_reference: str,
    day: dt.date,
    *,
    location: str | None = None,
    schema_path: Path | None = None,
) -> Any:
    """Load one shard, replacing any existing table for that day.

    Returns the completed load job. Raises if the job fails, so a scheduled
    caller can rely on a non-zero exit meaning nothing landed.
    """
    bigquery = _client_module()

    project, dataset, table = table_id(dataset_reference, day)
    client = bigquery.Client(project=project)
    destination = f"{client.project}.{dataset}.{table}"

    job_config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        # The committed schema is authoritative. Autodetect would infer types
        # from the data and silently drop the all-NULL columns that a real
        # export still carries.
        schema=client.schema_from_json(str(schema_path or SCHEMA_PATH)),
    )

    job = client.load_table_from_file(
        rows_to_ndjson(rows), destination, job_config=job_config, location=location
    )
    job.result()  # raises on failure

    if job.output_rows != len(rows):
        raise RuntimeError(
            f"{destination}: loaded {job.output_rows} rows but generated {len(rows)}"
        )
    return job


def ensure_dataset(dataset_reference: str, location: str) -> None:
    """Create the destination dataset if it does not already exist."""
    bigquery = _client_module()
    project, dataset = parse_dataset(dataset_reference)
    client = bigquery.Client(project=project)
    reference = bigquery.Dataset(f"{client.project}.{dataset}")
    reference.location = location
    client.create_dataset(reference, exists_ok=True)
