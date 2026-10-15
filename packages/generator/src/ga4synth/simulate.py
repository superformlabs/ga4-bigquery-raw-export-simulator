"""The behavioural layer: visitors, sessions, and journeys.

This module knows nothing about the GA4 export format. It produces an abstract
stream of ``Action`` objects, and ``serialize.py`` turns those into export rows.
Keeping the split means behavioural realism and schema fidelity can be reasoned
about, and tested, separately.

Determinism without state
-------------------------
Generating a single daily shard must not require reading any other shard, yet
returning visitors have to be the *same* people across days. Both hold because
visitor identity is derived, not stored:

* A visitor is identified by ``(cohort_date, index)``, where the cohort date is
  the day of their first visit.
* Cohort sizes depend only on the date, so any past cohort can be reconstructed.
* Whether a visitor returns on a later day is a deterministic function of their
  identity and that day.
* So are the number of sessions they have on that day and each one's start
  time, so earlier sessions can be counted and replayed without building them.

So generating day D replays the *identities* of the last ``retention.window_days``
cohorts, which is cheap, and never their events.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field
from typing import Any, Iterator
from zoneinfo import ZoneInfo

from .rng import derive, stable_int, uniform, weighted_choice
from .world import World

# Page types that emit an ecommerce funnel event, in funnel order. Used by the
# invariant suite to check nesting.
FUNNEL_ORDER = ["view_item", "add_to_cart", "view_cart", "begin_checkout", "purchase"]


@dataclass(frozen=True)
class CartLine:
    item_id: str
    item_name: str
    category: str
    variant: str
    price: float
    quantity: int


@dataclass
class Action:
    """One abstract event, positioned in absolute time."""

    event_name: str
    when: dt.datetime  # timezone-aware, UTC
    page_type: str
    page_path: str
    page_title: str
    page_referrer: str | None
    batch_page_id: int
    payload: dict[str, Any] = field(default_factory=dict)
    # The channel whose campaign this event collected, or None for the events
    # that collected nothing. Set on the entrance events, and on a page view
    # that re-acquired the visit part-way through the session.
    acquisition: str | None = None


@dataclass
class Visitor:
    cohort: dt.date
    index: int
    user_pseudo_id: str
    first_touch_us: int
    device: dict[str, Any]
    geo: dict[str, Any]
    language: str
    first_channel: str
    # The person behind the device. Several visitors can share one person_id:
    # that is how cross-device behaviour reaches the export, since a shared
    # user_id is the only thing that links two browsers.
    person_id: str
    # Whether that person signs in. Decided on the person, not the device, so
    # every device of a signed-in person reports the user_id on every event.
    # A device that flipped between user_id and NULL would fragment the person
    # for anything downstream that keys on COALESCE(user_id, user_pseudo_id).
    authenticated: bool
    # Whether this identity anchors its person rather than being a second device.
    # Offline orders are placed against a person's primary device only.
    primary_device: bool
    # Latent purchase intent, drawn once. It is what links coming back with
    # buying: the same trait that makes a visitor return soon also makes their
    # visits convert, so returning sessions convert better without any visitor
    # needing to remember what happened on an earlier day.
    intent: str


@dataclass
class Session:
    visitor: Visitor
    session_number: int
    # None for a server-side order sent without a session id.
    ga_session_id: int | None
    channel: str
    started: dt.datetime
    actions: list[Action]
    engaged: bool
    analytics_granted: bool
    ads_granted: bool
    user_id: str | None
    # The channel GA4 attributes the whole session to: the last campaign
    # clicked during it. Differs from `channel` only when the visit was
    # re-acquired part-way through.
    last_click_channel: str
    # The visitor's earlier sessions, oldest first, each as (visit date,
    # ordinal within that day). Ordinal 0 is the day's first session. Empty for
    # a first session. serialize.py replays these to accumulate lifetime revenue.
    prior_sessions: tuple[tuple[dt.date, int], ...] = ()
    # An order sent from the server with no browser session behind it, such as
    # a phone or account reorder. Its only action is a server-side purchase.
    server_side_only: bool = False
    # GA4 dropped or delayed the opening hit, so session_start (and first_visit)
    # never reach the export. The actions stay in place and the serialiser
    # withholds their rows, which leaves every other row of the session as is.
    start_dropped: bool = False


# ---------------------------------------------------------------------------
# Visitor identity
# ---------------------------------------------------------------------------


def _session_start_local(world: World, cohort: dt.date, index: int, day: dt.date) -> dt.datetime:
    """Pick a session start time on ``day``, weighted by hour of day."""
    rng = derive(world.master_seed, "start", cohort.isoformat(), index, day.isoformat())
    weights = world.section("session")["hour_weights"]
    hour = rng.choices(range(24), weights=weights, k=1)[0]
    naive = dt.datetime(
        day.year, day.month, day.day, hour, rng.randrange(60), rng.randrange(60),
        rng.randrange(1_000_000),
    )
    return naive.replace(tzinfo=ZoneInfo(world.timezone))


def _session_starts(world: World, cohort: dt.date, index: int, day: dt.date) -> list[dt.datetime]:
    """Start times, in UTC, of every session a visitor has on a visit day.

    The first entry is the day's first session, and the extras do not change
    its start. Each extra session starts a drawn gap after the previous start.
    The count and the gaps come from their own stream, keyed on the identity
    and the day, so anything that needs to count or replay a visitor's sessions
    can do so without building one.

    The configured minimum gap is longer than the longest possible session plus
    GA4's session timeout (load_world checks this), so two sessions never
    overlap and never merge. An extra that would start after local midnight is
    dropped, so every session of a visit day starts on that local day. So is an
    extra that would start less than the minimum gap before the visitor's first
    session of the next day, which keeps that first session where it was.
    """
    starts = [_session_start_local(world, cohort, index, day).astimezone(dt.timezone.utc)]
    counts, weights = world.extra_session_weights
    if not counts:
        return starts
    rng = derive(world.master_seed, "extra-sessions", cohort.isoformat(), index, day.isoformat())
    extras = rng.choices(counts, weights=weights, k=1)[0]
    gap_low, gap_high = world.extra_session_gap_seconds
    min_gap = dt.timedelta(seconds=gap_low)
    tz = ZoneInfo(world.timezone)
    tomorrow = day + dt.timedelta(days=1)
    for _ in range(extras):
        # Added in UTC, so a daylight saving change cannot shorten the gap.
        candidate = starts[-1] + dt.timedelta(seconds=rng.uniform(gap_low, gap_high))
        if candidate.astimezone(tz).date() != day:
            break
        # Only a late extra can reach into tomorrow, so the replay of
        # tomorrow's visit is skipped for all the others.
        if (candidate + min_gap).astimezone(tz).date() != day and _returns_on(world, cohort, index, tomorrow):
            if candidate + min_gap > _session_start_local(world, cohort, index, tomorrow):
                break
        starts.append(candidate)
    return starts


def _intent(world: World, cohort: dt.date, index: int) -> str:
    """A visitor's latent purchase-intent segment.

    ``intent.channel_segment_weights`` can make the segment depend on the
    channel that first brought the visitor, so that a channel draws browsers
    and another buyers. The draw itself is the same either way: a visitor
    whose channel is not listed gets exactly the segment it had without the
    setting.
    """
    weights = {name: seg["weight"] for name, seg in world.intent_segments.items()}
    by_channel = world.channel_segment_weights
    if by_channel:
        weights = by_channel.get(_visitor_draws(world, cohort, index)[2], weights)
    draw = uniform(world.master_seed, "intent", cohort.isoformat(), index)
    total = sum(weights.values())
    running = 0.0
    for name, weight in weights.items():
        running += weight / total
        if draw < running:
            return name
    return name


def _returns_on(world: World, cohort: dt.date, index: int, day: dt.date) -> bool:
    delta = (day - cohort).days
    probability = world.return_probability(delta) * world.day_factors(day).returns
    if probability <= 0.0:
        return False
    draw = derive(
        world.master_seed, "return", cohort.isoformat(), index, day.isoformat()
    ).random()
    # Almost every draw clears even the most loyal segment's threshold, so the
    # intent lookup only runs for the few that might actually return.
    if draw >= probability * world.max_return_factor:
        return False
    return draw < probability * world.intent_segments[_intent(world, cohort, index)]["return_factor"]


def _visit_dates(world: World, cohort: dt.date, index: int, upto: dt.date) -> list[dt.date]:
    """All visit dates for a visitor from their cohort day through ``upto``."""
    dates = [cohort]
    day = cohort + dt.timedelta(days=1)
    while day <= upto:
        if _returns_on(world, cohort, index, day):
            dates.append(day)
        day += dt.timedelta(days=1)
    return dates


# How many candidate identities a second device tries before giving up and
# anchoring on itself. Eight leaves well under 1% of attempts unsatisfied at
# the shipped shares, while keeping the work per visitor constant.
_ROOT_ATTEMPTS = 8


def _is_authenticated(world: World, cohort: dt.date, index: int) -> bool:
    """Whether the person anchored at this identity signs in.

    Drawn on the person's root identity so that every device of one person
    agrees, without any of them having to be generated.
    """
    share = world.user_id_share
    if share <= 0.0:
        return False
    return derive(world.master_seed, "auth", cohort.isoformat(), index).random() < share


def _is_second_device(world: World, cohort: dt.date, index: int) -> bool:
    """Whether this visitor is an existing person arriving on another device."""
    share = world.cross_device_share
    if share <= 0.0:
        return False
    return derive(world.master_seed, "person", cohort.isoformat(), index).random() < share


def _consent(world: World, cohort: dt.date, index: int) -> tuple[bool, bool]:
    """Whether this visitor grants ``(analytics_storage, ads_storage)``.

    Consent is a choice made once on the cookie banner, so it is drawn on the
    visitor's identity and holds on every session. A visitor who denies
    analytics storage also denies ads storage. ``consent.ads_granted`` is
    therefore the share of analytics-consenting visitors who grant ads storage.

    With ``consent.enabled: false`` every visitor grants both, whatever the
    shares say.
    """
    if not world.consent_enabled:
        return True, True
    consent = world.section("consent")
    rng = derive(world.master_seed, "consent", cohort.isoformat(), index)
    analytics = rng.random() < float(consent["analytics_granted"])
    ads = rng.random() < float(consent["ads_granted"])
    return analytics, analytics and ads


def _start_dropped(world: World, visitor: Visitor, ga_session_id: int) -> bool:
    """Whether GA4 lost the opening hit of this browser session."""
    rate = world.missing_session_start_rate
    if rate <= 0.0:
        return False
    draw = uniform(
        world.master_seed, "start-dropped", visitor.cohort.isoformat(), visitor.index,
        ga_session_id,
    )
    return draw < rate


def _person_root(world: World, cohort: dt.date, index: int) -> tuple[dt.date, int]:
    """The identity anchoring this visitor's person.

    A visitor's own identity, unless they are a second device, in which case
    the earlier identity they belong to. Stateless in the same way visitors
    are: the root is drawn from the visitor's own seed, so the two agree
    without either being generated for the other.
    """
    if not _is_second_device(world, cohort, index):
        return cohort, index

    # Same stream as _is_second_device, continued past its first draw.
    rng = derive(world.master_seed, "person", cohort.isoformat(), index)
    rng.random()

    # Not every identity can host a second device. One that is itself a second
    # device would chain them into an arbitrarily long trail, and an anonymous
    # one has no user_id to be recognised by, so the link would be invisible in
    # the export. Both are common enough that taking the first candidate would
    # waste most of the draws and leave cross_device_share meaning far less
    # than it says, so the search retries before giving up.
    for _ in range(_ROOT_ATTEMPTS):
        lag = rng.randrange(1, world.cross_device_max_lag_days + 1)
        root_cohort = cohort - dt.timedelta(days=lag)
        # new_visitors_on never returns less than 1, so the cohort is never empty.
        root_index = rng.randrange(world.new_visitors_on(root_cohort))
        if _is_second_device(world, root_cohort, root_index):
            continue
        if not _is_authenticated(world, root_cohort, root_index):
            continue
        return root_cohort, root_index

    return cohort, index


def _visitor_draws(world: World, cohort: dt.date, index: int) -> tuple[dict[str, str], dict[str, str], str]:
    """The device, geography and first channel of a visitor, from its own stream.

    One sequence of draws, in a fixed order, so that the first channel can be
    looked up without building the whole visitor.
    """
    rng = derive(world.master_seed, "visitor", cohort.isoformat(), index)

    # A second device can have a mix of its own: people discover a shop on
    # their phone and come back to buy on a computer.
    device_weights = world.device_weights
    # The test is the outcome, not the draw: a visitor drawn as a second device
    # that finds no one to belong to stays a primary device.
    if world.cross_device_device_weights and _person_root(world, cohort, index) != (cohort, index):
        device_weights = world.cross_device_device_weights
    category = weighted_choice(rng, device_weights)
    device_cfg = world.section("devices")[category]
    device = {
        "category": category,
        "operating_system": rng.choice(device_cfg["os"]),
        "browser": rng.choice(device_cfg["browser"]),
        # Real exports leave mobile_brand_name empty for desktop.
        "mobile_brand_name": rng.choice(device_cfg["brand"]) if device_cfg.get("brand") else "",
    }

    geo_options, geo_weights = world.geo_choices()
    geo = rng.choices(geo_options, weights=geo_weights, k=1)[0]

    channel_weights = world.channel_weights_on(cohort)
    skew = world.device_channel_skew.get(category)
    if skew:
        channel_weights = {name: w * skew.get(name, 1.0) for name, w in channel_weights.items()}
    first_channel = weighted_choice(rng, channel_weights)
    return device, geo, first_channel


def _materialise(world: World, cohort: dt.date, index: int) -> Visitor:
    """Build a visitor's stable attributes.

    Device, geography, and language are visitor-scoped: a returning visitor
    comes back on the same device, as GA4 would see it through one browser's
    pseudo id. A person on a second device is a *separate* visitor with its own
    device and its own pseudo id, linked to the first only by a shared
    person_id, which is exactly the shape the export has.
    """
    device, geo, first_channel = _visitor_draws(world, cohort, index)

    first_touch = _session_start_local(world, cohort, index, cohort)
    first_touch_us = int(first_touch.timestamp() * 1_000_000)
    # GA4 renders user_pseudo_id as "<10-digit>.<first-touch epoch seconds>".
    pseudo = f"{stable_int(world.master_seed, cohort.isoformat(), index)}.{int(first_touch.timestamp())}"

    root_cohort, root_index = _person_root(world, cohort, index)

    return Visitor(
        cohort=cohort,
        index=index,
        user_pseudo_id=pseudo,
        first_touch_us=first_touch_us,
        device=device,
        geo=dict(geo),
        language=world.language(geo),
        first_channel=first_channel,
        # 12 digits, for the reason _transaction_id is 12 digits: at 9 the
        # birthday bound puts a collision among this many people at better than
        # even odds, and a collision here silently merges two unrelated people
        # into one user_id, which is the one thing this identifier must not do.
        person_id=f"u{stable_int(world.master_seed, 'person_id', root_cohort.isoformat(), root_index, digits=12)}",
        authenticated=_is_authenticated(world, root_cohort, root_index),
        primary_device=(root_cohort, root_index) == (cohort, index),
        intent=_intent(world, cohort, index),
    )


# A visitor's earlier sessions, oldest first, each as (visit date, ordinal
# within that day). Ordinal 0 is the day's first session.
PriorSessions = tuple[tuple[dt.date, int], ...]


def _sessions_through(
    world: World, cohort: dt.date, index: int, upto: dt.date
) -> list[tuple[dt.date, int]]:
    """Every session of a visitor from their cohort day through ``upto``.

    Each entry is ``(visit date, ordinal within that day)``, oldest first. The
    position of an entry in the list, counted from 1, is its ga_session_number.
    """
    return [
        (date, ordinal)
        for date in _visit_dates(world, cohort, index, upto)
        for ordinal in range(len(_session_starts(world, cohort, index, date)))
    ]


def visits_on(world: World, day: dt.date) -> Iterator[tuple[Visitor, int, PriorSessions]]:
    """Yield ``(visitor, session_number, prior_sessions)`` for each session on ``day``.

    New visitors come from ``day``'s own cohort; returning visitors are found by
    replaying the identities of earlier cohorts within the retention window.
    The prior sessions fall out of the same replay that establishes the session
    number, so they are handed back rather than recomputed by the caller.

    A visitor with several sessions on ``day`` is yielded once per session, in
    start order. The earlier sessions of the day are part of ``prior_sessions``,
    so the number of entries dated ``day`` is the session's ordinal within it.
    """
    def sessions(cohort: dt.date, index: int, prior: list[tuple[dt.date, int]]):
        visitor = _materialise(world, cohort, index)
        for ordinal in range(len(_session_starts(world, cohort, index, day))):
            yield visitor, len(prior) + 1, tuple(prior)
            prior = prior + [(day, ordinal)]

    # New visitors.
    for index in range(world.new_visitors_on(day)):
        yield from sessions(day, index, [])

    # Returning visitors.
    for age in range(1, world.retention_window + 1):
        cohort = day - dt.timedelta(days=age)
        for index in range(world.new_visitors_on(cohort)):
            if not _returns_on(world, cohort, index, day):
                continue
            prior = _sessions_through(world, cohort, index, day - dt.timedelta(days=1))
            yield from sessions(cohort, index, prior)


# ---------------------------------------------------------------------------
# Journey
# ---------------------------------------------------------------------------


def _slug(text: str) -> str:
    """Lowercase hyphenated slug, as most sites build URLs."""
    return "-".join(str(text).lower().split())


def _page(world: World, rng, page_type: str, payload: dict[str, Any]) -> tuple[str, str]:
    """Return ``(path, title)`` for a page, from the configured templates.

    Page *types* are a fixed vocabulary because their funnel semantics live in
    code, but what each one looks like is entirely configuration, so a reuser can
    point this at their own URL structure without touching Python.
    """
    pages = world.section("pages")
    if page_type not in pages:
        raise ValueError(
            f"page type {page_type!r} has no entry under `pages` in the config"
        )
    template = pages[page_type]
    if isinstance(template, list):
        template = template[payload.get("variant", 0)]

    fields: dict[str, Any] = {"brand": world.section("property")["brand"]}
    if "category" in payload:
        fields["category"] = payload["category"]
        fields["category_slug"] = _slug(payload["category"])
    if "item" in payload:
        fields["item_name"] = payload["item"]["item_name"]
        fields["item_slug"] = _slug(payload["item"]["item_name"])
        fields["item_id"] = payload["item"]["item_id"]
    if "search_term" in payload:
        fields["search_term"] = payload["search_term"]
        fields["search_query"] = "+".join(str(payload["search_term"]).split())

    try:
        return template["path"].format(**fields), template["title"].format(**fields)
    except KeyError as error:
        raise ValueError(
            f"pages.{page_type} template references {error} which is not available "
            f"for this page type; available: {sorted(fields)}"
        ) from error


def _build_cart(world: World, rng, viewed: list[dict[str, Any]]) -> list[CartLine]:
    """Turn viewed products into cart lines.

    Only products the visitor actually viewed can end up in the cart. This is
    what keeps the funnel nested, and it is checked by the invariant suite.
    """
    max_lines = int(world.section("cart")["max_line_items"])
    quantities, quantity_weights = world.cart_quantities()
    chosen = viewed[-max_lines:] if len(viewed) > max_lines else viewed
    lines = []
    for item in chosen:
        lines.append(
            CartLine(
                item_id=item["item_id"],
                item_name=item["item_name"],
                category=item["category"],
                variant=rng.choice(item["variants"]),
                price=float(item["price"]),
                quantity=rng.choices(quantities, weights=quantity_weights, k=1)[0],
            )
        )
    return lines


def build_session(
    world: World,
    visitor: Visitor,
    session_number: int,
    day: dt.date,
    prior_sessions: PriorSessions = (),
    ordinal: int | None = None,
) -> Session:
    """Simulate one session and return it with its ordered actions.

    ``ordinal`` is the session's position among the visitor's sessions on
    ``day``, with 0 for the first. When omitted it is the number of entries in
    ``prior_sessions`` dated ``day``, which is what ``visits_on`` hands back.

    ``prior_sessions`` does not otherwise affect behaviour; it is carried so the
    serialiser can accumulate lifetime revenue. Replaying a prior session can
    therefore pass its ordinal and leave the history empty without recursing.
    """
    if ordinal is None:
        ordinal = sum(1 for date, _ in prior_sessions if date == day)
    # The first session of a day keeps the key it had before extra sessions
    # existed, so they leave it unchanged. Extra sessions get their own stream.
    if ordinal == 0:
        rng = derive(
            world.master_seed, "session", visitor.cohort.isoformat(), visitor.index,
            day.isoformat(),
        )
    else:
        rng = derive(
            world.master_seed, "extra-session", visitor.cohort.isoformat(), visitor.index,
            day.isoformat(), ordinal,
        )
    journey = world.section("journey")
    catalogue = world.section("catalogue")
    tracking = world.section("tracking")
    custom_events = tracking.get("custom_events") or []

    # Channel: a returning visitor is not necessarily reacquired the same way.
    if session_number == 1:
        channel = visitor.first_channel
    else:
        # A returning visitor is not necessarily reacquired the same way.
        channel = weighted_choice(rng, world.returning_channel_weights(day))

    started_utc = _session_starts(world, visitor.cohort, visitor.index, day)[ordinal]
    ga_session_id = int(started_utc.timestamp())
    reacquire_at: int | None = None
    reacquire_channel: str | None = None

    # The referrer belongs to the source this acquisition drew, which
    # world.acquisition keys on the session's start second.
    external_referrer = world.acquisition(channel, visitor.user_pseudo_id, ga_session_id)["referrer"]
    gap_low, gap_high = world.section("session")["event_gap_seconds"]

    # How likely this visit is to move down the funnel: the visit number, the
    # visitor's latent intent, and the day (demand drift and calendar events).
    conversion = (
        world.session_number_conversion_factor(session_number)
        * world.intent_segments[visitor.intent]["conversion_factor"]
        * world.day_factors(day).conversion
    )
    if (world.raw.get("intent") or {}).get("device_conversion_factor"):
        conversion *= world.device_conversion_factor(visitor.device["category"])
    transitions, add_to_cart_rate = world.scaled_journey(conversion)
    form_start_rate = world.form_start_rate(conversion)
    server = world.server_side
    server_share = float(server.get("purchase_share", 0.0))
    analytics_granted, ads_granted = _consent(world, visitor.cohort, visitor.index)

    # Walk the page graph.
    page_type = weighted_choice(rng, journey["entry_weights"])
    walk: list[str] = []
    while len(walk) < int(journey["max_pages"]):
        walk.append(page_type)
        nxt = weighted_choice(rng, transitions[page_type])
        if nxt == "end":
            break
        page_type = nxt

    # Payloads are resolved for the whole walk up front, so a page can look
    # ahead at the next one. select_item needs this: it fires on the listing
    # page but names the product that the *following* page will show.
    pages: list[tuple[str, dict[str, Any]]] = []
    for position, page_type in enumerate(walk):
        payload: dict[str, Any] = {}
        if page_type == "plp":
            payload["category"] = rng.choice(sorted({i["category"] for i in catalogue}))
        elif page_type == "pdp":
            payload["item"] = rng.choice(catalogue)
        elif page_type == "search":
            payload["search_term"] = rng.choice(world.section("search_terms"))
        variants = world.section("pages")[page_type]
        if isinstance(variants, list) and len(variants) > 1:
            # Its own stream, so giving a page several URLs moves no other draw.
            payload["variant"] = derive(
                world.master_seed, "page-variant", visitor.cohort.isoformat(), visitor.index,
                day.isoformat(), ordinal, position,
            ).choices(range(len(variants)), weights=[float(v.get("weight", 1)) for v in variants], k=1)[0]
        pages.append((page_type, payload))

    # A campaign clicked part-way through a visit. GA4 does not start a new
    # session for it, so one session ends up carrying two acquisitions: the
    # one it arrived on, and the one collected on the page that re-acquired
    # it. A single-page session has nowhere to switch, so it never qualifies.
    if world.source_change_rate > 0.0 and len(pages) > 1:
        if rng.random() < world.source_change_rate:
            options = world.reacquisition_channel_weights(exclude=channel, day=day)
            if options:
                reacquire_at = rng.randrange(1, len(pages))
                reacquire_channel = weighted_choice(rng, options)

    actions: list[Action] = []
    cursor = started_utc
    viewed: list[dict[str, Any]] = []
    cart: list[CartLine] = []
    previous_url: str | None = None
    batch_page_id = rng.randrange(10**8, 10**9)
    transaction_seq = 0

    def page_load_delay() -> dt.timedelta:
        """The gap between a page_view and an event that fires as the page loads.

        Only first_visit, session_start and page_view share a timestamp. Any
        other event tied with session_start would compete with it for the
        session's first event, and it collected no campaign.
        """
        return dt.timedelta(seconds=rng.uniform(*world.dwell("page_load")))

    for position, (page_type, payload) in enumerate(pages):
        path, title = _page(world, rng, page_type, payload)
        url = f"https://{world.hostname}{path}"
        # A re-acquired page arrives from the new campaign, so it carries that
        # channel's referrer rather than the page the visitor came from.
        if position == reacquire_at:
            acquired = reacquire_channel
            referrer = world.acquisition(
                reacquire_channel, visitor.user_pseudo_id, ga_session_id
            )["referrer"]
        else:
            acquired = channel if position == 0 else None
            referrer = previous_url if position > 0 else external_referrer
        batch_page_id += 1

        def emit(
            event_name: str,
            extra: dict[str, Any] | None = None,
            at: dt.datetime | None = None,
            acquisition: str | None = None,
        ) -> None:
            actions.append(
                Action(
                    event_name=event_name,
                    when=at or cursor,
                    page_type=page_type,
                    page_path=path,
                    page_title=title,
                    page_referrer=referrer,
                    batch_page_id=batch_page_id,
                    payload=extra or {},
                    acquisition=acquisition,
                )
            )

        # The first page load of a session also carries session_start, and
        # first_visit for a brand new user. GA4 batches these at the same
        # timestamp as the page_view, ordered within the batch.
        if position == 0:
            if session_number == 1:
                emit("first_visit", acquisition=acquired)
            emit("session_start", acquisition=acquired)

        emit("page_view", {"entrances": position == 0}, acquisition=acquired)

        next_entry = pages[position + 1] if position + 1 < len(pages) else None

        if page_type == "plp":
            # With ecommerce off a listing is just a page_view; view_item_list
            # carries items, so it is one of the events that switch off wholesale.
            if world.event_enabled("view_item_list"):
                listed = [i for i in catalogue if i["category"] == payload["category"]]
                cursor += page_load_delay()
                emit("view_item_list", {"items": listed, "list_name": payload["category"]})
            # Clicking through from a listing to a product emits select_item,
            # naming the product about to be viewed.
            if world.event_enabled("select_item") and next_entry and next_entry[0] == "pdp":
                cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("select_item")))
                emit(
                    "select_item",
                    {"item": next_entry[1]["item"], "list_name": payload["category"]},
                )
        elif page_type == "pdp":
            item = payload["item"]
            viewed.append(item)
            if world.event_enabled("view_item"):
                cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("view_item")))
                emit("view_item", {"item": item})
        elif page_type == "search":
            if world.event_enabled("view_search_results"):
                cursor += page_load_delay()
                emit("view_search_results", {"search_term": payload["search_term"]})
        elif page_type == "cart":
            if world.event_enabled("view_cart"):
                cursor += page_load_delay()
                emit("view_cart", {"cart": cart})
        elif page_type == "checkout":
            if world.event_enabled("begin_checkout"):
                cursor += page_load_delay()
                emit("begin_checkout", {"cart": cart})
            if world.event_enabled("add_shipping_info"):
                cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("add_shipping_info")))
                emit("add_shipping_info", {"cart": cart})
            if world.event_enabled("add_payment_info"):
                cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("add_payment_info")))
                emit("add_payment_info", {"cart": cart})
        elif page_type == "contact":
            # Sending the form is what takes the visitor to the confirmation
            # page, so a form that is sent was also started. A visitor who
            # leaves without sending it may still have started filling it in.
            submits = next_entry is not None and next_entry[0] == "lead_confirmation"
            if world.event_enabled("form_start") and (submits or rng.random() < form_start_rate):
                cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("form_start")))
                emit("form_start")
        elif page_type == "lead_confirmation":
            if world.event_enabled("generate_lead"):
                cursor += page_load_delay()
                emit("generate_lead")
        elif page_type == "purchased":
            if world.event_enabled("purchase"):
                cursor += page_load_delay()
                transaction_seq += 1
                order = {
                    "cart": cart,
                    "transaction_id": _transaction_id(world, visitor, day, transaction_seq, ordinal),
                }
                # Some sites confirm the order from the server once payment
                # clears, instead of from the thank-you page. The browser still
                # loads that page, but the purchase arrives a little later with
                # no session attached.
                # A visitor who denied analytics storage has no client id for
                # the server to report against, so their purchase stays in the
                # browser. The draw is still taken, so consent never shifts
                # the rest of the session.
                server_confirmed = server_share > 0.0 and rng.random() < server_share
                if server_confirmed and analytics_granted:
                    low, high = server.get("confirmation_delay_seconds", [30, 900])
                    order["server_side"] = True
                    emit("purchase", order, at=cursor + dt.timedelta(seconds=rng.uniform(low, high)))
                else:
                    emit("purchase", order)

        # Enhanced measurement, gated by the same toggles GA4 exposes in its
        # admin UI. Turning one off removes the event from the dataset.
        if world.event_enabled("scroll") and rng.random() < float(journey["scroll_rate"]):
            cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("scroll")))
            emit("scroll", {"percent_scrolled": world.scroll_depth_percent})
        if world.event_enabled("click") and rng.random() < float(journey["outbound_click_rate"]):
            cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("outbound_click")))
            emit("click", {"link_url": rng.choice(world.section("outbound_links"))})

        # Events this property defines for itself. The parameter specifications
        # travel with the action and are resolved during serialisation, where
        # the full event context is available for templates.
        for custom in custom_events:
            if page_type not in custom.get("on_page", []):
                continue
            rate = float(custom.get("rate", 0.0))
            by_intent = custom.get("rate_by_intent")
            if by_intent:
                # The same draw either way, so other events stay where they were.
                rate = min(1.0, rate * float(by_intent.get(visitor.intent, 1.0)))
            if rng.random() >= rate:
                continue
            cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("custom_event")))
            emit(custom["name"], {"custom_params": custom.get("params") or {}})

        # add_to_cart happens on a product page. It is forced when the next page
        # is the cart and nothing has been added yet, because a cart view with an
        # empty cart would break funnel nesting.
        wants_cart = next_entry is not None and next_entry[0] == "cart"
        if (page_type == "pdp" and world.event_enabled("add_to_cart")
                and (rng.random() < add_to_cart_rate or (wants_cart and not cart))):
            line = _build_cart(world, rng, [payload["item"]])[0]
            cart = cart + [line]
            cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("add_to_cart")))
            emit("add_to_cart", {"cart": [line]})

        # form_submit is the last thing on a contact page: it navigates away.
        if (page_type == "contact" and world.event_enabled("form_submit")
                and next_entry is not None and next_entry[0] == "lead_confirmation"):
            cursor += dt.timedelta(seconds=rng.uniform(*world.dwell("form_submit")))
            emit("form_submit")

        previous_url = url
        cursor += dt.timedelta(seconds=rng.uniform(gap_low, gap_high))

    # A server-confirmed purchase is not part of the browser session, so it
    # neither counts towards engagement nor anchors the closing events.
    server_actions = [a for a in actions if a.payload.get("server_side")]
    actions = [a for a in actions if not a.payload.get("server_side")]

    # Engagement is derived from what actually happened, not drawn independently.
    page_views = sum(1 for a in actions if a.event_name == "page_view")
    duration = (actions[-1].when - actions[0].when).total_seconds() if actions else 0.0
    session_cfg = world.section("session")
    engaged = (
        page_views >= int(session_cfg["engaged_min_page_views"])
        or duration >= float(session_cfg["engaged_min_seconds"])
        or any(a.event_name in ("purchase", "generate_lead") for a in actions)
    )

    # A trailing user_engagement is only sent for engaged sessions.
    if engaged and actions:
        actions.append(
            Action(
                event_name="user_engagement",
                when=cursor,
                page_type=actions[-1].page_type,
                page_path=actions[-1].page_path,
                page_title=actions[-1].page_title,
                page_referrer=actions[-1].page_referrer,
                batch_page_id=actions[-1].batch_page_id,
            )
        )

    actions.extend(server_actions)

    return Session(
        visitor=visitor,
        session_number=session_number,
        ga_session_id=ga_session_id,
        channel=channel,
        started=started_utc,
        actions=actions,
        engaged=engaged,
        analytics_granted=analytics_granted,
        ads_granted=ads_granted,
        # Sign-in is a property of the person, so it is the same on every
        # device they use and on every session they have.
        user_id=visitor.person_id if visitor.authenticated else None,
        last_click_channel=reacquire_channel or channel,
        prior_sessions=prior_sessions,
        start_dropped=_start_dropped(world, visitor, ga_session_id),
    )


def _transaction_id(world: World, visitor: Visitor, day: dt.date, seq: int, ordinal: int = 0) -> str:
    """A transaction id unique to ``(visitor, day, ordinal, seq)``.

    ``ordinal`` is the session's position within the visitor's day. It joins
    the key only for an extra session, so the ids of a day's first session are
    the ones it had before extra sessions existed.

    The key is unique by construction, but the id is a hash of it, so the width
    of the hash is what actually bounds collisions. At 8 digits the space is
    9e7, and a 6k-transaction dataset draws two matching ids about 2% of the
    time by the birthday bound -- which is exactly what happened in the first
    published run. 12 digits puts that below 1e-4 even for several years of
    output. Widening the hash rather than deduplicating against a ledger is
    what keeps a shard reproducible without reading any other shard.
    """
    key: tuple[object, ...] = (visitor.user_pseudo_id, day.isoformat(), seq)
    if ordinal:
        key += ("extra-session", ordinal)
    number = stable_int(world.master_seed, "txn", *key, digits=12)
    return f"{world.ecommerce_setting('transaction_id_prefix')}{number}"


# ---------------------------------------------------------------------------
# Offline orders
# ---------------------------------------------------------------------------
# Orders a signed-in customer places without visiting the site, such as a phone
# or account reorder, which the server reports to GA4 against the customer's
# stored client id. They are the realistic source of a conversion with no
# traffic touch in front of it.


def _places_offline_order(world: World, cohort: dt.date, index: int, day: dt.date) -> bool:
    """Whether this identity places an offline order on ``day``.

    Only a signed-in person's primary device qualifies: the server needs a known
    customer to report against. A visitor who denied analytics storage places
    none, because the server has no client id to report them under. The cheap
    draw runs first so the identity checks only happen for the rare hit.
    """
    if not world.offline_orders_enabled:
        return False
    cfg = world.server_side["offline_orders"]
    rate = float(cfg["daily_rate"])
    delta = (day - cohort).days
    if delta < 1:
        return False
    probability = rate * math.exp(-delta / float(cfg.get("decay_days", 60)))
    if uniform(world.master_seed, "offline", cohort.isoformat(), index, day.isoformat()) >= probability:
        return False
    if _person_root(world, cohort, index) != (cohort, index):
        return False
    if not _is_authenticated(world, cohort, index):
        return False
    return _consent(world, cohort, index)[0]


def _offline_order_dates(world: World, visitor: Visitor, before: dt.datetime) -> list[dt.date]:
    """Days this visitor placed an offline order, strictly before ``before``."""
    if not (visitor.authenticated and visitor.primary_device):
        return []
    dates = []
    day = visitor.cohort + dt.timedelta(days=1)
    local_end = before.astimezone(ZoneInfo(world.timezone)).date()
    while day <= local_end:
        if _places_offline_order(world, visitor.cohort, visitor.index, day):
            order = build_offline_order(world, visitor, day)
            if order.started < before:
                dates.append(day)
        day += dt.timedelta(days=1)
    return dates


def build_offline_order(
    world: World,
    visitor: Visitor,
    day: dt.date,
    prior_sessions: PriorSessions = (),
) -> Session:
    """A server-side order with no browser session, at an hour drawn from session.hour_weights."""
    rng = derive(world.master_seed, "offline-order", visitor.cohort.isoformat(), visitor.index, day.isoformat())
    weights = world.section("session")["hour_weights"]
    hour = rng.choices(range(24), weights=weights, k=1)[0]
    local = dt.datetime(
        day.year, day.month, day.day, hour, rng.randrange(60), rng.randrange(60),
        rng.randrange(1_000_000), tzinfo=ZoneInfo(world.timezone),
    )
    when = local.astimezone(dt.timezone.utc)

    catalogue = world.section("catalogue")
    counts, weights = world.offline_line_item_weights
    lines = int(rng.choices(counts, weights=weights, k=1)[0])
    picked = rng.sample(catalogue, k=min(lines, len(catalogue)))
    cart = _build_cart(world, rng, picked)
    order = Action(
        event_name="purchase",
        when=when,
        page_type="offline",
        page_path="",
        page_title="",
        page_referrer=None,
        batch_page_id=0,
        payload={
            "cart": cart,
            # A sequence number no browser session reaches, so the id cannot
            # collide with a web order placed by the same visitor that day.
            "transaction_id": _transaction_id(world, visitor, day, 1_000),
            "server_side": True,
        },
    )

    # Some Measurement Protocol integrations send a session id with the order.
    # No browser session stands behind it, so the row forms a session of one
    # event with no session_start. The id is the order's own epoch second, as a
    # browser session's id is its start second.
    ga_session_id: int | None = None
    session_number = 0
    share = float((world.server_side.get("offline_orders") or {}).get("session_id_share", 0.0))
    if share > 0.0 and uniform(
        world.master_seed, "offline-session", visitor.cohort.isoformat(), visitor.index,
        day.isoformat(),
    ) < share:
        ga_session_id = int(when.timestamp())
        # Only a browser session that started in the very same second could
        # share the id. Step past it, so the order never joins that session.
        # Same-day sessions are hours apart, so one step is always enough.
        if day == visitor.cohort or _returns_on(world, visitor.cohort, visitor.index, day):
            taken = {
                int(start.timestamp())
                for start in _session_starts(world, visitor.cohort, visitor.index, day)
            }
            if ga_session_id in taken:
                ga_session_id += 1
        # The number of the customer's latest browser session, which is what a
        # server replaying the stored session cookie forwards.
        session_number = max(1, len(prior_sessions))

    analytics_granted, ads_granted = _consent(world, visitor.cohort, visitor.index)
    return Session(
        visitor=visitor,
        session_number=session_number,
        ga_session_id=ga_session_id,
        channel="direct",
        started=when,
        actions=[order],
        engaged=False,
        analytics_granted=analytics_granted,
        ads_granted=ads_granted,
        user_id=visitor.person_id if visitor.authenticated else None,
        last_click_channel="direct",
        prior_sessions=prior_sessions,
        server_side_only=True,
    )


def offline_orders_on(world: World, day: dt.date) -> Iterator[Session]:
    """Every offline order placed on ``day`` (local time)."""
    if not world.offline_orders_enabled:
        return
    # An offline order is a purchase event, so a property that does not send
    # purchases (or sells nothing) has none.
    if not world.event_enabled("purchase"):
        return
    for age in range(1, world.retention_window + 1):
        cohort = day - dt.timedelta(days=age)
        for index in range(world.new_visitors_on(cohort)):
            if not _places_offline_order(world, cohort, index, day):
                continue
            visitor = _materialise(world, cohort, index)
            prior = _sessions_through(world, cohort, index, day - dt.timedelta(days=1))
            order = build_offline_order(world, visitor, day)
            # A session the same day precedes the order only if it started earlier.
            if _returns_on(world, cohort, index, day):
                for ordinal, started in enumerate(_session_starts(world, cohort, index, day)):
                    if started < order.started:
                        prior.append((day, ordinal))
            yield build_offline_order(world, visitor, day, prior_sessions=tuple(prior))


def sessions_for_visit_date(world: World, day: dt.date) -> Iterator[Session]:
    """All sessions started on ``day`` (local time)."""
    for visitor, session_number, prior in visits_on(world, day):
        session = build_session(world, visitor, session_number, day, prior_sessions=prior)
        if session.actions:
            yield session
