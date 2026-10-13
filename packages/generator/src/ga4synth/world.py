"""Loading and light validation of the configuration.

The configuration is two files answering two different questions:

    property.yaml   what exists          hostname, events, pages, catalogue
    mixer.yaml      how much, how often  volume, weights, rates, durations

They are merged into one mapping at load time. Their top-level keys are
required to be disjoint, so the merge cannot silently prefer one file's value
over the other's.

The split is deliberate. Tuning a dataset means editing mixer.yaml and leaving
property.yaml untouched, which makes a tuning change reviewable as a diff of
numbers rather than a diff of everything.

Blocks that carry both identity and mix are split by key, not torn: a channel's
source and medium live in property.yaml `channels`, and its weight lives in
mixer.yaml `channel_mix`. Keys must match exactly in both directions, because
a channel present in one file and missing from the other is always a mistake
and is never what the author meant.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

from .rng import derive, stable_int, uniform, weighted_choice
from .values import SPEC_KEYS, ValueSpecError, validate_spec

PROPERTY_ENV_VAR = "GA4SYNTH_PROPERTY"
MIXER_ENV_VAR = "GA4SYNTH_MIXER"

# Kept for callers that still point at a single combined file via the older
# environment variable. See default_config_paths.
CONFIG_ENV_VAR = "GA4SYNTH_CONFIG"

# Page types whose funnel semantics only make sense for a property that sells
# something. Rejected when ecommerce.enabled is false.
#
# plp is deliberately absent: a listing page is a perfectly ordinary content
# page. With ecommerce off it simply stops emitting view_item_list and becomes
# a page_view, which is what a section index on a publisher's site looks like.
ECOMMERCE_PAGES = frozenset({"pdp", "cart", "checkout", "purchased"})

# Events that only fire on an ecommerce property.
ECOMMERCE_EVENTS = frozenset({
    "view_item_list", "select_item", "view_item", "add_to_cart", "view_cart",
    "begin_checkout", "add_shipping_info", "add_payment_info", "purchase",
})

# The ecommerce funnel, in order. check_funnel_nesting requires that a session
# containing one of these also contains every earlier one, so the *enabled* set
# has to be an unbroken run from the front.
FUNNEL_CHAIN = ("view_item", "add_to_cart", "view_cart", "begin_checkout", "purchase")

# Events GA4 always collects. They cannot be toggled.
ALWAYS_ON_EVENTS = frozenset({
    "first_visit", "session_start", "page_view", "user_engagement",
})

# Every dwell range the generator asks for. Validated up front so a missing key
# fails at load rather than part-way through a shard.
REQUIRED_DWELL = (
    "page_load", "select_item", "view_item", "add_to_cart", "add_shipping_info",
    "add_payment_info", "scroll", "outbound_click", "custom_event",
)

# The page-walk edges that move a visitor towards a purchase. A conversion
# factor is spread evenly across them (as its cube root), so a factor of 1.5
# lifts the rate of completing the whole funnel by roughly 1.5. It is slightly
# less at high values, because the checkout step is already likely and cannot
# exceed certainty.
FORWARD_EDGES = (("pdp", "cart"), ("cart", "checkout"), ("checkout", "purchased"))

# GA4 closes a session after 30 minutes without an event. Two sessions of one
# visitor must be further apart than this, or GA4 would have kept them as one.
SESSION_TIMEOUT_SECONDS = 30 * 60

# Minutes from one session start to the next on the same day, as [min, max],
# when session.extra_sessions.gap_minutes is not set.
DEFAULT_EXTRA_SESSION_GAP_MINUTES = (120, 360)


def _max_session_seconds(raw: dict[str, Any]) -> float:
    """An upper bound on the length of one browser session.

    A session has at most journey.max_pages pages. A page draws each dwell
    range at most once, except custom_event, which it draws once per configured
    custom event, and then one gap before the next page. The bound is loose on
    purpose: it only has to be safe, and no real session comes close to it.
    """
    dwell = raw["dwell_seconds"]
    custom_events = len(raw["tracking"].get("custom_events") or [])
    per_page = (
        float(raw["session"]["event_gap_seconds"][1])
        + sum(float(high) for _, high in dwell.values())
        + max(custom_events - 1, 0) * float(dwell["custom_event"][1])
    )
    return int(raw["journey"]["max_pages"]) * per_page


@dataclass(frozen=True)
class DayFactors:
    """Everything a calendar day changes, resolved once per day."""

    traffic: float
    returns: float
    conversion: float
    channels: dict[str, float]
    campaigns: dict[str, str]
    events: tuple[str, ...]


PROPERTY_SECTIONS = (
    "property", "seed", "ecommerce", "channels", "devices", "geos",
    "catalogue", "pages", "tracking",
)
MIXER_SECTIONS = (
    "volume", "retention", "session", "consent", "identity", "channel_mix",
    "device_mix", "geo_mix", "journey", "cart", "dwell_seconds",
)


def _search(*relative: str) -> Path | None:
    """First existing candidate for a config file, or None."""
    for base in (Path.cwd(), Path(__file__).resolve().parents[2]):
        candidate = base.joinpath(*relative)
        if candidate.is_file():
            return candidate
    return None


def default_config_paths() -> tuple[Path, Path]:
    """Locate property.yaml and mixer.yaml.

    The config is user-owned, so unlike the schema it is not shipped inside the
    package. Each file is looked up in the order a caller would expect:

    1. its environment variable, which is how a container is pointed at config
    2. ``config/<name>.yaml`` under the current directory, which is what you
       get when running from a clone of the repository
    3. the repository layout relative to this file, for an editable install

    Resolving rather than assuming matters because an earlier version derived
    the path from ``__file__`` alone, which broke the moment the package was
    installed non-editably: the path landed in site-packages' parent.
    """
    from os import environ

    if environ.get(PROPERTY_ENV_VAR):
        prop = Path(environ[PROPERTY_ENV_VAR])
    else:
        prop = _search("config", "property.yaml") or Path.cwd() / "config" / "property.yaml"

    if environ.get(MIXER_ENV_VAR):
        mixer = Path(environ[MIXER_ENV_VAR])
    else:
        mixer = _search("config", "mixer.yaml") or Path.cwd() / "config" / "mixer.yaml"

    return prop, mixer


@dataclass(frozen=True)
class World:
    """The simulated property. Immutable once loaded."""

    raw: dict[str, Any]
    # Per-day factors, resolved on first use. The dict is mutated, never
    # reassigned, so the dataclass stays frozen.
    _day_cache: dict[dt.date, DayFactors] = field(
        default_factory=dict, compare=False, repr=False
    )
    # Values read once per identity per day in the replay loop. Rebuilding them
    # on every call would dominate the cost of a shard.
    _cache: dict[Any, Any] = field(default_factory=dict, compare=False, repr=False)

    # -- convenience accessors -------------------------------------------
    @property
    def stream_id(self) -> str:
        return str(self.raw["property"]["stream_id"])

    @property
    def hostname(self) -> str:
        return self.raw["property"]["hostname"]

    @property
    def currency(self) -> str:
        return self.raw["property"]["currency"]

    @property
    def timezone(self) -> str:
        return self.raw["property"]["timezone"]

    @property
    def master_seed(self) -> str:
        return self.raw["seed"]["master"]

    def section(self, name: str) -> Any:
        return self.raw[name]

    # -- ecommerce -------------------------------------------------------
    @property
    def ecommerce_enabled(self) -> bool:
        return bool(self.raw["ecommerce"].get("enabled", True))

    # -- mixes -----------------------------------------------------------
    # Returned in property.yaml's key order, which is what keeps a weighted
    # draw reproducible: weighted_choice feeds the keys to random.choices
    # positionally, so reordering the mapping would change the draw.
    def _mix(self, identity: str, mix: str) -> dict[str, float]:
        weights = self.raw[mix]
        return {name: float(weights[name]) for name in self.raw[identity]}

    @property
    def channel_weights(self) -> dict[str, float]:
        return self._mix("channels", "channel_mix")

    @property
    def device_weights(self) -> dict[str, float]:
        return self._mix("devices", "device_mix")

    def geo_choices(self) -> tuple[list[dict[str, Any]], list[float]]:
        """Geographies and their weights, aligned and in configured order."""
        geos = self.raw["geos"]
        mix = self.raw["geo_mix"]
        names = list(geos)
        return [geos[name] for name in names], [float(mix[name]) for name in names]

    def channel_weights_on(self, day: dt.date) -> dict[str, float]:
        """Channel weights for a first visit on ``day``, after calendar events."""
        return self._apply_channels(self.channel_weights, day)

    def returning_channel_weights(self, day: dt.date | None = None) -> dict[str, float]:
        """Channel weights for a visitor's second and later sessions."""
        weights = self.channel_weights
        for name, factor in (self.raw.get("returning_channel_skew") or {}).items():
            if name in weights:
                weights[name] = weights[name] * float(factor)
        return self._apply_channels(weights, day) if day is not None else weights

    def _apply_channels(self, weights: dict[str, float], day: dt.date) -> dict[str, float]:
        factors = self.day_factors(day).channels
        if not factors:
            return weights
        return {name: weight * factors.get(name, 1.0) for name, weight in weights.items()}

    def reacquisition_channel_weights(self, exclude: str, day: dt.date | None = None) -> dict[str, float]:
        """Channel weights for a campaign clicked part-way through a session.

        Direct is excluded because a direct arrival collects no campaign at
        all, so it would be indistinguishable from the session simply carrying
        on. The channel the session already arrived on is excluded because
        re-arriving on it is not a change of source.
        """
        weights = self.channel_weights_on(day) if day is not None else self.channel_weights
        return {
            name: weight
            for name, weight in weights.items()
            if name != "direct" and name != exclude
        }

    # -- campaigns -------------------------------------------------------
    def campaign_weights(self, channel: str, day: dt.date | None) -> dict[str, float]:
        """The campaigns a channel runs on ``day``, with their relative weights.

        A channel's own campaigns are always on. A calendar event that names a
        campaign for the channel adds it to the set on its days, and gives it
        ``acquisition.calendar_campaign_share`` of the channel's acquisitions.
        The always-on campaigns split what is left in their usual proportions.
        """
        key = ("campaign_weights", channel, day)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        weights = {
            name: entry["weight"]
            for name, entry in _channel_campaigns(self.raw["channels"][channel]).items()
        }
        event = self.day_factors(day).campaigns.get(channel) if day is not None else None
        if event:
            weights.pop(event, None)
            share = self.calendar_campaign_share
            total = sum(weights.values())
            if share >= 1.0 or total <= 0.0:
                weights = {event: 1.0}
            else:
                weights[event] = total * share / (1.0 - share)
        self._cache[key] = weights
        return weights

    def acquisition(self, channel: str, user_pseudo_id: str, start_epoch: int) -> dict[str, Any]:
        """The campaign fields of one acquisition.

        The campaign is drawn from its own stream, keyed on the visitor, the
        channel and the second the session started. Every field of the
        acquisition reads this one answer, so they cannot disagree. A visitor's
        first session starts at their first touch, which is how
        ``traffic_source.name`` finds the same campaign without building the
        session.

        The calendar day is the local date of the session start, also for a
        campaign collected after midnight in a session that began before it.

        A channel that declares ``other_sources`` draws the source the same
        way, from a stream of its own. The source, its medium and its referrer
        come back together, so the collected source, the last click and the
        page referrer of one acquisition always name the same site.
        """
        cfg = self.raw["channels"][channel]
        day = dt.datetime.fromtimestamp(start_epoch, ZoneInfo(self.timezone)).date()
        weights = self.campaign_weights(channel, day)
        if not weights:
            name = None
        elif len(weights) == 1:
            name = next(iter(weights))
        else:
            name = weighted_choice(
                derive(self.master_seed, "campaign", user_pseudo_id, channel, start_epoch),
                weights,
            )
        own = _channel_campaigns(cfg).get(name) or {}
        sources = _channel_sources(cfg)
        if len(sources) == 1:
            origin = sources[0]
        else:
            # Its own stream, so declaring other sources moves no other draw.
            origin = derive(
                self.master_seed, "source", user_pseudo_id, channel, start_epoch
            ).choices(sources, weights=[entry["weight"] for entry in sources], k=1)[0]
        fields = {
            "campaign": name,
            "source": origin["source"],
            "medium": origin["medium"],
            "referrer": origin["referrer"],
            "term": own.get("term", cfg.get("term")),
            "content": own.get("content", cfg.get("content")),
        }
        if cfg.get("gclid") and name is not None:
            # Google Ads ids follow the campaign. They are derived from the
            # names, so a calendar campaign gets stable ids without declaring any.
            ad_group = str(own.get("ad_group") or name)
            fields["campaign_id"] = str(stable_int(self.master_seed, "google-ads-campaign", name, digits=11))
            fields["ad_group_id"] = str(stable_int(self.master_seed, "google-ads-ad-group", name, ad_group, digits=12))
            fields["ad_group_name"] = ad_group
        return fields

    @property
    def gclid_only_share(self) -> float:
        """Share of Google Ads acquisitions that carry a gclid and no UTM parameters."""
        return float((self.raw.get("acquisition") or {}).get("gclid_only_share", 0.0))

    @property
    def calendar_campaign_share(self) -> float:
        """Share of a channel's acquisitions a calendar campaign takes on its days."""
        return float((self.raw.get("acquisition") or {}).get("calendar_campaign_share", 0.75))

    @property
    def last_non_direct_lookback_days(self) -> int:
        """How far back a direct session looks for the visitor's last campaign."""
        return int((self.raw.get("acquisition") or {}).get("last_non_direct_lookback_days", 0))

    # -- intent ----------------------------------------------------------
    @property
    def intent_segments(self) -> dict[str, dict[str, float]]:
        """Latent purchase-intent segments, in configured order."""
        cached = self._cache.get("intent_segments")
        if cached is None:
            cached = self._cache["intent_segments"] = self._build_intent_segments()
        return cached

    def _build_intent_segments(self) -> dict[str, dict[str, float]]:
        segments = (self.raw.get("intent") or {}).get("segments") or {}
        if not segments:
            return {"default": {"weight": 1.0, "return_factor": 1.0, "conversion_factor": 1.0}}
        return {
            name: {
                "weight": float(cfg["weight"]),
                "return_factor": float(cfg.get("return_factor", 1.0)),
                "conversion_factor": float(cfg.get("conversion_factor", 1.0)),
            }
            for name, cfg in segments.items()
        }

    @property
    def max_return_factor(self) -> float:
        cached = self._cache.get("max_return_factor")
        if cached is None:
            cached = self._cache["max_return_factor"] = max(
                seg["return_factor"] for seg in self.intent_segments.values()
            )
        return cached

    def session_number_conversion_factor(self, session_number: int) -> float:
        """Conversion factor for a visit number; the last entry covers every later visit."""
        factors = (self.raw.get("intent") or {}).get("session_number_conversion_factor") or [1.0]
        return float(factors[min(session_number, len(factors)) - 1])

    def scaled_journey(self, conversion_factor: float) -> tuple[dict[str, dict[str, float]], float]:
        """The page-walk transitions and add-to-cart rate for one conversion factor.

        Key order is preserved, which is what keeps a weighted draw reproducible.
        """
        journey = self.raw["journey"]
        per_edge = conversion_factor ** (1.0 / len(FORWARD_EDGES))
        forward = set(FORWARD_EDGES)
        transitions = {
            page: {
                target: float(weight) * (per_edge if (page, target) in forward else 1.0)
                for target, weight in targets.items()
            }
            for page, targets in journey["transitions"].items()
        }
        add_to_cart = min(1.0, float(journey["add_to_cart_rate"]) * per_edge)
        return transitions, add_to_cart

    # -- calendar --------------------------------------------------------
    def day_factors(self, day: dt.date) -> DayFactors:
        """Traffic, return, conversion, channel and campaign factors for ``day``."""
        cached = self._day_cache.get(day)
        if cached is not None:
            return cached

        traffic = returns = 1.0
        conversion = self._demand(day)
        channels: dict[str, float] = {}
        campaigns: dict[str, str] = {}
        active = []
        for event in self.raw.get("calendar") or []:
            if not _event_active(event, day):
                continue
            active.append(str(event["name"]))
            traffic *= float(event.get("traffic", 1.0))
            returns *= float(event.get("returns", 1.0))
            conversion *= float(event.get("conversion", 1.0))
            for name, factor in (event.get("channels") or {}).items():
                channels[name] = channels.get(name, 1.0) * float(factor)
            campaigns.update(event.get("campaigns") or {})

        factors = DayFactors(traffic, returns, conversion, channels, campaigns, tuple(active))
        self._day_cache[day] = factors
        return factors

    def _demand(self, day: dt.date) -> float:
        """Day-level conversion propensity, independent of traffic.

        Three parts, all stateless in the date: a weekday profile, a slow drift
        interpolated between random knots ``period_days`` apart, and independent
        daily noise. Drift and noise are log-normal so they never go negative.
        """
        demand = self.raw.get("demand") or {}
        factor = float((demand.get("weekday_conversion_factor") or {}).get(day.isoweekday(), 1.0))

        drift = demand.get("drift") or {}
        sigma = float(drift.get("sigma", 0.0))
        if sigma > 0:
            period = int(drift.get("period_days", 7))
            ordinal = day.toordinal()
            knot, offset = divmod(ordinal, period)
            left = derive(self.master_seed, "demand-drift", knot).gauss(0.0, 1.0)
            right = derive(self.master_seed, "demand-drift", knot + 1).gauss(0.0, 1.0)
            blend = (1 - math.cos(math.pi * offset / period)) / 2
            factor *= math.exp(sigma * (left + (right - left) * blend))

        noise = float(demand.get("daily_noise", 0.0))
        if noise > 0:
            factor *= math.exp(noise * derive(self.master_seed, "demand-noise", day.isoformat()).gauss(0.0, 1.0))
        return factor

    # -- server-side purchases ------------------------------------------
    @property
    def server_side(self) -> dict[str, Any]:
        return self.raw.get("server_side") or {}

    # -- identity --------------------------------------------------------
    @property
    def user_id_share(self) -> float:
        """Share of people who sign in, and so report a user_id."""
        return float(self.raw["identity"]["user_id_share"])

    @property
    def cross_device_share(self) -> float:
        """Share of new visitors who are an existing person on a second device."""
        return float(self.raw["identity"].get("cross_device_share", 0.0))

    @property
    def cross_device_max_lag_days(self) -> int:
        """How far back a second device may reach to find the person it belongs to."""
        return int(self.raw["identity"].get("cross_device_max_lag_days", 30))

    # -- sessions --------------------------------------------------------
    @property
    def source_change_rate(self) -> float:
        """Share of multi-page sessions that collect a second campaign part-way through."""
        return float(self.raw["session"].get("source_change_rate", 0.0))

    @property
    def missing_session_start_rate(self) -> float:
        """Share of browser sessions whose session_start never reaches the export."""
        return float(self.raw["session"].get("missing_session_start_rate", 0.0))

    @property
    def batch_window_seconds(self) -> float:
        """How long after its first event a request still accepts another event."""
        return float(self.raw["session"].get("batch_window_seconds", 5.0))

    @property
    def extra_session_weights(self) -> tuple[list[int], list[float]]:
        """Extra sessions per visit day and their relative weights, ascending.

        Both lists are empty when no extra session can happen, which is how a
        caller knows to skip the draw altogether.
        """
        key = "extra_session_weights"
        if key not in self._cache:
            raw = (self.raw["session"].get("extra_sessions") or {}).get("weights") or {}
            weights = {int(count): float(weight) for count, weight in raw.items()}
            counts = sorted(weights)
            if not any(weights[count] > 0.0 for count in counts if count > 0):
                counts = []
            self._cache[key] = (counts, [weights[count] for count in counts])
        return self._cache[key]

    @property
    def extra_session_gap_seconds(self) -> tuple[float, float]:
        """Seconds from one session start to the next on the same day, as (low, high)."""
        low, high = (self.raw["session"].get("extra_sessions") or {}).get(
            "gap_minutes", DEFAULT_EXTRA_SESSION_GAP_MINUTES
        )
        return float(low) * 60.0, float(high) * 60.0

    @property
    def max_session_seconds(self) -> float:
        """An upper bound on the length of one browser session."""
        return _max_session_seconds(self.raw)

    # -- events ----------------------------------------------------------
    def event_enabled(self, name: str) -> bool:
        """Whether this property sends ``name``.

        Events GA4 always collects are always on. Anything absent from the
        toggle map defaults to on, so adding a new optional event to the
        generator does not silently disappear from existing configs.
        """
        if name in ALWAYS_ON_EVENTS:
            return True
        if not self.ecommerce_enabled and name in ECOMMERCE_EVENTS:
            return False
        return bool((self.raw["tracking"].get("events") or {}).get(name, True))

    # -- timing ----------------------------------------------------------
    def dwell(self, name: str) -> tuple[float, float]:
        """Seconds between an event and the one before it, as (low, high)."""
        low, high = self.raw["dwell_seconds"][name]
        return float(low), float(high)

    @property
    def scroll_depth_percent(self) -> int:
        return int(self.raw.get("scroll_depth_percent", 90))

    @property
    def server_offset_micros(self) -> tuple[int, int]:
        low, high = self.raw.get("server_offset_micros", [200_000, 4_000_000])
        return int(low), int(high)

    # -- cart ------------------------------------------------------------
    def cart_quantities(self) -> tuple[list[int], list[float]]:
        """Units per line and their relative weights, in ascending order."""
        weights = self.raw["cart"]["quantity_weights"]
        quantities = sorted(int(q) for q in weights)
        return quantities, [float(weights[q]) for q in quantities]

    # -- volume model ----------------------------------------------------
    def new_visitors_on(self, day: dt.date) -> int:
        """Expected count of first-time visitors on ``day``.

        Combines a baseline, a weekday factor, annual seasonality, and
        deterministic per-day jitter. Deterministic in ``day`` alone, so cohort
        sizes are stable no matter which shard is being generated.
        """
        volume = self.raw["volume"]
        base = float(volume["new_visitors_per_day"])
        weekday = float(volume["weekday_factor"][day.isoweekday()])

        season = volume["seasonality"]
        phase = 2 * math.pi * (day.timetuple().tm_yday - float(season["peak_day_of_year"])) / 365.25
        seasonal = 1.0 + float(season["amplitude"]) * math.cos(phase)

        jitter_span = float(volume["jitter"])
        jitter = 1.0 + derive(self.master_seed, "volume", day.isoformat()).uniform(
            -jitter_span, jitter_span
        )

        return max(1, round(base * weekday * seasonal * jitter * self.day_factors(day).traffic))

    def return_probability(self, days_since_first_visit: int) -> float:
        """Probability a visitor returns on a day this far after their first."""
        key = ("return_probability", days_since_first_visit)
        cached = self._cache.get(key)
        if cached is None:
            cached = self._cache[key] = self._return_probability(days_since_first_visit)
        return cached

    def _return_probability(self, days_since_first_visit: int) -> float:
        retention = self.raw["retention"]
        if days_since_first_visit <= 0:
            return 0.0
        curve = retention.get("return_curve")
        if curve:
            decay = sum(
                float(term["weight"]) * math.exp(-days_since_first_visit / float(term["decay_days"]))
                for term in curve
            )
        else:
            decay = math.exp(-days_since_first_visit / float(retention["decay_days"]))
        return float(retention["return_base"]) * decay

    @property
    def retention_window(self) -> int:
        return int(self.raw["retention"]["window_days"])


def _channel_campaigns(cfg: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """A channel's always-on campaigns, by name, each with a float ``weight``.

    ``campaigns`` maps a name to a weight, or to a mapping with a ``weight``
    and optional ``term``, ``content`` and ``ad_group``. The single
    ``campaign`` key is the same thing with one entry.
    """
    declared = cfg.get("campaigns")
    if declared is None:
        return {cfg["campaign"]: {"weight": 1.0}} if cfg.get("campaign") else {}
    out = {}
    for name, entry in declared.items():
        entry = dict(entry) if isinstance(entry, dict) else {"weight": entry}
        entry["weight"] = float(entry.get("weight", 1.0))
        out[str(name)] = entry
    return out


def _channel_sources(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Every source a channel can arrive from, the channel's own source first.

    ``other_sources`` maps a source name to a mapping with a ``weight`` and an
    optional ``referrer`` and ``medium``. The weights are relative to
    ``source_weight``, the weight of the channel's own ``source``.
    """
    main = {
        "source": cfg["source"],
        "medium": cfg["medium"],
        "referrer": cfg.get("referrer"),
        "weight": float(cfg.get("source_weight", 1.0)),
    }
    others = [
        {
            "source": str(name),
            "medium": entry.get("medium", cfg["medium"]),
            "referrer": entry.get("referrer"),
            "weight": float(entry["weight"]),
        }
        for name, entry in (cfg.get("other_sources") or {}).items()
    ]
    return [main] + others


def _event_active(event: dict[str, Any], day: dt.date) -> bool:
    """Whether a calendar event covers ``day``.

    ``weekday`` (ISO, or a list) repeats weekly. ``from``/``to`` as ``MM-DD``
    repeat every year, and may wrap past the new year. As ``YYYY-MM-DD`` they
    happen once.
    """
    if "weekday" in event:
        weekdays = event["weekday"] if isinstance(event["weekday"], list) else [event["weekday"]]
        return day.isoweekday() in {int(w) for w in weekdays}
    start, end = str(event["from"]), str(event["to"])
    if len(start) == 10:
        return dt.date.fromisoformat(start) <= day <= dt.date.fromisoformat(end)
    stamp = day.strftime("%m-%d")
    if start <= end:
        return start <= stamp <= end
    return stamp >= start or stamp <= end


def _validate_dynamics(raw: dict[str, Any]) -> None:
    """Intent, return curve, demand, calendar and server-side settings."""
    curve = raw["retention"].get("return_curve")
    if curve is not None:
        if not curve:
            raise ValueError("retention.return_curve must not be empty")
        for index, term in enumerate(curve):
            if float(term.get("weight", 0)) <= 0 or float(term.get("decay_days", 0)) <= 0:
                raise ValueError(f"retention.return_curve[{index}] needs positive weight and decay_days")
    elif "decay_days" not in raw["retention"]:
        raise ValueError("retention needs either return_curve or decay_days")

    intent = raw.get("intent") or {}
    for name, cfg in (intent.get("segments") or {}).items():
        for key in ("weight", "return_factor", "conversion_factor"):
            if float(cfg.get(key, 1.0)) <= 0:
                raise ValueError(f"intent.segments.{name}.{key} must be positive")
    factors = intent.get("session_number_conversion_factor")
    if factors is not None and (not factors or any(float(f) <= 0 for f in factors)):
        raise ValueError("intent.session_number_conversion_factor must be a non-empty list of positive numbers")

    demand = raw.get("demand") or {}
    weekday = demand.get("weekday_conversion_factor")
    if weekday is not None and sorted(weekday) != list(range(1, 8)):
        raise ValueError("demand.weekday_conversion_factor must have keys 1-7 (Mon-Sun)")
    drift = demand.get("drift") or {}
    if drift and int(drift.get("period_days", 7)) < 1:
        raise ValueError("demand.drift.period_days must be 1 or more")

    channels = set(raw["channels"])
    for index, event in enumerate(raw.get("calendar") or []):
        where = f"calendar[{index}]"
        if "name" not in event:
            raise ValueError(f"{where} needs a name")
        where = f"calendar[{index}] ({event['name']})"
        if ("weekday" in event) == ("from" in event or "to" in event):
            raise ValueError(f"{where} needs either weekday, or from and to")
        if "from" in event and ("to" not in event or len(str(event["from"])) != len(str(event["to"]))):
            raise ValueError(f"{where} needs from and to in the same format (MM-DD or YYYY-MM-DD)")
        for key in ("traffic", "returns", "conversion"):
            if float(event.get(key, 1.0)) <= 0:
                raise ValueError(f"{where}.{key} must be positive")
        for key in ("channels", "campaigns"):
            unknown = sorted(set(event.get(key) or {}) - channels)
            if unknown:
                raise ValueError(f"{where}.{key} names channels not in property.yaml: {unknown}")

    server = raw.get("server_side") or {}
    for key in ("purchase_share",):
        if not 0.0 <= float(server.get(key, 0.0)) <= 1.0:
            raise ValueError(f"server_side.{key} must be between 0 and 1")
    delay = server.get("confirmation_delay_seconds")
    if delay is not None and (len(delay) != 2 or float(delay[0]) > float(delay[1]) or float(delay[0]) < 0):
        raise ValueError("server_side.confirmation_delay_seconds must be [min, max] with 0 <= min <= max")
    offline = server.get("offline_orders") or {}
    if offline and (float(offline.get("daily_rate", 0)) < 0 or float(offline.get("decay_days", 1)) <= 0):
        raise ValueError("server_side.offline_orders needs daily_rate >= 0 and decay_days > 0")
    if not 0.0 <= float(offline.get("session_id_share", 0.0)) <= 1.0:
        raise ValueError("server_side.offline_orders.session_id_share must be between 0 and 1")


def _read(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(
            f"{label} config not found at {path}. Pass --{label}, set "
            f"GA4SYNTH_{label.upper()}, or run from a directory containing "
            f"config/{label}.yaml."
        )
    with open(path) as handle:
        loaded = yaml.safe_load(handle)
    if not isinstance(loaded, dict):
        raise ValueError(f"{path} must contain a YAML mapping at the top level")
    return loaded


def load_world(
    property_path: str | Path | None = None,
    mixer_path: str | Path | None = None,
) -> World:
    """Load and validate the configuration."""
    default_property, default_mixer = default_config_paths()
    prop = Path(property_path) if property_path else default_property
    mixer = Path(mixer_path) if mixer_path else default_mixer

    property_raw = _read(prop, "property")
    mixer_raw = _read(mixer, "mixer")

    overlap = sorted(set(property_raw) & set(mixer_raw))
    if overlap:
        raise ValueError(
            f"{prop.name} and {mixer.name} both define {', '.join(overlap)}. "
            "Top-level keys must be disjoint so neither file silently wins."
        )

    raw = {**property_raw, **mixer_raw}
    _validate(raw, prop.name, mixer.name)
    return World(raw=raw)


def _validate(raw: dict[str, Any], property_name: str, mixer_name: str) -> None:
    """Fail loudly on configuration errors that would silently skew output."""
    missing = [key for key in PROPERTY_SECTIONS if key not in raw]
    if missing:
        raise ValueError(f"{property_name} missing sections: {', '.join(missing)}")
    missing = [key for key in MIXER_SECTIONS if key not in raw]
    if missing:
        raise ValueError(f"{mixer_name} missing sections: {', '.join(missing)}")

    _validate_mixes(raw, property_name, mixer_name)

    hours = raw["session"]["hour_weights"]
    if len(hours) != 24:
        raise ValueError(f"session.hour_weights must have 24 entries, got {len(hours)}")

    factors = raw["volume"]["weekday_factor"]
    if sorted(factors) != list(range(1, 8)):
        raise ValueError("volume.weekday_factor must have keys 1-7 (Mon-Sun)")

    for name in REQUIRED_DWELL:
        if name not in raw["dwell_seconds"]:
            raise ValueError(f"dwell_seconds.{name} is required")
        pair = raw["dwell_seconds"][name]
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError(f"dwell_seconds.{name} must be [min, max] seconds")
        if float(pair[0]) > float(pair[1]):
            raise ValueError(f"dwell_seconds.{name}: min is greater than max")

    quantities = raw["cart"]["quantity_weights"]
    if not quantities:
        raise ValueError("cart.quantity_weights must not be empty")
    for q in quantities:
        if int(q) < 1:
            raise ValueError(f"cart.quantity_weights key {q} must be 1 or greater")

    _validate_identity(raw)
    _validate_dynamics(raw)
    _validate_acquisition(raw)

    rate = float(raw["session"].get("source_change_rate", 0.0))
    if not 0.0 <= rate <= 1.0:
        raise ValueError(f"session.source_change_rate must be between 0 and 1, got {rate}")
    rate = float(raw["session"].get("missing_session_start_rate", 0.0))
    if not 0.0 <= rate <= 1.0:
        raise ValueError(f"session.missing_session_start_rate must be between 0 and 1, got {rate}")
    for key in ("analytics_granted", "ads_granted"):
        share = float(raw["consent"][key])
        if not 0.0 <= share <= 1.0:
            raise ValueError(f"consent.{key} must be between 0 and 1, got {share}")

    _validate_journey(raw)
    _validate_events(raw)
    _validate_tracking(raw)
    _validate_extra_sessions(raw)


def _validate_extra_sessions(raw: dict[str, Any]) -> None:
    """Extra sessions need sane weights, and a gap no session can reach across."""
    extra = raw["session"].get("extra_sessions") or {}
    weights = extra.get("weights") or {}
    for count, weight in weights.items():
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError(
                f"session.extra_sessions.weights key {count!r} must be a whole number, 0 or greater"
            )
        if float(weight) < 0.0:
            raise ValueError(f"session.extra_sessions.weights[{count}] must not be negative")
    if weights and sum(float(weight) for weight in weights.values()) <= 0.0:
        raise ValueError("session.extra_sessions.weights must not all be zero")

    pair = extra.get("gap_minutes", DEFAULT_EXTRA_SESSION_GAP_MINUTES)
    if not isinstance(pair, (list, tuple)) or len(pair) != 2:
        raise ValueError("session.extra_sessions.gap_minutes must be [min, max] minutes")
    low, high = float(pair[0]), float(pair[1])
    if low > high:
        raise ValueError("session.extra_sessions.gap_minutes: min is greater than max")

    # The gap runs from one session start to the next. It has to outlast the
    # longest possible session plus GA4's session timeout, or two sessions
    # could overlap, or sit so close that GA4 would have reported one session.
    if any(float(weight) > 0.0 for count, weight in weights.items() if count > 0):
        needed = (_max_session_seconds(raw) + SESSION_TIMEOUT_SECONDS) / 60.0
        if low < needed:
            raise ValueError(
                f"session.extra_sessions.gap_minutes minimum is {low:g}, but it must be at "
                f"least {math.ceil(needed)}: the longest possible session (journey.max_pages, "
                "session.event_gap_seconds and dwell_seconds) plus the 30 minute session timeout"
            )


def _validate_acquisition(raw: dict[str, Any]) -> None:
    """Campaign declarations and the acquisition dials."""
    for channel, cfg in raw["channels"].items():
        where = f"channels.{channel}"
        if "campaigns" not in cfg:
            continue
        if "campaign" in cfg:
            raise ValueError(f"{where} declares both `campaign` and `campaigns`; keep one")
        if not isinstance(cfg["campaigns"], dict) or not cfg["campaigns"]:
            raise ValueError(f"{where}.campaigns must be a non-empty mapping of campaign name to weight")
        for name, entry in cfg["campaigns"].items():
            weight = entry.get("weight", 1.0) if isinstance(entry, dict) else entry
            if not isinstance(weight, (int, float)) or isinstance(weight, bool) or weight <= 0:
                raise ValueError(f"{where}.campaigns.{name} needs a positive weight")
            unknown = sorted(set(entry) - {"weight", "term", "content", "ad_group"}) if isinstance(entry, dict) else []
            if unknown:
                raise ValueError(f"{where}.campaigns.{name} has unknown keys: {unknown}")

    for channel, cfg in raw["channels"].items():
        where = f"channels.{channel}"
        others = cfg.get("other_sources")
        if others is None:
            if "source_weight" in cfg:
                raise ValueError(f"{where}.source_weight has no effect without `other_sources`")
            continue
        if cfg.get("gclid"):
            # A click id belongs to one ad platform, so the channel cannot mix sources.
            raise ValueError(f"{where} sets `gclid`, so it cannot declare `other_sources`")
        if not isinstance(others, dict) or not others:
            raise ValueError(f"{where}.other_sources must be a non-empty mapping of source name to settings")
        weight = cfg.get("source_weight")
        if not isinstance(weight, (int, float)) or isinstance(weight, bool) or weight <= 0:
            raise ValueError(f"{where}.source_weight must be a positive weight when `other_sources` is declared")
        for name, entry in others.items():
            if not isinstance(entry, dict):
                raise ValueError(f"{where}.other_sources.{name} must be a mapping with a `weight`")
            weight = entry.get("weight")
            if not isinstance(weight, (int, float)) or isinstance(weight, bool) or weight <= 0:
                raise ValueError(f"{where}.other_sources.{name} needs a positive weight")
            unknown = sorted(set(entry) - {"weight", "referrer", "medium"})
            if unknown:
                raise ValueError(f"{where}.other_sources.{name} has unknown keys: {unknown}")
            if str(name) == str(cfg["source"]):
                raise ValueError(f"{where}.other_sources repeats the channel's own source `{name}`")

    dials = raw.get("acquisition") or {}
    share = float(dials.get("gclid_only_share", 0.0))
    if not 0.0 <= share <= 1.0:
        raise ValueError(f"acquisition.gclid_only_share must be between 0 and 1, got {share}")
    share = float(dials.get("calendar_campaign_share", 0.75))
    if not 0.0 < share <= 1.0:
        raise ValueError(f"acquisition.calendar_campaign_share must be above 0 and at most 1, got {share}")
    lookback = dials.get("last_non_direct_lookback_days", 0)
    if not isinstance(lookback, int) or isinstance(lookback, bool) or lookback < 0:
        raise ValueError(
            f"acquisition.last_non_direct_lookback_days must be a whole number of days, 0 or more, got {lookback!r}"
        )


def _validate_identity(raw: dict[str, Any]) -> None:
    """Identity shares must be probabilities, and stitching needs something to stitch with."""
    identity = raw["identity"]
    for key in ("user_id_share", "cross_device_share"):
        share = float(identity.get(key, 0.0))
        if not 0.0 <= share <= 1.0:
            raise ValueError(f"identity.{key} must be between 0 and 1, got {share}")

    lag = int(identity.get("cross_device_max_lag_days", 30))
    if lag < 1:
        raise ValueError(f"identity.cross_device_max_lag_days must be 1 or more, got {lag}")

    # A second device only becomes visible in the export through a shared
    # user_id. Without sign-in it is just another anonymous visitor, so the
    # combination is a configuration mistake rather than a quiet no-op.
    if float(identity.get("cross_device_share", 0.0)) > 0.0 and float(identity["user_id_share"]) <= 0.0:
        raise ValueError(
            "identity.cross_device_share needs identity.user_id_share above 0: "
            "a second device is only observable through the user_id it shares"
        )


def _validate_mixes(raw: dict[str, Any], property_name: str, mixer_name: str) -> None:
    """Every identity block and its weight map must name exactly the same keys."""
    for identity, mix in (("channels", "channel_mix"),
                          ("devices", "device_mix"),
                          ("geos", "geo_mix")):
        left, right = set(raw[identity]), set(raw[mix])
        if left == right:
            continue
        unweighted = sorted(left - right)
        unknown = sorted(right - left)
        problems = []
        if unweighted:
            problems.append(
                f"defined in {property_name} `{identity}` but missing from "
                f"{mixer_name} `{mix}`: {', '.join(unweighted)}"
            )
        if unknown:
            problems.append(
                f"weighted in {mixer_name} `{mix}` but not defined in "
                f"{property_name} `{identity}`: {', '.join(unknown)}"
            )
        raise ValueError("; ".join(problems))


def _validate_journey(raw: dict[str, Any]) -> None:
    ecommerce = bool(raw["ecommerce"].get("enabled", True))

    # Every page type reachable via a transition must itself have transitions,
    # or the walk would dead-end on a KeyError mid-generation.
    transitions = raw["journey"]["transitions"]
    reachable = {"end"} | set(transitions)
    for page, targets in transitions.items():
        unknown = set(targets) - reachable
        if unknown:
            raise ValueError(
                f"journey.transitions[{page}] targets undefined pages: {sorted(unknown)}"
            )
    for page in raw["journey"]["entry_weights"]:
        if page not in transitions:
            raise ValueError(f"journey.entry_weights[{page}] has no transitions defined")

    for page in transitions:
        if page not in raw["pages"]:
            raise ValueError(
                f"page type {page!r} is used in journey.transitions but absent from `pages`"
            )
    for page, template in raw["pages"].items():
        for key in ("path", "title"):
            if key not in template:
                raise ValueError(f"pages.{page} is missing {key!r}")

    if not ecommerce:
        used = (set(transitions) | set(raw["journey"]["entry_weights"])) & ECOMMERCE_PAGES
        if used:
            raise ValueError(
                f"ecommerce.enabled is false but the journey walks {sorted(used)}. "
                "Those page types emit ecommerce events. Remove them from "
                "journey.entry_weights and journey.transitions, or enable ecommerce."
            )

    # plp draws its category list from the catalogue and pdp draws the product
    # itself, so either one walked means the catalogue has to be populated,
    # whether or not anything is for sale.
    walked = set(transitions) | set(raw["journey"]["entry_weights"])
    if walked & {"plp", "pdp"} and not raw["catalogue"]:
        raise ValueError(
            "catalogue must not be empty: the journey walks "
            f"{sorted(walked & {'plp', 'pdp'})}, which names categories or products"
        )


def _validate_events(raw: dict[str, Any]) -> None:
    """Toggles must not produce a funnel with a hole in it."""
    toggles = raw["tracking"].get("events") or {}
    if not isinstance(toggles, dict):
        raise ValueError("tracking.events must be a mapping of event name to true/false")

    for name, value in toggles.items():
        if not isinstance(value, bool):
            raise ValueError(f"tracking.events.{name} must be true or false")
        if name in ALWAYS_ON_EVENTS:
            raise ValueError(
                f"tracking.events.{name}: GA4 always collects this event and it "
                "cannot be turned off"
            )

    if not bool(raw["ecommerce"].get("enabled", True)):
        return  # the funnel is off wholesale; per-event toggles do not apply

    enabled = [step for step in FUNNEL_CHAIN if toggles.get(step, True)]
    expected = list(FUNNEL_CHAIN[: len(enabled)])
    if enabled != expected:
        disabled = [step for step in FUNNEL_CHAIN if not toggles.get(step, True)]
        raise ValueError(
            "tracking.events: the ecommerce funnel must be enabled as an unbroken "
            f"run from the front of {' -> '.join(FUNNEL_CHAIN)}. "
            f"Currently disabled: {', '.join(disabled)}, which leaves "
            f"{', '.join(enabled)} enabled with a gap. A session containing a step "
            "without its earlier steps is what check_funnel_nesting rejects."
        )


# GA4 owns these parameter names. Configuration may not redefine them, because
# the generator sets them from session state and a silent override would produce
# data that contradicts itself.
RESERVED_PARAMS = frozenset({
    "ga_session_id", "ga_session_number", "session_engaged",
    "engaged_session_event", "engagement_time_msec", "entrances",
    "page_location", "page_title", "page_referrer", "ignore_referrer",
    "batch_page_id", "batch_ordering_id", "percent_scrolled", "search_term",
    "unique_search_term", "link_url", "link_domain", "outbound", "currency",
    "value", "transaction_id", "tax", "shipping", "coupon", "shipping_tier",
    "payment_type", "item_list_id", "item_list_name", "source", "medium",
    "campaign", "term", "content", "gclid",
})

# Event names GA4 defines. Configuration may add to these, never redefine them.
RESERVED_EVENTS = frozenset({
    "first_visit", "session_start", "page_view", "user_engagement", "scroll",
    "click", "view_search_results", "view_item_list", "select_item", "view_item",
    "add_to_cart", "view_cart", "begin_checkout", "add_shipping_info",
    "add_payment_info", "purchase", "refund", "remove_from_cart",
})


def _check_params(specs: dict, where: str) -> None:
    if not isinstance(specs, dict):
        raise ValueError(f"{where} must be a mapping of parameter name to specification")
    for name, spec in specs.items():
        if name in RESERVED_PARAMS:
            raise ValueError(
                f"{where}.{name} is a GA4 parameter set by the generator and cannot be "
                "overridden; choose a different name"
            )
        try:
            validate_spec(spec, f"{where}.{name}")
        except ValueSpecError as error:
            raise ValueError(str(error)) from error


def _validate_tracking(raw: dict[str, Any]) -> None:
    """Validate the tracking section, which is the main reuse surface."""
    tracking = raw["tracking"]
    pages = set(raw["pages"])

    _check_params(tracking.get("global_params") or {}, "tracking.global_params")

    for event, specs in (tracking.get("params_by_event") or {}).items():
        _check_params(specs, f"tracking.params_by_event.{event}")

    seen: set[str] = set()
    for index, custom in enumerate(tracking.get("custom_events") or []):
        where = f"tracking.custom_events[{index}]"
        if not isinstance(custom, dict) or "name" not in custom:
            raise ValueError(f"{where} must be a mapping with a `name`")
        name = custom["name"]
        if name in RESERVED_EVENTS:
            raise ValueError(
                f"{where}: {name!r} is a standard GA4 event emitted by the generator; "
                "custom events must use a different name"
            )
        if name in seen:
            raise ValueError(f"{where}: duplicate custom event name {name!r}")
        seen.add(name)
        on_page = custom.get("on_page") or []
        if not on_page:
            raise ValueError(f"{where}: `on_page` must list at least one page type")
        unknown = set(on_page) - pages
        if unknown:
            raise ValueError(f"{where}: on_page references unknown page types {sorted(unknown)}")
        rate = custom.get("rate", 0.0)
        if not isinstance(rate, (int, float)) or not 0.0 <= rate <= 1.0:
            raise ValueError(f"{where}: `rate` must be a probability between 0 and 1")
        _check_params(custom.get("params") or {}, f"{where}.params")

    properties = tracking.get("user_properties") or {}
    if not isinstance(properties, dict):
        raise ValueError("tracking.user_properties must be a mapping")
    for name, spec in properties.items():
        try:
            validate_spec(spec, f"tracking.user_properties.{name}")
        except ValueSpecError as error:
            raise ValueError(str(error)) from error
