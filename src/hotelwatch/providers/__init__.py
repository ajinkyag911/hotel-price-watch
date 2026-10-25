"""Provider registry: one provider per booking engine, each turning a Target into a Reading."""

from __future__ import annotations

from hotelwatch.providers.base import Provider, ProviderError
from hotelwatch.providers.swiftbook import SwiftbookProvider

_PROVIDERS: dict[str, type[Provider]] = {
    SwiftbookProvider.name: SwiftbookProvider,
}


def get_provider(name: str, **kwargs: object) -> Provider:
    try:
        cls = _PROVIDERS[name.lower()]
    except KeyError as exc:
        known = ", ".join(sorted(_PROVIDERS))
        raise ProviderError(f"unknown provider {name!r}; known: {known}") from exc
    return cls(**kwargs)  # type: ignore[arg-type]


def detect_provider(url: str) -> str | None:
    """Best-effort guess from a booking URL, used by `hotelwatch add`."""
    for name, cls in _PROVIDERS.items():
        if cls.matches_url(url):
            return name
    return None


__all__ = ["Provider", "ProviderError", "SwiftbookProvider", "detect_provider", "get_provider"]
