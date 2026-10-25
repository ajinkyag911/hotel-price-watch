"""Core data types: what we watch (Target) and what we observed (Reading)."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from typing import Any


class WatchlistError(ValueError):
    """Raised when watchlist.json is malformed."""


@dataclass(frozen=True)
class Target:
    """One room, at one property, for one stay. The unit we track."""

    id: str
    name: str
    url: str
    provider: str
    room: str
    check_in: date
    check_out: date
    adults: int = 2
    children: tuple[int, ...] = ()
    rate_plan: str | None = None
    alert_below: float | None = None
    country: str = "IN"

    @property
    def nights(self) -> int:
        return (self.check_out - self.check_in).days

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Target:
        required = ("id", "name", "url", "provider", "room", "check_in", "check_out")
        missing = [k for k in required if not raw.get(k)]
        if missing:
            raise WatchlistError(f"target {raw.get('id', '?')!r}: missing {', '.join(missing)}")

        try:
            check_in = date.fromisoformat(raw["check_in"])
            check_out = date.fromisoformat(raw["check_out"])
        except (TypeError, ValueError) as exc:
            raise WatchlistError(f"target {raw['id']!r}: dates must be YYYY-MM-DD") from exc
        if check_out <= check_in:
            raise WatchlistError(f"target {raw['id']!r}: check_out must be after check_in")

        adults = int(raw.get("adults", 2))
        if adults < 1:
            raise WatchlistError(f"target {raw['id']!r}: adults must be at least 1")

        children = tuple(int(c) for c in raw.get("children", []))
        alert_below = raw.get("alert_below")
        if alert_below is not None:
            alert_below = float(alert_below)
            if alert_below <= 0:
                raise WatchlistError(f"target {raw['id']!r}: alert_below must be positive")

        return cls(
            id=str(raw["id"]),
            name=str(raw["name"]),
            url=str(raw["url"]),
            provider=str(raw["provider"]).lower(),
            room=str(raw["room"]),
            check_in=check_in,
            check_out=check_out,
            adults=adults,
            children=children,
            rate_plan=raw.get("rate_plan") or None,
            alert_below=alert_below,
            country=str(raw.get("country", "IN")).upper(),
        )

    def to_public_dict(self) -> dict[str, Any]:
        """Fields safe to publish on the chart page."""
        return {
            "id": self.id,
            "name": self.name,
            "url": self.url,
            "provider": self.provider,
            "room": self.room,
            "check_in": self.check_in.isoformat(),
            "check_out": self.check_out.isoformat(),
            "nights": self.nights,
            "adults": self.adults,
            "children": list(self.children),
            "rate_plan": self.rate_plan,
            "alert_below": self.alert_below,
        }


@dataclass(frozen=True)
class PlanQuote:
    """One rate plan's quote for the whole stay."""

    rate_id: str
    name: str
    before_tax: float
    after_tax: float
    refundable: bool
    promo: str | None
    nightly_before_tax: dict[str, float]


@dataclass(frozen=True)
class Reading:
    """What the booking engine said for a target at one moment."""

    target_id: str
    observed_at: datetime
    currency: str
    available: bool
    price: float | None
    price_after_tax: float | None
    plan_name: str | None
    plan_rate_id: str | None
    promo: str | None
    plans: tuple[PlanQuote, ...] = ()
    note: str | None = None

    @staticmethod
    def now() -> datetime:
        return datetime.now(UTC).replace(microsecond=0)

    def to_record(self) -> dict[str, Any]:
        rec = asdict(self)
        rec["observed_at"] = self.observed_at.isoformat()
        rec["plans"] = [asdict(p) for p in self.plans]
        return rec


def load_watchlist(raw: dict[str, Any]) -> list[Target]:
    targets_raw = raw.get("targets")
    if not isinstance(targets_raw, list) or not targets_raw:
        raise WatchlistError("watchlist must contain a non-empty 'targets' list")
    targets = [Target.from_dict(t) for t in targets_raw]
    ids = [t.id for t in targets]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise WatchlistError(f"duplicate target ids: {', '.join(sorted(dupes))}")
    return targets


__all__ = ["PlanQuote", "Reading", "Target", "WatchlistError", "load_watchlist"]
