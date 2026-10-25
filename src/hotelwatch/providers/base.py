from __future__ import annotations

from typing import ClassVar, Protocol

from hotelwatch.models import Reading, Target


class ProviderError(RuntimeError):
    """The booking engine answered, but not in a way we could use."""


class Provider(Protocol):
    name: ClassVar[str]

    def fetch(self, target: Target) -> Reading: ...

    @classmethod
    def matches_url(cls, url: str) -> bool: ...
