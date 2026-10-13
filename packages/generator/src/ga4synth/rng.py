"""Deterministic random number derivation.

Every random choice in this project is derived from a stable key rather than
drawn from a global stream. That is what makes a daily shard reproducible and
re-runnable: regenerating ``events_20260101`` a year later must produce byte
identical output, and it must do so without reading any other shard.

The rule: never call ``random`` directly. Always derive a generator from the
identity of the thing you are making a decision about.
"""

from __future__ import annotations

import hashlib
import random


def derive(*parts: object) -> random.Random:
    """Return a ``Random`` seeded from the given key parts.

    The key is order sensitive and separator delimited, so ``derive("a", "bc")``
    and ``derive("ab", "c")`` are distinct.
    """
    key = "\x1f".join(str(part) for part in parts).encode("utf-8")
    digest = hashlib.blake2b(key, digest_size=16).digest()
    return random.Random(int.from_bytes(digest, "big"))


def uniform(*parts: object) -> float:
    """A stable float in ``[0, 1)`` for the given key parts.

    Equivalent in spirit to ``derive(*parts).random()``, but hashes straight to
    a float instead of seeding a ``Random``. That is about ten times cheaper,
    which matters for decisions made once per identity per day across the whole
    retention window, where ``derive`` would dominate the cost of a shard.
    """
    key = "\x1f".join(str(part) for part in parts).encode("utf-8")
    digest = hashlib.blake2b(key, digest_size=8).digest()
    return int.from_bytes(digest, "big") / 2**64


def stable_int(*parts: object, digits: int = 10) -> int:
    """Derive a stable integer with exactly ``digits`` digits.

    Used for identifiers that GA4 renders as fixed width numeric strings, such
    as the first component of ``user_pseudo_id``.
    """
    lower = 10 ** (digits - 1)
    upper = 10**digits - 1
    return derive("stable_int", digits, *parts).randint(lower, upper)


def weighted_choice(rng: random.Random, weights: dict[str, float]) -> str:
    """Pick a key from a mapping of key to relative weight."""
    if not weights:
        raise ValueError("weighted_choice requires at least one option")
    keys = list(weights)
    return rng.choices(keys, weights=[weights[k] for k in keys], k=1)[0]
