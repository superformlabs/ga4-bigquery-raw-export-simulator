"""The quality gate.

Filling the schema correctly is easy to eyeball. Referential integrity is not,
and it is what actually determines whether the dataset behaves like a real
export when someone queries it. These checks run over generated rows and are the
gate that a shard must pass before it is loaded.

Each check returns a list of human readable failures. An empty list means pass.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from typing import Any, Callable
from zoneinfo import ZoneInfo

from .world import SESSION_TIMEOUT_SECONDS, World

Row = dict[str, Any]
Check = Callable[[World, dt.date, list[Row]], list[str]]

# Funnel steps that imply every earlier step must also have occurred in the
# same session.
FUNNEL = ["view_item", "add_to_cart", "view_cart", "begin_checkout", "purchase"]
LEAD_FUNNEL = ["form_start", "form_submit", "generate_lead"]


def _param(row: Row, key: str) -> Any:
    for entry in row["event_params"]:
        if entry["key"] == key:
            value = entry["value"]
            for slot in ("string_value", "int_value", "double_value", "float_value"):
                if value[slot] is not None:
                    return value[slot]
            return None
    return None


def _is_sessionless(row: Row) -> bool:
    """A row that carries no ga_session_id."""
    return _param(row, "ga_session_id") is None


def _is_denied(row: Row) -> bool:
    """A row collected without analytics storage.

    GA4 exports it with no user_pseudo_id and no ga_session_id, so it cannot
    be tied to a visitor or to a session. That is the real difficulty of
    consent mode, and the checks below live with it rather than work around
    it: a check that needs a session skips these rows, and a check that reads
    one row at a time still applies to them. check_consent_denied_rows holds
    what is specific to them.
    """
    return row["privacy_info"]["analytics_storage"] == "No"


def _is_server_side(row: Row) -> bool:
    """A row sent from the server. It was never part of a browser request."""
    return row["batch_ordering_id"] is None


def _sessions(rows: list[Row]) -> dict[tuple[str, Any], list[Row]]:
    """Rows grouped by ``(user_pseudo_id, ga_session_id)``.

    Rows without a session id are in no session. That covers most server-side
    purchases and every consent-denied row. A server-side purchase that does
    carry a session id forms a session of its own, with one event.
    """
    grouped: dict[tuple[str, Any], list[Row]] = defaultdict(list)
    for row in rows:
        if _is_sessionless(row) or _is_denied(row):
            continue
        grouped[(row["user_pseudo_id"], _param(row, "ga_session_id"))].append(row)
    for events in grouped.values():
        events.sort(key=lambda r: (r["event_timestamp"], r["batch_ordering_id"] or 0, r["batch_event_index"] or 0))
    return grouped


def _opens_in_shard(events: list[Row]) -> bool:
    """Whether a browser session's first batch is among ``events``.

    A session cut by midnight leaves its first batch in the previous shard.
    session_start is not a reliable marker, because GA4 sometimes drops it,
    so the first batch itself is the evidence.
    """
    return any(row["batch_ordering_id"] == 1 for row in events)


def check_shard_matches_event_date(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """Every row's event_date must equal the shard date, and agree with its timestamp.

    This is the single most common defect in synthetic GA4 data: rows placed in
    the shard matching UTC rather than the property's reporting timezone.
    """
    failures = []
    stamp = day.strftime("%Y%m%d")
    tz = ZoneInfo(world.timezone)
    for row in rows:
        if row["event_date"] != stamp:
            failures.append(
                f"event_date {row['event_date']} in shard {stamp} "
                f"(event_timestamp {row['event_timestamp']})"
            )
            continue
        local = dt.datetime.fromtimestamp(row["event_timestamp"] / 1_000_000, tz)
        if local.strftime("%Y%m%d") != row["event_date"]:
            failures.append(
                f"event_date {row['event_date']} disagrees with local date "
                f"{local.strftime('%Y%m%d')} derived from event_timestamp"
            )
    return failures[:20]


def check_identifier_stability(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """user_pseudo_id must pin one first-touch timestamp; sessions must be coherent."""
    failures = []
    first_touch: dict[str, int] = {}
    for row in rows:
        if _is_denied(row) or row["user_pseudo_id"] is None:
            continue  # no user_pseudo_id to pin anything to
        pseudo = row["user_pseudo_id"]
        touch = row["user_first_touch_timestamp"]
        if pseudo in first_touch and first_touch[pseudo] != touch:
            failures.append(
                f"user_pseudo_id {pseudo} has two first-touch timestamps: "
                f"{first_touch[pseudo]} and {touch}"
            )
        first_touch.setdefault(pseudo, touch)
        # The second component of user_pseudo_id is the first-touch epoch second.
        _, _, suffix = pseudo.partition(".")
        if suffix != str(touch // 1_000_000):
            failures.append(
                f"user_pseudo_id {pseudo} suffix does not match "
                f"user_first_touch_timestamp {touch}"
            )

    for (pseudo, session_id), events in _sessions(rows).items():
        numbers = {_param(row, "ga_session_number") for row in events}
        if len(numbers) > 1:
            failures.append(
                f"session {pseudo}/{session_id} has multiple ga_session_number: {sorted(numbers)}"
            )
    # A missing ga_session_id is checked by check_server_side_events, which
    # tells a legitimate server-side purchase apart from a web event that lost
    # its session. Denied rows have no session to be coherent with.
    return failures[:20]


def check_user_id_stability(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """One device reports one user_id, on every event or on none of them.

    Sign-in is modelled as a property of the person, so a device either carries
    their user_id throughout or is anonymous throughout. A device that flipped
    between the two would split one visitor in any analysis keyed on
    COALESCE(user_id, user_pseudo_id), which is the standard way to read the
    column. Collecting NULL alongside a real id catches both halves of that.
    """
    failures = []
    seen: dict[str, set[str | None]] = {}
    for row in rows:
        if _is_denied(row) or row["user_pseudo_id"] is None:
            continue  # no device to group by; check_consent_denied_rows requires NULL
        seen.setdefault(row["user_pseudo_id"], set()).add(row["user_id"])

    for pseudo, ids in sorted(seen.items()):
        if len(ids) > 1:
            reported = ", ".join(sorted("NULL" if i is None else i for i in ids))
            failures.append(f"user_pseudo_id {pseudo} reports several user_ids: {reported}")
    return failures[:20]


def check_server_side_events(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """A consented row without ga_session_id must be a server-side purchase, and look like one.

    Among consented rows, server-side events are the only legitimate reason
    for a missing session id, and they carry nothing a browser adds: no page
    parameters, no batch position, no collected campaign and no session
    attribution. Anything else without a session id is a web event that lost
    its session, which would silently drop it from every session-scoped
    analysis.

    Some integrations send a session id with the order. Such a row has no
    batch position, which is how it is recognised, and must look the same in
    every other respect. It carries ga_session_number if and only if it
    carries ga_session_id.

    Denied rows lack a session id for another reason and are left to
    check_consent_denied_rows, which also requires them to be browser rows.
    """
    failures = []
    browser_only = (
        "page_location", "page_title", "page_referrer",
        "session_engaged", "engaged_session_event", "batch_page_id", "batch_ordering_id",
    )
    for row in rows:
        if _is_denied(row):
            continue
        if not (_is_sessionless(row) or _is_server_side(row)):
            continue
        label = f"{row['event_name']} for {row['user_pseudo_id']} at {row['event_timestamp']}"
        if row["event_name"] != "purchase":
            failures.append(
                f"{label}: no ga_session_id or no batch position, "
                "but only a server-side purchase may lack one"
            )
            continue
        present = [key for key in browser_only if any(e["key"] == key for e in row["event_params"])]
        if present:
            failures.append(f"{label}: server-side purchase carries browser parameters {present}")
        if (_param(row, "ga_session_number") is None) != _is_sessionless(row):
            failures.append(
                f"{label}: server-side purchase must carry ga_session_id and "
                "ga_session_number together or not at all"
            )
        if any(row[key] is not None for key in ("batch_page_id", "batch_ordering_id", "batch_event_index")):
            failures.append(f"{label}: server-side purchase has a batch position")
        if any(value is not None for value in row["collected_traffic_source"].values()):
            failures.append(f"{label}: server-side purchase has a collected campaign")
        if row["session_traffic_source_last_click"]["cross_channel_campaign"]["default_channel_group"] is not None:
            failures.append(f"{label}: server-side purchase has session attribution")
    return failures[:20]


def check_timestamp_monotonicity(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """Batch order and clock order must agree within a session.

    Ties are permitted: GA4 genuinely emits session_start, first_visit and the
    opening page_view at the same microsecond, ordered by batch position.

    Note this deliberately does *not* sort by event_timestamp first. An earlier
    version did, which made the check unfalsifiable: it sorted the timestamps
    and then asserted they were sorted. The real invariant is that the batch
    sequence GA4 assigns agrees with the clock, so the events are ordered by
    ``(batch_ordering_id, batch_event_index)`` and the timestamps are then
    required to be non-decreasing.

    Denied rows are skipped. Batch positions restart in every session, and
    nothing on a denied row says which session it belongs to.
    """
    failures = []
    for (pseudo, session_id), events in _sessions(rows).items():
        in_batch_order = sorted(
            events, key=lambda r: (r["batch_ordering_id"], r["batch_event_index"])
        )
        stamps = [row["event_timestamp"] for row in in_batch_order]
        for index in range(1, len(stamps)):
            if stamps[index] < stamps[index - 1]:
                failures.append(
                    f"session {pseudo}/{session_id}: event_timestamp goes backwards "
                    f"({stamps[index - 1]} -> {stamps[index]}) in batch order"
                )
                break
    return failures[:20]


_PAGE_LOAD_EVENTS = ("first_visit", "session_start", "page_view")


def check_first_batch_composition(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """The first batch of a session holds its page-load events and nothing else.

    Only first_visit, session_start and page_view collect the campaign. A model
    that resolves the session source from the first event, and falls back to
    page_referrer on the first batch, reads an external referrer off any other
    event it finds there. A view_item_list tied with session_start then turns
    a google / organic session into www.google.com / referral.

    A session cut by midnight leaves its opening batch in the previous shard,
    so only sessions whose first batch is in this shard are checked. The first
    batch, not session_start, marks the opening, because GA4 sometimes drops
    session_start and the rule holds for those sessions all the same.

    Denied rows cannot be grouped into sessions, so they get the half of the
    rule that needs no session: nothing but a page-load event sits in batch 1.
    """
    failures = []
    for row in rows:
        if _is_denied(row) and row["batch_ordering_id"] == 1 and row["event_name"] not in _PAGE_LOAD_EVENTS:
            failures.append(
                f"consent-denied {row['event_name']} at {row['event_timestamp']} is in the first batch"
            )

    for (pseudo, session_id), events in _sessions(rows).items():
        opening = [
            row["event_timestamp"] for row in events
            if row["batch_ordering_id"] == 1 and row["event_name"] in _PAGE_LOAD_EVENTS
        ]
        if not opening:
            # No batch 1 here at all: the session opened in the previous
            # shard. A batch 1 without a page load breaks the rule outright.
            stray = next((row for row in events if row["batch_ordering_id"] == 1), None)
            if stray is not None:
                failures.append(
                    f"session {pseudo}/{session_id}: {stray['event_name']} is in the first batch"
                )
            continue
        started = min(opening)
        for row in events:
            if row["event_name"] in _PAGE_LOAD_EVENTS:
                continue
            if row["batch_ordering_id"] == 1:
                failures.append(
                    f"session {pseudo}/{session_id}: {row['event_name']} is in the first batch"
                )
                break
            if row["event_timestamp"] <= started:
                failures.append(
                    f"session {pseudo}/{session_id}: {row['event_name']} is not later "
                    f"than the page load that opened the session"
                )
                break
    return failures[:20]


_SESSION_TIMEOUT_MICROS = SESSION_TIMEOUT_SECONDS * 1_000_000


def check_session_lifecycle(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """session_start at most once per session; first_visit at most once per user.

    "At most" rather than "exactly" because a session that straddles midnight
    has its opening events in the previous shard, and because GA4 sometimes
    drops session_start altogether. Within a single shard, a session's start
    may legitimately be absent.

    A visitor's sessions must also be separate sessions: numbered one after
    the other, and further apart than GA4's session timeout.

    Denied rows are skipped: they name neither a session nor a user, so there
    is nothing to count them within.
    """
    failures = []
    for (pseudo, session_id), events in _sessions(rows).items():
        starts = [row for row in events if row["event_name"] == "session_start"]
        if len(starts) > 1:
            failures.append(f"session {pseudo}/{session_id} has {len(starts)} session_start events")
        if starts and events[0]["event_name"] not in ("session_start", "first_visit"):
            failures.append(
                f"session {pseudo}/{session_id} starts with {events[0]['event_name']}, "
                "not session_start/first_visit"
            )

    per_user = defaultdict(int)
    for row in rows:
        if row["event_name"] == "first_visit" and not _is_denied(row):
            per_user[row["user_pseudo_id"]] += 1
    for pseudo, count in per_user.items():
        if count > 1:
            failures.append(f"user {pseudo} has {count} first_visit events")

    # A visitor can have several sessions in one shard. Their session numbers
    # must count up in start order, one at a time. GA4 only reports two
    # sessions if 30 minutes passed without an event, so a session must also
    # start at least that long after the previous one ended. The generator
    # guarantees that gap between the sessions of one visit day, so that is
    # the pair this check covers. ga_session_id is the start in epoch seconds.
    tz = ZoneInfo(world.timezone)
    per_visitor = defaultdict(list)
    for (pseudo, session_id), events in _sessions(rows).items():
        if pseudo is None:
            continue  # no identifier to group by
        stamps = [row["event_timestamp"] for row in events]
        per_visitor[pseudo].append(
            (min(stamps), max(stamps), _param(events[0], "ga_session_number"), session_id)
        )
    for pseudo, spans in per_visitor.items():
        spans.sort()
        for (_, ended, number, session_id), (started, _, next_number, next_id) in zip(spans, spans[1:]):
            same_day = (
                dt.datetime.fromtimestamp(session_id, tz).date()
                == dt.datetime.fromtimestamp(next_id, tz).date()
            )
            if same_day and started - ended < _SESSION_TIMEOUT_MICROS:
                failures.append(
                    f"user {pseudo}: session {next_id} starts {(started - ended) / 1e6:.0f}s after "
                    f"session {session_id} ends, inside the 30 minute session timeout"
                )
            if next_number != number + 1:
                failures.append(
                    f"user {pseudo}: session {next_id} has ga_session_number {next_number}, "
                    f"expected {number + 1} after session {session_id}"
                )
    return failures[:20]


def check_entrances(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """The entrances parameter appears at most once per session, on a page_view.

    The count needs a session, so it skips denied rows. The event name is read
    off one row, so it holds for every row, denied or not.
    """
    failures = []
    for (pseudo, session_id), events in _sessions(rows).items():
        marked = [row for row in events if _param(row, "entrances") == 1]
        if len(marked) > 1:
            failures.append(f"session {pseudo}/{session_id} has {len(marked)} events with entrances=1")
    for row in rows:
        if row["event_name"] != "page_view" and _param(row, "entrances") == 1:
            failures.append(f"entrances=1 on {row['event_name']}, expected page_view")
    return failures[:20]


def check_funnel_nesting(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """A funnel step implies every earlier step happened in the same session.

    Sessions straddling midnight are skipped, because their earlier steps
    legitimately live in the previous shard. So is a server-side purchase that
    carries a session id: it is a session of one event by design. Denied rows
    cannot be grouped into sessions and are skipped as well.
    """
    failures = []
    for (pseudo, session_id), events in _sessions(rows).items():
        if not _opens_in_shard(events):
            continue  # opened in a previous shard, or a lone server-side purchase
        present = {row["event_name"] for row in events}
        for funnel in (FUNNEL, LEAD_FUNNEL):
            for position, step in enumerate(funnel):
                if step not in present:
                    continue
                missing = [earlier for earlier in funnel[:position] if earlier not in present]
                if missing:
                    failures.append(
                        f"session {pseudo}/{session_id} has {step} without {', '.join(missing)}"
                    )
    return failures[:20]


def check_purchased_items_were_viewed(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """You cannot buy a product you never looked at.

    Skips the same sessions as check_funnel_nesting, for the same reasons.
    """
    failures = []
    for (pseudo, session_id), events in _sessions(rows).items():
        if not _opens_in_shard(events):
            continue
        viewed = {
            item["item_id"]
            for row in events if row["event_name"] == "view_item"
            for item in row["items"]
        }
        for row in events:
            if row["event_name"] != "purchase":
                continue
            for item in row["items"]:
                if item["item_id"] not in viewed:
                    failures.append(
                        f"session {pseudo}/{session_id} purchased {item['item_id']} "
                        "which was never in a view_item"
                    )
    return failures[:20]


def check_revenue_reconciles(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """purchase_revenue must equal item revenue: GA4 recommends leaving out tax and shipping."""
    failures = []
    for row in rows:
        if row["event_name"] != "purchase":
            continue
        ecommerce = row["ecommerce"]
        items_total = round(sum(item["item_revenue"] for item in row["items"]), 2)
        actual = round(ecommerce["purchase_revenue"], 2)
        if abs(items_total - actual) > 0.011:
            failures.append(
                f"transaction {ecommerce['transaction_id']}: purchase_revenue {actual} "
                f"!= item revenue {items_total}"
            )
        quantity = sum(item["quantity"] for item in row["items"])
        if ecommerce["total_item_quantity"] != quantity:
            failures.append(
                f"transaction {ecommerce['transaction_id']}: total_item_quantity "
                f"{ecommerce['total_item_quantity']} != summed quantity {quantity}"
            )
    return failures[:20]


def check_transaction_ids_unique(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """One purchase event per transaction_id within a shard."""
    seen: dict[str, int] = defaultdict(int)
    for row in rows:
        if row["event_name"] == "purchase":
            seen[row["ecommerce"]["transaction_id"]] += 1
    return [f"transaction_id {txn} appears {count} times" for txn, count in seen.items() if count > 1][:20]


def check_null_policy(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """Fields a web-only export never populates must stay NULL.

    Guards against the failure mode where filling in more of the schema is
    mistaken for higher fidelity.
    """
    failures = []
    always_null = [
        ("event_previous_timestamp", lambda r: r["event_previous_timestamp"]),
        ("event_original_occurrence_timestamp", lambda r: r["event_original_occurrence_timestamp"]),
        ("app_info.id", lambda r: r["app_info"]["id"]),
        ("device.advertising_id", lambda r: r["device"]["advertising_id"]),
        ("device.vendor_id", lambda r: r["device"]["vendor_id"]),
        ("publisher.ad_revenue_in_usd", lambda r: r["publisher"]["ad_revenue_in_usd"]),
        ("event_dimensions.hostname", lambda r: r["event_dimensions"]["hostname"]),
        ("ecommerce.refund_value", lambda r: r["ecommerce"]["refund_value"]),
    ]
    for name, getter in always_null:
        offenders = sum(1 for row in rows if getter(row) is not None)
        if offenders:
            failures.append(f"{name} populated on {offenders} rows, expected always NULL")

    # float_value is in the schema but GA4 never writes to it.
    float_used = sum(
        1 for row in rows for entry in row["event_params"]
        if entry["value"]["float_value"] is not None
    )
    if float_used:
        failures.append(f"event_params.value.float_value populated on {float_used} entries, expected never")

    # user_properties must match what the config declares: none for a vanilla
    # export, and otherwise every declared key on every row. Checking both
    # directions catches a property that silently stops being emitted.
    declared = set((world.section("tracking").get("user_properties") or {}))
    mismatched = 0
    for row in rows:
        if {entry["key"] for entry in row["user_properties"]} - declared:
            mismatched += 1
    if mismatched:
        failures.append(
            f"user_properties contain undeclared keys on {mismatched} rows; "
            f"config declares {sorted(declared) or 'none'}"
        )
    if not declared:
        with_props = sum(1 for row in rows if row["user_properties"])
        if with_props:
            failures.append(
                f"user_properties non-empty on {with_props} rows but the config declares none"
            )
    return failures


def check_session_engaged_slot(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """session_engaged is int_value on session_start and string_value elsewhere.

    A real export quirk, verified against live data. Reproduced deliberately.
    Denied rows are browser rows and are held to the same rule.
    """
    failures = []
    for row in rows:
        if _is_server_side(row) or (_is_sessionless(row) and not _is_denied(row)):
            continue  # sent outside a browser session; check_server_side_events covers it
        entry = next((e for e in row["event_params"] if e["key"] == "session_engaged"), None)
        if entry is None:
            failures.append(f"{row['event_name']} is missing session_engaged")
            continue
        value = entry["value"]
        if row["event_name"] == "session_start":
            if value["int_value"] is None or value["string_value"] is not None:
                failures.append("session_start must carry session_engaged as int_value")
        elif value["string_value"] is None or value["int_value"] is not None:
            failures.append(f"{row['event_name']} must carry session_engaged as string_value")
    return failures[:20]


def check_single_value_slot(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """Exactly one of the four value slots is populated per parameter."""
    failures = []
    for row in rows:
        for entry in row["event_params"]:
            populated = [k for k, v in entry["value"].items() if v is not None]
            if len(populated) != 1:
                failures.append(
                    f"{row['event_name']} param {entry['key']} populates {populated}, expected exactly one"
                )
    return failures[:20]


def check_consent_denied_rows(world: World, day: dt.date, rows: list[Row]) -> list[str]:
    """A row collected without analytics storage carries no identifier.

    Measured on a real export that uses consent mode: every row with
    analytics_storage "No" has a NULL user_pseudo_id, no ga_session_id, and an
    entirely NULL session_traffic_source_last_click, while ga_session_number
    is always present. A NULL user_id is this generator's assumption, since
    that export has no user_id at all. One leaked identifier is enough to
    re-link a visitor who asked not to be tracked, so each is checked.

    The reverse holds too: a NULL user_pseudo_id appears on denied rows only.
    Denied visitors are never reported from the server, so a denied row is
    always a browser row, and a visitor who denies analytics storage also
    denies ads storage.
    """
    failures = []
    for row in rows:
        label = f"{row['event_name']} at {row['event_timestamp']}"
        if not _is_denied(row):
            if row["user_pseudo_id"] is None:
                failures.append(f"{label}: user_pseudo_id is NULL although analytics storage is granted")
            continue
        for column in ("user_pseudo_id", "user_id"):
            if row[column] is not None:
                failures.append(f"{label}: consent-denied row carries {column}")
        if not _is_sessionless(row):
            failures.append(f"{label}: consent-denied row carries ga_session_id")
        if _param(row, "ga_session_number") is None:
            failures.append(f"{label}: consent-denied row is missing ga_session_number")
        populated = sorted(
            f"{branch}.{field}"
            for branch, fields in row["session_traffic_source_last_click"].items()
            for field, value in (fields or {}).items()
            if value is not None
        )
        if populated:
            failures.append(f"{label}: consent-denied row has a last click: {populated}")
        if row["privacy_info"]["ads_storage"] != "No":
            failures.append(f"{label}: analytics storage denied but ads storage granted")
        if _is_server_side(row):
            failures.append(f"{label}: consent-denied row was sent from the server")
    return failures[:20]


ALL_CHECKS: list[Check] = [
    check_shard_matches_event_date,
    check_identifier_stability,
    check_user_id_stability,
    check_server_side_events,
    check_consent_denied_rows,
    check_timestamp_monotonicity,
    check_first_batch_composition,
    check_session_lifecycle,
    check_entrances,
    check_funnel_nesting,
    check_purchased_items_were_viewed,
    check_revenue_reconciles,
    check_transaction_ids_unique,
    check_null_policy,
    check_session_engaged_slot,
    check_single_value_slot,
]


def run_all(world: World, day: dt.date, rows: list[Row]) -> dict[str, list[str]]:
    """Run every check and return a mapping of check name to failures."""
    return {check.__name__: check(world, day, rows) for check in ALL_CHECKS}
