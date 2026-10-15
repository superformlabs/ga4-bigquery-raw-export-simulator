"""A small declarative language for configured parameter values.

Users of this generator need to describe their own event parameters without
writing Python. They also must not be able to describe something that cannot be
represented in a GA4 export. So values are declared, not computed: a fixed set of
generator forms, each of which produces a string, an integer, a float, or a
boolean.

Forms
-----
A bare scalar is a literal::

    site_section: "shop"
    is_logged_in: false

``choice`` picks one option, either uniformly from a list or by relative weight
from a mapping::

    ab_variant:
      choice: [control, variant_a]
    page_category:
      choice: {shop: 60, editorial: 30, support: 10}

``int_range`` and ``float_range`` sample a number. ``float_range`` accepts
``round`` to fix the decimal places, which also decides whether the value lands
in ``int_value`` or ``double_value`` once packed::

    cart_size:
      int_range: [1, 8]
    cart_value:
      float_range: [10.0, 400.0]
      round: 2

``template`` interpolates the event's context::

    landing:
      template: "{page_path}"

Any form may carry ``present``, the probability the parameter appears at all.
Omission is meaningful in GA4, so a parameter that is absent 70% of the time is
different from one that is present with a falsy value::

    coupon:
      choice: [SPRING10, WELCOME]
      present: 0.15
"""

from __future__ import annotations

import random
from typing import Any

# Keys a template may interpolate. Anything else is rejected at validation time,
# so a typo surfaces on load rather than as a literal "{page_titel}" in the data.
TEMPLATE_KEYS = frozenset({
    "event_name", "page_path", "page_title", "page_location", "page_type",
    "hostname", "brand", "channel", "source", "medium", "campaign",
    "user_pseudo_id", "ga_session_id", "ga_session_number", "device_category",
    "country", "currency",
})

_GENERATOR_KEYS = frozenset({"choice", "int_range", "float_range", "template"})
_MODIFIER_KEYS = frozenset({"present", "round"})
SPEC_KEYS = _GENERATOR_KEYS | _MODIFIER_KEYS


class ValueSpecError(ValueError):
    """Raised when a configured value specification is malformed."""


def validate_spec(spec: Any, where: str) -> None:
    """Check one value specification, raising with a located message."""
    if not isinstance(spec, dict):
        if isinstance(spec, (str, int, float, bool)) or spec is None:
            return
        raise ValueSpecError(f"{where}: unsupported literal of type {type(spec).__name__}")

    unknown = set(spec) - SPEC_KEYS
    if unknown:
        raise ValueSpecError(
            f"{where}: unknown keys {sorted(unknown)}; expected any of {sorted(SPEC_KEYS)}"
        )

    generators = set(spec) & _GENERATOR_KEYS
    if len(generators) != 1:
        raise ValueSpecError(
            f"{where}: expected exactly one of {sorted(_GENERATOR_KEYS)}, got {sorted(generators)}"
        )

    if "choice" in spec:
        options = spec["choice"]
        if isinstance(options, dict):
            if not options:
                raise ValueSpecError(f"{where}: choice mapping is empty")
            for option, weight in options.items():
                if not isinstance(weight, (int, float)) or weight < 0:
                    raise ValueSpecError(
                        f"{where}: choice weight for {option!r} must be a non-negative number"
                    )
        elif isinstance(options, list):
            if not options:
                raise ValueSpecError(f"{where}: choice list is empty")
        else:
            raise ValueSpecError(f"{where}: choice must be a list or a mapping of option to weight")

    for key in ("int_range", "float_range"):
        if key in spec:
            bounds = spec[key]
            if not isinstance(bounds, list) or len(bounds) != 2:
                raise ValueSpecError(f"{where}: {key} must be a two element list [low, high]")
            low, high = bounds
            if not all(isinstance(b, (int, float)) for b in bounds):
                raise ValueSpecError(f"{where}: {key} bounds must be numbers")
            if low > high:
                raise ValueSpecError(f"{where}: {key} low bound {low} exceeds high bound {high}")

    if "template" in spec:
        template = spec["template"]
        if not isinstance(template, str):
            raise ValueSpecError(f"{where}: template must be a string")
        for field in template_fields(template):
            if field not in TEMPLATE_KEYS:
                raise ValueSpecError(
                    f"{where}: template references unknown field {{{field}}}; "
                    f"available: {sorted(TEMPLATE_KEYS)}"
                )

    if "round" in spec:
        if "float_range" not in spec:
            raise ValueSpecError(f"{where}: round only applies to float_range")
        if not isinstance(spec["round"], int) or spec["round"] < 0:
            raise ValueSpecError(f"{where}: round must be a non-negative integer")

    if "present" in spec:
        probability = spec["present"]
        if not isinstance(probability, (int, float)) or not 0.0 <= probability <= 1.0:
            raise ValueSpecError(f"{where}: present must be a probability between 0 and 1")


def template_fields(template: str) -> list[str]:
    """Extract ``{field}`` names from a template string."""
    fields, depth, current = [], 0, []
    for char in template:
        if char == "{":
            depth, current = depth + 1, []
        elif char == "}" and depth:
            depth -= 1
            fields.append("".join(current))
        elif depth:
            current.append(char)
    return fields


def resolve(spec: Any, rng: random.Random, context: dict[str, Any]) -> Any:
    """Produce a value from a specification. Returns None when omitted."""
    if not isinstance(spec, dict):
        return spec

    if "present" in spec and rng.random() >= float(spec["present"]):
        return None

    if "choice" in spec:
        options = spec["choice"]
        if isinstance(options, dict):
            keys = list(options)
            return rng.choices(keys, weights=[options[k] for k in keys], k=1)[0]
        return rng.choice(options)

    if "int_range" in spec:
        low, high = spec["int_range"]
        return rng.randint(int(low), int(high))

    if "float_range" in spec:
        low, high = spec["float_range"]
        value = rng.uniform(float(low), float(high))
        if "round" in spec:
            value = round(value, int(spec["round"]))
            # A rounded float that lands on a whole number is packed as an
            # integer by params.pack, exactly as GA4 does.
        return value

    if "template" in spec:
        return spec["template"].format(**{key: context.get(key, "") for key in TEMPLATE_KEYS})

    raise ValueSpecError(f"no generator in specification: {spec!r}")


def resolve_mapping(
    specs: dict[str, Any], rng_for: Any, context: dict[str, Any]
) -> dict[str, Any]:
    """Resolve a mapping of parameter name to specification.

    ``rng_for`` is called with the parameter name and must return a Random, so
    each parameter draws from its own stream. That keeps a parameter's values
    stable when an unrelated parameter is added to the config.
    """
    resolved = {}
    for name, spec in specs.items():
        value = resolve(spec, rng_for(name), context)
        if value is not None:
            resolved[name] = value
    return resolved
