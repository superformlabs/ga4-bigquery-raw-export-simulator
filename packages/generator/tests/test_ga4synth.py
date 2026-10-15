"""Tests for the generator.

Two things are being defended here. First, that the invariant suite actually
fails when an invariant is broken; a green suite that cannot go red is worse
than no suite. Second, that rare-but-real situations (a session crossing
midnight) are exercised deliberately rather than left to whether a given day
happens to contain one.
"""

from __future__ import annotations

import collections
import copy
import datetime as dt
import json
from zoneinfo import ZoneInfo

import pytest

from ga4synth.generate import rows_for_shard, sorted_rows_for_shard
from ga4synth.invariants import ALL_CHECKS, _param, run_all
from ga4synth.params import pack, pack_session_engaged
from ga4synth.schema import validate_rows
from ga4synth.serialize import serialize_session
from ga4synth.simulate import (
    _materialise,
    _person_root,
    _transaction_id,
    build_session,
    offline_orders_on,
    sessions_for_visit_date,
    visits_on,
)
from ga4synth.world import load_world

DAY = dt.date(2026, 8, 25)


@pytest.fixture(scope="module")
def world():
    return load_world()


@pytest.fixture(scope="module")
def rows(world):
    return sorted_rows_for_shard(world, DAY)


# ---------------------------------------------------------------------------
# Value packing
# ---------------------------------------------------------------------------


def test_whole_numbers_go_to_int_value():
    assert pack("value", 100)["value"]["int_value"] == 100
    # An integral float is coerced to int_value, matching GA4.
    assert pack("value", 100.0)["value"]["int_value"] == 100
    assert pack("value", 100.0)["value"]["double_value"] is None


def test_fractional_numbers_go_to_double_value():
    packed = pack("value", 99.95)["value"]
    assert packed["double_value"] == 99.95
    assert packed["int_value"] is None


def test_float_value_slot_is_never_used():
    for value in (1, 1.5, "x", True):
        packed = pack("k", value)
        assert packed is None or packed["value"]["float_value"] is None


def test_ga4_omit_when_false_keys_disappear_rather_than_writing_false():
    """Only GA4's own omit-when-false keys vanish; see pack() for why."""
    assert pack("ignore_referrer", False) is None
    assert pack("ignore_referrer", True)["value"]["string_value"] == "true"


def test_session_engaged_changes_slot_on_session_start():
    on_start = pack_session_engaged(True, "session_start")["value"]
    elsewhere = pack_session_engaged(True, "page_view")["value"]
    assert on_start["int_value"] == 1 and on_start["string_value"] is None
    assert elsewhere["string_value"] == "1" and elsewhere["int_value"] is None


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_shard_is_reproducible(world):
    assert sorted_rows_for_shard(world, DAY) == sorted_rows_for_shard(world, DAY)


def test_generating_a_shard_does_not_depend_on_other_shards(world):
    """A shard generated in isolation matches one generated after its neighbours."""
    isolated = sorted_rows_for_shard(world, DAY)
    sorted_rows_for_shard(world, DAY - dt.timedelta(days=3))
    sorted_rows_for_shard(world, DAY + dt.timedelta(days=1))
    assert sorted_rows_for_shard(world, DAY) == isolated


def test_returning_visitors_keep_their_identity_across_days(world):
    """The same person visiting twice must carry one user_pseudo_id."""
    returning = [
        (visitor, number)
        for visitor, number, _ in visits_on(world, DAY)
        # A new visitor's extra session is also numbered 2, so go by the cohort.
        if visitor.cohort < DAY
    ]
    assert returning, "no returning visitors on the test day; retention config may be broken"
    visitor, number = returning[0]
    # Their cohort day is in the past and their session number reflects history.
    assert visitor.cohort < DAY
    assert number >= 2
    # Regenerating their cohort day yields the identical pseudo id.
    same = [v for v, _, _ in visits_on(world, visitor.cohort) if v.index == visitor.index]
    assert same and same[0].user_pseudo_id == visitor.user_pseudo_id


# ---------------------------------------------------------------------------
# Invariants on real output
# ---------------------------------------------------------------------------


def test_all_invariants_pass_on_a_generated_shard(world, rows):
    results = run_all(world, DAY, rows)
    failures = {name: fails for name, fails in results.items() if fails}
    assert not failures, failures


def test_shard_is_not_empty(rows):
    assert len(rows) > 1000


@pytest.mark.parametrize(
    "mutation,expected_check",
    [
        (
            lambda row: row.update({"event_date": "20260101"}),
            "check_shard_matches_event_date",
        ),
        (
            lambda row: row.update({"event_previous_timestamp": 1}),
            "check_null_policy",
        ),
        (
            lambda row: row.update({"user_first_touch_timestamp": 999}),
            "check_identifier_stability",
        ),
        (
            lambda row: row.update({"user_id": "u000000000"}),
            "check_user_id_stability",
        ),
        (
            # A web event that loses its session id is not a server-side purchase.
            lambda row: row.update({"event_params": [
                e for e in row["event_params"] if e["key"] != "ga_session_id"
            ]}),
            "check_server_side_events",
        ),
        (
            # A consented row that loses its user_pseudo_id is not a denied row.
            lambda row: row.update({"user_pseudo_id": None}),
            "check_consent_denied_rows",
        ),
        (
            lambda row: row["event_params"].append(
                {"key": "x", "value": {"string_value": None, "int_value": None,
                                       "float_value": 1.5, "double_value": None}}
            ),
            "check_null_policy",
        ),
        (
            lambda row: row["event_params"].append(
                {"key": "y", "value": {"string_value": "a", "int_value": 1,
                                       "float_value": None, "double_value": None}}
            ),
            "check_single_value_slot",
        ),
    ],
)
def test_invariants_fail_when_broken(world, rows, mutation, expected_check):
    """Each check must actually fire. A check that cannot go red is not a check."""
    broken = copy.deepcopy(rows)
    # An ordinary browser row of a consenting visitor. Denied rows and
    # server-side rows are exempt from some of these checks by design.
    mutation(next(
        row for row in broken[5:]
        if row["user_pseudo_id"] is not None and row["batch_ordering_id"] is not None
    ))
    results = run_all(world, DAY, broken)
    assert results[expected_check], f"{expected_check} stayed green on broken data"


def _denied_row(rows: list[dict]) -> dict:
    return next(row for row in rows if row["privacy_info"]["analytics_storage"] == "No")


@pytest.mark.parametrize(
    "mutation",
    [
        lambda row: row.update({"user_pseudo_id": "1234567890.1780000000"}),
        lambda row: row.update({"user_id": "u000000000000"}),
        lambda row: row["event_params"].append(pack("ga_session_id", 1780000000)),
        lambda row: row.update({"event_params": [
            e for e in row["event_params"] if e["key"] != "ga_session_number"
        ]}),
        lambda row: row["session_traffic_source_last_click"]["cross_channel_campaign"].update(
            {"source": "google"}
        ),
        lambda row: row["session_traffic_source_last_click"]["manual_campaign"].update(
            {"campaign_name": "spring"}
        ),
        lambda row: row["privacy_info"].update({"ads_storage": "Yes"}),
    ],
)
def test_consent_denied_check_fails_on_any_leaked_identifier(world, rows, mutation):
    """One identifier is enough to re-link a visitor who refused, so each must fire."""
    broken = copy.deepcopy(rows)
    mutation(_denied_row(broken))
    results = run_all(world, DAY, broken)
    assert results["check_consent_denied_rows"]


def test_first_batch_rule_reaches_denied_rows(world, rows):
    """Denied rows have no session to group by, but batch 1 is visible on the row."""
    broken = copy.deepcopy(rows)
    target = next(
        row for row in broken
        if row["privacy_info"]["analytics_storage"] == "No" and row["event_name"] == "scroll"
    )
    target["batch_ordering_id"] = 1
    assert run_all(world, DAY, broken)["check_first_batch_composition"]


def test_first_batch_rule_fails_a_batch_without_a_page_load(world, rows):
    """A batch 1 holding only forbidden events must not pass for lack of a page load."""
    target = next(
        row for row in rows
        if row["user_pseudo_id"] and row["event_name"] == "scroll" and row["batch_ordering_id"] > 1
    )
    key = (target["user_pseudo_id"], _param(target, "ga_session_id"))
    broken = [
        copy.deepcopy(row) for row in rows
        if not (
            (row["user_pseudo_id"], _param(row, "ga_session_id")) == key
            and row["batch_ordering_id"] == 1
        )
    ]
    moved = next(
        row for row in broken
        if (row["user_pseudo_id"], _param(row, "ga_session_id")) == key and row["event_name"] == "scroll"
    )
    moved["batch_ordering_id"] = 1
    assert run_all(world, DAY, broken)["check_first_batch_composition"]



def test_timestamp_monotonicity_check_can_fail(world, rows):
    """Regression test: this check was once written so that it could never fail."""
    broken = copy.deepcopy(rows)
    # Find a session with several events and invert two of its timestamps.
    target = next(events for events in _by_session(broken).values() if len(events) >= 3)
    target.sort(key=lambda r: (r["batch_ordering_id"], r["batch_event_index"]))
    target[-1]["event_timestamp"] = target[0]["event_timestamp"] - 5_000_000

    results = run_all(world, DAY, broken)
    assert results["check_timestamp_monotonicity"]


def _by_session(rows: list[dict]) -> dict[tuple, list[dict]]:
    """Rows by session. Denied rows name no session, so they are in none."""
    by_session: dict[tuple, list[dict]] = {}
    for row in rows:
        session_id = _param(row, "ga_session_id")
        if session_id is not None and row["user_pseudo_id"] is not None:
            by_session.setdefault((row["user_pseudo_id"], session_id), []).append(row)
    return by_session


def test_first_batch_holds_only_page_load_events(rows):
    """Nothing but the page-load events may sit in batch 1 or tie with session_start.

    GA4Dataform falls back to page_referrer on the first batch. An event there
    that collected no campaign resolved whole sessions to a referral source.
    """
    page_load = {"first_visit", "session_start", "page_view"}
    others_seen = False
    for events in _by_session(rows).values():
        starts = [r for r in events if r["event_name"] == "session_start"]
        if not starts:
            continue
        for row in events:
            if row["event_name"] in page_load:
                continue
            others_seen = True
            assert row["batch_ordering_id"] > 1
            assert row["event_timestamp"] > starts[0]["event_timestamp"]
    assert others_seen


def test_batch_positions_are_contiguous(rows):
    """Within a session, batches count 1, 2, 3 and each batch indexes from 0."""
    checked = 0
    for events in _by_session(rows).values():
        if not any(r["event_name"] == "session_start" for r in events):
            continue
        batches: dict[int, list[int]] = {}
        for row in events:
            batches.setdefault(row["batch_ordering_id"], []).append(row["batch_event_index"])
        assert sorted(batches) == list(range(1, len(batches) + 1))
        for indexes in batches.values():
            assert sorted(indexes) == list(range(len(indexes)))
        checked += 1
    assert checked


def test_first_batch_composition_check_can_fail(world, rows):
    broken = copy.deepcopy(rows)
    target = next(
        row for row in broken
        if row["event_name"] not in ("first_visit", "session_start", "page_view")
        and _param(row, "ga_session_id") is not None
        and any(
            other["event_name"] == "session_start"
            and other["user_pseudo_id"] == row["user_pseudo_id"]
            and _param(other, "ga_session_id") == _param(row, "ga_session_id")
            for other in broken
        )
    )
    target["batch_ordering_id"] = 1

    results = run_all(world, DAY, broken)
    assert results["check_first_batch_composition"]


def test_every_check_is_exercised_by_the_suite():
    """Guards against a check being added and silently never run."""
    assert len(ALL_CHECKS) == 16


# ---------------------------------------------------------------------------
# Midnight crossing
# ---------------------------------------------------------------------------


def test_late_session_splits_across_two_shards(world):
    """A session starting just before midnight must land in both shards.

    Real days contain very few of these, so rather than hope one appears, a
    session is forced to start at 23:58 local and its rows are checked to
    straddle the boundary. This is the code path that places a row in the shard
    matching the property's reporting timezone rather than UTC.
    """
    visitor, number, prior = next(iter(visits_on(world, DAY)))
    session = build_session(world, visitor, number, DAY, prior_sessions=prior)

    # Re-anchor the whole session to 23:58:30 local time, preserving gaps.
    tz = ZoneInfo(world.timezone)
    target = dt.datetime(DAY.year, DAY.month, DAY.day, 23, 58, 30, tzinfo=tz)
    shift = target - session.actions[0].when
    for action in session.actions:
        action.when = action.when + shift
    # Ensure the session is long enough to actually cross.
    session.actions[-1].when = target + dt.timedelta(minutes=5)

    dates = {row["event_date"] for row in serialize_session(world, session)}
    assert dates == {DAY.strftime("%Y%m%d"), (DAY + dt.timedelta(days=1)).strftime("%Y%m%d")}, (
        f"expected the session to straddle midnight, got {dates}"
    )


def test_shard_only_contains_its_own_date(world, rows):
    assert {row["event_date"] for row in rows} == {DAY.strftime("%Y%m%d")}


def test_shard_lookback_includes_previous_day_sessions(world):
    """rows_for_shard must consider sessions that started the day before."""
    # Every row in the shard whose session opened on the previous day has no
    # session_start in this shard. The mechanism is exercised even when no such
    # session exists on a given day, so assert the lookback range instead.
    previous = DAY - dt.timedelta(days=1)
    assert any(True for _ in sessions_for_visit_date(world, previous))
    # And confirm no row from the previous day's sessions leaks in with the
    # wrong date.
    for row in rows_for_shard(world, DAY):
        assert row["event_date"] == DAY.strftime("%Y%m%d")


# ---------------------------------------------------------------------------
# Funnel completeness
# ---------------------------------------------------------------------------


def test_full_ecommerce_funnel_is_present(rows):
    names = {row["event_name"] for row in rows}
    expected = {
        "first_visit", "session_start", "page_view", "user_engagement", "scroll",
        "view_search_results", "view_item_list", "select_item", "view_item",
        "add_to_cart", "view_cart", "begin_checkout", "add_shipping_info",
        "add_payment_info", "purchase",
    }
    missing = expected - names
    assert not missing, f"missing standard events: {sorted(missing)}"


def test_session_shape_stays_realistic(rows):
    """Most real sessions are short, and the shipped journey must keep it so.

    Session length and conversion are emergent, so nothing else stops a change
    to the journey weights from drifting back to long sessions, or from
    shortening them so far that the purchases disappear. The bands are wide on
    purpose: they guard the shape, not the exact figures in the documentation.
    """
    sessions = list(_by_session(rows).values())
    events = sorted(len(s) for s in sessions)
    page_views = [sum(r["event_name"] == "page_view" for r in s) for s in sessions]
    converting = sum(any(r["event_name"] == "purchase" for r in s) for s in sessions)

    median = events[len(events) // 2]
    p90 = events[int(len(events) * 0.9)]
    single_page = sum(v == 1 for v in page_views) / len(sessions)
    multi_page = sum(v > 1 for v in page_views) / len(sessions)
    conversion_rate = converting / len(sessions)

    assert 3 <= median <= 6, median
    assert p90 <= 14, p90
    assert 0.35 <= single_page <= 0.65, single_page
    assert multi_page >= 0.30, multi_page
    assert 0.025 <= conversion_rate <= 0.055, conversion_rate


def test_no_custom_parameters_in_a_vanilla_export(rows):
    """A vanilla export contains only GA4's own parameters."""
    standard = {
        "ga_session_id", "ga_session_number", "session_engaged",
        "engaged_session_event", "engagement_time_msec", "entrances",
        "page_location", "page_title", "page_referrer", "ignore_referrer",
        "batch_page_id", "batch_ordering_id", "percent_scrolled", "search_term",
        "unique_search_term", "link_url", "link_domain", "outbound", "currency",
        "value", "transaction_id", "tax", "shipping", "coupon", "shipping_tier",
        "payment_type", "item_list_id", "item_list_name", "source", "medium",
        "campaign", "term", "content", "gclid",
    }
    seen = {entry["key"] for row in rows for entry in row["event_params"]}
    assert not seen - standard, f"non-standard parameters present: {sorted(seen - standard)}"


def test_purchase_revenue_is_positive(rows):
    purchases = [row for row in rows if row["event_name"] == "purchase"]
    assert purchases
    for row in purchases:
        assert row["ecommerce"]["purchase_revenue"] > 0
        assert row["items"]


# ---------------------------------------------------------------------------
# Configurable tracking: the reuse surface
# ---------------------------------------------------------------------------


import pathlib  # noqa: E402
import tempfile  # noqa: E402

import yaml  # noqa: E402

from conftest import BASE_MIXER_FILE, BASE_PROPERTY_FILE  # noqa: E402
from ga4synth.values import ValueSpecError, resolve, validate_spec  # noqa: E402


def _write_config(prop, mixer):
    """Write a property/mixer pair to a temp directory and return their paths."""
    directory = pathlib.Path(tempfile.mkdtemp())
    yaml.safe_dump(prop, open(directory / "property.yaml", "w"), sort_keys=False)
    yaml.safe_dump(mixer, open(directory / "mixer.yaml", "w"), sort_keys=False)
    return directory / "property.yaml", directory / "mixer.yaml"


def _base_config():
    return (
        yaml.safe_load(open(BASE_PROPERTY_FILE)),
        yaml.safe_load(open(BASE_MIXER_FILE)),
    )


def _config_with(**tracking):
    """Load a config with the given tracking overrides applied."""
    prop, mixer = _base_config()
    prop["tracking"].update(tracking)
    return load_world(*_write_config(prop, mixer))


def test_custom_events_and_params_appear_in_the_output():
    custom = _config_with(
        global_params={"site_section": {"template": "{page_type}"}},
        params_by_event={"purchase": {"delivery_method": {"choice": ["standard"]}}},
        custom_events=[
            {"name": "wishlist_add", "on_page": ["pdp"], "rate": 1.0,
             "params": {"wishlist_size": {"int_range": [1, 20]}}}
        ],
    )
    rows = sorted_rows_for_shard(custom, DAY)

    wishlist = [r for r in rows if r["event_name"] == "wishlist_add"]
    assert wishlist, "custom event never fired at rate 1.0"
    keys = {e["key"] for e in wishlist[0]["event_params"]}
    assert "wishlist_size" in keys
    assert "site_section" in keys, "global params must reach custom events too"

    purchases = [r for r in rows if r["event_name"] == "purchase"]
    assert purchases and any(
        e["key"] == "delivery_method" for e in purchases[0]["event_params"]
    )


def test_user_properties_are_stable_per_visitor():
    custom = _config_with(user_properties={"tier": {"choice": {"new": 70, "vip": 30}}})
    rows = sorted_rows_for_shard(custom, DAY)
    seen: dict[str, str] = {}
    for row in rows:
        entry = next(p for p in row["user_properties"] if p["key"] == "tier")
        value = entry["value"]["string_value"]
        assert entry["value"]["set_timestamp_micros"] == row["user_first_touch_timestamp"]
        if row["user_pseudo_id"] is None:
            continue  # a denied row names no visitor to compare with
        if row["user_pseudo_id"] in seen:
            assert seen[row["user_pseudo_id"]] == value, "user property changed mid-visitor"
        seen[row["user_pseudo_id"]] = value
    assert len(seen) > 100


def test_disabling_an_event_removes_it():
    """tracking.events is the single toggle surface, enhanced measurement included."""
    off = _config_with(events={"scroll": False, "click": False,
                               "view_search_results": True})
    names = {row["event_name"] for row in sorted_rows_for_shard(off, DAY)}
    assert "scroll" not in names and "click" not in names
    assert "page_view" in names and "view_search_results" in names


def test_configured_output_still_passes_every_invariant(world):
    custom = _config_with(
        global_params={"site_section": {"template": "{page_type}"}},
        user_properties={"tier": {"choice": ["new", "vip"]}},
        custom_events=[{"name": "wishlist_add", "on_page": ["pdp"], "rate": 0.5}],
    )
    rows = sorted_rows_for_shard(custom, DAY)
    assert not validate_rows(rows)
    failures = {k: v for k, v in run_all(custom, DAY, rows).items() if v}
    assert not failures, failures


def test_page_templates_drive_urls():
    prop, mixer = _base_config()
    prop["property"]["hostname"] = "shop.example"
    prop["pages"]["pdp"] = {"path": "/titles/{item_id}/{item_slug}", "title": "{item_name}"}
    rows = sorted_rows_for_shard(load_world(*_write_config(prop, mixer)), DAY)
    pdp = next(r for r in rows if r["event_name"] == "view_item")
    location = next(e["value"]["string_value"] for e in pdp["event_params"]
                    if e["key"] == "page_location")
    assert location.startswith("https://shop.example/titles/")


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tracking,fragment",
    [
        ({"global_params": {"page_location": "x"}}, "cannot be overridden"),
        ({"custom_events": [{"name": "purchase", "on_page": ["home"], "rate": 0.1}]},
         "standard GA4 event"),
        ({"custom_events": [{"name": "x", "on_page": ["nope"], "rate": 0.1}]},
         "unknown page types"),
        ({"custom_events": [{"name": "x", "on_page": ["home"], "rate": 5}]},
         "probability"),
        ({"global_params": {"a": {"template": "{no_such_field}"}}}, "unknown field"),
        ({"global_params": {"a": {"choice": [], }}}, "empty"),
        ({"global_params": {"a": {"int_range": [10, 1]}}}, "exceeds high bound"),
        ({"global_params": {"a": {"choice": ["x"], "int_range": [1, 2]}}}, "exactly one"),
    ],
)
def test_bad_config_is_rejected_with_a_useful_message(tracking, fragment):
    with pytest.raises(ValueError) as error:
        _config_with(**tracking)
    assert fragment in str(error.value), str(error.value)


def test_custom_false_boolean_is_kept_but_ga4_omit_keys_are_dropped():
    """A configured `logged_in: false` is data; ignore_referrer=false is absence."""
    assert pack("logged_in", False)["value"]["string_value"] == "false"
    assert pack("ignore_referrer", False) is None


def test_value_spec_forms_resolve():
    import random
    rng = random.Random(0)
    assert resolve({"choice": ["a"]}, rng, {}) == "a"
    assert 1 <= resolve({"int_range": [1, 5]}, rng, {}) <= 5
    assert resolve({"template": "{page_type}"}, rng, {"page_type": "pdp"}) == "pdp"
    assert resolve({"choice": ["a"], "present": 0.0}, rng, {}) is None
    validate_spec({"float_range": [0, 1], "round": 2}, "x")
    with pytest.raises(ValueSpecError):
        validate_spec({"round": 2}, "x")


# ---------------------------------------------------------------------------
# Regressions found by reviewing the first published dataset
# ---------------------------------------------------------------------------


def test_is_active_user_is_not_constantly_true(rows):
    """GA4 marks a user active for an engaged session, not for every session.

    The original expression also accepted any session with more than one
    action. Every session emits at least session_start and page_view, so the
    column was True on all 1.3M rows of the published dataset and carried no
    information.
    """
    values = {row["is_active_user"] for row in rows}
    assert values == {True, False}, "is_active_user must vary across a shard"

    # It must agree with session_engaged on every row, since both derive from
    # the same rule.
    for row in rows:
        engaged = str(_param(row, "session_engaged")) == "1"
        assert bool(row["is_active_user"]) is engaged, (
            f"is_active_user {row['is_active_user']} disagrees with "
            f"session_engaged {engaged} on {row['event_name']}"
        )


def test_transaction_ids_are_wide_enough_to_avoid_collisions(rows):
    """An 8-digit id space collided twice in the first 6k transactions."""
    ids = [
        row["ecommerce"]["transaction_id"]
        for row in rows
        if row["event_name"] == "purchase"
    ]
    assert ids, "no purchases in the shard; funnel config may be broken"
    for txn in ids:
        digits = txn.split("-")[1]
        assert len(digits) >= 12, f"transaction_id {txn} leaves too little entropy"


def test_transaction_ids_do_not_repeat_across_days(world):
    """The per-shard invariant cannot see this, so check it across a range."""
    seen: dict[str, dt.date] = {}
    for offset in range(6):
        day = DAY + dt.timedelta(days=offset)
        for row in rows_for_shard(world, day):
            if row["event_name"] != "purchase":
                continue
            txn = row["ecommerce"]["transaction_id"]
            assert txn not in seen, f"transaction_id {txn} reused on {seen.get(txn)} and {day}"
            seen[txn] = day
    assert len(seen) > 100, "too few transactions to be a meaningful check"


def test_user_ltv_accumulates_across_sessions(world):
    """user_ltv.revenue is lifetime value, so it must span a visitor's sessions.

    It previously reset to zero at every session boundary, so a repeat buyer's
    LTV only ever showed their most recent order.
    """
    # Find a visitor with enough history to have bought in an earlier session.
    target = None
    for offset in range(6):
        day = DAY + dt.timedelta(days=offset)
        for visitor, number, prior in visits_on(world, day):
            if not prior:
                continue
            # Every session so far, as (visit date, ordinal within that day).
            history = list(prior) + [(day, sum(1 for d, _ in prior if d == day))]
            running = 0.0
            opens = []
            for n, (d, _) in enumerate(history, start=1):
                session = build_session(
                    world, visitor, n, d, prior_sessions=tuple(history[: n - 1])
                )
                shard_rows = list(serialize_session(world, session))
                if not shard_rows:
                    continue
                opens.append((shard_rows[0]["user_ltv"]["revenue"], running))
                running += sum(
                    r["ecommerce"]["purchase_revenue"]
                    for r in shard_rows
                    if r["event_name"] == "purchase"
                )
            if running > 0 and any(opening > 0 for opening, _ in opens):
                target = (visitor, opens)
                break
        if target:
            break

    assert target, "no returning visitor bought in an earlier session; widen the search"
    _, opens = target
    for opening, expected in opens:
        assert opening == pytest.approx(expected, abs=0.01), (
            f"session opened at LTV {opening}, expected {expected}"
        )


# ---------------------------------------------------------------------------
# The property / mixer split
# ---------------------------------------------------------------------------


def _expect_config_error(prop, mixer, fragment):
    with pytest.raises(ValueError) as caught:
        load_world(*_write_config(prop, mixer))
    assert fragment in str(caught.value), str(caught.value)


def test_top_level_keys_must_be_disjoint():
    """Neither file may silently win a key the other also defines."""
    prop, mixer = _base_config()
    mixer["property"] = {"hostname": "sneaky.example"}
    _expect_config_error(prop, mixer, "Top-level keys must be disjoint")


@pytest.mark.parametrize(
    "mutate,fragment",
    [
        (lambda p, m: m["channel_mix"].update({"tiktok": 9}),
         "weighted in mixer.yaml `channel_mix` but not defined"),
        (lambda p, m: m["geo_mix"].pop("fr_paris"),
         "defined in property.yaml `geos` but missing from mixer.yaml `geo_mix`"),
        (lambda p, m: m["device_mix"].pop("tablet"),
         "defined in property.yaml `devices` but missing from mixer.yaml `device_mix`"),
    ],
)
def test_identity_and_mix_keys_must_match(mutate, fragment):
    """A name in one file and not the other is always a mistake, so it is refused."""
    prop, mixer = _base_config()
    mutate(prop, mixer)
    _expect_config_error(prop, mixer, fragment)


def test_funnel_toggles_must_not_leave_a_hole():
    """check_funnel_nesting would reject the data, so the config is rejected first."""
    prop, mixer = _base_config()
    prop["tracking"]["events"]["view_cart"] = False
    _expect_config_error(prop, mixer, "unbroken run from the front")


def test_funnel_can_be_trimmed_from_the_end():
    """Disabling a suffix is legitimate: the site simply has no checkout."""
    off = _config_with(events={"begin_checkout": False, "purchase": False})
    rows = sorted_rows_for_shard(off, DAY)
    names = collections.Counter(row["event_name"] for row in rows)
    assert names["purchase"] == 0 and names["begin_checkout"] == 0
    assert names["view_cart"] > 0 and names["add_to_cart"] > 0
    failures = {k: v for k, v in run_all(off, DAY, rows).items() if v}
    assert not failures, failures


def test_always_on_events_cannot_be_disabled():
    prop, mixer = _base_config()
    prop["tracking"]["events"]["session_start"] = False
    _expect_config_error(prop, mixer, "GA4 always collects this event")


def test_dwell_seconds_is_read_from_the_mixer():
    """Timing is a dial, not a constant. Widening it must lengthen sessions."""
    prop, mixer = _base_config()
    for name in mixer["dwell_seconds"]:
        mixer["dwell_seconds"][name] = [600, 900]
    # Sessions this long could run into a same-day extra session, and the
    # config is refused for it, so the slow world has one session per day.
    _expect_config_error(prop, mixer, "session.extra_sessions.gap_minutes")
    mixer["session"]["extra_sessions"] = {"weights": {0: 1}}
    slow = load_world(*_write_config(prop, mixer))
    rows = sorted_rows_for_shard(slow, DAY)

    def span(rs):
        stamps = [[row["event_timestamp"] for row in events] for events in _by_session(rs).values()]
        return max((max(v) - min(v)) / 1e6 for v in stamps)

    baseline = sorted_rows_for_shard(load_world(*_write_config(*_base_config())), DAY)
    assert span(rows) > span(baseline) * 2


def test_non_ecommerce_property_emits_no_ecommerce_data():
    """ecommerce.enabled false makes this a content site, columns included."""
    prop, mixer = _base_config()
    prop["ecommerce"]["enabled"] = False
    removed = {"pdp", "cart", "checkout", "purchased"}
    for page in removed:
        prop["pages"].pop(page)
    # A custom event on a page a content site does not have goes with it.
    prop["tracking"]["custom_events"] = [
        event for event in prop["tracking"].get("custom_events") or []
        if not set(event["on_page"]) & removed
    ]
    mixer["journey"]["entry_weights"] = {"home": 40, "plp": 25, "search": 10, "blog": 25}
    mixer["journey"]["transitions"] = {
        "home": {"plp": 40, "blog": 25, "search": 10, "end": 25},
        "plp": {"blog": 45, "plp": 10, "home": 5, "search": 5, "end": 35},
        "search": {"blog": 40, "plp": 15, "search": 8, "end": 37},
        "blog": {"blog": 22, "home": 10, "plp": 8, "end": 60},
    }
    content = load_world(*_write_config(prop, mixer))
    rows = sorted_rows_for_shard(content, DAY)
    assert rows

    from ga4synth.world import ECOMMERCE_EVENTS
    names = {row["event_name"] for row in rows}
    assert not (names & ECOMMERCE_EVENTS), sorted(names & ECOMMERCE_EVENTS)

    # The columns a real non-ecommerce export leaves empty must be empty here.
    for row in rows:
        assert row["items"] == []
        assert all(value is None for value in row["ecommerce"].values())

    assert not validate_rows(rows)
    failures = {k: v for k, v in run_all(content, DAY, rows).items() if v}
    assert not failures, failures


def test_ecommerce_pages_are_refused_when_ecommerce_is_off():
    prop, mixer = _base_config()
    prop["ecommerce"]["enabled"] = False
    _expect_config_error(prop, mixer, "ecommerce.enabled is false but the journey walks")


# ---------------------------------------------------------------------------
# Identity: people, devices, and sign-in
# ---------------------------------------------------------------------------


def test_a_signed_in_person_reports_one_user_id_on_every_event(rows):
    """The column is all-or-nothing per device, which check_user_id_stability enforces."""
    by_device: dict[str, set] = {}
    for row in rows:
        by_device.setdefault(row["user_pseudo_id"], set()).add(row["user_id"])
    assert all(len(ids) == 1 for ids in by_device.values())


def test_some_visitors_are_signed_in_and_some_are_not(rows):
    """A dataset where everyone signs in exercises neither branch of the COALESCE."""
    ids = {row["user_id"] for row in rows}
    assert None in ids, "no anonymous visitors"
    assert len(ids - {None}) > 10, "too few signed-in visitors to be useful"


def test_one_person_appears_on_several_devices(world):
    """Cross-device behaviour must reach the export as one user_id over several pseudo ids.

    Checked on the visitor stream rather than a shard, because the two devices
    of a person are separate visitors whose sessions rarely fall on the same
    day. Only new visitors are materialised, which is what makes this cheap:
    a second device joins as one.
    """
    by_person: dict[str, set] = {}
    for age in range(21):
        cohort = DAY - dt.timedelta(days=age)
        for index in range(world.new_visitors_on(cohort)):
            visitor = _materialise(world, cohort, index)
            if visitor.authenticated:
                by_person.setdefault(visitor.person_id, set()).add(visitor.user_pseudo_id)

    shared = {person: ids for person, ids in by_person.items() if len(ids) > 1}
    assert shared, "no person was seen on more than one device"


def test_every_device_of_a_person_agrees_on_sign_in(world):
    """Authentication is decided on the person, so their devices cannot disagree."""
    status: dict[str, set] = {}
    for age in range(21):
        cohort = DAY - dt.timedelta(days=age)
        for index in range(world.new_visitors_on(cohort)):
            visitor = _materialise(world, cohort, index)
            status.setdefault(visitor.person_id, set()).add(visitor.authenticated)
    assert all(len(flags) == 1 for flags in status.values())


def test_person_ids_are_wide_enough_to_avoid_collisions(world):
    """A collision would merge two unrelated people behind one user_id."""
    roots: dict[str, tuple] = {}
    for age in range(30):
        cohort = DAY - dt.timedelta(days=age)
        for index in range(world.new_visitors_on(cohort)):
            visitor = _materialise(world, cohort, index)
            root = _person_root(world, cohort, index)
            clash = roots.setdefault(visitor.person_id, root)
            assert clash == root, (
                f"person_id {visitor.person_id} is shared by unrelated "
                f"identities {clash} and {root}"
            )
    assert len(roots) > 10_000, "too few people to say anything about collisions"


def test_a_second_device_is_never_itself_a_root(world):
    """Roots anchor themselves, so devices never chain into a trail."""
    for age in range(10):
        cohort = DAY - dt.timedelta(days=age)
        for index in range(world.new_visitors_on(cohort)):
            root = _person_root(world, cohort, index)
            if root != (cohort, index):
                assert _person_root(world, *root) == root


def test_cross_device_requires_sign_in():
    """Without a user_id a second device is invisible, so the pairing is refused."""
    prop, mixer = _base_config()
    mixer["identity"]["user_id_share"] = 0.0
    mixer["identity"]["cross_device_share"] = 0.2
    with pytest.raises(ValueError, match="user_id_share"):
        load_world(*_write_config(prop, mixer))


# ---------------------------------------------------------------------------
# Mid-session source change
# ---------------------------------------------------------------------------


def _collected_keys(events: list[dict]) -> set:
    # The gclid is part of the key because a gclid-only click collects nothing else.
    keys = {
        (
            row["collected_traffic_source"]["manual_source"],
            row["collected_traffic_source"]["manual_medium"],
            row["collected_traffic_source"]["manual_campaign_name"],
            row["collected_traffic_source"]["gclid"],
        )
        for row in events
    }
    return keys - {(None, None, None, None)}


def test_some_sessions_collect_a_second_campaign(rows):
    """source_change_rate must actually produce sessions with two acquisitions."""
    by_session = _by_session(rows)
    changed = [s for s in by_session.values() if len(_collected_keys(s)) > 1]
    assert changed, "no session collected a second campaign"


def test_last_click_follows_the_second_campaign(rows):
    """GA4 attributes a session to its last click, so a re-acquired session follows the new one."""
    by_session = _by_session(rows)

    for events in by_session.values():
        keys = _collected_keys(events)
        if len(keys) <= 1:
            continue
        events.sort(key=lambda r: (r["batch_ordering_id"], r["batch_event_index"]))
        last_collected = [
            row for row in events
            if row["collected_traffic_source"]["manual_source"] is not None
            or row["collected_traffic_source"]["gclid"] is not None
        ][-1]["collected_traffic_source"]
        # A gclid-only click names no source; GA4 resolves it to Google Ads.
        expected = (
            (last_collected["manual_source"], last_collected["manual_medium"])
            if last_collected["manual_source"] is not None else ("google", "cpc")
        )
        # Every event of the session reports the same last click, and it is the
        # campaign collected most recently.
        for row in events:
            cross = row["session_traffic_source_last_click"]["cross_channel_campaign"]
            assert (cross["source"], cross["medium"]) == expected
        return
    pytest.fail("no re-acquired session to check")


def test_a_re_acquired_page_view_arrives_from_the_new_campaign(world, rows):
    """The re-entry is a click from outside, so it carries that channel's referrer."""
    external = {
        source.get("referrer")
        for cfg in world.section("channels").values()
        for source in [cfg, *(cfg.get("other_sources") or {}).values()]
        if source.get("referrer")
    }
    by_session = _by_session(rows)

    for events in by_session.values():
        if len(_collected_keys(events)) <= 1:
            continue
        events.sort(key=lambda r: (r["batch_ordering_id"], r["batch_event_index"]))
        # The later acquisition is a page_view that is not the entrance.
        later = [
            row for row in events
            if row["collected_traffic_source"]["manual_source"] is not None
            and row["event_name"] == "page_view"
            and _param(row, "entrances") is None
        ]
        if not later:
            continue
        assert _param(later[0], "page_referrer") in external
        return
    pytest.fail("no re-acquired page view to check")


def test_source_change_can_be_switched_off():
    """At rate 0 every session reports exactly one acquisition."""
    prop, mixer = _base_config()
    mixer["session"]["source_change_rate"] = 0.0
    world = load_world(*_write_config(prop, mixer))

    by_session = _by_session(sorted_rows_for_shard(world, DAY))
    assert by_session
    assert all(len(_collected_keys(s)) <= 1 for s in by_session.values())


# ---------------------------------------------------------------------------
# Campaigns: gclid-only paid search, and several campaigns per channel
# ---------------------------------------------------------------------------

_UTM_PARAMS = ("source", "medium", "campaign", "term", "content")


@pytest.fixture(scope="module")
def utm_rows():
    """The same shard with every paid-search click carrying UTM parameters."""
    prop, mixer = _base_config()
    mixer["acquisition"]["gclid_only_share"] = 0.0
    return sorted_rows_for_shard(load_world(*_write_config(prop, mixer)), DAY)


def _sessions(rows: list[dict]) -> list[list[dict]]:
    """Browser sessions, each in event order."""
    by_session: dict[tuple, list[dict]] = {}
    for row in rows:
        if _param(row, "ga_session_id") is not None:
            by_session.setdefault((row["user_pseudo_id"], _param(row, "ga_session_id")), []).append(row)
    for events in by_session.values():
        events.sort(key=lambda r: (r["batch_ordering_id"], r["batch_event_index"]))
    return list(by_session.values())


def test_some_paid_search_acquisitions_are_gclid_only(rows):
    clicks = [
        row["collected_traffic_source"] for row in rows
        if row["event_name"] == "page_view" and row["collected_traffic_source"]["gclid"]
    ]
    gclid_only = [c for c in clicks if c["manual_source"] is None]
    assert gclid_only, "no gclid-only acquisition"
    assert len(gclid_only) < len(clicks), "no paid-search acquisition kept its UTM parameters"
    assert 0.15 < len(gclid_only) / len(clicks) < 0.45


def test_a_gclid_only_row_collects_the_gclid_and_nothing_else(rows):
    checked = resolved = 0
    for row in rows:
        collected = row["collected_traffic_source"]
        if not collected["gclid"] or collected["manual_source"] is not None:
            continue
        checked += 1
        assert {k: v for k, v in collected.items() if v is not None} == {"gclid": collected["gclid"]}
        assert all(_param(row, key) is None for key in _UTM_PARAMS)
        assert _param(row, "gclid") == collected["gclid"]
        # GA4 resolves the click id itself, so last click still names the
        # campaign, unless a later click in the session took the session over.
        last_click = row["session_traffic_source_last_click"]
        if last_click["cross_channel_campaign"]["medium"] == "cpc":
            resolved += 1
            assert last_click["google_ads_campaign"]["campaign_name"]
            assert last_click["cross_channel_campaign"]["campaign_name"] == last_click["google_ads_campaign"]["campaign_name"]
    assert checked and resolved


def test_gclid_only_share_zero_changes_nothing_else(rows, utm_rows):
    """The dial has its own stream, so it moves the collected fields and nothing else."""
    assert len(rows) == len(utm_rows)
    for row, utm in zip(rows, utm_rows):
        collected = utm["collected_traffic_source"]
        if collected["gclid"]:
            assert collected["manual_source"] == "google" and collected["manual_medium"] == "cpc"
            assert collected["manual_campaign_name"]
            assert _param(utm, "campaign") == collected["manual_campaign_name"]
        if row["collected_traffic_source"] == collected:
            assert row == utm
            continue
        assert row["collected_traffic_source"]["gclid"] == collected["gclid"]
        ignored = ("collected_traffic_source", "event_params")
        assert {k: v for k, v in row.items() if k not in ignored} == {k: v for k, v in utm.items() if k not in ignored}


def test_multi_campaign_channels_show_several_campaigns(world, utm_rows):
    multi = {
        name: cfg for name, cfg in world.section("channels").items()
        if len(cfg.get("campaigns") or {}) > 1
    }
    assert {"paid_search", "paid_social", "email"} <= set(multi)
    for name, cfg in multi.items():
        seen = {
            row["collected_traffic_source"]["manual_campaign_name"]
            for row in utm_rows
            if row["collected_traffic_source"]["manual_source"] == cfg["source"]
            and row["collected_traffic_source"]["manual_medium"] == cfg["medium"]
        }
        assert len(seen) > 1, (name, seen)
        assert seen <= set(world.campaign_weights(name, DAY)), (name, seen)


def test_traffic_source_name_is_the_first_sessions_campaign(utm_rows):
    names = set()
    for row in utm_rows:
        if row["event_name"] != "first_visit":
            continue
        collected = row["collected_traffic_source"]["manual_campaign_name"]
        if collected:
            assert row["traffic_source"]["name"] == collected
        names.add(collected)
    assert len(names) > 5, names


def test_traffic_source_name_without_a_campaign_names_the_medium(rows):
    """GA4 writes (organic), (referral) and so on; only direct traffic is (direct)."""
    by_medium = collections.defaultdict(set)
    for row in rows:
        name = row["traffic_source"]["name"]
        if row["user_pseudo_id"] is not None and name.startswith("("):
            by_medium[row["traffic_source"]["medium"]].add(name)
    assert by_medium["(none)"] == {"(direct)"}
    assert by_medium["organic"] == {"(organic)"}
    assert by_medium["referral"] == {"(referral)"}
    assert by_medium["social"] == {"(social)"}


def test_first_touch_campaign_is_stable_on_a_later_day(world, rows):
    """A returning visitor reports the campaign their first session collected."""
    first_touch = {
        row["user_pseudo_id"]: row["traffic_source"]["name"]
        for row in rows
        # A visitor who denied consent has no user_pseudo_id to look up.
        if row["event_name"] == "first_visit" and row["user_pseudo_id"] is not None
    }
    checked = 0
    for session in sessions_for_visit_date(world, DAY + dt.timedelta(days=1)):
        if session.visitor.cohort != DAY:
            continue
        row = next(iter(serialize_session(world, session)))
        # Skips denied visitors and the few whose first_visit never arrived.
        if row["user_pseudo_id"] not in first_touch:
            continue
        assert row["traffic_source"]["name"] == first_touch[row["user_pseudo_id"]]
        checked += 1
    assert checked > 20


def test_the_campaign_fields_of_one_acquisition_agree(utm_rows):
    google_ads: dict[str, set] = {}
    reacquired = 0
    for events in _sessions(utm_rows):
        clicks = [
            row for row in events
            if row["event_name"] == "page_view" and row["collected_traffic_source"]["manual_source"] is not None
        ]
        for row in events:
            collected = row["collected_traffic_source"]
            if collected["manual_source"] is not None:
                assert _param(row, "campaign") == collected["manual_campaign_name"]
                assert _param(row, "term") == collected["manual_term"]
                assert _param(row, "content") == collected["manual_content"]
        if not clicks:
            continue  # a direct session collects nothing
        reacquired += len(clicks) > 1
        # Last click follows the campaign collected most recently.
        last = clicks[-1]["collected_traffic_source"]
        for row in events:
            last_click = row["session_traffic_source_last_click"]
            assert last_click["cross_channel_campaign"]["campaign_name"] == last["manual_campaign_name"]
            if last["gclid"]:
                ads = last_click["google_ads_campaign"]
                assert ads["campaign_name"] == last["manual_campaign_name"]
                google_ads.setdefault(ads["campaign_name"], set()).add(
                    (ads["campaign_id"], ads["ad_group_id"], ads["ad_group_name"])
                )
            else:
                assert last_click["manual_campaign"]["campaign_name"] == (last["manual_campaign_name"] or "(not set)")
                assert last_click["manual_campaign"]["term"] == last["manual_term"]
                assert last_click["manual_campaign"]["content"] == last["manual_content"]
    assert reacquired, "no re-acquired session to check"
    # Each Google Ads campaign has its own id and ad group.
    assert len(google_ads) > 1
    assert all(len(ids) == 1 for ids in google_ads.values())
    ids = [next(iter(v)) for v in google_ads.values()]
    assert len({i[0] for i in ids}) == len(ids) and len({i[1] for i in ids}) == len(ids)


def test_single_campaign_key_still_works():
    prop, mixer = _base_config()
    prop["channels"]["email"].pop("campaigns")
    prop["channels"]["email"]["campaign"] = "weekly-digest"
    world = load_world(*_write_config(prop, mixer))
    assert world.campaign_weights("email", DAY) == {"weekly-digest": 1.0}
    assert world.acquisition("email", "1.2", 1_787_000_000)["campaign"] == "weekly-digest"


def test_campaign_declarations_are_validated():
    prop, mixer = _base_config()
    prop["channels"]["email"]["campaign"] = "weekly-digest"
    with pytest.raises(ValueError, match="both `campaign` and `campaigns`"):
        load_world(*_write_config(prop, mixer))

    prop, mixer = _base_config()
    prop["channels"]["email"]["campaigns"]["weekly-digest"] = 0
    with pytest.raises(ValueError, match="positive weight"):
        load_world(*_write_config(prop, mixer))

    prop, mixer = _base_config()
    mixer["acquisition"]["gclid_only_share"] = 1.5
    with pytest.raises(ValueError, match="gclid_only_share"):
        load_world(*_write_config(prop, mixer))


# ---------------------------------------------------------------------------
# Intent, demand and the calendar
# ---------------------------------------------------------------------------


def test_returning_visits_convert_better_than_first_visits(world):
    """Latent intent ties coming back to buying, as in a real store."""
    visits = collections.Counter()
    purchases = collections.Counter()
    for offset in range(3):
        for session in sessions_for_visit_date(world, DAY + dt.timedelta(days=offset)):
            key = "first" if session.session_number == 1 else "returning"
            visits[key] += 1
            purchases[key] += any(a.event_name == "purchase" for a in session.actions)
    first = purchases["first"] / visits["first"]
    returning = purchases["returning"] / visits["returning"]
    assert returning > 1.3 * first, (first, returning)


def _without_showcase_settings():
    """The shipped config with every setting PR #15 added taken out again."""
    prop, mixer = _base_config()
    mixer["intent"].pop("channel_segment_weights", None)
    mixer["intent"].pop("device_conversion_factor", None)
    mixer["identity"].pop("cross_device_device_mix", None)
    mixer["acquisition"].pop("device_channel_skew", None)
    return prop, mixer


def _channel_intent_world(by_channel):
    prop, mixer = _without_showcase_settings()
    mixer["intent"]["channel_segment_weights"] = by_channel
    return load_world(*_write_config(prop, mixer))


def test_intent_follows_the_first_channel_when_configured():
    """A listed channel draws from its own weights; every other visitor keeps its segment."""
    world = load_world(*_write_config(*_without_showcase_settings()))
    skewed = _channel_intent_world({"paid_social": {"browsing": 1}, "email": {"ready": 1}})
    seen = collections.Counter()
    for index in range(world.new_visitors_on(DAY)):
        before = _materialise(world, DAY, index)
        after = _materialise(skewed, DAY, index)
        assert after.first_channel == before.first_channel
        if after.first_channel == "paid_social":
            assert after.intent == "browsing"
        elif after.first_channel == "email":
            assert after.intent == "ready"
        else:
            assert after.intent == before.intent
        seen[after.first_channel] += 1
    assert seen["paid_social"] > 10 and seen["email"] > 10, seen


def test_empty_showcase_settings_change_nothing():
    """Every showcase setting left empty gives the same shard as leaving it out, row for row."""
    absent = sorted_rows_for_shard(load_world(*_write_config(*_without_showcase_settings())), DAY)
    prop, mixer = _without_showcase_settings()
    mixer["intent"].update({"channel_segment_weights": {}, "device_conversion_factor": {}})
    mixer["identity"]["cross_device_device_mix"] = {}
    mixer["acquisition"]["device_channel_skew"] = {}
    empty = sorted_rows_for_shard(load_world(*_write_config(prop, mixer)), DAY)
    assert [_frozen(row) for row in empty] == [_frozen(row) for row in absent]


def _materialised(world, days: int = 3):
    return [
        _materialise(world, DAY + dt.timedelta(days=offset), index)
        for offset in range(days)
        for index in range(world.new_visitors_on(DAY + dt.timedelta(days=offset)))
    ]


def test_second_devices_can_have_their_own_device_mix(world):
    prop, mixer = _base_config()
    mixer["identity"]["cross_device_device_mix"] = {"desktop": 1}
    skewed = load_world(*_write_config(prop, mixer))
    seconds = 0
    for before, after in zip(_materialised(world), _materialised(skewed)):
        if after.primary_device:
            assert after.device == before.device
        else:
            assert after.device["category"] == "desktop"
            seconds += 1
    assert seconds > 50, seconds


def test_device_channel_skew_moves_only_that_devices_first_channel(world):
    prop, mixer = _base_config()
    mixer["acquisition"]["device_channel_skew"] = {"mobile": {"paid_social": 0}}
    skewed = load_world(*_write_config(prop, mixer))
    mobile = 0
    for before, after in zip(_materialised(world), _materialised(skewed)):
        assert after.device == before.device
        if after.device["category"] == "mobile":
            assert after.first_channel != "paid_social"
            mobile += 1
        else:
            assert after.first_channel == before.first_channel
    assert mobile > 100, mobile


def test_device_conversion_factor_shifts_purchases_between_devices():
    prop, mixer = _base_config()
    mixer["intent"]["device_conversion_factor"] = {"desktop": 2.5, "mobile": 0.4}
    world = load_world(*_write_config(prop, mixer))
    visits = collections.Counter()
    bought = collections.Counter()
    for offset in range(3):
        for session in sessions_for_visit_date(world, DAY + dt.timedelta(days=offset)):
            category = session.visitor.device["category"]
            visits[category] += 1
            bought[category] += any(a.event_name == "purchase" for a in session.actions)
    desktop = bought["desktop"] / visits["desktop"]
    mobile = bought["mobile"] / visits["mobile"]
    # Conversion factors reach the funnel through a cube root, so a factor
    # ratio of 6.25 gives about 2.4 times the purchase rate.
    assert desktop > 1.8 * mobile, (desktop, mobile)


def test_custom_event_rate_can_depend_on_intent():
    prop, mixer = _base_config()
    prop["tracking"]["custom_events"] = [{
        "name": "newsletter_signup", "on_page": ["home", "plp", "pdp", "blog"], "rate": 0.2,
        "rate_by_intent": {"browsing": 0, "ready": 4},
    }]
    world = load_world(*_write_config(prop, mixer))
    fired = collections.Counter()
    visits = collections.Counter()
    for session in sessions_for_visit_date(world, DAY):
        visits[session.visitor.intent] += 1
        fired[session.visitor.intent] += any(a.event_name == "newsletter_signup" for a in session.actions)
    assert fired["browsing"] == 0
    assert fired["ready"] / visits["ready"] > fired["considering"] / visits["considering"] > 0


@pytest.mark.parametrize(
    "by_channel,fragment",
    [
        ({"carrier_pigeon": {"browsing": 1}}, "channels not in property.yaml"),
        ({"paid_social": {"window_shopping": 1}}, "segments not in intent.segments"),
        ({"paid_social": {"browsing": -1, "ready": 2}}, "non-negative weights"),
        ({"paid_social": {"browsing": 0}}, "positive sum"),
    ],
)
def test_channel_segment_weights_are_validated(by_channel, fragment):
    prop, mixer = _base_config()
    mixer["intent"]["channel_segment_weights"] = by_channel
    _expect_config_error(prop, mixer, fragment)


@pytest.mark.parametrize(
    "mutate,fragment",
    [
        (lambda p, m: m["identity"].update({"cross_device_device_mix": {"smartwatch": 1}}), "cross_device_device_mix names devices"),
        (lambda p, m: m["identity"].update({"cross_device_device_mix": {"desktop": 0}}), "cross_device_device_mix needs"),
        (lambda p, m: m["acquisition"].update({"device_channel_skew": {"mobile": {"fax": 2}}}), "device_channel_skew.mobile names channels"),
        (lambda p, m: m["acquisition"].update({"device_channel_skew": {"mobile": {"email": -1}}}), "must not be negative"),
        (lambda p, m: m["intent"].update({"device_conversion_factor": {"desktop": 0}}), "device_conversion_factor values"),
        (lambda p, m: p["tracking"].update({"custom_events": [{"name": "x_signup", "on_page": ["home"], "rate": 0.1,
                                                              "rate_by_intent": {"curious": 2}}]}), "rate_by_intent names segments"),
    ],
)
def test_device_and_intent_settings_are_validated(mutate, fragment):
    prop, mixer = _base_config()
    mutate(prop, mixer)
    _expect_config_error(prop, mixer, fragment)


def test_neutral_conversion_factor_leaves_the_journey_untouched(world):
    """A factor of 1 must reproduce the configured walk exactly, key order included."""
    transitions, add_to_cart = world.scaled_journey(1.0)
    configured = world.section("journey")["transitions"]
    assert list(transitions) == list(configured)
    for page, targets in configured.items():
        assert list(transitions[page]) == list(targets)
        assert all(transitions[page][t] == pytest.approx(float(w)) for t, w in targets.items())
    assert add_to_cart == pytest.approx(float(world.section("journey")["add_to_cart_rate"]))


def test_conversion_factor_lifts_only_the_funnel_edges(world):
    transitions, _ = world.scaled_journey(2.0)
    configured = world.section("journey")["transitions"]
    assert transitions["checkout"]["purchased"] > float(configured["checkout"]["purchased"])
    assert transitions["checkout"]["end"] == pytest.approx(float(configured["checkout"]["end"]))
    assert transitions["home"] == pytest.approx({k: float(v) for k, v in configured["home"].items()})


def test_daily_demand_varies_and_is_deterministic(world):
    days = [DAY + dt.timedelta(days=offset) for offset in range(28)]
    factors = [world.day_factors(day).conversion for day in days]
    assert len({round(f, 6) for f in factors}) == len(factors), "demand did not vary by day"
    fresh = load_world()
    assert factors == [fresh.day_factors(day).conversion for day in days]


def test_calendar_events_match_their_days():
    prop, mixer = _base_config()
    mixer["calendar"] = [
        {"name": "tuesday", "weekday": 2, "channels": {"email": 3.0}},
        {"name": "new-year", "from": "12-30", "to": "01-02", "conversion": 1.5},
        {"name": "one-off", "from": "2026-08-25", "to": "2026-08-25", "traffic": 2.0},
    ]
    mixer.pop("demand", None)
    world = load_world(*_write_config(prop, mixer))
    assert world.day_factors(dt.date(2026, 8, 25)).events == ("tuesday", "one-off")
    assert world.day_factors(dt.date(2026, 8, 25)).channels == {"email": 3.0}
    assert world.day_factors(dt.date(2027, 1, 1)).conversion == pytest.approx(1.5)
    assert world.day_factors(dt.date(2026, 12, 28)).events == ()  # a Monday outside new-year
    assert world.day_factors(dt.date(2027, 8, 25)).traffic == 1.0


def _launch_world(new_visitors_only):
    prop, mixer = _base_config()
    mixer["calendar"] = [
        {"name": "tuesday", "weekday": 2, "channels": {"email": 3.0}},
        {"name": "launch", "from": "2026-08-25", "to": "2026-08-25", "channels": {"paid_social": 5.0},
         "new_visitors_only": new_visitors_only},
    ]
    return load_world(*_write_config(prop, mixer))


def test_new_visitors_only_keeps_returning_visits_on_their_usual_channels():
    day = dt.date(2026, 8, 25)  # a Tuesday
    world = _launch_world(True)
    assert world.day_factors(day).channels == {"email": 3.0, "paid_social": 5.0}
    # The other event still reaches returning visits; the launch does not.
    assert world.day_factors(day).returning_channels == {"email": 3.0}
    usual = world.returning_channel_weights()
    returning = world.returning_channel_weights(day)
    assert returning["paid_social"] == pytest.approx(usual["paid_social"])
    assert returning["email"] == pytest.approx(3.0 * usual["email"])
    assert world.channel_weights_on(day)["paid_social"] == pytest.approx(5.0 * world.channel_weights["paid_social"])


def test_without_new_visitors_only_the_launch_reaches_returning_visits_too():
    world = _launch_world(False)
    factors = world.day_factors(dt.date(2026, 8, 25))
    assert factors.returning_channels == factors.channels


def test_new_visitors_only_must_be_a_boolean():
    prop, mixer = _base_config()
    mixer["calendar"] = [{"name": "bad", "weekday": 1, "channels": {"email": 2.0}, "new_visitors_only": "yes"}]
    _expect_config_error(prop, mixer, "new_visitors_only")


def test_calendar_rejects_unknown_channels():
    prop, mixer = _base_config()
    mixer["calendar"] = [{"name": "bad", "weekday": 1, "channels": {"tiktok": 2.0}}]
    with pytest.raises(ValueError, match="tiktok"):
        load_world(*_write_config(prop, mixer))


def test_calendar_campaign_reaches_the_export(rows):
    """On 2026-08-25 paid social runs the third quarter's prospecting campaign.

    It leads the channel while it runs. The always-on campaigns continue beside
    it, and no other quarter's campaign appears.

    Adapted by the app on 2026-10-14 (decision D-97, ORIGIN.md): its
    configuration runs one prospecting campaign a quarter, so the campaign of
    25 August is q3-prospecting, where upstream's is summer-prospecting.
    """
    campaigns = collections.Counter(
        row["collected_traffic_source"]["manual_campaign_name"]
        for row in rows
        if row["collected_traffic_source"]["manual_medium"] == "paid_social"
        and row["event_name"] == "page_view"
    )
    assert campaigns.most_common(1)[0][0] == "q3-prospecting"
    assert campaigns["q3-prospecting"] > sum(campaigns.values()) / 2
    assert not {name for name in campaigns if name.endswith("-prospecting")} - {"q3-prospecting"}


def test_calendar_campaign_can_replace_the_always_on_ones():
    """At calendar_campaign_share 1.0 an event renames the channel's campaign outright."""
    prop, mixer = _base_config()
    mixer["acquisition"]["calendar_campaign_share"] = 1.0
    world = load_world(*_write_config(prop, mixer))
    # q3-prospecting, not upstream's summer-prospecting: see the test above.
    assert world.campaign_weights("paid_social", DAY) == {"q3-prospecting": 1.0}
    assert set(world.campaign_weights("email", DAY)) == set(prop["channels"]["email"]["campaigns"])


def test_single_decay_retention_is_still_accepted():
    prop, mixer = _base_config()
    mixer["retention"].pop("return_curve")
    mixer["retention"]["decay_days"] = 30.0
    world = load_world(*_write_config(prop, mixer))
    assert world.return_probability(30) == pytest.approx(float(mixer["retention"]["return_base"]) * 0.36788, rel=1e-3)


def test_return_curve_front_loads_returns(world):
    """Most returns come within days, then a long tail.

    The attribution showcase (issue #10, insight B) lengthens consideration on
    purpose, so day 1 is about 2.3 times day 14 rather than 3 times or more.
    """
    assert world.return_probability(1) > 2 * world.return_probability(14)
    assert world.return_probability(60) > 0


# ---------------------------------------------------------------------------
# Server-side purchases
# ---------------------------------------------------------------------------


def _consented_sessionless(rows: list[dict]) -> list[dict]:
    """Rows that lack a session id for a reason other than consent."""
    return [
        row for row in rows
        if _param(row, "ga_session_id") is None
        and row["privacy_info"]["analytics_storage"] == "Yes"
    ]


def test_shard_contains_server_side_purchases(rows):
    sessionless = _consented_sessionless(rows)
    assert sessionless, "no server-side purchase in the shard"
    assert {row["event_name"] for row in sessionless} == {"purchase"}


def test_offline_orders_belong_to_signed_in_primary_devices(world):
    orders = [
        order
        for offset in range(10)
        for order in offline_orders_on(world, DAY + dt.timedelta(days=offset))
    ]
    assert orders, "no offline order in ten days"
    for order in orders:
        assert order.server_side_only
        assert order.visitor.authenticated and order.visitor.primary_device
        assert order.user_id == order.visitor.person_id
        assert [a.event_name for a in order.actions] == ["purchase"]


def test_server_side_purchases_can_be_switched_off():
    prop, mixer = _base_config()
    mixer["server_side"] = {"purchase_share": 0.0}
    world = load_world(*_write_config(prop, mixer))
    rows = sorted_rows_for_shard(world, DAY)
    assert not _consented_sessionless(rows)
    assert not [row for row in rows if row["batch_ordering_id"] is None]


def test_offline_orders_can_be_switched_off():
    """enabled: false places no offline order, whatever the rate."""
    prop, mixer = _base_config()
    mixer["server_side"]["offline_orders"].update({"enabled": False, "daily_rate": 0.01})
    world = load_world(*_write_config(prop, mixer))
    assert not world.offline_orders_enabled
    assert not [order for offset in range(10) for order in offline_orders_on(world, DAY + dt.timedelta(days=offset))]


def test_offline_orders_respect_the_purchase_toggle():
    """A property that does not send purchases places no offline orders either."""
    prop, mixer = _base_config()
    prop["tracking"]["events"]["purchase"] = False
    world = load_world(*_write_config(prop, mixer))
    assert not [order for offset in range(10) for order in offline_orders_on(world, DAY + dt.timedelta(days=offset))]


# ---------------------------------------------------------------------------
# Consent-denied cohort
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def plain_rows():
    """The shard with everyone consenting and no session_start ever missing."""
    prop, mixer = _base_config()
    mixer["consent"]["analytics_granted"] = 1.0
    mixer["session"]["missing_session_start_rate"] = 0.0
    mixer["server_side"]["offline_orders"]["session_id_share"] = 0.0
    return sorted_rows_for_shard(load_world(*_write_config(prop, mixer)), DAY)


def _frozen(row: dict) -> str:
    return json.dumps(row, sort_keys=True)


def test_denied_rows_carry_no_identifier(rows):
    """The shape measured on a real consent-mode export."""
    denied = [row for row in rows if row["privacy_info"]["analytics_storage"] == "No"]
    assert 0.08 < len(denied) / len(rows) < 0.17, len(denied) / len(rows)

    from ga4synth.serialize import _null_last_click
    for row in denied:
        assert row["user_pseudo_id"] is None and row["user_id"] is None
        assert _param(row, "ga_session_id") is None
        assert _param(row, "ga_session_number") is not None
        assert row["session_traffic_source_last_click"] == _null_last_click()
        assert row["privacy_info"]["ads_storage"] == "No"
        # Still an ordinary browser row.
        assert row["batch_ordering_id"] is not None
        assert row["user_first_touch_timestamp"] is not None

    # A NULL user_pseudo_id means denied consent, and nothing else.
    assert all(
        row["privacy_info"]["analytics_storage"] == "No"
        for row in rows if row["user_pseudo_id"] is None
    )

    names = {row["event_name"] for row in denied}
    assert {"session_start", "first_visit", "page_view", "scroll", "user_engagement"} <= names
    # The acquiring events still collect their campaign.
    assert any(
        row["collected_traffic_source"]["manual_source"] is not None
        for row in denied if row["event_name"] == "session_start"
    )


def test_consent_is_a_property_of_the_visitor(world):
    """Whoever denies consent denies it on every session."""
    checked = 0
    for visitor, number, prior in visits_on(world, DAY):
        if not prior:
            continue
        # Every earlier session of the visitor, as (date, ordinal within the day).
        granted = {
            build_session(world, visitor, n, day, ordinal=ordinal).analytics_granted
            for n, (day, ordinal) in enumerate(prior, start=1)
        }
        granted.add(build_session(world, visitor, number, DAY, prior_sessions=prior).analytics_granted)
        assert len(granted) == 1
        checked += 1
        if checked >= 60:
            break
    assert checked


def test_a_denied_session_is_otherwise_a_normal_session(world):
    """Consent removes identifiers and session attribution, and changes nothing else."""
    import dataclasses

    denied = next(
        session for session in sessions_for_visit_date(world, DAY)
        if not session.analytics_granted and len(session.actions) > 4
    )
    granted = dataclasses.replace(denied, analytics_granted=True, ads_granted=True)

    denied_rows = list(serialize_session(world, denied))
    granted_rows = list(serialize_session(world, granted))
    assert len(denied_rows) == len(granted_rows)
    for without, with_consent in zip(denied_rows, granted_rows):
        expected = copy.deepcopy(with_consent)
        expected["user_pseudo_id"] = None
        expected["user_id"] = None
        expected["privacy_info"] = without["privacy_info"]
        expected["session_traffic_source_last_click"] = without["session_traffic_source_last_click"]
        expected["event_params"] = [e for e in expected["event_params"] if e["key"] != "ga_session_id"]
        assert without == expected


def test_denied_visitors_are_never_reported_from_the_server(world):
    """Their purchases stay in the browser, and they place no offline orders."""
    denied_purchases = 0
    for offset in range(4):
        day = DAY + dt.timedelta(days=offset)
        for session in sessions_for_visit_date(world, day):
            if session.analytics_granted:
                continue
            for action in session.actions:
                assert not action.payload.get("server_side")
                denied_purchases += action.event_name == "purchase"
        for order in offline_orders_on(world, day):
            assert order.analytics_granted
    assert denied_purchases, "no denied visitor bought anything; widen the search"


def test_consent_leaves_consenting_visitors_untouched(rows, plain_rows):
    """Consent is its own stream, so a consenting visitor's rows do not depend on the dial.

    An offline order that carries a session id differs by design, and is the
    only consented row allowed to.
    """
    plain = {_frozen(row) for row in plain_rows}
    changed = [
        row for row in rows
        if row["user_pseudo_id"] is not None and _frozen(row) not in plain
    ]
    assert all(
        row["batch_ordering_id"] is None and _param(row, "ga_session_id") is not None
        for row in changed
    ), changed[:1]
    assert all(row["user_pseudo_id"] is not None for row in plain_rows)
    assert {row["privacy_info"]["analytics_storage"] for row in plain_rows} == {"Yes"}


def test_consent_can_be_switched_off(plain_rows):
    """enabled: false gives the same shard as everyone granting, whatever the shares."""
    prop, mixer = _base_config()
    mixer["consent"].update({"enabled": False, "analytics_granted": 0.5, "ads_granted": 0.5})
    mixer["session"]["missing_session_start_rate"] = 0.0
    world = load_world(*_write_config(prop, mixer))
    assert not world.consent_enabled
    rows = sorted_rows_for_shard(world, DAY)
    assert [_frozen(row) for row in rows] == [_frozen(row) for row in plain_rows]
    assert {row["privacy_info"]["ads_storage"] for row in rows} == {"Yes"}


# ---------------------------------------------------------------------------
# Sessions without session_start
# ---------------------------------------------------------------------------


def _opened_without_start(rows: list[dict]) -> list[list[dict]]:
    """Sessions whose first batch is in the shard but whose session_start is not."""
    return [
        events for events in _by_session(rows).values()
        if any(row["batch_ordering_id"] == 1 for row in events)
        and not any(row["event_name"] == "session_start" for row in events)
    ]


def test_some_sessions_lose_their_session_start(rows):
    lost = _opened_without_start(rows)
    share = len(lost) / len(_by_session(rows))
    assert 0.005 < share < 0.05, share
    for events in lost:
        names = [row["event_name"] for row in events]
        assert "first_visit" not in names
        entrance = next(row for row in events if _param(row, "entrances") == 1)
        assert entrance["event_name"] == "page_view" and entrance["batch_ordering_id"] == 1
    # The entrance page_view still collects the campaign the session arrived on.
    assert any(
        row["collected_traffic_source"]["manual_source"] is not None
        for events in lost for row in events if _param(row, "entrances") == 1
    )


def test_a_lost_session_start_changes_no_other_row(rows, plain_rows):
    """Only session_start and first_visit go missing. The rest is byte-identical."""
    assert not _opened_without_start(plain_rows)

    kept = {_frozen(row) for row in rows}
    missing = [
        row for row in plain_rows
        if _frozen(row) not in kept
        and (row["user_pseudo_id"], _param(row, "ga_session_id")) in {
            (events[0]["user_pseudo_id"], _param(events[0], "ga_session_id"))
            for events in _opened_without_start(rows)
        }
    ]
    assert missing
    assert {row["event_name"] for row in missing} <= {"session_start", "first_visit"}


def _offline_orders(world, days: int = 40):
    return [
        order
        for offset in range(days)
        for order in offline_orders_on(world, DAY + dt.timedelta(days=offset))
    ]


@pytest.fixture(scope="module")
def session_id_world():
    """Half of the offline orders send a session id. The shipped config sends none."""
    prop, mixer = _base_config()
    mixer["server_side"]["offline_orders"]["session_id_share"] = 0.5
    return load_world(*_write_config(prop, mixer))


def test_shipped_offline_orders_are_sessionless(world):
    orders = _offline_orders(world, days=20)
    assert orders and all(order.ga_session_id is None for order in orders)


def test_some_offline_orders_carry_a_session_id(session_id_world):
    """A one-event session: a session id and number, and nothing else a browser adds."""
    world = session_id_world
    orders = _offline_orders(world)
    with_session = [order for order in orders if order.ga_session_id is not None]
    assert with_session and len(with_session) < len(orders)

    for order in with_session:
        (row,) = serialize_session(world, order)
        assert row["event_name"] == "purchase"
        assert _param(row, "ga_session_id") == order.ga_session_id == int(order.started.timestamp())
        assert _param(row, "ga_session_number") >= 1
        assert _param(row, "session_engaged") is None and _param(row, "page_location") is None
        assert row["batch_ordering_id"] is None
        assert row["user_pseudo_id"] == order.visitor.user_pseudo_id

        # No browser session this visitor could have around the order shares the id.
        local_day = order.started.astimezone(ZoneInfo(world.timezone)).date()
        for visit in (local_day - dt.timedelta(days=1), local_day):
            browser = build_session(world, order.visitor, 2, visit)
            assert browser.ga_session_id != order.ga_session_id

        failures = {k: v for k, v in run_all(world, local_day, [row]).items() if v}
        assert not failures, failures

    for order in orders:
        if order.ga_session_id is None:
            (row,) = serialize_session(world, order)
            assert _param(row, "ga_session_id") is None and _param(row, "ga_session_number") is None


def test_a_server_side_purchase_needs_both_session_parameters_or_neither(session_id_world):
    world = session_id_world
    order = next(order for order in _offline_orders(world) if order.ga_session_id is not None)
    (row,) = serialize_session(world, order)
    day = order.started.astimezone(ZoneInfo(world.timezone)).date()
    row["event_params"] = [e for e in row["event_params"] if e["key"] != "ga_session_number"]
    assert run_all(world, day, [row])["check_server_side_events"]


def test_offline_order_session_ids_can_be_switched_off():
    prop, mixer = _base_config()
    mixer["server_side"]["offline_orders"]["session_id_share"] = 0.0
    orders = _offline_orders(load_world(*_write_config(prop, mixer)), days=20)
    assert orders and all(order.ga_session_id is None for order in orders)


@pytest.mark.parametrize(
    "mutate,fragment",
    [
        (lambda m: m["consent"].update({"analytics_granted": 1.2}), "consent.analytics_granted"),
        (lambda m: m["session"].update({"missing_session_start_rate": -0.1}), "missing_session_start_rate"),
        (lambda m: m["server_side"]["offline_orders"].update({"session_id_share": 2}), "session_id_share"),
        (lambda m: m["server_side"]["offline_orders"].update({"enabled": "no"}), "offline_orders.enabled"),
        (lambda m: m["consent"].update({"enabled": "no"}), "consent.enabled"),
    ],
)
def test_consent_and_missing_start_dials_are_validated(mutate, fragment):
    prop, mixer = _base_config()
    mutate(mixer)
    _expect_config_error(prop, mixer, fragment)


# ---------------------------------------------------------------------------
# Several sessions per visitor per day
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def day_sessions(world):
    """The sessions that start on DAY, grouped by visitor, in start order."""
    grouped: dict[tuple, list] = {}
    for session in sessions_for_visit_date(world, DAY):
        grouped.setdefault((session.visitor.cohort, session.visitor.index), []).append(session)
    return grouped


def test_some_visit_days_have_several_sessions(day_sessions):
    """A real export has 2+ sessions on about a fifth of its user-days."""
    several = sum(1 for sessions in day_sessions.values() if len(sessions) >= 2)
    share = several / len(day_sessions)
    assert 0.15 <= share <= 0.20, f"{share:.1%} of user-days have 2+ sessions"
    assert any(len(sessions) >= 3 for sessions in day_sessions.values())


def test_sessions_of_one_visitor_never_overlap(world, day_sessions):
    """Each session starts 30+ minutes after the previous one ended, as GA4 requires."""
    tz = ZoneInfo(world.timezone)
    # The guarantee comes from the configured gap, not from luck on this day.
    gap_low, _ = world.extra_session_gap_seconds
    assert gap_low >= world.max_session_seconds + 30 * 60

    checked = 0
    for sessions in day_sessions.values():
        assert len({s.ga_session_id for s in sessions}) == len(sessions)
        for session in sessions:
            assert session.started.astimezone(tz).date() == DAY
            browser = [a.when for a in session.actions if not a.payload.get("server_side")]
            assert (max(browser) - session.started).total_seconds() <= world.max_session_seconds
        for earlier, later in zip(sessions, sessions[1:]):
            ended = max(a.when for a in earlier.actions if not a.payload.get("server_side"))
            assert later.started - ended >= dt.timedelta(minutes=30)
            checked += 1
    assert checked > 100


def test_extra_sessions_are_acquired_like_returning_sessions(day_sessions):
    """An extra session draws its own channel, which is what makes a same-day path."""
    paths = [
        [s.channel for s in sessions]
        for sessions in day_sessions.values() if len(sessions) >= 2
    ]
    assert any(len(set(path)) > 1 for path in paths), "no same-day multi-touch path"
    # Only a visitor's very first session is a first visit.
    for sessions in day_sessions.values():
        for session in sessions:
            first_visits = [a for a in session.actions if a.event_name == "first_visit"]
            assert len(first_visits) == (1 if session.session_number == 1 else 0)
        assert [s.session_number for s in sessions] == list(
            range(sessions[0].session_number, sessions[0].session_number + len(sessions))
        )


def test_session_numbers_are_contiguous_across_days(world):
    """ga_session_number counts every earlier session, extras on earlier days included."""
    numbers: dict[int, list[int]] = collections.defaultdict(list)
    extras_before_a_later_day = 0
    for offset in range(5):
        day = DAY + dt.timedelta(days=offset)
        per_day: dict[int, int] = collections.Counter()
        for visitor, number, prior in visits_on(world, day):
            if visitor.cohort != DAY:
                continue  # only a cohort seen from its first day has a full history
            assert len(prior) == number - 1
            if offset and not per_day[visitor.index] and len(prior) > len({d for d, _ in prior}):
                extras_before_a_later_day += 1
            per_day[visitor.index] += 1
            numbers[visitor.index].append(number)
    for index, seen in numbers.items():
        assert seen == list(range(1, len(seen) + 1)), f"visitor {index} has session numbers {seen}"
    assert extras_before_a_later_day, "no visitor came back after a day with an extra session"


def test_user_ltv_carries_over_to_a_later_session_the_same_day(world, day_sessions):
    """Revenue from the morning's order is lifetime value by the afternoon."""
    checked = 0
    for sessions in day_sessions.values():
        visitor = sessions[0].visitor
        if visitor.authenticated and visitor.primary_device:
            continue  # an offline order could land between the two sessions
        for earlier, later in zip(sessions, sessions[1:]):
            if not any(a.event_name == "purchase" for a in earlier.actions):
                continue
            closing = max(r["user_ltv"]["revenue"] for r in serialize_session(world, earlier))
            opening = next(iter(serialize_session(world, later)))["user_ltv"]["revenue"]
            assert closing > 0
            assert opening == pytest.approx(closing, abs=0.01)
            checked += 1
    assert checked, "no visitor bought and then came back the same day; widen the search"


def test_transaction_ids_of_same_day_sessions_differ(world, day_sessions):
    ids = [
        a.payload["transaction_id"]
        for sessions in day_sessions.values() for s in sessions for a in s.actions
        if a.event_name == "purchase"
    ]
    assert len(ids) == len(set(ids))
    # The extra session's ordinal is part of the key, so the same sequence
    # number in two sessions of one day still gives two ids.
    visitor = next(iter(day_sessions.values()))[0].visitor
    assert _transaction_id(world, visitor, DAY, 1) != _transaction_id(world, visitor, DAY, 1, 1)
    assert _transaction_id(world, visitor, DAY, 1, 1) != _transaction_id(world, visitor, DAY, 1, 2)


@pytest.mark.parametrize("extra_sessions", [{"weights": {0: 1}}, {"weights": {0: 1, 1: 0}}, None])
def test_extra_sessions_can_be_switched_off(world, day_sessions, extra_sessions):
    """With the dial off, every visitor has one session a day, and it is the same first session."""
    prop, mixer = _base_config()
    if extra_sessions is None:
        del mixer["session"]["extra_sessions"]
    else:
        mixer["session"]["extra_sessions"] = extra_sessions
    single = load_world(*_write_config(prop, mixer))

    seen = set()
    for visitor, number, prior in visits_on(single, DAY):
        key = (visitor.cohort, visitor.index)
        assert key not in seen, "a visitor has two sessions with extra sessions switched off"
        seen.add(key)
        assert len({d for d, _ in prior}) == len(prior)
    assert seen == set(day_sessions)

    # The first session of a day does not depend on the dial. New visitors have
    # no history, so their rows must match exactly.
    compared = 0
    for (cohort, index), sessions in day_sessions.items():
        if cohort != DAY or compared >= 200:
            continue
        alone = build_session(single, sessions[0].visitor, 1, DAY)
        assert list(serialize_session(single, alone)) == list(serialize_session(world, sessions[0]))
        compared += 1
    assert compared


def test_session_separation_check_can_fail(world, rows):
    """Two sessions of one visitor that sit too close, or skip a number, must go red."""
    by_visitor: dict[str, list[list[dict]]] = {}
    for (pseudo, _), events in _by_session(rows).items():
        # Sessions that opened in this shard, so they started on the same day.
        if any(row["event_name"] == "session_start" for row in events):
            by_visitor.setdefault(pseudo, []).append(events)
    pseudo = next(p for p, sessions in by_visitor.items() if len(sessions) >= 2)

    def later_session(broken):
        sessions = [e for (p, _), e in _by_session(broken).items() if p == pseudo]
        return max(sessions, key=lambda events: events[0]["event_timestamp"])

    renumbered = copy.deepcopy(rows)
    for row in later_session(renumbered):
        for entry in row["event_params"]:
            if entry["key"] == "ga_session_number":
                entry["value"]["int_value"] += 1
    assert run_all(world, DAY, renumbered)["check_session_lifecycle"]

    # Pull the later session back until it starts a minute after the earlier one ends.
    crowded = copy.deepcopy(rows)
    target = later_session(crowded)
    earlier_end = max(
        row["event_timestamp"] for row in crowded
        if row["user_pseudo_id"] == pseudo
        and _param(row, "ga_session_id") not in (None, _param(target[0], "ga_session_id"))
    )
    shift = min(r["event_timestamp"] for r in target) - earlier_end - 60_000_000
    for row in target:
        row["event_timestamp"] -= shift
    assert run_all(world, DAY, crowded)["check_session_lifecycle"]


def test_extra_session_gap_must_outlast_the_longest_session():
    prop, mixer = _base_config()
    mixer["session"]["extra_sessions"]["gap_minutes"] = [45, 360]
    _expect_config_error(prop, mixer, "session.extra_sessions.gap_minutes")
    # Harmless when no extra session can happen.
    mixer["session"]["extra_sessions"]["weights"] = {0: 1}
    load_world(*_write_config(prop, mixer))


# ---------------------------------------------------------------------------
# Last click of a direct session
# ---------------------------------------------------------------------------


def _direct_sessions_with_history(world, day):
    """Consenting browser sessions that arrived direct and have earlier sessions."""
    for session in sessions_for_visit_date(world, day):
        if session.last_click_channel == "direct" and session.analytics_granted and session.prior_sessions:
            yield session


def test_a_direct_session_reports_the_last_non_direct_campaign(world):
    """GA4 attributes a direct session to the visitor's last campaign, when there is one."""
    channels = world.section("channels")
    lookback = world.last_non_direct_lookback_days
    assert lookback > 0
    inherited = stayed_direct = 0
    for session in _direct_sessions_with_history(world, DAY):
        visitor = session.visitor
        expected, clicked_in = "direct", session
        for number, (day, ordinal) in reversed(list(enumerate(session.prior_sessions, start=1))):
            if (DAY - day).days > lookback:
                break
            earlier = build_session(world, visitor, number, day, ordinal=ordinal)
            if session.started - earlier.started > dt.timedelta(days=lookback):
                break  # the window is exact, not counted in calendar days
            if earlier.last_click_channel != "direct":
                expected, clicked_in = earlier.last_click_channel, earlier
                break
        assert session.started - clicked_in.started <= dt.timedelta(days=lookback)
        # The source is the one that earlier click drew, not just its channel's.
        clicked = world.acquisition(expected, visitor.user_pseudo_id, int(clicked_in.started.timestamp()))
        assert clicked["source"] in _declared_sources(channels[expected])
        rows = list(serialize_session(world, session))
        for row in rows:
            if row["batch_ordering_id"] is None:
                continue  # a server-confirmed purchase carries no session attribution
            click = row["session_traffic_source_last_click"]["cross_channel_campaign"]
            assert (click["source"], click["medium"]) == (clicked["source"], clicked["medium"])
            # What the session itself collected is unchanged: a direct arrival collects nothing.
            if row["event_name"] == "session_start":
                assert row["collected_traffic_source"]["manual_source"] is None
                assert row["collected_traffic_source"]["gclid"] is None
        if expected == "direct":
            stayed_direct += 1
        else:
            inherited += 1
    assert inherited > 20 and stayed_direct > 0, (inherited, stayed_direct)


def test_an_inherited_last_click_names_the_campaign_the_earlier_session_collected(world):
    checked = 0
    for session in _direct_sessions_with_history(world, DAY):
        number = len(session.prior_sessions)
        day, ordinal = session.prior_sessions[-1]
        earlier = build_session(world, session.visitor, number, day, ordinal=ordinal)
        if earlier.last_click_channel == "direct" or not earlier.analytics_granted:
            continue
        theirs = next(iter(serialize_session(world, earlier)))["session_traffic_source_last_click"]
        ours = next(iter(serialize_session(world, session)))["session_traffic_source_last_click"]
        assert ours == theirs
        checked += 1
        if checked >= 40:
            break
    assert checked > 10


def test_a_new_visitor_arriving_direct_stays_direct(world):
    """With no earlier session there is no campaign to fall back on."""
    seen = 0
    for session in sessions_for_visit_date(world, DAY):
        if session.session_number != 1 or session.last_click_channel != "direct":
            continue
        if not session.analytics_granted:
            continue
        click = next(iter(serialize_session(world, session)))["session_traffic_source_last_click"]
        assert (click["cross_channel_campaign"]["source"], click["cross_channel_campaign"]["medium"]) == (
            "(direct)", "(none)"
        )
        seen += 1
    assert seen > 50


def test_last_non_direct_lookback_can_be_switched_off():
    prop, mixer = _base_config()
    mixer["acquisition"]["last_non_direct_lookback_days"] = 0
    world = load_world(*_write_config(prop, mixer))
    checked = 0
    for session in _direct_sessions_with_history(world, DAY):
        click = next(iter(serialize_session(world, session)))["session_traffic_source_last_click"]
        assert click["cross_channel_campaign"]["source"] == "(direct)"
        checked += 1
        if checked >= 50:
            break
    assert checked

    mixer["acquisition"]["last_non_direct_lookback_days"] = -1
    _expect_config_error(prop, mixer, "last_non_direct_lookback_days")


# ---------------------------------------------------------------------------
# Publishing several days at once
# ---------------------------------------------------------------------------


def test_publish_workers_cover_the_same_days(capfd):
    """``--workers`` changes how the days are scheduled, not what is loaded."""
    from ga4synth.cli import main

    outputs = []
    for workers in ("1", "2"):
        code = main(["publish", "--dataset", "project:dataset", "--date", "2026-07-02",
                     "--days", "2", "--dry-run", "--workers", workers])
        assert code == 0
        outputs.append(sorted(capfd.readouterr().out.splitlines()))
    assert outputs[0] == outputs[1]
    assert sum("would load" in line for line in outputs[0]) == 2


def test_upload_buffer_is_gzipped_ndjson_and_reproducible(world):
    """The loader uploads gzip. The bytes must decode to the rows, and repeat."""
    import gzip

    from ga4synth.load import rows_to_ndjson

    rows = sorted_rows_for_shard(world, DAY)[:500]
    payload = rows_to_ndjson(rows).getvalue()
    assert payload[:2] == b"\x1f\x8b"
    decoded = [json.loads(line) for line in gzip.decompress(payload).splitlines()]
    assert decoded == json.loads(json.dumps(rows))
    assert rows_to_ndjson(rows).getvalue() == payload


# ---------------------------------------------------------------------------
# Several sources per channel, and the long tail of countries
# ---------------------------------------------------------------------------


def _declared_sources(cfg: dict) -> dict[str, dict]:
    """Every source a channel declares, by name, with its referrer and medium."""
    declared = {cfg["source"]: {"referrer": cfg.get("referrer"), "medium": cfg["medium"]}}
    for name, entry in (cfg.get("other_sources") or {}).items():
        declared[name] = {"referrer": entry.get("referrer"), "medium": entry.get("medium", cfg["medium"])}
    return declared


def test_a_channel_arrives_from_several_sources(world, rows):
    """Every declared source shows up, and the channel's own source still leads."""
    starts = [row for row in rows if row["event_name"] == "session_start"]
    for name, cfg in world.section("channels").items():
        if not cfg.get("other_sources"):
            continue
        declared = _declared_sources(cfg)
        seen = collections.Counter(
            row["collected_traffic_source"]["manual_source"]
            for row in starts
            if row["collected_traffic_source"]["manual_medium"] == cfg["medium"]
            and row["collected_traffic_source"]["manual_source"] in declared
        )
        assert set(seen) == set(declared), (name, seen)
        assert seen.most_common(1)[0][0] == cfg["source"], (name, seen)


def test_the_referrer_and_the_attribution_name_the_same_source(world, rows):
    """One acquisition is one site: its referrer, last click and first touch agree."""
    referrers = {}
    for cfg in world.section("channels").values():
        for source, entry in _declared_sources(cfg).items():
            referrers[(source, entry["medium"])] = entry["referrer"]
    checked = 0
    for events in _by_session(rows).values():
        start = next((row for row in events if row["event_name"] == "session_start"), None)
        if start is None or start["collected_traffic_source"]["manual_source"] is None:
            continue
        collected = start["collected_traffic_source"]
        key = (collected["manual_source"], collected["manual_medium"])
        assert _param(start, "page_referrer") == referrers[key]
        assert _param(start, "source") == collected["manual_source"]
        if len(_collected_keys(events)) == 1:
            click = start["session_traffic_source_last_click"]["cross_channel_campaign"]
            assert (click["source"], click["medium"]) == key
        if _param(start, "ga_session_number") == 1:
            assert (start["traffic_source"]["source"], start["traffic_source"]["medium"]) == key
        checked += 1
    assert checked > 500


def test_other_sources_can_be_switched_off():
    prop, mixer = _base_config()
    for cfg in prop["channels"].values():
        cfg.pop("other_sources", None)
        cfg.pop("source_weight", None)
    world = load_world(*_write_config(prop, mixer))
    own = {cfg["source"] for cfg in prop["channels"].values()}
    seen = {
        row["collected_traffic_source"]["manual_source"]
        for row in sorted_rows_for_shard(world, DAY)
        if row["collected_traffic_source"]["manual_source"] is not None
    }
    assert seen <= own and len(seen) > 3


def test_other_sources_are_validated():
    cases = [
        (lambda c: c["organic_search"].pop("source_weight"), "source_weight must be a positive weight"),
        (lambda c: c["organic_search"]["other_sources"]["bing"].pop("weight"), "needs a positive weight"),
        (lambda c: c["organic_search"]["other_sources"]["bing"].update(campaign="x"), "unknown keys"),
        (lambda c: c["organic_search"]["other_sources"].update(google={"weight": 1}), "repeats the channel's own source"),
        (lambda c: c["paid_search"].update(source_weight=1, other_sources={"bing": {"weight": 1}}), "cannot declare `other_sources`"),
        (lambda c: c["email"].update(source_weight=1), "no effect without `other_sources`"),
    ]
    for mutate, fragment in cases:
        prop, mixer = _base_config()
        mutate(prop["channels"])
        _expect_config_error(prop, mixer, fragment)


def test_visitors_come_from_a_long_tail_of_countries(world, rows):
    countries = collections.Counter(
        row["geo"]["country"] for row in rows if row["event_name"] == "session_start"
    )
    assert len(countries) >= 30
    # Still a store with a home market: the long tail stays a tail.
    assert countries.most_common(1)[0][0] == "United States"
    home = sum(count for _, count in countries.most_common(6))
    assert 0.80 < home / sum(countries.values()) < 0.92


# ---------------------------------------------------------------------------
# Values the export carries verbatim
# ---------------------------------------------------------------------------


def _fixed_values_world():
    prop, mixer = _base_config()
    prop["property"].update(currency="EUR", usd_exchange_rate=1.1, default_language="xx-yy")
    prop["geos"]["fr_paris"]["language"] = "fr-fr"
    prop["channels"]["paid_search"]["channel_group"] = "Cross-network"
    prop["channels"]["paid_search"]["google_ads"] = {"customer_id": "1234567890", "account_name": "{brand} Ads"}
    prop["ecommerce"].update(
        transaction_id_prefix="T-",
        shipping_tier={"choice": {"Standard": 50, "Express": 50}},
        payment_type="PayPal",
        view_item_list_name=None,
    )
    mixer["server_side"]["offline_orders"]["line_item_weights"] = {2: 1}
    return load_world(*_write_config(prop, mixer))


def test_fixed_values_follow_the_config():
    """Every value that used to be a constant in code now comes from the config."""
    world = _fixed_values_world()
    rows = sorted_rows_for_shard(world, DAY)
    assert not validate_rows(rows)
    failures = {k: v for k, v in run_all(world, DAY, rows).items() if v}
    assert not failures, failures

    purchases = [r for r in rows if r["event_name"] == "purchase"]
    assert purchases
    for row in purchases:
        ecommerce = row["ecommerce"]
        assert ecommerce["transaction_id"].startswith("T-")
        assert ecommerce["purchase_revenue_in_usd"] == round(ecommerce["purchase_revenue"] * 1.1 + 1e-9, 2)
        assert row["event_value_in_usd"] is not None
        for item in row["items"]:
            assert item["price_in_usd"] == round(item["price"] * 1.1 + 1e-9, 2)

    languages = {(r["geo"]["country"], r["device"]["language"]) for r in rows}
    assert ("France", "fr-fr") in languages and ("Germany", "xx-yy") in languages
    assert ("United States", "en-us") in languages

    paid = [r for r in rows if r["session_traffic_source_last_click"]["google_ads_campaign"]["customer_id"]]
    assert paid
    for row in paid:
        click = row["session_traffic_source_last_click"]
        assert click["google_ads_campaign"]["customer_id"] == "1234567890"
        assert click["google_ads_campaign"]["account_name"] == "GA4Dataform Ads"
        assert click["cross_channel_campaign"]["default_channel_group"] == "Cross-network"

    tiers = {_param(r, "shipping_tier") for r in rows if r["event_name"] == "add_shipping_info"}
    assert tiers == {"Standard", "Express"}
    assert {_param(r, "payment_type") for r in rows if r["event_name"] == "add_payment_info"} == {"PayPal"}
    for row in (r for r in rows if r["event_name"] == "view_item"):
        assert all(item["item_list_name"] is None and item["item_list_id"] is None for item in row["items"])

    offline = list(offline_orders_on(world, DAY))
    assert offline
    assert all(len(session.actions[0].payload["cart"]) == 2 for session in offline)


def test_shipping_tier_is_stable_within_a_session():
    world = _fixed_values_world()
    rows = sorted_rows_for_shard(world, DAY)
    for events in _by_session(rows).values():
        tiers = {_param(r, "shipping_tier") for r in events if r["event_name"] == "add_shipping_info"}
        assert len(tiers) <= 1


@pytest.mark.parametrize(
    "mutate,fragment",
    [
        (lambda p, m: p["property"].update(currency="EUR", usd_exchange_rate=None), "usd_exchange_rate is required"),
        (lambda p, m: p["property"].update(usd_exchange_rate=1.2), "must be 1.0 when property.currency is USD"),
        (lambda p, m: p["property"].update(currency="EUR", usd_exchange_rate=0), "must be a positive number"),
        (lambda p, m: p["geos"]["fr_paris"].update(language=""), "geos.fr_paris.language"),
        (lambda p, m: p["channels"]["email"].update(google_ads={"customer_id": "1"}), "no effect without `gclid: true`"),
        (lambda p, m: p["channels"]["paid_search"]["google_ads"].update(customer_id="abc"), "must be digits"),
        (lambda p, m: p["channels"]["paid_search"]["google_ads"].update(account_name="{site}"), "may only use the {brand} field"),
        (lambda p, m: p["channels"]["paid_search"]["google_ads"].update(manager="x"), "unknown keys"),
        (lambda p, m: p["channels"]["email"].update(channel_group=""), "channel_group must be a non-empty string"),
        (lambda p, m: p["ecommerce"].update(shipping_tier={"int_range": [1, 2]}), "must be a literal or a {choice"),
        (lambda p, m: p["ecommerce"].update(transaction_id_prefix=7), "transaction_id_prefix must be a string"),
        (lambda p, m: m["server_side"]["offline_orders"].update(line_item_weights={4: 1}), "more than cart.max_line_items"),
        (lambda p, m: m["server_side"]["offline_orders"].update(line_item_weights={0: 1}), "1 or greater"),
        (lambda p, m: m["retention"].update(decay_days=30), "both return_curve and decay_days"),
        (lambda p, m: p["tracking"].update(user_properties={"x": {"template": "{page_path}"}}),
         "a user property template can only use"),
    ],
)
def test_fixed_values_are_validated(mutate, fragment):
    prop, mixer = _base_config()
    mutate(prop, mixer)
    _expect_config_error(prop, mixer, fragment)


def test_defaults_match_the_shipped_config():
    """Leaving the new keys out reproduces the values an old config got.

    So a configuration written before those keys existed keeps its output.
    """
    prop, mixer = _base_config()
    prop["property"].pop("usd_exchange_rate")
    prop["property"].pop("default_language")
    for geo in prop["geos"].values():
        geo.pop("language", None)
    for cfg in prop["channels"].values():
        cfg.pop("channel_group", None)
        cfg.pop("google_ads", None)
    for key in ("transaction_id_prefix", "shipping_tier", "payment_type", "view_item_list_name"):
        prop["ecommerce"].pop(key)
    # The code default is an empty prefix, not this brand's "GD-".
    prop["ecommerce"]["transaction_id_prefix"] = "GD-"
    mixer["server_side"]["offline_orders"].pop("line_item_weights")
    bare = load_world(*_write_config(prop, mixer))
    shipped = load_world(*_write_config(*_base_config()))
    for geo in shipped.section("geos").values():
        assert bare.language(geo) == shipped.language(geo)
    for channel in shipped.section("channels"):
        assert bare.channel_group(channel) == shipped.channel_group(channel)
    assert bare.google_ads_account("paid_search") == shipped.google_ads_account("paid_search")
    # Adapted by the app on 2026-10-14 (decision D-97, ORIGIN.md): these
    # three are set by the app's configuration, which sells software and
    # posts nothing, so they no longer equal the code's defaults. The
    # guarantee is the same one: a configuration that leaves the keys out
    # still gets the values it always got.
    assert bare.ecommerce_setting("shipping_tier") == "Standard"
    assert bare.ecommerce_setting("payment_type") == "Credit Card"
    assert bare.ecommerce_setting("view_item_list_name") == "Product detail"
    assert bare.offline_line_item_weights == shipped.offline_line_item_weights
    assert bare.usd_exchange_rate == shipped.usd_exchange_rate == 1.0


# ---------------------------------------------------------------------------
# Scenarios and the lead funnel
# ---------------------------------------------------------------------------

from ga4synth.cli import main as cli_main  # noqa: E402
from ga4synth.world import available_scenarios, scenario_paths  # noqa: E402

SCENARIOS = ("default", "lead-generation", "ecommerce", "eu-consent")


def _scenario_world(name):
    return load_world(*scenario_paths(name))


@pytest.fixture(scope="module")
def lead_rows():
    world = _scenario_world("lead-generation")
    return world, sorted_rows_for_shard(world, DAY)


def test_the_shipped_scenarios_are_all_there():
    assert set(SCENARIOS) <= set(available_scenarios())


@pytest.mark.parametrize("name", SCENARIOS)
def test_every_scenario_passes_every_invariant(name):
    world = _scenario_world(name)
    rows = sorted_rows_for_shard(world, DAY)
    assert rows
    assert not validate_rows(rows)
    failures = {k: v for k, v in run_all(world, DAY, rows).items() if v}
    assert not failures, failures


def test_lead_events_carry_their_parameters(lead_rows):
    world, rows = lead_rows
    leads = [r for r in rows if r["event_name"] == "generate_lead"]
    assert len(leads) > 10
    for row in leads:
        assert _param(row, "value") == 150
        assert _param(row, "currency") == "USD"
        assert _param(row, "lead_source") in {"website", "webinar"}
        assert row["event_value_in_usd"] == 150.0
    submits = [r for r in rows if r["event_name"] == "form_submit"]
    assert submits
    for row in submits:
        assert _param(row, "form_id") == "demo-request"
        assert _param(row, "form_name") == "demo"
        assert _param(row, "form_submit_text") == "Book my demo"
        assert _param(row, "form_destination") == "https://ga4dataform.com/demo/thank-you"
    starts = [r for r in rows if r["event_name"] == "form_start"]
    assert len(starts) > len(submits), "some visitors start the form and leave"
    assert all(_param(r, "form_submit_text") is None for r in starts)


def test_a_lead_follows_its_form_in_the_same_session(lead_rows):
    _, rows = lead_rows
    checked = 0
    for events in _by_session(rows).values():
        names = [r["event_name"] for r in events]
        if "generate_lead" not in names:
            continue
        assert names.index("form_start") < names.index("form_submit") < names.index("generate_lead")
        assert _param(events[-1], "session_engaged") == "1"
        checked += 1
    assert checked > 10


def test_lead_funnel_nesting_check_can_fail(lead_rows):
    world, rows = lead_rows
    broken = [r for r in rows if r["event_name"] != "form_start"]
    assert run_all(world, DAY, broken)["check_funnel_nesting"]


def test_a_page_type_can_have_several_urls(lead_rows):
    _, rows = lead_rows
    blog = {
        _param(r, "page_location") for r in rows
        if r["event_name"] == "page_view" and "/blog/" in _param(r, "page_location")
    }
    assert len(blog) == 4


def test_default_scenario_is_a_basic_install():
    """The app's `default` is the same site as `ecommerce` without the shop.

    The only test here the app changed in the sync of D-95 (see ORIGIN.md).
    Upstream's `default` is another site altogether: a studio with a contact
    form, no consent banner and no sign-in. The app does not take it (D-23),
    so this test describes what the app's `default` is instead: the same site
    as `ecommerce` with no shop, which keeps the consent banner and the
    sign-in.
    """
    world = _scenario_world("default")
    rows = sorted_rows_for_shard(world, DAY)
    names = {r["event_name"] for r in rows}
    assert not names & {
        "view_item_list", "select_item", "view_item", "add_to_cart", "view_cart",
        "begin_checkout", "add_shipping_info", "add_payment_info", "purchase",
    }, "no event of a shop"
    assert not names & {"form_start", "form_submit", "generate_lead"}, "no lead funnel"
    assert all(not r["items"] for r in rows), "no item"
    assert any(r["user_pseudo_id"] is None for r in rows), "a consent banner"
    assert any(r["user_id"] is not None for r in rows), "a sign-in"


def test_eu_scenario_converts_currency_and_reports_local_languages():
    world = _scenario_world("eu-consent")
    rows = sorted_rows_for_shard(world, DAY)
    denied = sum(1 for r in rows if r["user_pseudo_id"] is None)
    assert 0.3 < denied / len(rows) < 0.6
    purchase = next(r for r in rows if r["event_name"] == "purchase")
    assert purchase["ecommerce"]["purchase_revenue_in_usd"] == round(
        purchase["ecommerce"]["purchase_revenue"] * 1.1 + 1e-9, 2
    )
    languages = {(r["geo"]["country"], r["device"]["language"]) for r in rows}
    assert ("Germany", "de-de") in languages and ("France", "fr-fr") in languages


def _lead_config():
    return (
        yaml.safe_load(open(scenario_paths("lead-generation")[0])),
        yaml.safe_load(open(scenario_paths("lead-generation")[1])),
    )


@pytest.mark.parametrize(
    "mutate,fragment",
    [
        (lambda p, m: m["journey"]["transitions"]["pricing"].update(lead_confirmation=5),
         "only contact can"),
        (lambda p, m: m["journey"]["entry_weights"].update(lead_confirmation=5),
         "cannot include lead_confirmation"),
        (lambda p, m: p["tracking"]["events"].update(form_submit=False),
         "the lead funnel must be enabled as an unbroken run"),
        (lambda p, m: p["leads"].update(score=5), "leads has unknown keys"),
        (lambda p, m: p["leads"].update(value=-1), "leads.value must be a non-negative number"),
        (lambda p, m: p["leads"].update(value={"template": "{page_path}"}), "leads.value may only use"),
        (lambda p, m: p["pages"]["blog"].append({"title": "x"}), "is missing 'path'"),
        (lambda p, m: p["pages"]["pricing"].update(weight=2), "only applies to a list"),
        (lambda p, m: m["journey"].update(form_start_rate=2), "form_start_rate must be a probability"),
        (lambda p, m: p["tracking"]["custom_events"].append(
            {"name": "generate_lead", "on_page": ["home"], "rate": 0.1}), "standard GA4 event"),
    ],
)
def test_lead_config_is_validated(mutate, fragment):
    prop, mixer = _lead_config()
    mutate(prop, mixer)
    _expect_config_error(prop, mixer, fragment)


def test_cli_scenario_flag(capsys):
    assert cli_main(["summary", "--scenario", "no-such-scenario", "--date", "2026-08-25"]) == 2
    assert "available: " in capsys.readouterr().err
    assert cli_main(["summary", "--scenario", "default", "--property", "x.yaml", "--date", "2026-08-25"]) == 2
    assert "--scenario replaces --property" in capsys.readouterr().err
