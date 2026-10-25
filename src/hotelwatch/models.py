"""Core data types: what we watch (Target, ScanTarget) and what we observed (Reading)."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

PriceBasis = Literal["before_tax", "after_tax"]


class WatchlistError(ValueError):
    """Raised when watchlist.json is malformed."""


def _parse_date(raw: Any, field: str, ident: str) -> date:
    try:
        return date.fromisoformat(raw)
    except (TypeError, ValueError) as exc:
        raise WatchlistError(f"{ident}: {field} must be YYYY-MM-DD") from exc


def _common_fields(raw: dict[str, Any], kind: str) -> dict[str, Any]:
    """Validate the fields shared by spot targets and scans."""
    required = ("id", "name", "url", "provider", "room")
    missing = [k for k in required if not raw.get(k)]
    if missing:
        raise WatchlistError(f"{kind} {raw.get('id', '?')!r}: missing {', '.join(missing)}")
    ident = f"{kind} {raw['id']!r}"
    adults = int(raw.get("adults", 2))
    if adults < 1:
        raise WatchlistError(f"{ident}: adults must be at least 1")
    return {
        "id": str(raw["id"]),
        "name": str(raw["name"]),
        "url": str(raw["url"]),
        "provider": str(raw["provider"]).lower(),
        "room": str(raw["room"]),
        "adults": adults,
        "children": tuple(int(c) for c in raw.get("children", [])),
        "rate_plan": raw.get("rate_plan") or None,
        "country": str(raw.get("country", "IN")).upper(),
    }


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
        common = _common_fields(raw, "target")
        ident = f"target {common['id']!r}"
        if not raw.get("check_in") or not raw.get("check_out"):
            raise WatchlistError(f"{ident}: missing check_in, check_out")
        check_in = _parse_date(raw["check_in"], "check_in", ident)
        check_out = _parse_date(raw["check_out"], "check_out", ident)
        if check_out <= check_in:
            raise WatchlistError(f"{ident}: check_out must be after check_in")
        alert_below = raw.get("alert_below")
        if alert_below is not None:
            alert_below = float(alert_below)
            if alert_below <= 0:
                raise WatchlistError(f"{ident}: alert_below must be positive")
        return cls(check_in=check_in, check_out=check_out, alert_below=alert_below, **common)

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
            "alert_below": self.alert_below,  # INR
        }


@dataclass(frozen=True)
class ScanTarget:
    """A room scanned across many check-in dates with a fixed stay length."""

    id: str
    name: str
    url: str
    provider: str
    room: str
    nights: int
    from_date: date
    to_date: date
    adults: int = 2
    children: tuple[int, ...] = ()
    rate_plan: str | None = None
    country: str = "IN"

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> ScanTarget:
        common = _common_fields(raw, "scan")
        ident = f"scan {common['id']!r}"
        nights = int(raw.get("nights", 0))
        if nights < 1:
            raise WatchlistError(f"{ident}: nights must be at least 1")
        if not raw.get("from") or not raw.get("to"):
            raise WatchlistError(f"{ident}: missing from, to")
        from_date = _parse_date(raw["from"], "from", ident)
        to_date = _parse_date(raw["to"], "to", ident)
        if to_date < from_date:
            raise WatchlistError(f"{ident}: 'to' must not be before 'from'")
        if (to_date - from_date).days > 366:
            raise WatchlistError(f"{ident}: window longer than a year")
        return cls(nights=nights, from_date=from_date, to_date=to_date, **common)

    def check_in_dates(self) -> list[date]:
        return [
            self.from_date + timedelta(days=i)
            for i in range((self.to_date - self.from_date).days + 1)
        ]

    def target_for(self, check_in: date) -> Target:
        return Target(
            id=f"{self.id}@{check_in.isoformat()}",
            name=self.name,
            url=self.url,
            provider=self.provider,
            room=self.room,
            check_in=check_in,
            check_out=check_in + timedelta(days=self.nights),
            adults=self.adults,
            children=self.children,
            rate_plan=self.rate_plan,
            country=self.country,
        )

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "url": self.url,
            "provider": self.provider,
            "room": self.room,
            "nights": self.nights,
            "from": self.from_date.isoformat(),
            "to": self.to_date.isoformat(),
            "adults": self.adults,
            "children": list(self.children),
            "rate_plan": self.rate_plan,
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
    """What the booking engine said for a target at one moment.

    ``price`` is the headline number the booking page shows for the whole stay;
    ``price_basis`` says whether that figure is before or after tax, since engines differ.
    """

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
    price_basis: PriceBasis = "before_tax"
    fx_rate: float | None = None  # INR per unit of ``currency`` on the observation day

    @staticmethod
    def now() -> datetime:
        return datetime.now(UTC).replace(microsecond=0)

    def to_record(self) -> dict[str, Any]:
        rec = asdict(self)
        rec["observed_at"] = self.observed_at.isoformat()
        rec["plans"] = [asdict(p) for p in self.plans]
        return rec


@dataclass(frozen=True)
class Watchlist:
    targets: tuple[Target, ...]
    scans: tuple[ScanTarget, ...]


def load_watchlist(raw: dict[str, Any]) -> Watchlist:
    targets_raw = raw.get("targets") or []
    scans_raw = raw.get("scans") or []
    if not isinstance(targets_raw, list) or not isinstance(scans_raw, list):
        raise WatchlistError("'targets' and 'scans' must be lists")
    if not targets_raw and not scans_raw:
        raise WatchlistError("watchlist must contain at least one target or scan")
    targets = tuple(Target.from_dict(t) for t in targets_raw)
    scans = tuple(ScanTarget.from_dict(s) for s in scans_raw)
    ids = [t.id for t in targets] + [s.id for s in scans]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise WatchlistError(f"duplicate ids: {', '.join(sorted(dupes))}")
    return Watchlist(targets=targets, scans=scans)


__all__ = [
    "PlanQuote",
    "PriceBasis",
    "Reading",
    "ScanTarget",
    "Target",
    "Watchlist",
    "WatchlistError",
    "load_watchlist",
]
