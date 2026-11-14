"""Scan a room across a window of check-in dates to find the cheapest dates."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

from hotelwatch.fx import Converter
from hotelwatch.http import BlockedError
from hotelwatch.models import Reading, ScanTarget
from hotelwatch.providers.base import Provider, ProviderError

log = logging.getLogger(__name__)

# After this many dates in a row are refused by the site's bot check, skip the rest of the window
# for this run: the block is site-wide, and hammering it only lengthens the job (and risks the
# job timeout taking every other scan's results down with it).
MAX_CONSECUTIVE_BLOCKS = 3


@dataclass(frozen=True)
class ScanPoint:
    check_in: str
    price: float | None
    plan: str | None
    promo: str | None
    available: bool


@dataclass(frozen=True)
class ScanResult:
    scan_id: str
    run_at: datetime
    nights: int
    currency: str
    price_basis: str
    points: tuple[ScanPoint, ...]
    failures: int
    fx_rate: float | None = None
    blocked: int = 0  # dates refused or skipped because of a bot check; not stored

    def to_record(self) -> dict[str, Any]:
        return {
            "scan_id": self.scan_id,
            "run_at": self.run_at.isoformat(),
            "nights": self.nights,
            "currency": self.currency,
            "price_basis": self.price_basis,
            "fx_rate": self.fx_rate,
            "failures": self.failures,
            "points": [asdict(p) for p in self.points],
        }


def run_scan(scan: ScanTarget, provider: Provider, fx: Converter | None = None) -> ScanResult:
    points: list[ScanPoint] = []
    failures = 0
    currency = ""
    basis = "before_tax"
    dates = scan.check_in_dates()
    streak = 0
    blocked = 0
    for i, check_in in enumerate(dates):
        target = scan.target_for(check_in)
        try:
            reading: Reading = provider.fetch(target)
        except BlockedError as exc:
            failures += 1
            blocked += 1
            streak += 1
            log.warning("%s %s: %s", scan.id, check_in, exc)
            if streak >= MAX_CONSECUTIVE_BLOCKS:
                skipped = len(dates) - i - 1
                failures += skipped
                blocked += skipped
                log.warning(
                    "%s: blocked %d times in a row; skipping the other %d date(s) this run",
                    scan.id, streak, skipped,
                )  # fmt: skip
                break
            continue
        except (ProviderError, RuntimeError) as exc:
            failures += 1
            log.warning("%s %s: %s", scan.id, check_in, exc)
            streak = 0
            continue
        streak = 0
        currency = currency or reading.currency
        basis = reading.price_basis
        points.append(
            ScanPoint(
                check_in=check_in.isoformat(),
                price=reading.price,
                plan=reading.plan_name,
                promo=reading.promo,
                available=reading.available,
            )
        )
    return ScanResult(
        scan_id=scan.id,
        run_at=Reading.now(),
        nights=scan.nights,
        currency=currency,
        price_basis=basis,
        points=tuple(points),
        failures=failures,
        fx_rate=fx.rate(currency) if fx and currency else None,
        blocked=blocked,
    )
