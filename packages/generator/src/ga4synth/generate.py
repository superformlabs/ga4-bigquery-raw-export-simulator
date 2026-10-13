"""Assembling a single ``events_YYYYMMDD`` shard.

A shard contains the events whose ``event_date`` falls on that day *in the
property's reporting timezone*, which is not the same as the events of sessions
that started that day. A session beginning at 23:50 local time spills into the
next shard, exactly as it does in a real export.

To get that right without keeping state, generating shard D simulates sessions
started on both D-1 and D, then keeps only the rows whose local date is D. The
lookback of one day is sufficient because a session is bounded by
``journey.max_pages`` and the per-page gap, which caps it well under an hour.
A visitor's extra sessions all start on the local day of the visit, so the same
lookback covers them.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Iterator

from .serialize import serialize_session
from .simulate import offline_orders_on, sessions_for_visit_date
from .world import World


def rows_for_shard(world: World, day: dt.date) -> Iterator[dict[str, Any]]:
    """Yield every export row belonging to the ``events_YYYYMMDD`` shard for ``day``."""
    stamp = day.strftime("%Y%m%d")
    for visit_date in (day - dt.timedelta(days=1), day):
        for session in sessions_for_visit_date(world, visit_date):
            for row in serialize_session(world, session):
                if row["event_date"] == stamp:
                    yield row
    # Offline orders are placed within their own local day, so the lookback
    # that catches sessions crossing midnight is not needed for them.
    for order in offline_orders_on(world, day):
        yield from serialize_session(world, order)


def sorted_rows_for_shard(world: World, day: dt.date) -> list[dict[str, Any]]:
    """Shard rows ordered by time, then by position within the batch.

    Real exports are not ordered, but a stable order makes the output diffable
    between runs, which is what lets you review a configuration change by
    looking at the delta.
    """
    rows = list(rows_for_shard(world, day))
    rows.sort(
        key=lambda r: (
            r["event_timestamp"],
            # NULL on the rows of a visitor who denied analytics storage.
            r["user_pseudo_id"] or "",
            # Server-side events have no batch position.
            r["batch_ordering_id"] or 0,
            r["batch_event_index"] or 0,
        )
    )
    return rows
