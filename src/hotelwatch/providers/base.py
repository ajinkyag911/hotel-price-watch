from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from typing import ClassVar, Protocol, TypeVar

from hotelwatch.models import Reading, Target

T = TypeVar("T")
_WS_RE = re.compile(r"\s+")


class ProviderError(RuntimeError):
    """The booking engine answered, but not in a way we could use."""


class Provider(Protocol):
    name: ClassVar[str]

    def fetch(self, target: Target) -> Reading: ...

    @classmethod
    def matches_url(cls, url: str) -> bool: ...


def norm(s: str) -> str:
    """Whitespace- and case-insensitive key for matching names users typed by hand."""
    return _WS_RE.sub(" ", s).strip().casefold()


def match_one(items: Iterable[T], wanted: str, key: Callable[[T], str], what: str) -> T:
    """Pick the single item whose name equals, or failing that contains, ``wanted``."""
    items = list(items)
    target = norm(wanted)
    exact = [i for i in items if norm(key(i)) == target]
    if len(exact) == 1:
        return exact[0]
    partial = [i for i in items if target in norm(key(i))]
    if len(partial) == 1:
        return partial[0]
    names = ", ".join(sorted(key(i).strip() for i in items)) or "none"
    kind = "ambiguous" if (exact or partial) else "no"
    raise ProviderError(f"{kind} match for {what} {wanted!r}; available: {names}")
