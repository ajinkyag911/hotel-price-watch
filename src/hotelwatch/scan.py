"""Scan a room across a window of check-in dates to find the cheapest dates."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

from hotelwatch.models import Reading, ScanTarget
from hotelwatch.providers.base import Provider, ProviderError

log = logging.getLogger(__name__)


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

    def to_record(self) -> dict[str, Any]:
        return {
            "scan_id": self.scan_id,
            "run_at": self.run_at.isoformat(),
            "nights": self.nights,
            "currency": self.currency,
            "price_basis": self.price_basis,
            "failures": self.failures,
            "points": [asdict(p) for p in self.points],
        }


def run_scan(scan: ScanTarget, provider: Provider) -> ScanResult:
    points: list[ScanPoint] = []
    failures = 0
    currency = ""
    basis = "before_tax"
    for check_in in scan.check_in_dates():
        target = scan.target_for(check_in)
        try:
            reading: Reading = provider.fetch(target)
        except (ProviderError, RuntimeError) as exc:
            failures += 1
            log.warning("%s %s: %s", scan.id, check_in, exc)
            continue
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
    )
