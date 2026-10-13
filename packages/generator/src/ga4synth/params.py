"""Construction of ``event_params`` and ``user_properties`` entries.

GA4 stores parameter values in a four slot struct (``string_value``,
``int_value``, ``float_value``, ``double_value``) and populates exactly one of
them. Which slot it picks is not arbitrary, and getting it wrong is the fastest
way to make synthetic data detectably fake, because every real world query
against the export has to know these rules.

The rules below were verified against a live GA4 web export
(``analytics_358576981.events_20260321``, 11,360 events):

* Strings go in ``string_value``.
* Whole numbers go in ``int_value``. Fractional numbers go in ``double_value``.
  The same key therefore lands in different slots across rows: in the reference
  export ``value`` appeared as ``int_value`` on 54% of ``add_to_cart`` rows and
  as ``double_value`` on 45%, purely according to whether the amount was whole.
* ``float_value`` is never populated by GA4. It exists in the schema and stays
  NULL. We reproduce that.
* Booleans are strings, and are only emitted when true. ``ignore_referrer`` was
  only ever ``"true"``; there is no ``"false"`` row.
* ``session_engaged`` is the one key that changes slot by event rather than by
  value: ``int_value`` on ``session_start``, ``string_value`` everywhere else.
  See ``pack_session_engaged``.
"""

from __future__ import annotations

from typing import Any

# Keys that GA4 emits only when the condition holds, rather than emitting a
# falsy value. Absence is meaningful, so callers pass None and we drop the key.
OMIT_WHEN_FALSY = frozenset({"ignore_referrer", "entrances", "engaged_session_event"})

_EMPTY_VALUE = {
    "string_value": None,
    "int_value": None,
    "float_value": None,
    "double_value": None,
}


def _value_struct(**slot: Any) -> dict[str, Any]:
    """Build a value struct with exactly one slot populated."""
    return {**_EMPTY_VALUE, **slot}


def pack(key: str, value: Any) -> dict[str, Any] | None:
    """Pack one parameter into an ``event_params`` entry.

    Returns ``None`` when the parameter should be omitted entirely, which the
    caller must filter out. This mirrors GA4: a missing key and a key with a
    NULL value mean different things downstream.
    """
    if value is None:
        return None

    if isinstance(value, bool):
        # GA4 stores booleans as strings. It does not drop false ones: the
        # reference export shows ignore_referrer only ever as "true" because
        # gtag omits it when false, not because the export discards it. That
        # caller-side behaviour is captured by OMIT_WHEN_FALSY, so only those
        # keys disappear; a configured `logged_in: false` becomes "false".
        if not value and key in OMIT_WHEN_FALSY:
            return None
        return {"key": key, "value": _value_struct(string_value="true" if value else "false")}

    if key in OMIT_WHEN_FALSY and not value:
        return None

    if isinstance(value, int):
        return {"key": key, "value": _value_struct(int_value=value)}

    if isinstance(value, float):
        # Integral floats go to int_value, matching GA4's own coercion.
        if value.is_integer():
            return {"key": key, "value": _value_struct(int_value=int(value))}
        return {"key": key, "value": _value_struct(double_value=value)}

    return {"key": key, "value": _value_struct(string_value=str(value))}


def pack_session_engaged(engaged: bool, event_name: str) -> dict[str, Any]:
    """Pack ``session_engaged``, which changes slot depending on the event.

    On ``session_start`` GA4 writes it as an integer; on every other event it
    writes the same information as a string. This is a real inconsistency in the
    export, not a modelling choice, so it is reproduced rather than smoothed
    over.
    """
    if event_name == "session_start":
        return {
            "key": "session_engaged",
            "value": _value_struct(int_value=1 if engaged else 0),
        }
    return {
        "key": "session_engaged",
        "value": _value_struct(string_value="1" if engaged else "0"),
    }


def build_params(pairs: dict[str, Any]) -> list[dict[str, Any]]:
    """Pack a mapping of parameters, dropping those that should be omitted."""
    packed = (pack(key, value) for key, value in pairs.items())
    return [entry for entry in packed if entry is not None]
