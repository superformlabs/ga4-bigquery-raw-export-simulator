"""Command line interface.

    ga4synth generate  --date 2026-08-25 [--out dir]
    ga4synth verify    --date 2026-08-25
    ga4synth backfill  --from 2026-06-01 --to 2026-08-25 --out dir
    ga4synth summary   --date 2026-08-25
    ga4synth load      --date 2026-08-25 --dataset project:dataset [--dry-run]
    ga4synth publish   --dataset project:dataset [--days 3] [--date 2026-08-25] [--workers 4]

Configuration is two files, ``config/property.yaml`` (what the site is) and
``config/mixer.yaml`` (how much traffic it gets). Override either with
``--property`` / ``--mixer``, or the GA4SYNTH_PROPERTY / GA4SYNTH_MIXER
environment variables.

``generate`` and ``backfill`` write gzipped newline-delimited JSON, one file per
shard. Nothing touches BigQuery unless you run ``load`` or ``publish``.

``publish`` is the entry point for a scheduled job: it generates, runs the
invariants, and only then loads, so a shard that fails verification never
reaches the dataset. It needs the optional BigQuery dependency
(``pip install 'ga4synth[bigquery]'``).
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json

import sys
from collections import Counter
from pathlib import Path

from .generate import sorted_rows_for_shard
from .invariants import run_all
from .schema import validate_rows
from .world import load_world, scenario_paths

SCHEMA_PATH = Path(__file__).resolve().parent / "data" / "events.json"


def _date(value: str) -> dt.date:
    return dt.date.fromisoformat(value)


def _shard_path(out: Path, day: dt.date) -> Path:
    return out / f"events_{day.strftime('%Y%m%d')}.json.gz"


def _write_shard(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")


def _report(name: str, results: dict[str, list[str]]) -> bool:
    """Print invariant results. Returns True if everything passed."""
    failed = {check: fails for check, fails in results.items() if fails}
    for check in results:
        status = "FAIL" if results[check] else "pass"
        print(f"  [{status}] {check}")
        for failure in results[check][:5]:
            print(f"         {failure}")
        if len(results[check]) > 5:
            print(f"         ... and {len(results[check]) - 5} more")
    if failed:
        print(f"\n{name}: FAILED {len(failed)} of {len(results)} checks")
        return False
    print(f"\n{name}: all {len(results)} invariant checks passed")
    return True


def cmd_generate(args) -> int:
    world = load_world(args.property, args.mixer)
    rows = sorted_rows_for_shard(world, args.date)
    path = _shard_path(Path(args.out), args.date)
    _write_shard(rows, path)
    print(f"{len(rows):,} rows -> {path}")
    return 0


def cmd_verify(args) -> int:
    world = load_world(args.property, args.mixer)
    rows = sorted_rows_for_shard(world, args.date)
    print(f"{args.date}: {len(rows):,} rows")

    # Structural conformance first: if the rows would not load, the behavioural
    # invariants are moot.
    schema_errors = validate_rows(rows)
    if schema_errors:
        print("  [FAIL] schema_conformance")
        for error in schema_errors[:10]:
            print(f"         {error}")
    else:
        print("  [pass] schema_conformance")

    ok = _report(str(args.date), run_all(world, args.date, rows))
    return 0 if ok and not schema_errors else 1


def cmd_backfill(args) -> int:
    world = load_world(args.property, args.mixer)
    out = Path(args.out)
    day, total = args.date_from, 0
    # The per-shard invariant can only see one day, so a transaction id reused
    # across two shards slips past it. A backfill is the only place with the
    # whole range in view, so the range-wide check belongs here.
    transaction_days: dict[str, dt.date] = {}
    collisions: list[str] = []
    while day <= args.date_to:
        rows = sorted_rows_for_shard(world, day)
        if args.verify:
            results = run_all(world, day, rows)
            if any(results.values()):
                print(f"{day}: invariants FAILED, stopping", file=sys.stderr)
                _report(str(day), results)
                return 1
            for row in rows:
                if row["event_name"] != "purchase":
                    continue
                txn = row["ecommerce"]["transaction_id"]
                earlier = transaction_days.get(txn)
                if earlier is None:
                    transaction_days[txn] = day
                else:
                    collisions.append(f"transaction_id {txn} reused on {earlier} and {day}")
        _write_shard(rows, _shard_path(out, day))
        total += len(rows)
        print(f"{day}: {len(rows):,} rows")
        day += dt.timedelta(days=1)
    if collisions:
        print(
            f"\n[FAIL] transaction_ids_unique_across_range: {len(collisions)} collisions",
            file=sys.stderr,
        )
        for line in collisions[:20]:
            print(f"       {line}", file=sys.stderr)
        return 1
    if args.verify:
        print(f"\n[pass] transaction_ids_unique_across_range ({len(transaction_days):,} transactions)")
    print(f"\ntotal {total:,} rows")
    return 0


def cmd_summary(args) -> int:
    """Print the shape of a shard, for eyeballing whether it looks plausible."""
    world = load_world(args.property, args.mixer)
    rows = sorted_rows_for_shard(world, args.date)
    if not rows:
        print("no rows")
        return 1

    events = Counter(row["event_name"] for row in rows)
    sessions = {
        (row["user_pseudo_id"], next(
            (e["value"]["int_value"] for e in row["event_params"] if e["key"] == "ga_session_id"), None))
        for row in rows
        # Consent-denied rows name neither a user nor a session, so they are
        # counted on their own line instead.
        if row["user_pseudo_id"] is not None
    }
    users = {row["user_pseudo_id"] for row in rows if row["user_pseudo_id"] is not None}
    denied = sum(1 for row in rows if row["user_pseudo_id"] is None)
    purchases = [row for row in rows if row["event_name"] == "purchase"]
    revenue = sum(row["ecommerce"]["purchase_revenue"] for row in purchases)
    channels = Counter(
        row["session_traffic_source_last_click"]["cross_channel_campaign"]["default_channel_group"]
        for row in rows
    )
    devices = Counter(row["device"]["category"] for row in rows)

    print(f"shard events_{args.date.strftime('%Y%m%d')}")
    print(f"  rows            {len(rows):,}")
    print(f"  no consent      {denied:,} rows ({100 * denied / len(rows):.1f}%)")
    print(f"  users           {len(users):,}")
    print(f"  sessions        {len(sessions):,}")
    print(f"  purchases       {len(purchases):,}")
    print(f"  revenue         {revenue:,.2f} {world.currency}")
    if sessions:
        identified = sum(1 for row in purchases if row["user_pseudo_id"] is not None)
        print(f"  conv. rate      {100 * identified / len(sessions):.2f}%")
    if purchases:
        print(f"  AOV             {revenue / len(purchases):,.2f} {world.currency}")
    leads = [row for row in rows if row["event_name"] == "generate_lead"]
    if leads:
        lead_value = sum(
            next((float(e["value"]["int_value"] if e["value"]["int_value"] is not None
                        else e["value"]["double_value"])
                  for e in row["event_params"] if e["key"] == "value"), 0.0)
            for row in leads
        )
        identified = sum(1 for row in leads if row["user_pseudo_id"] is not None)
        print(f"  leads           {len(leads):,}")
        print(f"  lead value      {lead_value:,.2f} {world.currency}")
        if sessions:
            print(f"  lead rate       {100 * identified / len(sessions):.2f}%")
    print("\n  events by name")
    for name, count in events.most_common():
        print(f"    {name:<22} {count:>7,}")
    print("\n  rows by channel")
    for name, count in channels.most_common():
        # NULL on server-side purchases and on consent-denied rows.
        print(f"    {name or '(none)':<22} {count:>7,}")
    print("\n  rows by device")
    for name, count in devices.most_common():
        print(f"    {name:<22} {count:>7,}")
    return 0


def cmd_load(args) -> int:
    """Load a previously generated shard file."""
    path = _shard_path(Path(args.out), args.date)
    if not path.exists():
        print(f"{path} does not exist; run generate first", file=sys.stderr)
        return 1
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle]
    return _load(rows, args)


def _load(rows: list[dict], args) -> int:
    """Shared load path for `load` and `publish`."""
    from .load import BigQueryUnavailable, load_shard, table_id

    project, dataset, table = table_id(args.dataset, args.date)
    target = f"{project or '(default project)'}.{dataset}.{table}"
    if args.dry_run:
        print(f"[dry run] would load {len(rows):,} rows into {target}", flush=True)
        return 0
    try:
        job = load_shard(rows, args.dataset, args.date, location=args.location)
    except BigQueryUnavailable as error:
        print(error, file=sys.stderr)
        return 1
    print(f"loaded {job.output_rows:,} rows into {target}", flush=True)
    return 0


# One world per worker process, set by ``_init_publish_worker``. A pool worker
# publishes many days, and the world is the same for all of them.
_PUBLISH_WORLD = None


def _init_publish_worker(property_path, mixer_path) -> None:
    global _PUBLISH_WORLD
    _PUBLISH_WORLD = load_world(property_path, mixer_path)


def _publish_day(world, args, day: dt.date) -> bool:
    """Generate, verify and load one day. Returns False if the shard failed."""
    rows = sorted_rows_for_shard(world, day)
    schema_errors = validate_rows(rows)
    results = run_all(world, day, rows)
    if schema_errors or any(results.values()):
        # One write, so reports from parallel workers do not interleave.
        lines = [f"{day}: FAILED verification, not loading"]
        lines += [f"  schema: {error}" for error in schema_errors[:5]]
        for check, fails in results.items():
            lines += [f"  {check}: {failure}" for failure in fails[:3]]
        print("\n".join(lines), file=sys.stderr, flush=True)
        return False
    day_args = argparse.Namespace(**{**vars(args), "date": day})
    return _load(rows, day_args) == 0


def _publish_day_in_worker(args, day: dt.date) -> bool:
    return _publish_day(_PUBLISH_WORLD, args, day)


def cmd_publish(args) -> int:
    """Generate, verify, and load. The scheduled-job entry point.

    Verification is not optional here. A scheduled job runs unattended, so the
    only safe default is to refuse to publish a shard that fails its invariants
    rather than to load it and hope someone notices.

    Publishing several days each run makes the job self-healing: loads replace
    rather than append, and generation is deterministic, so re-running a day is
    a no-op that repairs a missed run at no cost.

    A shard depends on nothing but the configuration and its date, so
    ``--workers`` publishes several days at once, each in its own process. That
    is for a long republish from a workstation: every worker holds a full shard
    in memory (about 300 MB at its peak), so the scheduled job keeps the default
    of one.
    """
    end = args.date or (dt.date.today() - dt.timedelta(days=1))
    days = [end - dt.timedelta(days=offset) for offset in range(args.days - 1, -1, -1)]
    workers = max(1, min(args.workers, len(days)))

    if workers == 1:
        world = load_world(args.property, args.mixer)
        outcomes = [_publish_day(world, args, day) for day in days]
    else:
        from concurrent.futures import ProcessPoolExecutor

        with ProcessPoolExecutor(
            max_workers=workers,
            initializer=_init_publish_worker,
            initargs=(args.property, args.mixer),
        ) as pool:
            futures = [pool.submit(_publish_day_in_worker, args, day) for day in days]
            try:
                outcomes = [future.result() for future in futures]
            except BaseException:
                # A load error stops the run, as it does with one worker. Days
                # already in flight finish; the rest are never started.
                pool.shutdown(cancel_futures=True)
                raise

    failed = outcomes.count(False)
    if failed:
        print(f"\n{failed} of {len(days)} shards failed", file=sys.stderr)
        return 1
    print(f"\npublished {len(days)} shard(s)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ga4synth", description=__doc__)
    parser.add_argument("--property", default=None, help="path to property.yaml")
    parser.add_argument("--mixer", default=None, help="path to mixer.yaml")
    parser.add_argument("--scenario", default=None,
                        help="a shipped scenario under config/scenarios, instead of --property and --mixer")

    def add_config(node):
        # argparse.SUPPRESS keeps the subparser from overwriting a path
        # supplied before the subcommand with its own None default.
        node.add_argument("--property", default=argparse.SUPPRESS,
                          help="path to property.yaml")
        node.add_argument("--mixer", default=argparse.SUPPRESS,
                          help="path to mixer.yaml")
        node.add_argument("--scenario", default=argparse.SUPPRESS,
                          help="a shipped scenario under config/scenarios, instead of --property and --mixer")
    sub = parser.add_subparsers(dest="command", required=True)

    for name, handler in (
        ("generate", cmd_generate), ("verify", cmd_verify),
        ("summary", cmd_summary), ("load", cmd_load),
    ):
        node = sub.add_parser(name)
        add_config(node)
        node.add_argument("--date", type=_date, required=True)
        node.set_defaults(handler=handler)
        if name in ("generate", "load"):
            node.add_argument("--out", default="out")
        if name == "load":
            node.add_argument("--dataset", required=True, help="project:dataset")
            node.add_argument("--dry-run", action="store_true")
            node.add_argument("--location", default=None, help="BigQuery location, e.g. US")

    node = sub.add_parser("publish")
    add_config(node)
    node.add_argument("--dataset", required=True, help="project:dataset")
    node.add_argument("--date", type=_date, default=None,
                      help="most recent day to publish (default: yesterday)")
    node.add_argument("--days", type=int, default=3,
                      help="how many days back to (re)publish; loads replace, so this "
                           "repairs missed runs (default: 3)")
    node.add_argument("--location", default=None, help="BigQuery location, e.g. US")
    node.add_argument("--dry-run", action="store_true")
    node.add_argument("--workers", type=int, default=1,
                      help="days to publish at once, one process each; every "
                           "worker holds a full shard in memory (default: 1)")
    node.set_defaults(handler=cmd_publish)

    node = sub.add_parser("backfill")
    add_config(node)
    node.add_argument("--from", dest="date_from", type=_date, required=True)
    node.add_argument("--to", dest="date_to", type=_date, required=True)
    node.add_argument("--out", default="out")
    node.add_argument("--verify", action="store_true", help="run invariants on every shard")
    node.set_defaults(handler=cmd_backfill)

    args = parser.parse_args(argv)
    try:
        if args.scenario:
            if args.property or args.mixer:
                raise ValueError("--scenario replaces --property and --mixer; pass one or the other")
            args.property, args.mixer = (str(path) for path in scenario_paths(args.scenario))
        return args.handler(args)
    except (FileNotFoundError, ValueError) as error:
        # Config problems are user errors, not crashes. A traceback here just
        # buries the one line that says what to fix.
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
