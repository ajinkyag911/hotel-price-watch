"""Provider for STAAH SwiftBook booking engines (swiftbook.io).

How the public page gets its prices, as observed in Oct 2026:

* ``POST https://csbe.staah.net/?RequestType=bedataguest&JDRN=Y`` with a JSON body of
  property id, dates and occupancy returns every room's rate plans with per-night
  before/after-tax rates. The ``X-Api-Key`` header is a public key shipped in the
  page's JavaScript. The page also sends an ``X-Ctx-Ref`` session blob, but the
  endpoint answers identically without it.
* ``GET https://www.swiftbook.io/PropertyJson/EN/{numeric_id}.json`` holds room and
  rate-plan names. The numeric id comes back in the first response.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from typing import Any, ClassVar

from hotelwatch.http import FetchJson, fetch_json
from hotelwatch.models import PlanQuote, Reading, Target
from hotelwatch.providers.base import ProviderError

RATES_URL = "https://csbe.staah.net/?RequestType=bedataguest&JDRN=Y"
PROPERTY_URL = "https://www.swiftbook.io/PropertyJson/{lang}/{property_id}.json"
# Public key embedded in swiftbook.io's front-end bundle; override via env if it rotates.
DEFAULT_API_KEY = "cPPq1uh0xD6BpfDFpGWEx9fxnDOUA3Y25RdigC0X"

_PROPERTY_ID_RE = re.compile(r"propertyId=([^&#\s]+)", re.IGNORECASE)
_WS_RE = re.compile(r"\s+")


def _norm(s: str) -> str:
    return _WS_RE.sub(" ", s).strip().casefold()


class SwiftbookProvider:
    name: ClassVar[str] = "swiftbook"

    def __init__(self, fetch: FetchJson = fetch_json, api_key: str | None = None) -> None:
        self._fetch = fetch
        self._api_key = api_key or os.environ.get("SWIFTBOOK_API_KEY") or DEFAULT_API_KEY
        self._property_cache: dict[str, dict[str, Any]] = {}

    @classmethod
    def matches_url(cls, url: str) -> bool:
        return "swiftbook.io" in url and bool(_PROPERTY_ID_RE.search(url))

    @staticmethod
    def property_token(url: str) -> str:
        m = _PROPERTY_ID_RE.search(url)
        if not m:
            raise ProviderError(f"no propertyId in URL: {url}")
        return m.group(1)

    # -- network -------------------------------------------------------------------------

    def _rates(self, target: Target) -> dict[str, Any]:
        body = {
            "Product": "no",
            "PropertyId": self.property_token(target.url),
            "CheckInDate": target.check_in.isoformat(),
            "CheckOutDate": target.check_out.isoformat(),
            "JDRN": "Y",
            "Country": target.country,
            "DeviceType": "desktop",
            "Lang": "EN",
            "Rooms": [{"Adult": target.adults, "Children": list(target.children)}],
        }
        headers = {
            "X-Api-Key": self._api_key,
            "Origin": "https://www.swiftbook.io",
            "Referer": "https://www.swiftbook.io/",
        }
        return self._fetch(RATES_URL, method="POST", headers=headers, body=body)

    def _property(self, numeric_id: str) -> dict[str, Any]:
        if numeric_id not in self._property_cache:
            data = self._fetch(PROPERTY_URL.format(lang="EN", property_id=numeric_id))
            try:
                self._property_cache[numeric_id] = data["PropertyList"][0]
            except (KeyError, IndexError, TypeError) as exc:
                raise ProviderError(f"unexpected property JSON for {numeric_id}") from exc
        return self._property_cache[numeric_id]

    # -- parsing -------------------------------------------------------------------------

    @staticmethod
    def _match_room(rooms: Iterable[dict[str, Any]], wanted: str) -> dict[str, Any]:
        rooms = list(rooms)
        target = _norm(wanted)
        exact = [r for r in rooms if _norm(r.get("RoomName", "")) == target]
        if len(exact) == 1:
            return exact[0]
        partial = [r for r in rooms if target in _norm(r.get("RoomName", ""))]
        if len(partial) == 1:
            return partial[0]
        names = ", ".join(sorted(r.get("RoomName", "?") for r in rooms))
        kind = "ambiguous" if (exact or partial) else "no"
        raise ProviderError(f"{kind} match for room {wanted!r}; property rooms: {names}")

    @staticmethod
    def _quote(plan: dict[str, Any], rate_names: dict[str, str]) -> PlanQuote | None:
        rate_id = str(plan.get("RateId", ""))
        rates = plan.get("Rates") or []
        if not rates:
            return None
        dates: dict[str, Any] = rates[0].get("Dates") or {}
        if not dates:
            return None
        try:
            nightly = {d: float(v["RateBeforeTax"]) for d, v in dates.items()}
            after_tax = sum(float(v["RateAfterTax"]) for v in dates.values())
        except (KeyError, TypeError, ValueError):
            return None
        if any(v <= 0 for v in nightly.values()):
            return None
        policy = plan.get("CancellationPolicy") or {}
        savings = plan.get("Savings") or {}
        promo = (savings.get("Title") or "").strip() or None
        return PlanQuote(
            rate_id=rate_id,
            name=rate_names.get(rate_id, rate_id),
            before_tax=round(sum(nightly.values()), 2),
            after_tax=round(after_tax, 2),
            refundable=str(policy.get("Type", "")).upper() != "NR",
            promo=promo,
            nightly_before_tax=nightly,
        )

    def fetch(self, target: Target) -> Reading:
        payload = self._rates(target)
        try:
            product = payload["Product"][0]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError(f"unexpected rates payload: {str(payload)[:200]}") from exc

        numeric_id = str(product.get("PropertyId", ""))
        currency = str(product.get("Currency", "")) or "INR"
        prop = self._property(numeric_id)
        room_meta = self._match_room(prop.get("RoomData", []), target.room)
        rate_names = {str(r["RateId"]): str(r["RateName"]) for r in prop.get("RateData", [])}

        room = next(
            (
                r
                for r in product.get("Rooms", [])
                if str(r.get("RoomId")) == str(room_meta["RoomId"])
            ),
            None,
        )
        observed = Reading.now()
        if room is None or str(room.get("Roommatch", "")).lower() != "fullmatch":
            return Reading(
                target_id=target.id,
                observed_at=observed,
                currency=currency,
                available=False,
                price=None,
                price_after_tax=None,
                plan_name=None,
                plan_rate_id=None,
                promo=None,
                note="room not available for these dates",
            )

        quotes = [q for q in (self._quote(p, rate_names) for p in room.get("RatePlans", [])) if q]
        if target.rate_plan:
            wanted = _norm(target.rate_plan)
            quotes = [q for q in quotes if wanted in _norm(q.name)]
        if not quotes:
            return Reading(
                target_id=target.id,
                observed_at=observed,
                currency=currency,
                available=False,
                price=None,
                price_after_tax=None,
                plan_name=None,
                plan_rate_id=None,
                promo=None,
                note="no matching rate plan with rates for every night",
            )

        quotes.sort(key=lambda q: (q.before_tax, not q.refundable, q.name))
        best = quotes[0]
        return Reading(
            target_id=target.id,
            observed_at=observed,
            currency=currency,
            available=True,
            price=best.before_tax,
            price_after_tax=best.after_tax,
            plan_name=best.name,
            plan_rate_id=best.rate_id,
            promo=best.promo,
            plans=tuple(quotes),
        )
