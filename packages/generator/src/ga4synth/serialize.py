"""The schema layer: abstract actions to GA4 export rows.

Fidelity here is mostly about restraint. The export schema has 217 field paths,
and a real web property leaves a large share of them permanently NULL. Filling
them all would make the data obviously synthetic to anyone who has queried a
real export.

NULL policy, measured against a live web export
-----------------------------------------------
Always NULL for a web-only property:

* ``event_previous_timestamp`` (0% populated in the reference export; it is a
  Firebase/app field)
* ``event_original_occurrence_timestamp`` (0% populated)
* ``app_info.*`` (app only)
* ``device.advertising_id``, ``device.vendor_id``,
  ``device.mobile_os_hardware_model`` (app only)
* ``publisher.*`` (AdMob only)
* ``event_dimensions.hostname`` (deprecated; NULL in modern exports)
* ``ecommerce.refund_*`` and ``items.item_refund*`` (no refund events modelled)
* the ad-platform branches of ``session_traffic_source_last_click``
  (``google_ads_campaign`` is populated only for gclid traffic; ``sa360_campaign``,
  ``cm360_campaign``, ``dv360_campaign`` require integrations this property does
  not have)
* ``user_properties`` is empty unless the config declares some under
  ``tracking.user_properties``; a vanilla export has none

``user_ltv.revenue`` is genuine lifetime value: it spans a visitor's earlier
sessions, which are re-simulated from their identity rather than read back from
an earlier shard. See ``_prior_ltv``.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Iterator
from zoneinfo import ZoneInfo

from .params import build_params, pack, pack_session_engaged
from .rng import derive, stable_int
from .simulate import Action, Session, Visitor, _offline_order_dates, _page, build_offline_order, build_session
from .values import resolve, resolve_mapping
from .world import World

_NULL_APP_INFO = {
    "id": None, "version": None, "install_store": None,
    "firebase_app_id": None, "install_source": None,
}

_NULL_PUBLISHER = {
    "ad_revenue_in_usd": None, "ad_format": None,
    "ad_source_name": None, "ad_unit_id": None,
}


def _struct(keys: list[str], values: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build a struct with all keys present, defaulting to NULL."""
    base = dict.fromkeys(keys)
    if values:
        base.update(values)
    return base


_MANUAL_CAMPAIGN_KEYS = [
    "campaign_id", "campaign_name", "source", "medium", "term", "content",
    "source_platform", "creative_format", "marketing_tactic",
]
_GOOGLE_ADS_KEYS = [
    "customer_id", "account_name", "campaign_id", "campaign_name",
    "ad_group_id", "ad_group_name",
]
_CROSS_CHANNEL_KEYS = [
    "campaign_id", "campaign_name", "source", "medium", "source_platform",
    "default_channel_group", "primary_channel_group",
]
_SA360_KEYS = [
    "campaign_id", "campaign_name", "source", "medium", "ad_group_id",
    "ad_group_name", "creative_format", "engine_account_name",
    "engine_account_type", "manager_account_name",
]
_CM360_KEYS = [
    "campaign_id", "campaign_name", "source", "medium", "account_id",
    "account_name", "advertiser_id", "advertiser_name", "creative_id",
    "creative_format", "creative_name", "creative_type", "creative_type_id",
    "creative_version", "placement_id", "placement_cost_structure",
    "placement_name", "rendering_id", "site_id", "site_name",
]
_DV360_KEYS = [
    "campaign_id", "campaign_name", "source", "medium", "advertiser_id",
    "advertiser_name", "creative_id", "creative_format", "creative_name",
    "exchange_id", "exchange_name", "insertion_order_id",
    "insertion_order_name", "line_item_id", "line_item_name", "partner_id",
    "partner_name",
]

_ITEM_KEYS = [
    "item_id", "item_name", "item_brand", "item_variant", "item_category",
    "item_category2", "item_category3", "item_category4", "item_category5",
    "price_in_usd", "price", "quantity", "item_revenue_in_usd", "item_revenue",
    "item_refund_in_usd", "item_refund", "coupon", "affiliation", "location_id",
    "item_list_id", "item_list_name", "item_list_index", "promotion_id",
    "promotion_name", "creative_name", "creative_slot", "item_params",
]

_ECOMMERCE_KEYS = [
    "total_item_quantity", "purchase_revenue_in_usd", "purchase_revenue",
    "refund_value_in_usd", "refund_value", "shipping_value_in_usd",
    "shipping_value", "tax_value_in_usd", "tax_value", "unique_items",
    "transaction_id",
]


def _money(amount: float) -> float:
    return round(amount + 1e-9, 2)


def _cart_totals(world: World, cart: list[Any]) -> dict[str, float]:
    subtotal = _money(sum(line.price * line.quantity for line in cart))
    ecom = world.section("ecommerce")
    shipping = 0.0 if subtotal >= float(ecom["free_shipping_threshold"]) else float(ecom["shipping_flat"])
    tax = _money(subtotal * float(ecom["tax_rate"]))
    return {
        "subtotal": subtotal,
        "shipping": shipping,
        "tax": tax,
    }


def _items_array(world: World, cart: list[Any], list_name: str | None = None) -> list[dict[str, Any]]:
    brand = world.section("property")["brand"]
    out = []
    for index, line in enumerate(cart, start=1):
        revenue = _money(line.price * line.quantity)
        out.append(
            _struct(
                _ITEM_KEYS,
                {
                    "item_id": line.item_id,
                    "item_name": line.item_name,
                    "item_brand": brand,
                    "item_variant": line.variant,
                    "item_category": line.category,
                    "price_in_usd": world.to_usd(line.price),
                    "price": line.price,
                    "quantity": line.quantity,
                    "item_revenue_in_usd": world.to_usd(revenue),
                    "item_revenue": revenue,
                    "item_list_name": list_name,
                    "item_list_id": list_name.lower().replace(" ", "_") if list_name else None,
                    "item_list_index": str(index) if list_name else None,
                    "item_params": [],
                },
            )
        )
    return out


def _catalogue_items(world: World, entries: list[dict[str, Any]], list_name: str | None) -> list[dict[str, Any]]:
    """Items array for a listing event, where there is no cart yet."""
    brand = world.section("property")["brand"]
    out = []
    for index, entry in enumerate(entries, start=1):
        listed = list_name is not None
        out.append(
            _struct(
                _ITEM_KEYS,
                {
                    "item_id": entry["item_id"],
                    "item_name": entry["item_name"],
                    "item_brand": brand,
                    "item_category": entry["category"],
                    "price_in_usd": world.to_usd(float(entry["price"])),
                    "price": float(entry["price"]),
                    "item_list_name": list_name,
                    "item_list_id": list_name.lower().replace(" ", "_") if listed else None,
                    "item_list_index": str(index) if listed else None,
                    "item_params": [],
                },
            )
        )
    return out


def _last_click(world: World, channel: str, acquired: dict[str, Any]) -> dict[str, Any]:
    """Session-scoped last-click attribution, populated for every event.

    ``acquired`` is ``world.acquisition`` for the session's last click, so the
    campaign here is the one that click collected.
    """
    cfg = world.section("channels")[channel]
    is_direct = channel == "direct"
    is_google_ads = bool(cfg.get("gclid"))
    campaign = acquired["campaign"]

    manual = None
    if not is_direct and not is_google_ads:
        manual = _struct(
            _MANUAL_CAMPAIGN_KEYS,
            {
                "campaign_name": campaign or "(not set)",
                "source": acquired["source"],
                "medium": acquired["medium"],
                "term": acquired["term"],
                "content": acquired["content"],
            },
        )

    google_ads = None
    if is_google_ads:
        customer_id, account_name = world.google_ads_account(channel)
        google_ads = _struct(
            _GOOGLE_ADS_KEYS,
            {
                "customer_id": customer_id,
                "account_name": account_name,
                "campaign_id": acquired.get("campaign_id"),
                "campaign_name": campaign,
                "ad_group_id": acquired.get("ad_group_id"),
                "ad_group_name": acquired.get("ad_group_name"),
            },
        )

    group = world.channel_group(channel)
    cross_channel = _struct(
        _CROSS_CHANNEL_KEYS,
        {
            "campaign_name": campaign or "(direct)" if is_direct else campaign,
            "source": acquired["source"],
            "medium": acquired["medium"],
            "default_channel_group": group,
            "primary_channel_group": group,
        },
    )

    return {
        "manual_campaign": manual or _struct(_MANUAL_CAMPAIGN_KEYS),
        "google_ads_campaign": google_ads or _struct(_GOOGLE_ADS_KEYS),
        "cross_channel_campaign": cross_channel,
        # Integrations this property does not have.
        "sa360_campaign": _struct(_SA360_KEYS),
        "cm360_campaign": _struct(_CM360_KEYS),
        "dv360_campaign": _struct(_DV360_KEYS),
    }


# The events one page load sends together, in its first network request.
_PAGE_LOAD_EVENTS = frozenset({"first_visit", "session_start", "page_view"})


def _collected(acquired: dict[str, Any] | None) -> dict[str, Any]:
    """Campaign fields collected on the event that acquired the visit.

    ``acquired`` is None on every event that collected nothing, which is most
    of them. Direct collects nothing by definition, so it reports the same
    empty struct. An auto-tagged Google Ads click with no UTM parameters
    collects its gclid and nothing else.
    """
    keys = [
        "manual_campaign_id", "manual_campaign_name", "manual_source",
        "manual_medium", "manual_term", "manual_content",
        "manual_source_platform", "manual_creative_format",
        "manual_marketing_tactic", "gclid", "dclid", "srsltid",
    ]
    if acquired is None:
        return _struct(keys)
    if acquired["gclid_only"]:
        return _struct(keys, {"gclid": acquired["gclid"]})
    return _struct(
        keys,
        {
            "manual_campaign_name": acquired["campaign"],
            "manual_source": acquired["source"],
            "manual_medium": acquired["medium"],
            "manual_term": acquired["term"],
            "manual_content": acquired["content"],
            "gclid": acquired["gclid"],
        },
    )


def _event_params(
    world: World, session: Session, action: Action, *, engagement_ms: int | None,
    batch_ordering_id: int, acquired: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Assemble event_params for one action."""
    host = world.hostname
    referrer = action.page_referrer
    internal_referrer = bool(referrer and referrer.startswith(f"https://{host}"))
    server_side = bool(action.payload.get("server_side"))

    common: dict[str, Any] = {} if server_side else {
        # Without analytics storage GA4 has no session cookie to read, so the
        # id is absent. The session number is still reported.
        "ga_session_id": session.ga_session_id if session.analytics_granted else None,
        "ga_session_number": session.session_number,
        "page_location": f"https://{host}{action.page_path}",
        "page_title": action.page_title,
        "page_referrer": referrer,
        # Only ever "true", and only when the referrer is our own host.
        "ignore_referrer": internal_referrer,
        "engaged_session_event": 1 if session.engaged else None,
        "engagement_time_msec": engagement_ms,
        "batch_page_id": action.batch_page_id,
        "batch_ordering_id": batch_ordering_id,
    }
    # An offline order whose integration sends a session id. It still has
    # nothing else a browser adds.
    if server_side and session.server_side_only and session.ga_session_id is not None:
        common["ga_session_id"] = session.ga_session_id
        common["ga_session_number"] = session.session_number

    payload = action.payload
    name = action.event_name
    currency = world.currency

    if name == "page_view":
        common["entrances"] = 1 if payload.get("entrances") else None
    elif name == "scroll":
        common["percent_scrolled"] = payload["percent_scrolled"]
    elif name == "view_search_results":
        common["search_term"] = payload["search_term"]
        common["unique_search_term"] = 1
    elif name in ("form_start", "form_submit"):
        common.update({
            "form_id": world.lead_setting("form_id"),
            "form_name": world.lead_setting("form_name"),
            "form_destination": _form_destination(world),
        })
        if name == "form_submit":
            common["form_submit_text"] = world.lead_setting("form_submit_text")
    elif name == "generate_lead":
        value = _lead_choice(world, session, "value")
        if value is not None:
            common["value"] = value
            common["currency"] = currency
        common["lead_source"] = _lead_choice(world, session, "lead_source")
    elif name == "click":
        url = payload["link_url"]
        domain = url.split("//", 1)[-1].split("/", 1)[0]
        common.update({
            "link_url": url,
            "link_domain": domain,
            "outbound": True,
        })
    elif name in ("view_item", "add_to_cart", "view_cart", "begin_checkout",
                  "add_shipping_info", "add_payment_info", "purchase"):
        common["currency"] = currency
        if name == "view_item":
            common["value"] = float(payload["item"]["price"])
        else:
            totals = _cart_totals(world, payload["cart"])
            common["value"] = totals["subtotal"]
            if name == "add_shipping_info":
                common["shipping_tier"] = _checkout_choice(world, session, "shipping_tier")
            elif name == "add_payment_info":
                common["payment_type"] = _checkout_choice(world, session, "payment_type")
            elif name == "purchase":
                common.update({
                    "transaction_id": payload["transaction_id"],
                    "tax": totals["tax"],
                    "shipping": totals["shipping"],
                })
    elif name in ("view_item_list", "select_item"):
        common["item_list_name"] = payload["list_name"]
        common["item_list_id"] = payload["list_name"].lower().replace(" ", "_")

    # Acquisition parameters ride on whichever event collected them: the
    # entrance events, and any page view that re-acquired the visit.
    # They mirror collected_traffic_source: a gclid-only click has no UTM
    # parameters to report, so it sends the gclid alone.
    if acquired is not None and acquired["gclid_only"]:
        common["gclid"] = acquired["gclid"]
    elif acquired is not None:
        common.update({
            "source": acquired["source"],
            "medium": acquired["medium"],
            "campaign": acquired["campaign"],
            "term": acquired["term"],
            "content": acquired["content"],
            "gclid": acquired["gclid"],
        })

    standard = build_params(common)
    # A server-side event belongs to no browser session, so it has neither
    # session_engaged nor any page-scoped configured parameter.
    if server_side:
        return standard
    standard.append(pack_session_engaged(session.engaged, name))

    configured = _configured_params(world, session, action)
    if not configured:
        return standard

    # Configuration never silently overwrites a GA4 parameter. A collision is a
    # mistake in the config, and is rejected at load time by world._validate, so
    # reaching here with one would be a bug.
    taken = {entry["key"] for entry in standard}
    return standard + [
        entry for key, value in configured.items()
        if key not in taken and (entry := pack(key, value)) is not None
    ]


def _template_context(world: World, session: Session, action: Action) -> dict[str, Any]:
    """Fields a configured template may interpolate."""
    visitor = session.visitor
    acquired = world.acquisition(
        session.channel, visitor.user_pseudo_id, int(session.started.timestamp())
    )
    return {
        "event_name": action.event_name,
        "page_path": action.page_path,
        "page_title": action.page_title,
        "page_location": f"https://{world.hostname}{action.page_path}",
        "page_type": action.page_type,
        "hostname": world.hostname,
        "brand": world.section("property")["brand"],
        "channel": session.channel,
        "source": acquired["source"],
        "medium": acquired["medium"],
        "campaign": acquired["campaign"] or "",
        # A configured template must not bring back an identifier that consent
        # removed from the row.
        "user_pseudo_id": visitor.user_pseudo_id if session.analytics_granted else "",
        "ga_session_id": session.ga_session_id if session.analytics_granted else "",
        "ga_session_number": session.session_number,
        "device_category": visitor.device["category"],
        "country": visitor.geo["country"],
        "currency": world.currency,
    }


def _checkout_choice(world: World, session: Session, key: str) -> Any:
    """``ecommerce.shipping_tier`` or ``ecommerce.payment_type`` for one session.

    Drawn from a stream of its own keyed on the session, so a session repeats
    its choice on every checkout and the draw moves nothing else.
    """
    spec = world.ecommerce_setting(key)
    if not isinstance(spec, dict):
        return spec
    rng = derive(
        world.master_seed, key, session.visitor.user_pseudo_id, int(session.started.timestamp()),
    )
    return resolve(spec, rng, {})


def _form_destination(world: World) -> str | None:
    """The URL a contact form posts to: the lead_confirmation page, if there is one."""
    if "lead_confirmation" not in world.section("pages"):
        return None
    path, _ = _page(world, None, "lead_confirmation", {})
    return f"https://{world.hostname}{path}"


def _lead_choice(world: World, session: Session, key: str) -> Any:
    """``leads.value`` or ``leads.lead_source`` for one session, from its own stream."""
    spec = world.lead_setting(key)
    if not isinstance(spec, dict):
        return spec
    rng = derive(
        world.master_seed, "lead", key, session.visitor.user_pseudo_id, int(session.started.timestamp()),
    )
    return resolve(spec, rng, {})


def _event_value_in_usd(world: World, value: dict[str, Any] | None) -> float | None:
    """event_value_in_usd: the event's `value` parameter, converted to US dollars."""
    if value is None:
        return None
    amount = float(value["int_value"]) if value["int_value"] is not None else value["double_value"]
    return world.to_usd(amount)


def _configured_params(
    world: World, session: Session, action: Action
) -> dict[str, Any]:
    """Resolve global, per-event, and custom-event parameters for one action."""
    tracking = world.section("tracking")
    specs: dict[str, Any] = {}
    specs.update(tracking.get("global_params") or {})
    specs.update((tracking.get("params_by_event") or {}).get(action.event_name) or {})
    specs.update(action.payload.get("custom_params") or {})
    if not specs:
        return {}

    context = _template_context(world, session, action)

    def rng_for(name: str):
        # Per-parameter streams, so adding one parameter does not shift the
        # values of the others.
        return derive(
            world.master_seed, "param", name, session.ga_session_id,
            action.batch_page_id, action.event_name,
        )

    return resolve_mapping(specs, rng_for, context)


def _user_properties(world: World, session: Session) -> list[dict[str, Any]]:
    """Build user-scoped properties, stable for the lifetime of a visitor."""
    specs = world.section("tracking").get("user_properties") or {}
    if not specs:
        return []

    visitor = session.visitor

    def rng_for(name: str):
        # Keyed on the visitor alone, so the value never changes between their
        # sessions, which is what "user scoped" means in GA4.
        return derive(world.master_seed, "user_property", name, visitor.user_pseudo_id)

    resolved = resolve_mapping(
        specs, rng_for,
        {"user_pseudo_id": visitor.user_pseudo_id if session.analytics_granted else ""},
    )
    entries = []
    for key, value in resolved.items():
        packed = pack(key, value)
        if packed is None:
            continue
        entries.append({
            "key": key,
            "value": {**packed["value"], "set_timestamp_micros": visitor.first_touch_us},
        })
    return entries


def _ecommerce_and_items(world: World, action: Action) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Populate the ecommerce struct and items array for an action."""
    name = action.event_name
    payload = action.payload

    if name == "view_item_list":
        return _struct(_ECOMMERCE_KEYS), _catalogue_items(world, payload["items"], payload["list_name"])

    if name == "select_item":
        return _struct(_ECOMMERCE_KEYS), _catalogue_items(world, [payload["item"]], payload["list_name"])

    if name == "view_item":
        item = payload["item"]
        return _struct(_ECOMMERCE_KEYS), _catalogue_items(
            world, [item], world.ecommerce_setting("view_item_list_name")
        )

    if name in ("add_to_cart", "view_cart", "begin_checkout", "add_shipping_info", "add_payment_info"):
        cart = payload["cart"]
        totals = _cart_totals(world, cart)
        ecommerce = _struct(_ECOMMERCE_KEYS, {
            "total_item_quantity": sum(line.quantity for line in cart),
            "unique_items": len(cart),
            "shipping_value": totals["shipping"] if name in ("add_shipping_info", "add_payment_info") else None,
            "shipping_value_in_usd": world.to_usd(totals["shipping"]) if name in ("add_shipping_info", "add_payment_info") else None,
        })
        return ecommerce, _items_array(world, cart)

    if name == "purchase":
        cart = payload["cart"]
        totals = _cart_totals(world, cart)
        ecommerce = _struct(_ECOMMERCE_KEYS, {
            "total_item_quantity": sum(line.quantity for line in cart),
            "unique_items": len(cart),
            # GA4 recommends a value without shipping or tax, which have
            # fields of their own.
            "purchase_revenue": totals["subtotal"],
            "purchase_revenue_in_usd": world.to_usd(totals["subtotal"]),
            "shipping_value": totals["shipping"],
            "shipping_value_in_usd": world.to_usd(totals["shipping"]),
            "tax_value": totals["tax"],
            "tax_value_in_usd": world.to_usd(totals["tax"]),
            "transaction_id": payload["transaction_id"],
        })
        return ecommerce, _items_array(world, cart)

    return _struct(_ECOMMERCE_KEYS), []


# Lifetime revenue per (visitor, day, ordinal within the day). A visitor's
# earlier sessions are rebuilt once and reused across every shard that needs
# them, which matters because a backfill asks for the same visitor's history
# on every day they return.
_LTV_CACHE: dict[tuple[Any, ...], float] = {}
_LTV_CACHE_LIMIT = 1_000_000


# What a replayed session contributes to a later one: its purchase revenue,
# the channel of the last campaign it clicked, and its start second.
_REPLAY_CACHE: dict[tuple[Any, ...], tuple[float, str, int]] = {}


def _replay(
    world: World, visitor: Visitor, session_number: int, day: dt.date, ordinal: int = 0
) -> tuple[float, str, int]:
    """Revenue, last-click channel and start second of one replayed session."""
    key = (world.master_seed, visitor.cohort, visitor.index, day, ordinal)
    cached = _REPLAY_CACHE.get(key)
    if cached is not None:
        return cached
    prior = build_session(world, visitor, session_number, day, ordinal=ordinal)
    revenue = _money(
        sum(
            _cart_totals(world, action.payload["cart"])["subtotal"]
            for action in prior.actions
            if action.event_name == "purchase"
        )
    )
    replayed = (revenue, prior.last_click_channel, int(prior.started.timestamp()))
    if len(_REPLAY_CACHE) < _LTV_CACHE_LIMIT:
        _REPLAY_CACHE[key] = replayed
    return replayed


def _session_revenue(
    world: World, visitor: Visitor, session_number: int, day: dt.date, ordinal: int = 0
) -> float:
    """Purchase revenue from one replayed session."""
    return _replay(world, visitor, session_number, day, ordinal)[0]


def _attributed_click(world: World, session: Session) -> tuple[str, int]:
    """The channel and start second of the click GA4 attributes this session to.

    GA4 avoids attributing a session to direct. A session that arrives direct
    reports the visitor's last non-direct campaign, when one was clicked within
    the lookback window. Earlier sessions are replayed from the visitor's
    identity, as the lifetime value is, so a shard still stands on its own.
    The start second comes back too, because it keys the campaign choice: the
    session must name the campaign the earlier session actually collected.
    """
    own = (session.last_click_channel, int(session.started.timestamp()))
    lookback = world.last_non_direct_lookback_days
    if session.last_click_channel != "direct" or lookback <= 0 or session.server_side_only:
        return own
    session_day = session.started.astimezone(ZoneInfo(world.timezone)).date()
    oldest = own[1] - lookback * 86_400
    history = list(enumerate(session.prior_sessions, start=1))
    for number, (day, ordinal) in reversed(history):
        # The calendar day rules most sessions out without replaying them. The
        # window itself is exact: lookback days of 24 hours before this start.
        if (session_day - day).days > lookback:
            break
        _, channel, started = _replay(world, session.visitor, number, day, ordinal)
        if started < oldest:
            break
        if channel != "direct":
            return channel, started
    return own


def _prior_ltv(world: World, session: Session) -> float:
    """Revenue this visitor accumulated before the current session began.

    GA4's ``user_ltv.revenue`` is lifetime, so it has to span sessions. Earlier
    sessions are re-simulated from the visitor's identity instead of being read
    from an earlier shard, which is what keeps a shard reproducible on its own.
    The cost is bounded by the retention curve, which gives a visitor a handful
    of sessions at most. Earlier sessions of the same day count too, and the
    position of a prior session in the history is its session number.
    """
    web = sum(
        _session_revenue(world, session.visitor, number, day, ordinal)
        for number, (day, ordinal) in enumerate(session.prior_sessions, start=1)
    )
    offline = sum(
        _offline_order_revenue(world, session.visitor, day)
        for day in _offline_order_dates(world, session.visitor, before=session.started)
    )
    return _money(web + offline)


def _offline_order_revenue(world: World, visitor: Visitor, day: dt.date) -> float:
    """Revenue of one replayed offline order."""
    key = (world.master_seed, "offline", visitor.cohort, visitor.index, day)
    cached = _LTV_CACHE.get(key)
    if cached is not None:
        return cached
    order = build_offline_order(world, visitor, day)
    revenue = _money(_cart_totals(world, order.actions[0].payload["cart"])["subtotal"])
    if len(_LTV_CACHE) < _LTV_CACHE_LIMIT:
        _LTV_CACHE[key] = revenue
    return revenue


def _null_last_click() -> dict[str, Any]:
    """session_traffic_source_last_click for an event GA4 attributes to no session.

    That is a server-side event, and every event of a visitor who denied
    analytics storage.
    """
    return {
        "manual_campaign": _struct(_MANUAL_CAMPAIGN_KEYS),
        "google_ads_campaign": _struct(_GOOGLE_ADS_KEYS),
        "cross_channel_campaign": _struct(_CROSS_CHANNEL_KEYS),
        "sa360_campaign": _struct(_SA360_KEYS),
        "cm360_campaign": _struct(_CM360_KEYS),
        "dv360_campaign": _struct(_DV360_KEYS),
    }


def _serialize_server_side(
    world: World, session: Session, action: Action, prior_ltv: float,
    traffic_source: dict[str, Any], user_properties: list[dict[str, Any]], rng,
) -> Iterator[dict[str, Any]]:
    """One purchase sent from the server, outside any browser session.

    The client id and user id are the customer's, so it lands on their
    user_pseudo_id. What a browser would add is absent: no session or page
    parameters, no batch position, no collected campaign, no session
    attribution. Device and geo are the visitor's, as they are when the server
    forwards them with the event.

    The one exception is an offline order whose integration sends a session
    id: it carries ga_session_id and ga_session_number, and nothing else. A
    visitor who denied analytics storage never reaches this function.
    """
    tz = ZoneInfo(world.timezone)
    visitor = session.visitor
    ecommerce, items = _ecommerce_and_items(world, action)
    params = _event_params(world, session, action, engagement_ms=None, batch_ordering_id=0, acquired=None)
    local = action.when.astimezone(tz)
    value = next((p["value"] for p in params if p["key"] == "value"), None)
    yield {
        "event_date": local.strftime("%Y%m%d"),
        "event_timestamp": int(action.when.timestamp() * 1_000_000),
        "event_name": action.event_name,
        "event_params": params,
        "event_previous_timestamp": None,
        "event_value_in_usd": _event_value_in_usd(world, value),
        "event_bundle_sequence_id": stable_int(
            world.master_seed, "bundle", action.payload["transaction_id"], digits=9,
        ),
        "event_server_timestamp_offset": rng.randrange(*world.server_offset_micros),
        "user_id": session.user_id,
        "user_pseudo_id": visitor.user_pseudo_id,
        "privacy_info": {
            "analytics_storage": "Yes" if session.analytics_granted else "No",
            "ads_storage": "Yes" if session.ads_granted else "No",
            "uses_transient_token": "No",
        },
        "user_properties": user_properties,
        "user_first_touch_timestamp": visitor.first_touch_us,
        "user_ltv": {
            "revenue": _money(prior_ltv + (ecommerce["purchase_revenue"] or 0.0)),
            "currency": world.currency,
        },
        "device": {
            "category": visitor.device["category"],
            "mobile_brand_name": visitor.device["mobile_brand_name"],
            "mobile_model_name": "",
            "mobile_marketing_name": "",
            "mobile_os_hardware_model": None,
            "operating_system": visitor.device["operating_system"],
            "operating_system_version": "",
            "vendor_id": None,
            "advertising_id": None,
            "language": visitor.language,
            "is_limited_ad_tracking": "No",
            "time_zone_offset_seconds": int(local.utcoffset().total_seconds()),
            "browser": visitor.device["browser"],
            "browser_version": "",
            "web_info": {
                "browser": visitor.device["browser"],
                "browser_version": "",
                "hostname": world.hostname,
            },
        },
        "geo": {
            "city": visitor.geo["city"],
            "country": visitor.geo["country"],
            "continent": visitor.geo["continent"],
            "region": visitor.geo["region"],
            "sub_continent": visitor.geo["sub_continent"],
            "metro": visitor.geo["metro"],
        },
        "app_info": dict(_NULL_APP_INFO),
        "traffic_source": traffic_source,
        "stream_id": world.stream_id,
        "platform": "WEB",
        "event_dimensions": {"hostname": None},
        "ecommerce": ecommerce,
        "items": items,
        "collected_traffic_source": _collected(None),
        "is_active_user": False,
        "batch_event_index": None,
        "batch_page_id": None,
        "batch_ordering_id": None,
        "session_traffic_source_last_click": _null_last_click(),
        "publisher": dict(_NULL_PUBLISHER),
        "event_original_occurrence_timestamp": None,
    }


def serialize_session(world: World, session: Session) -> Iterator[dict[str, Any]]:
    """Yield export rows for one session, in event order."""
    tz = ZoneInfo(world.timezone)
    visitor = session.visitor

    def gclid_for(channel: str | None) -> str | None:
        """The click id a paid channel would carry, keyed so two acquisitions differ."""
        if channel is None or not world.section("channels")[channel].get("gclid"):
            return None
        return "Cj0KCQ" + str(
            stable_int(
                world.master_seed, "gclid", visitor.user_pseudo_id,
                session.ga_session_id, channel, digits=12,
            )
        )

    start_epoch = int(session.started.timestamp())
    acquisitions: dict[str, dict[str, Any]] = {}

    def acquired_by(channel: str | None) -> dict[str, Any] | None:
        """Everything one acquisition collected, or None if it collected nothing.

        Resolved once per channel and shared by collected_traffic_source and
        the event parameters, so the two cannot disagree.
        """
        if channel is None or channel == "direct":
            return None
        if channel not in acquisitions:
            gclid = gclid_for(channel)
            # Whether an auto-tagged click also carries UTM parameters. Its own
            # stream, so turning the dial moves nothing else.
            gclid_only = gclid is not None and derive(
                world.master_seed, "gclid-only", visitor.user_pseudo_id,
                session.ga_session_id, channel,
            ).random() < world.gclid_only_share
            acquisitions[channel] = {
                **world.acquisition(channel, visitor.user_pseudo_id, start_epoch),
                "gclid": gclid,
                "gclid_only": gclid_only,
            }
        return acquisitions[channel]

    # User-scoped first-touch attribution is constant across all of a visitor's
    # events, and reflects their *first* channel, not this session's. The first
    # session started at the first touch, so this is the campaign it collected.
    first_acquired = world.acquisition(
        visitor.first_channel, visitor.user_pseudo_id, visitor.first_touch_us // 1_000_000
    )
    # Without a campaign, GA4 names the medium in parentheses: (organic),
    # (referral). Direct, whose medium is (none), becomes (direct).
    medium = first_acquired["medium"]
    traffic_source = {
        "name": first_acquired["campaign"] or ("(direct)" if medium == "(none)" else f"({medium})"),
        "medium": medium,
        "source": first_acquired["source"],
    }

    # Analytics storage denied: GA4 exports the events without the identifiers
    # that would tie them to a browser or a session, and attributes nothing at
    # session scope. The events themselves are unchanged.
    denied = not session.analytics_granted

    # GA4 resolves a click id server-side, so last click names the campaign
    # even when the click collected a gclid and nothing else.
    if denied:
        last_click = _null_last_click()
    else:
        click_channel, click_epoch = _attributed_click(world, session)
        last_click = _last_click(
            world, click_channel,
            world.acquisition(click_channel, visitor.user_pseudo_id, click_epoch),
        )
    user_properties = _user_properties(world, session)
    # An offline order may have no session id. Its start time then keys the stream.
    rng = derive(
        world.master_seed, "rows", visitor.user_pseudo_id,
        session.ga_session_id if session.ga_session_id is not None else session.started.isoformat(),
    )

    # A batch is one network request. The page-load request holds first_visit,
    # session_start and page_view only, as in a real export. A later event on
    # the page joins the current request while the batching window is open and
    # opens a new one otherwise. batch_ordering_id increments across batches;
    # batch_event_index positions events inside one.
    #
    # This matters for attribution. Only the page-load events collect the
    # campaign, and a model that falls back to page_referrer on the first batch
    # would otherwise read an external referrer off view_item_list or scroll.
    batch_counter = 0
    batch_page: int | None = None
    batch_started: dt.datetime | None = None
    batch_is_page_load = False
    position = 0

    previous_when: dt.datetime | None = None
    ltv = _prior_ltv(world, session)

    for action in session.actions:
        server_side = bool(action.payload.get("server_side"))
        if server_side:
            yield from _serialize_server_side(world, session, action, ltv, traffic_source, user_properties, rng)
            ltv = _money(ltv + _cart_totals(world, action.payload["cart"])["subtotal"])
            continue
        page_load = action.event_name in _PAGE_LOAD_EVENTS
        same_batch = (
            action.batch_page_id == batch_page
            and page_load == batch_is_page_load
            and (action.when - batch_started).total_seconds() <= world.batch_window_seconds
        )
        if same_batch:
            position += 1
        else:
            batch_counter += 1
            batch_page = action.batch_page_id
            batch_started = action.when
            batch_is_page_load = page_load
            position = 0
        batch_ordering_id = batch_counter

        engagement_ms: int | None = None
        if previous_when is not None:
            delta = int((action.when - previous_when).total_seconds() * 1000)
            engagement_ms = delta if delta > 0 else None
        previous_when = action.when

        ecommerce, items = _ecommerce_and_items(world, action)
        if action.event_name == "purchase":
            ltv = _money(ltv + (ecommerce["purchase_revenue"] or 0.0))

        acquired = acquired_by(action.acquisition)
        params = _event_params(
            world, session, action,
            engagement_ms=engagement_ms,
            batch_ordering_id=batch_ordering_id,
            acquired=acquired,
        )

        value_param = next(
            (p["value"] for p in params if p["key"] == "value"), None
        )
        event_value_in_usd = _event_value_in_usd(world, value_param)

        local = action.when.astimezone(tz)

        # GA4 lost the opening hit. Everything above still ran, so the rows
        # that remain are exactly the ones the full session would have had.
        dropped = session.start_dropped and action.event_name in ("first_visit", "session_start")

        row = {
            "event_date": local.strftime("%Y%m%d"),
            "event_timestamp": int(action.when.timestamp() * 1_000_000),
            "event_name": action.event_name,
            "event_params": params,
            "event_previous_timestamp": None,  # app-only
            "event_value_in_usd": event_value_in_usd,
            "event_bundle_sequence_id": stable_int(
                world.master_seed, "bundle", session.ga_session_id,
                action.batch_page_id, batch_ordering_id, digits=9,
            ),
            "event_server_timestamp_offset": rng.randrange(*world.server_offset_micros),
            # NULL without analytics storage. For user_id that is an
            # assumption: the reference export has no user_id at all.
            "user_id": None if denied else session.user_id,
            "user_pseudo_id": None if denied else visitor.user_pseudo_id,
            "privacy_info": {
                "analytics_storage": "Yes" if session.analytics_granted else "No",
                "ads_storage": "Yes" if session.ads_granted else "No",
                "uses_transient_token": "No",
            },
            "user_properties": user_properties,
            "user_first_touch_timestamp": visitor.first_touch_us,
            "user_ltv": {"revenue": ltv, "currency": world.currency},
            "device": {
                "category": visitor.device["category"],
                "mobile_brand_name": visitor.device["mobile_brand_name"],
                "mobile_model_name": "",
                "mobile_marketing_name": "",
                "mobile_os_hardware_model": None,  # app-only
                "operating_system": visitor.device["operating_system"],
                "operating_system_version": "",
                "vendor_id": None,  # app-only
                "advertising_id": None,  # app-only
                "language": visitor.language,
                "is_limited_ad_tracking": "No",
                "time_zone_offset_seconds": int(local.utcoffset().total_seconds()),
                "browser": visitor.device["browser"],
                "browser_version": "",
                "web_info": {
                    "browser": visitor.device["browser"],
                    "browser_version": "",
                    "hostname": world.hostname,
                },
            },
            "geo": {
                "city": visitor.geo["city"],
                "country": visitor.geo["country"],
                "continent": visitor.geo["continent"],
                "region": visitor.geo["region"],
                "sub_continent": visitor.geo["sub_continent"],
                "metro": visitor.geo["metro"],
            },
            "app_info": dict(_NULL_APP_INFO),  # web-only property
            "traffic_source": traffic_source,
            "stream_id": world.stream_id,
            "platform": "WEB",
            "event_dimensions": {"hostname": None},  # deprecated, NULL in modern exports
            "ecommerce": ecommerce,
            "items": items,
            "collected_traffic_source": _collected(acquired),
            # GA4 counts a user as active for an engaged session, which is the
            # rule build_session already applies: 2+ page views, 10s+, or a
            # conversion. The previous disjunction also accepted any session
            # with more than one action, and since every session emits at least
            # session_start and page_view, that made the column constantly True.
            "is_active_user": session.engaged,
            "batch_event_index": position,
            "batch_page_id": action.batch_page_id,
            "batch_ordering_id": batch_ordering_id,
            "session_traffic_source_last_click": last_click,
            "publisher": dict(_NULL_PUBLISHER),  # no AdMob
            "event_original_occurrence_timestamp": None,  # 0% populated in web exports
        }
        if not dropped:
            yield row
