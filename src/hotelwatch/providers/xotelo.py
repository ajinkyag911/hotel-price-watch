"""Provider for Xotelo (xotelo.com), a free public API over TripAdvisor's rate comparison.

A fallback for hotels whose own booking engine can't be read, for example when the engine sits
behind a bot check. How it behaves, as observed in Nov 2026:

* ``GET https://data.xotelo.com/api/rates?hotel_key=g…-d…&chk_in=…&chk_out=…&currency=THB&adults=2``
  returns one rate per online travel agency (Booking.com, Agoda, Trip.com, …). No key needed.
* Each ``rate`` is the **cheapest room's nightly price** on that agency, not a specific room and
  not the stay total: a 1-night and a 5-night search return the same figure. ``tax`` is usually
  null, so whether taxes are included depends on the agency.
* The hotel key is the ``g<geo>-d<hotel>`` pair in the hotel's TripAdvisor URL, which is what the
  watchlist ``url`` holds.

``rate_plan`` in the watchlist, when set, names the agency to follow (e.g. "Booking.com");
otherwise the cheapest agency wins.
"""

from __future__ import annotations

import re
import time
import urllib.parse
from typing import Any, ClassVar

from hotelwatch.http import FetchJson, fetch_json
from hotelwatch.models import PlanQuote, Reading, Target
from hotelwatch.providers.base import ProviderError, match_one

RATES_URL = "https://data.xotelo.com/api/rates"
_KEY_RE = re.compile(r"(g\d+-d\d+)")
CURRENCY_BY_COUNTRY = {"IN": "INR", "TH": "THB", "MY": "MYR"}


class XoteloProvider:
    name: ClassVar[str] = "xotelo"

    def __init__(self, fetch: FetchJson = fetch_json, delay: float = 1.0, sleep=time.sleep) -> None:
        self._fetch = fetch
        self._delay = delay
        self._sleep = sleep
        self._last = 0.0

    @classmethod
    def matches_url(cls, url: str) -> bool:
        return "tripadvisor." in url and bool(_KEY_RE.search(url))

    @staticmethod
    def hotel_key(url: str) -> str:
        m = _KEY_RE.search(url)
        if not m:
            raise ProviderError(f"no TripAdvisor hotel key (g…-d…) in URL: {url}")
        return m.group(1)

    def _throttle(self) -> None:
        wait = self._delay - (time.monotonic() - self._last)
        if wait > 0:
            self._sleep(wait)
        self._last = time.monotonic()

    def fetch(self, target: Target) -> Reading:
        currency = CURRENCY_BY_COUNTRY.get(target.country, "USD")
        query = urllib.parse.urlencode(
            {
                "hotel_key": self.hotel_key(target.url),
                "chk_in": target.check_in.isoformat(),
                "chk_out": target.check_out.isoformat(),
                "currency": currency,
                "adults": target.adults,
            }
        )
        self._throttle()
        data: Any = self._fetch(f"{RATES_URL}?{query}")
        return parse_rates(data, target, currency)


def parse_rates(data: Any, target: Target, currency: str) -> Reading:
    if not isinstance(data, dict):
        raise ProviderError("unexpected Xotelo response")
    if data.get("error"):
        err = data["error"]
        msg = err.get("message") if isinstance(err, dict) else err
        raise ProviderError(f"Xotelo error: {msg}")
    result = data.get("result") or {}
    nights = target.nights
    plans = []
    for r in result.get("rates") or []:
        try:
            nightly = float(r["rate"])
        except (KeyError, TypeError, ValueError):
            continue
        if nightly <= 0:
            continue
        total = round(nightly * nights, 2)
        plans.append(
            PlanQuote(
                rate_id=str(r.get("code") or r.get("name")),
                name=str(r.get("name") or r.get("code")),
                before_tax=total,
                after_tax=total,
                refundable=False,
                promo=None,
                nightly_before_tax={},
            )
        )
    note = "cheapest room on each travel site; taxes may be extra"
    plans_considered = plans
    if target.rate_plan and plans:
        plans_considered = [match_one(plans, target.rate_plan, lambda p: p.name, "site")]
    if not plans_considered:
        return Reading(
            target_id=target.id,
            observed_at=Reading.now(),
            currency=currency,
            available=False,
            price=None,
            price_after_tax=None,
            plan_name=None,
            plan_rate_id=None,
            promo=None,
            note="no travel site listed a rate for these dates",
        )
    best = min(plans_considered, key=lambda p: p.before_tax)
    return Reading(
        target_id=target.id,
        observed_at=Reading.now(),
        currency=currency,
        available=True,
        price=best.before_tax,
        price_after_tax=None,
        plan_name=best.name,
        plan_rate_id=best.rate_id,
        promo=None,
        plans=tuple(sorted(plans, key=lambda p: p.before_tax)),
        note=note,
        price_basis="before_tax",
    )
