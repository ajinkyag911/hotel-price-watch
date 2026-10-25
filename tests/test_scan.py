from __future__ import annotations

from datetime import date

from hotelwatch.models import Reading, ScanTarget
from hotelwatch.providers.base import ProviderError
from hotelwatch.scan import run_scan


class DateProvider:
    """Price depends on the check-in weekday; one date errors, one is sold out."""

    name = "fake"

    def fetch(self, target) -> Reading:
        ci = target.check_in
        if ci == date(2027, 1, 3):
            raise ProviderError("boom")
        sold_out = ci == date(2027, 1, 4)
        price = None if sold_out else 1000.0 * target.nights * (1.5 if ci.weekday() >= 5 else 1)
        return Reading(
            target_id=target.id,
            observed_at=Reading.now(),
            currency="THB",
            available=not sold_out,
            price=price,
            price_after_tax=price,
            plan_name=None if sold_out else "Plan",
            plan_rate_id="1",
            promo=None,
            price_basis="after_tax",
        )

    @classmethod
    def matches_url(cls, url: str) -> bool:
        return True


def test_scan_target_dates_and_targets() -> None:
    s = ScanTarget.from_dict(
        {
            "id": "s",
            "name": "n",
            "url": "u",
            "provider": "fake",
            "room": "r",
            "nights": 5,
            "from": "2027-01-01",
            "to": "2027-01-07",
        }
    )
    dates = s.check_in_dates()
    assert len(dates) == 7
    t = s.target_for(dates[0])
    assert t.id == "s@2027-01-01"
    assert t.check_out == date(2027, 1, 6)
    assert t.nights == 5


def test_run_scan_collects_points_and_counts_failures() -> None:
    s = ScanTarget(
        id="s", name="n", url="u", provider="fake", room="r", nights=2,
        from_date=date(2027, 1, 1), to_date=date(2027, 1, 7),
    )  # fmt: skip
    result = run_scan(s, DateProvider())
    assert result.failures == 1
    assert len(result.points) == 6
    assert result.currency == "THB"
    assert result.price_basis == "after_tax"
    by_date = {p.check_in: p for p in result.points}
    assert by_date["2027-01-04"].available is False and by_date["2027-01-04"].price is None
    assert by_date["2027-01-01"].price == 2000.0  # Friday
    assert by_date["2027-01-02"].price == 3000.0  # Saturday
    rec = result.to_record()
    assert rec["scan_id"] == "s" and len(rec["points"]) == 6 and "run_at" in rec
