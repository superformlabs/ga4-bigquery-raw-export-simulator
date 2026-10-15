"""GEN-3: two configurations, `ecommerce` and `default` (decision D-23).

`ecommerce` is the app's own configuration of the website that sells its
plans online (D-97). `default` is the same company and the same site without
its shop. It belongs
to the app, and it is the ecommerce configuration with five changes:

    property.yaml  ecommerce.enabled is false
                   pages has no pdp, cart, checkout or purchased
                   tracking.events has the nine events of a shop at false
                   tracking.custom_events has no trial_start: it fires on
                   the pdp, a page this site does not have
    mixer.yaml     journey.entry_weights and journey.transitions have no shop
                   page; what went to them is shared in proportion

`config/` holds two more folders, `eu-consent` and `lead-generation`. The
app offers those two as well, since issues #317, #318 and #316 of
2026-10-14 (decision D-96): all four are a `datasetType`, and the image
holds all four. The integration tests run the command line against
`default` and `ecommerce` (`conftest.py`); the two others are exercised by
the generator's own tests and, here, by the test that they load. Since D-97
all four are the same invented website, GA4Dataform's own.

The tests here read the files and the rows written by the command line. They
assert no number of rows and no rate.
"""

from __future__ import annotations

import copy
import gzip
import json
from pathlib import Path

import pytest
import yaml

from conftest import (
    CONFIG_DIR,
    CONFIG_FILES,
    CONFIG_FOLDERS,
    CONFIGURATIONS,
    DEFAULT,
    ECOMMERCE,
    OUTSIDE_THE_PAIR,
    mixer_file,
    property_file,
)

# The page types of a shop. The generator refuses them when ecommerce is off.
SHOP_PAGES = {"pdp", "cart", "checkout", "purchased"}

# The events only a shop sends.
SHOP_EVENTS = {
    "view_item_list", "select_item", "view_item", "add_to_cart", "view_cart",
    "begin_checkout", "add_shipping_info", "add_payment_info", "purchase",
}

# The custom event `default` drops with the shop pages: it fires on the pdp.
SHOP_CUSTOM_EVENTS = {"trial_start"}

# Weights of the default journey are written with two decimals, so that each
# row of transitions adds up to 100 exactly.
ROUNDING = 0.02


def load(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        loaded = yaml.safe_load(handle)
    assert isinstance(loaded, dict), path
    return loaded


def rows_of(shard: Path) -> list[dict]:
    with gzip.open(shard, "rt", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle]


def shares(weights: dict[str, float]) -> dict[str, float]:
    """Relative weights as parts of 100."""
    total = sum(float(weight) for weight in weights.values())
    return {name: 100.0 * float(weight) / total for name, weight in weights.items()}


def without_shop_pages(weights: dict[str, float], keep_end: bool) -> dict[str, float]:
    """What a row of the ecommerce journey becomes without the shop.

    The shop pages are removed. With `keep_end`, `end` keeps its part of 100
    and the pages left share the rest in proportion to their weights. Without
    it, all the names left share 100 in proportion.
    """
    left = {name: float(weight) for name, weight in weights.items() if name not in SHOP_PAGES}
    if not keep_end:
        return shares(left)
    end = shares(weights)["end"]
    pages = {name: weight for name, weight in left.items() if name != "end"}
    total = sum(pages.values())
    expected = {name: (100.0 - end) * weight / total for name, weight in pages.items()}
    # `end` goes back to its place in the row: the order of the names decides
    # which page a given random draw picks.
    return {name: end if name == "end" else expected[name] for name in left}


def assert_same_weights(actual: dict[str, float], expected: dict[str, float], where: str) -> None:
    assert list(actual) == list(expected), f"{where}: names or their order differ"
    actual = shares(actual)
    for name, value in expected.items():
        assert actual[name] == pytest.approx(value, abs=ROUNDING), f"{where}.{name}"


# ---------------------------------------------------------------------------
# The files
# ---------------------------------------------------------------------------


def test_config_holds_the_four_folders_and_nothing_else() -> None:
    """Four folders, and the image and the API take all four.

    Each folder name is a value of `datasetType` and a folder of the image
    (decision D-96). `default` and `ecommerce` are the pair the rest of this
    file compares, and the two the integration tests run (`conftest.py`),
    which is what `CONFIGURATIONS` holds.
    """
    found = sorted(path.name for path in CONFIG_DIR.iterdir())
    assert found == sorted(CONFIG_FOLDERS)
    assert sorted(CONFIGURATIONS) == [DEFAULT, ECOMMERCE]
    for folder in CONFIG_FOLDERS:
        files = sorted(path.name for path in (CONFIG_DIR / folder).iterdir())
        assert files == sorted(CONFIG_FILES), folder


@pytest.mark.parametrize("folder", OUTSIDE_THE_PAIR)
def test_a_folder_outside_the_compared_pair_still_loads(folder: str) -> None:
    """It has the two files and they parse.

    `eu-consent` and `lead-generation` are offered by the app (D-96) and go
    into the image, so a broken file would reach a visitor. The integration
    tests do not run them, so this is where they are read.
    """
    assert load(property_file(folder))["property"]["hostname"]
    assert load(mixer_file(folder))["journey"]["entry_weights"]


def test_ecommerce_has_a_shop() -> None:
    """The checks on `default` below mean something only if this one holds."""
    config = load(property_file(ECOMMERCE))
    assert config["ecommerce"]["enabled"] is True
    assert SHOP_PAGES <= set(config["pages"])
    journey = load(mixer_file(ECOMMERCE))["journey"]
    assert SHOP_PAGES <= set(journey["transitions"])


# ---------------------------------------------------------------------------
# default: no shop
# ---------------------------------------------------------------------------


def test_default_has_the_shop_switched_off() -> None:
    config = load(property_file(DEFAULT))
    assert config["ecommerce"]["enabled"] is False
    events = config["tracking"]["events"]
    switched_on = sorted(name for name in SHOP_EVENTS if events.get(name) is not False)
    assert not switched_on, f"events of a shop not set to false: {switched_on}"
    custom = {event["name"] for event in config["tracking"]["custom_events"] or []}
    assert not custom & SHOP_CUSTOM_EVENTS, f"custom events of a shop: {custom}"


def test_default_has_no_shop_page() -> None:
    pages = load(property_file(DEFAULT))["pages"]
    journey = load(mixer_file(DEFAULT))["journey"]
    assert not SHOP_PAGES & set(pages), "pages"
    assert not SHOP_PAGES & set(journey["entry_weights"]), "journey.entry_weights"
    assert not SHOP_PAGES & set(journey["transitions"]), "journey.transitions"
    for page, targets in journey["transitions"].items():
        assert not SHOP_PAGES & set(targets), f"journey.transitions.{page}"


# ---------------------------------------------------------------------------
# default: nothing else differs from ecommerce
# ---------------------------------------------------------------------------


def test_default_property_differs_only_by_the_shop() -> None:
    ecommerce = load(property_file(ECOMMERCE))
    default = load(property_file(DEFAULT))

    expected = copy.deepcopy(ecommerce)
    expected["ecommerce"]["enabled"] = False
    expected["pages"] = {
        page: template for page, template in ecommerce["pages"].items()
        if page not in SHOP_PAGES
    }
    expected["tracking"]["events"] = {
        name: False if name in SHOP_EVENTS else value
        for name, value in ecommerce["tracking"]["events"].items()
    }
    expected["tracking"]["custom_events"] = [
        event for event in ecommerce["tracking"]["custom_events"]
        if event["name"] not in SHOP_CUSTOM_EVENTS
    ]
    assert list(default) == list(ecommerce), "sections or their order differ"
    for section in ecommerce:
        assert default[section] == expected[section], section
    assert list(default["pages"]) == list(expected["pages"])


def test_default_mixer_differs_only_by_the_journey() -> None:
    ecommerce = load(mixer_file(ECOMMERCE))
    default = load(mixer_file(DEFAULT))

    assert list(default) == list(ecommerce), "sections or their order differ"
    for section in ecommerce:
        if section != "journey":
            assert default[section] == ecommerce[section], section

    rewritten = {"entry_weights", "transitions"}
    assert list(default["journey"]) == list(ecommerce["journey"])
    for dial in ecommerce["journey"]:
        if dial not in rewritten:
            assert default["journey"][dial] == ecommerce["journey"][dial], f"journey.{dial}"


def test_default_journey_shares_the_shop_pages_in_proportion() -> None:
    """The rule written above `journey` in config/default/mixer.yaml.

    Entries: the pages left keep their weights. Transitions: in each row `end`
    keeps its part, so a visitor is as likely to leave from a page as in the
    ecommerce configuration, and the pages left share the rest in proportion.
    """
    ecommerce = load(mixer_file(ECOMMERCE))["journey"]
    default = load(mixer_file(DEFAULT))["journey"]

    assert_same_weights(
        default["entry_weights"],
        without_shop_pages(ecommerce["entry_weights"], keep_end=False),
        "journey.entry_weights",
    )

    pages = [page for page in ecommerce["transitions"] if page not in SHOP_PAGES]
    assert list(default["transitions"]) == pages
    for page in pages:
        assert_same_weights(
            default["transitions"][page],
            without_shop_pages(ecommerce["transitions"][page], keep_end=True),
            f"journey.transitions.{page}",
        )


# ---------------------------------------------------------------------------
# The rows of a generated day
# ---------------------------------------------------------------------------


def test_default_day_holds_no_event_of_a_shop(
    generated_shard: Callable[[str], Path],
) -> None:
    rows = rows_of(generated_shard(DEFAULT))
    assert rows
    names = {row["event_name"] for row in rows}
    found = sorted(names & (SHOP_EVENTS | SHOP_CUSTOM_EVENTS))
    assert not found, f"events of a shop in the default dataset: {found}"


def test_default_day_leaves_ecommerce_and_items_empty(
    generated_shard: Callable[[str], Path],
) -> None:
    """`items` is an empty array and every field of `ecommerce` is null."""
    for number, row in enumerate(rows_of(generated_shard(DEFAULT)), start=1):
        assert row["items"] == [], f"row {number}: items"
        filled = {key: value for key, value in (row["ecommerce"] or {}).items() if value is not None}
        assert not filled, f"row {number}: ecommerce {filled}"


def test_default_day_visits_no_shop_page(
    generated_shard: Callable[[str], Path],
) -> None:
    """No row names the address of a page the default site does not have."""
    pages = load(property_file(ECOMMERCE))["pages"]
    # The fixed start of each shop address: "/products/", "/cart", "/checkout".
    starts = {pages[page]["path"].split("{")[0] for page in SHOP_PAGES}
    hostname = load(property_file(DEFAULT))["property"]["hostname"]
    for number, row in enumerate(rows_of(generated_shard(DEFAULT)), start=1):
        for param in row["event_params"]:
            if param["key"] != "page_location":
                continue
            address = param["value"]["string_value"]
            path = address.removeprefix(f"https://{hostname}")
            assert not any(path.startswith(start) for start in starts), (
                f"row {number}: {address}"
            )


def test_ecommerce_day_holds_the_events_of_a_shop(
    generated_shard: Callable[[str], Path],
) -> None:
    """The same reading finds them where they exist, so the checks above can fail."""
    rows = rows_of(generated_shard(ECOMMERCE))
    assert (SHOP_EVENTS | SHOP_CUSTOM_EVENTS) <= {row["event_name"] for row in rows}
    assert any(row["items"] for row in rows)
    assert any(row["ecommerce"]["transaction_id"] for row in rows)
