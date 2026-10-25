"""Exchange rates to INR, fetched once per run and stored with each reading.

Sources, both free and keyless:
* open.er-api.com — refreshed once a day, used for "today's" rate.
* api.frankfurter.dev — ECB reference rates, supports historical dates, used as fallback and
  for back-filling older records.

A reading stores ``fx_rate`` (INR per unit of its currency) so converted history never shifts
when rates move later.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from hotelwatch.http import FetchJson, HttpError, fetch_json

log = logging.getLogger(__name__)

HOME = "INR"
ER_API_URL = "https://open.er-api.com/v6/latest/{base}"
FRANKFURTER_URL = "https://api.frankfurter.dev/v1/{day}?base={base}&symbols={home}"


class FxError(RuntimeError):
    pass


class Converter:
    """Looks up INR rates with per-run caching. Failures are logged, not fatal."""

    def __init__(self, fetch: FetchJson = fetch_json, home: str = HOME) -> None:
        self._fetch = fetch
        self.home = home
        self._cache: dict[tuple[str, str], float | None] = {}

    def rate(self, currency: str, day: date | None = None) -> float | None:
        """INR per one unit of ``currency`` on ``day`` (today when None). None if unavailable."""
        cur = (currency or "").upper()
        if not cur:
            return None
        if cur == self.home:
            return 1.0
        key = (cur, day.isoformat() if day else "latest")
        if key not in self._cache:
            self._cache[key] = self._lookup(cur, day)
        return self._cache[key]

    def _lookup(self, cur: str, day: date | None) -> float | None:
        errors: list[str] = []
        if day is None:
            try:
                data: Any = self._fetch(ER_API_URL.format(base=cur))
                rate = float(data["rates"][self.home])
                if rate > 0:
                    return rate
            except (HttpError, KeyError, TypeError, ValueError) as exc:
                errors.append(f"er-api: {exc}")
        try:
            data = self._fetch(
                FRANKFURTER_URL.format(
                    day=day.isoformat() if day else "latest", base=cur, home=self.home
                )
            )
            rate = float(data["rates"][self.home])
            if rate > 0:
                return rate
        except (HttpError, KeyError, TypeError, ValueError) as exc:
            errors.append(f"frankfurter: {exc}")
        log.warning("no %s→%s rate (%s)", cur, self.home, "; ".join(errors) or "empty response")
        return None


def to_inr(amount: float | None, fx_rate: float | None) -> float | None:
    if amount is None or fx_rate is None:
        return None
    return round(amount * fx_rate, 2)
