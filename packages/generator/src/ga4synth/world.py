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
from .values import SPEC_KEYS, ValueSpecError, template_fields, validate_spec

# The template fields a user property can use. See _validate_tracking.
USER_PROPERTY_TEMPLATE_KEYS = frozenset({"user_pseudo_id"})

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

# The lead funnel, in order. Like FUNNEL_CHAIN, the enabled set has to be an
# unbroken run from the front, because check_funnel_nesting holds it to the
# same rule.
LEAD_FUNNEL_CHAIN = ("form_start", "form_submit", "generate_lead")

# Page types whose semantics live in code for the lead funnel. A contact page
# carries the form; lead_confirmation is the page a submitted form lands on.
# Neither needs ecommerce.
LEAD_PAGES = frozenset({"contact", "lead_confirmation"})

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

# Seconds for the lead-funnel events, when dwell_seconds does not set them.
# Only a journey that walks a contact page uses them.
DEFAULT_LEAD_DWELL = {"form_start": (3, 20), "form_submit": (15, 120)}

# Defaults for the property.yaml `leads` block.
DEFAULT_LEADS = {
    "form_id": "contact-form",
    "form_name": "contact",
    "form_submit_text": "Send",
    "value": None,
    "lead_source": None,
}

# Probability a form_start fires on a contact page the visitor leaves without
# submitting, when journey.form_start_rate is not set.
DEFAULT_FORM_START_RATE = 0.3

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

# What GA4 reports as default_channel_group for a channel that does not set
# `channel_group`. A channel key not listed here reports "Unassigned".
DEFAULT_CHANNEL_GROUPS = {
    "organic_search": "Organic Search",
    "direct": "Direct",
    "paid_search": "Paid Search",
    "paid_social": "Paid Social",
    "organic_social": "Organic Social",
    "email": "Email",
    "referral": "Referral",
}

# The Google Ads account a `gclid` channel reports when it sets no `google_ads`.
DEFAULT_GOOGLE_ADS = {"customer_id": "4477112200", "account_name": "{brand} | Search"}

# Fixed values of the ecommerce block, used when property.yaml leaves them out.
DEFAULT_ECOMMERCE = {
    "transaction_id_prefix": "",
    "shipping_tier": "Standard",
    "payment_type": "Credit Card",
    "view_item_list_name": "Product detail",
}

# Countries whose visitors report en-us when neither the geo nor
# property.default_language names a language. Everyone else reports en-gb.
LEGACY_EN_US_COUNTRIES = frozenset({"United States", "Canada", "United Kingdom", "Australia"})

# Lines per offline order, with relative weights, when
# server_side.offline_orders.line_item_weights is not set.
DEFAULT_OFFLINE_LINE_ITEM_WEIGHTS = {1: 70, 2: 22, 3: 8}


def _max_session_seconds(raw: dict[str, Any]) -> float:
    """An upper bound on the length of one browser session.

    A session has at most journey.max_pages pages. A page draws each dwell
    range at most once, except custom_event, which it draws once per configured
    custom event, and then one gap before the next page. The bound is loose on
    purpose: it only has to be safe, and no real session comes close to it.
    """
    dwell = raw["dwell_seconds"]
    # The form events only fire on a contact page, so their dwell only counts
    # when the journey walks one.
    if "contact" in raw["journey"]["transitions"]:
        dwell = {**DEFAULT_LEAD_DWELL, **dwell}
    else:
        dwell = {name: pair for name, pair in dwell.items() if name not in DEFAULT_LEAD_DWELL}
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
    # Channel factors for returning visits: those of events not marked
    # new_visitors_only. Equal to ``channels`` when no event is.
    returning_channels: dict[str, float] = field(default_factory=dict)


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


def scenarios_dir() -> Path:
    """The directory holding the shipped scenarios, one sub-directory each.

    Looked up the way default_config_paths looks up the config itself.

    The only line of src/ga4synth/ the app changed in the sync of D-95: the
    app keeps one folder per type of dataset directly in `config/` (D-23), so
    there is no `config/scenarios/` here. See ORIGIN.md.
    """
    for base in (Path.cwd(), Path(__file__).resolve().parents[2]):
        candidate = base / "config"
        if candidate.is_dir():
            return candidate
    return Path.cwd() / "config"


def available_scenarios() -> list[str]:
    """Names of the scenarios that have both a property.yaml and a mixer.yaml."""
    root = scenarios_dir()
    if not root.is_dir():
        return []
    return sorted(
        entry.name for entry in root.iterdir()
        if (entry / "property.yaml").is_file() and (entry / "mixer.yaml").is_file()
    )


def scenario_paths(name: str) -> tuple[Path, Path]:
    """property.yaml and mixer.yaml of a shipped scenario, such as ``lead-generation``."""
    folder = scenarios_dir() / name
    if not (folder / "property.yaml").is_file() or not (folder / "mixer.yaml").is_file():
        raise FileNotFoundError(
            f"no scenario named {name!r} in {scenarios_dir()}; "
            f"available: {', '.join(available_scenarios()) or 'none'}"
        )
    return folder / "property.yaml", folder / "mixer.yaml"


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

    @property
    def brand(self) -> str:
        return self.raw["property"]["brand"]

    @property
    def usd_exchange_rate(self) -> float:
        """US dollars per unit of ``property.currency``, for the ``*_in_usd`` fields."""
        rate = self.raw["property"].get("usd_exchange_rate")
        return 1.0 if rate is None else float(rate)

    def to_usd(self, amount: float | None) -> float | None:
        """An amount in the property currency, converted for an ``*_in_usd`` field."""
        rate = self.usd_exchange_rate
        if amount is None or rate == 1.0:
            return amount
        return round(amount * rate + 1e-9, 2)

    def language(self, geo: dict[str, Any]) -> str:
        """device.language for a visitor from ``geo``.

        The geo's own ``language`` wins, then ``property.default_language``.
        Without either, English-speaking countries report en-us and every other
        country en-gb, which is what the generator did before both existed.
        """
        if geo.get("language"):
            return str(geo["language"])
        default = self.raw["property"].get("default_language")
        if default:
            return str(default)
        return "en-us" if geo["country"] in LEGACY_EN_US_COUNTRIES else "en-gb"

    def channel_group(self, channel: str) -> str:
        """default_channel_group reported for ``channel``."""
        configured = self.raw["channels"][channel].get("channel_group")
        return str(configured or DEFAULT_CHANNEL_GROUPS.get(channel, "Unassigned"))

    def google_ads_account(self, channel: str) -> tuple[str, str]:
        """``(customer_id, account_name)`` of the Google Ads account behind ``channel``."""
        cfg = {**DEFAULT_GOOGLE_ADS, **(self.raw["channels"][channel].get("google_ads") or {})}
        return str(cfg["customer_id"]), str(cfg["account_name"]).format(brand=self.brand)

    def ecommerce_setting(self, key: str) -> Any:
        """A fixed ecommerce value: transaction_id_prefix, shipping_tier, payment_type, view_item_list_name."""
        ecommerce = self.raw["ecommerce"]
        return ecommerce[key] if key in ecommerce else DEFAULT_ECOMMERCE[key]

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
        if day is None:
            return weights
        return self._apply_channels(weights, day, self.day_factors(day).returning_channels)

    def _apply_channels(
        self, weights: dict[str, float], day: dt.date, factors: dict[str, float] | None = None
    ) -> dict[str, float]:
        if factors is None:
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
    def channel_segment_weights(self) -> dict[str, dict[str, float]]:
        """Intent segment weights for visitors first acquired through a channel.

        A channel listed here replaces ``segments[].weight`` for its new
        visitors; a segment it leaves out gets weight 0. Empty by default, so
        intent then depends on nothing but the visitor.
        """
        cached = self._cache.get("channel_segment_weights")
        if cached is None:
            configured = (self.raw.get("intent") or {}).get("channel_segment_weights") or {}
            cached = self._cache["channel_segment_weights"] = {
                channel: {name: float(weights.get(name, 0.0)) for name in self.intent_segments}
                for channel, weights in configured.items()
            }
        return cached

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
        per_lead_edge = self.lead_edge_factor(conversion_factor)
        forward = set(FORWARD_EDGES)

        def factor(page: str, target: str) -> float:
            if (page, target) in forward:
                return per_edge
            # The lead funnel has two steps: reaching the form, and sending it.
            if target == "contact" or (page, target) == ("contact", "lead_confirmation"):
                return per_lead_edge
            return 1.0

        transitions = {
            page: {target: float(weight) * factor(page, target) for target, weight in targets.items()}
            for page, targets in journey["transitions"].items()
        }
        add_to_cart = min(1.0, float(journey["add_to_cart_rate"]) * per_edge)
        return transitions, add_to_cart

    @staticmethod
    def lead_edge_factor(conversion_factor: float) -> float:
        """A conversion factor spread over the two steps of the lead funnel."""
        return conversion_factor ** 0.5

    def form_start_rate(self, conversion_factor: float) -> float:
        """Probability a form_start fires on a contact page left without submitting."""
        rate = float(self.raw["journey"].get("form_start_rate", DEFAULT_FORM_START_RATE))
        return min(1.0, rate * self.lead_edge_factor(conversion_factor))

    # -- leads -----------------------------------------------------------
    def lead_setting(self, key: str) -> Any:
        """A `leads` value: form_id, form_name, form_submit_text, value, lead_source."""
        leads = self.raw.get("leads") or {}
        return leads[key] if key in leads else DEFAULT_LEADS[key]

    # -- calendar --------------------------------------------------------
    def day_factors(self, day: dt.date) -> DayFactors:
        """Traffic, return, conversion, channel and campaign factors for ``day``."""
        cached = self._day_cache.get(day)
        if cached is not None:
            return cached

        traffic = returns = 1.0
        conversion = self._demand(day)
        channels: dict[str, float] = {}
        returning_channels: dict[str, float] = {}
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
                # A launch that only brings in new visitors leaves returning
                # visits on their usual channels.
                if not event.get("new_visitors_only", False):
                    returning_channels[name] = returning_channels.get(name, 1.0) * float(factor)
            campaigns.update(event.get("campaigns") or {})

        factors = DayFactors(
            traffic, returns, conversion, channels, campaigns, tuple(active), returning_channels
        )
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

    # -- consent ---------------------------------------------------------
    @property
    def consent_enabled(self) -> bool:
        """Whether consent mode applies. Off, every visitor grants both storages."""
        return bool(self.raw["consent"].get("enabled", True))

    @property
    def offline_orders_enabled(self) -> bool:
        """Whether customers place offline orders at all.

        ``enabled: false`` switches them off whatever the rate. A missing block
        or a zero ``daily_rate`` also means none.
        """
        cfg = self.server_side.get("offline_orders") or {}
        return bool(cfg.get("enabled", True)) and float(cfg.get("daily_rate", 0.0)) > 0.0

    @property
    def offline_line_item_weights(self) -> tuple[list[int], list[float]]:
        """Lines per offline order and their relative weights, in ascending order."""
        cfg = self.server_side.get("offline_orders") or {}
        weights = cfg.get("line_item_weights") or DEFAULT_OFFLINE_LINE_ITEM_WEIGHTS
        lines = sorted(int(n) for n in weights)
        return lines, [float(weights[n]) for n in lines]

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

    @property
    def cross_device_device_weights(self) -> dict[str, float]:
        """Device mix for second devices, in configured device order; empty when unset."""
        mix = self.raw["identity"].get("cross_device_device_mix") or {}
        return {name: float(mix.get(name, 0.0)) for name in self.raw["devices"]} if mix else {}

    @property
    def device_channel_skew(self) -> dict[str, dict[str, float]]:
        """Channel factors for a new visitor's first channel, by device category."""
        return {
            device: {channel: float(f) for channel, f in factors.items()}
            for device, factors in ((self.raw.get("acquisition") or {}).get("device_channel_skew") or {}).items()
        }

    def device_conversion_factor(self, category: str) -> float:
        """Conversion factor for a device category; 1 when unset."""
        factors = (self.raw.get("intent") or {}).get("device_conversion_factor") or {}
        return float(factors.get(category, 1.0))

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
        dwell = self.raw["dwell_seconds"]
        low, high = dwell[name] if name in dwell else DEFAULT_LEAD_DWELL[name]
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
        if "decay_days" in raw["retention"]:
            raise ValueError("retention sets both return_curve and decay_days; keep one")
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
    by_channel = intent.get("channel_segment_weights") or {}
    unknown = sorted(set(by_channel) - set(raw["channels"]))
    if unknown:
        raise ValueError(f"intent.channel_segment_weights names channels not in property.yaml: {unknown}")
    segment_names = set(intent.get("segments") or {"default": None})
    for channel, weights in by_channel.items():
        where = f"intent.channel_segment_weights.{channel}"
        unknown = sorted(set(weights or {}) - segment_names)
        if unknown:
            raise ValueError(f"{where} names segments not in intent.segments: {unknown}")
        values = [float(w) for w in (weights or {}).values()]
        if any(w < 0 for w in values) or sum(values) <= 0:
            raise ValueError(f"{where} needs non-negative weights with a positive sum")
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
        if not isinstance(event.get("new_visitors_only", False), bool):
            raise ValueError(f"{where}.new_visitors_only must be true or false")
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
    if not isinstance(offline.get("enabled", True), bool):
        raise ValueError("server_side.offline_orders.enabled must be true or false")
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
    if not isinstance(raw["consent"].get("enabled", True), bool):
        raise ValueError("consent.enabled must be true or false")
    for key in ("analytics_granted", "ads_granted"):
        share = float(raw["consent"][key])
        if not 0.0 <= share <= 1.0:
            raise ValueError(f"consent.{key} must be between 0 and 1, got {share}")

    _validate_journey(raw)
    _validate_events(raw)
    _validate_tracking(raw)
    _validate_extra_sessions(raw)
    _validate_device_and_intent_levers(raw)
    _validate_fixed_values(raw)
    _validate_leads(raw)


def _validate_leads(raw: dict[str, Any]) -> None:
    """The `leads` block: form attributes and the value of one lead."""
    leads = raw.get("leads")
    if leads is None:
        return
    if not isinstance(leads, dict):
        raise ValueError("leads must be a mapping")
    unknown = sorted(set(leads) - set(DEFAULT_LEADS))
    if unknown:
        raise ValueError(f"leads has unknown keys: {unknown}")
    for key in ("form_id", "form_name", "form_submit_text"):
        if key in leads and not isinstance(leads[key], str):
            raise ValueError(f"leads.{key} must be a string")
    allowed = {
        "value": {"choice", "int_range", "float_range", "round", "present"},
        "lead_source": {"choice", "present"},
    }
    for key, keys in allowed.items():
        spec = leads.get(key)
        if isinstance(spec, dict) and set(spec) - keys:
            raise ValueError(f"leads.{key} may only use {sorted(keys)}")
        if key == "value" and spec is not None and not isinstance(spec, dict):
            if not isinstance(spec, (int, float)) or isinstance(spec, bool) or spec < 0:
                raise ValueError("leads.value must be a non-negative number, a value spec, or null")
        try:
            validate_spec(spec, f"leads.{key}")
        except ValueSpecError as error:
            raise ValueError(str(error)) from error


def _validate_fixed_values(raw: dict[str, Any]) -> None:
    """Values the export carries verbatim: currency conversion, language, labels, ids."""
    prop = raw["property"]
    rate = prop.get("usd_exchange_rate")
    if rate is not None and (not isinstance(rate, (int, float)) or isinstance(rate, bool) or rate <= 0):
        raise ValueError(f"property.usd_exchange_rate must be a positive number, got {rate!r}")
    if prop["currency"] == "USD" and rate is not None and float(rate) != 1.0:
        raise ValueError("property.usd_exchange_rate must be 1.0 when property.currency is USD")
    if prop["currency"] != "USD" and rate is None:
        raise ValueError(
            f"property.currency is {prop['currency']}, so property.usd_exchange_rate is required: "
            "the *_in_usd fields hold the same amounts converted to US dollars"
        )
    for where, value in [("property.default_language", prop.get("default_language"))] + [
        (f"geos.{name}.language", geo.get("language")) for name, geo in raw["geos"].items()
    ]:
        if value is not None and (not isinstance(value, str) or not value):
            raise ValueError(f"{where} must be a language tag such as en-us, got {value!r}")

    for channel, cfg in raw["channels"].items():
        where = f"channels.{channel}"
        group = cfg.get("channel_group")
        if group is not None and (not isinstance(group, str) or not group):
            raise ValueError(f"{where}.channel_group must be a non-empty string")
        ads = cfg.get("google_ads")
        if ads is None:
            continue
        if not cfg.get("gclid"):
            raise ValueError(f"{where}.google_ads has no effect without `gclid: true`")
        if not isinstance(ads, dict):
            raise ValueError(f"{where}.google_ads must be a mapping with customer_id and account_name")
        unknown = sorted(set(ads) - set(DEFAULT_GOOGLE_ADS))
        if unknown:
            raise ValueError(f"{where}.google_ads has unknown keys: {unknown}")
        if "customer_id" in ads and not str(ads["customer_id"]).isdigit():
            raise ValueError(f"{where}.google_ads.customer_id must be digits, as Google Ads writes it")
        try:
            str(ads.get("account_name", "")).format(brand="")
        except (KeyError, IndexError, ValueError) as error:
            raise ValueError(
                f"{where}.google_ads.account_name may only use the {{brand}} field: {error}"
            ) from error

    ecommerce = raw["ecommerce"]
    for key in ("transaction_id_prefix", "view_item_list_name"):
        value = ecommerce.get(key, DEFAULT_ECOMMERCE[key])
        if key == "view_item_list_name" and value is None:
            continue
        if not isinstance(value, str):
            raise ValueError(f"ecommerce.{key} must be a string")
    for key in ("shipping_tier", "payment_type"):
        spec = ecommerce.get(key, DEFAULT_ECOMMERCE[key])
        if isinstance(spec, dict) and set(spec) - {"choice", "present"}:
            raise ValueError(f"ecommerce.{key} must be a literal or a {{choice: ...}}, optionally with `present`")
        try:
            validate_spec(spec, f"ecommerce.{key}")
        except ValueSpecError as error:
            raise ValueError(str(error)) from error

    offline = (raw.get("server_side") or {}).get("offline_orders") or {}
    weights = offline.get("line_item_weights")
    if weights is not None:
        where = "server_side.offline_orders.line_item_weights"
        if not isinstance(weights, dict) or not weights:
            raise ValueError(f"{where} must be a non-empty mapping of line count to weight")
        for count, weight in weights.items():
            if not isinstance(count, int) or isinstance(count, bool) or count < 1:
                raise ValueError(f"{where} key {count!r} must be a whole number, 1 or greater")
            if float(weight) < 0:
                raise ValueError(f"{where}[{count}] must not be negative")
        if sum(float(w) for w in weights.values()) <= 0:
            raise ValueError(f"{where} must not all be zero")
        cap = int(raw["cart"]["max_line_items"])
        over = sorted(count for count, weight in weights.items() if count > cap and float(weight) > 0)
        if over:
            raise ValueError(
                f"{where} draws {over} lines, more than cart.max_line_items ({cap}); "
                "those orders would be cut down to the cap"
            )


def _validate_device_and_intent_levers(raw: dict[str, Any]) -> None:
    """Device-dependent mixes and factors, and intent-dependent custom-event rates."""
    devices = set(raw["devices"])
    channels = set(raw["channels"])
    segments = set((raw.get("intent") or {}).get("segments") or {"default": None})

    mix = raw["identity"].get("cross_device_device_mix") or {}
    unknown = sorted(set(mix) - devices)
    if unknown:
        raise ValueError(f"identity.cross_device_device_mix names devices not in property.yaml: {unknown}")
    if mix and (any(float(w) < 0 for w in mix.values()) or sum(float(w) for w in mix.values()) <= 0):
        raise ValueError("identity.cross_device_device_mix needs non-negative weights with a positive sum")

    skew = (raw.get("acquisition") or {}).get("device_channel_skew") or {}
    unknown = sorted(set(skew) - devices)
    if unknown:
        raise ValueError(f"acquisition.device_channel_skew names devices not in property.yaml: {unknown}")
    for device, factors in skew.items():
        unknown = sorted(set(factors or {}) - channels)
        if unknown:
            raise ValueError(f"acquisition.device_channel_skew.{device} names channels not in property.yaml: {unknown}")
        if any(float(f) < 0 for f in (factors or {}).values()):
            raise ValueError(f"acquisition.device_channel_skew.{device} factors must not be negative")

    factors = (raw.get("intent") or {}).get("device_conversion_factor") or {}
    unknown = sorted(set(factors) - devices)
    if unknown:
        raise ValueError(f"intent.device_conversion_factor names devices not in property.yaml: {unknown}")
    if any(float(f) <= 0 for f in factors.values()):
        raise ValueError("intent.device_conversion_factor values must be positive")

    for index, custom in enumerate(raw["tracking"].get("custom_events") or []):
        by_intent = custom.get("rate_by_intent") or {}
        where = f"tracking.custom_events[{index}].rate_by_intent"
        unknown = sorted(set(by_intent) - segments)
        if unknown:
            raise ValueError(f"{where} names segments not in intent.segments: {unknown}")
        if any(float(f) < 0 for f in by_intent.values()):
            raise ValueError(f"{where} factors must not be negative")


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
    for page, entry in raw["pages"].items():
        # A page type is one {path, title}, or a list of them for a page type
        # with several URLs, such as articles. A list entry may add a weight.
        variants = entry if isinstance(entry, list) else [entry]
        if not variants:
            raise ValueError(f"pages.{page} must not be an empty list")
        for index, template in enumerate(variants):
            where = f"pages.{page}" if not isinstance(entry, list) else f"pages.{page}[{index}]"
            if not isinstance(template, dict):
                raise ValueError(f"{where} must be a mapping with path and title")
            for key in ("path", "title"):
                if key not in template:
                    raise ValueError(f"{where} is missing {key!r}")
            unknown = sorted(set(template) - {"path", "title", "weight"})
            if unknown:
                raise ValueError(f"{where} has unknown keys: {unknown}")
            if "weight" in template and not isinstance(entry, list):
                raise ValueError(f"{where}.weight only applies to a list of page variants")
            weight = template.get("weight", 1)
            if not isinstance(weight, (int, float)) or isinstance(weight, bool) or weight <= 0:
                raise ValueError(f"{where}.weight must be a positive number")

    # A thank-you page reached without sending the form would carry a
    # generate_lead with no form_submit before it.
    if "lead_confirmation" in raw["journey"]["entry_weights"]:
        raise ValueError("journey.entry_weights cannot include lead_confirmation: a lead needs a form first")
    for page, targets in transitions.items():
        if "lead_confirmation" in targets and page != "contact":
            raise ValueError(
                f"journey.transitions[{page}] leads to lead_confirmation; only contact can, "
                "because the confirmation page is where a submitted form lands"
            )
    rate = raw["journey"].get("form_start_rate", DEFAULT_FORM_START_RATE)
    if not isinstance(rate, (int, float)) or isinstance(rate, bool) or not 0.0 <= rate <= 1.0:
        raise ValueError("journey.form_start_rate must be a probability between 0 and 1")
    for name in DEFAULT_LEAD_DWELL:
        pair = raw["dwell_seconds"].get(name)
        if pair is None:
            continue
        if not isinstance(pair, (list, tuple)) or len(pair) != 2 or float(pair[0]) > float(pair[1]):
            raise ValueError(f"dwell_seconds.{name} must be [min, max] seconds with min <= max")

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

    chains = [("lead", LEAD_FUNNEL_CHAIN)]
    # With ecommerce off its funnel is off wholesale; per-event toggles do not apply.
    if bool(raw["ecommerce"].get("enabled", True)):
        chains.insert(0, ("ecommerce", FUNNEL_CHAIN))
    for label, chain in chains:
        enabled = [step for step in chain if toggles.get(step, True)]
        expected = list(chain[: len(enabled)])
        if enabled != expected:
            disabled = [step for step in chain if not toggles.get(step, True)]
            raise ValueError(
                f"tracking.events: the {label} funnel must be enabled as an unbroken "
                f"run from the front of {' -> '.join(chain)}. "
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
    "campaign", "term", "content", "gclid", "form_id", "form_name",
    "form_destination", "form_submit_text", "lead_source",
})

# Event names GA4 defines. Configuration may add to these, never redefine them.
RESERVED_EVENTS = frozenset({
    "first_visit", "session_start", "page_view", "user_engagement", "scroll",
    "click", "view_search_results", "view_item_list", "select_item", "view_item",
    "add_to_cart", "view_cart", "begin_checkout", "add_shipping_info",
    "add_payment_info", "purchase", "refund", "remove_from_cart",
    "form_start", "form_submit", "generate_lead",
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
        where = f"tracking.user_properties.{name}"
        try:
            validate_spec(spec, where)
        except ValueSpecError as error:
            raise ValueError(str(error)) from error
        # A user property is resolved once per visitor, outside any event, so
        # the only template field it has is the visitor's own id.
        if isinstance(spec, dict) and "template" in spec:
            fields = set(template_fields(spec["template"])) - USER_PROPERTY_TEMPLATE_KEYS
            if fields:
                raise ValueError(
                    f"{where}: a user property template can only use "
                    f"{sorted(USER_PROPERTY_TEMPLATE_KEYS)}, not {sorted(fields)}"
                )
