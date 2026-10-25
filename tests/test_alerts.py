from __future__ import annotations

from datetime import UTC, datetime

from hotelwatch.alerts import evaluate
from hotelwatch.models import Reading


def _reading(target_id: str, price: float | None) -> Reading:
    return Reading(
        target_id=target_id,
        observed_at=datetime(2026, 10, 25, tzinfo=UTC),
        currency="INR",
        available=price is not None,
        price=price,
        price_after_tax=price,
        plan_name="Plan",
        plan_rate_id="1",
        promo=None,
    )


def _prior(*prices: float) -> list[dict]:
    return [{"price": p} for p in prices]


def test_no_alert_without_prior_and_above_threshold(riva_target) -> None:
    assert evaluate(riva_target, _reading("riva", 40036), []) == []


def test_threshold_fires_on_first_reading_below(riva_target) -> None:
    kinds = [a.kind for a in evaluate(riva_target, _reading("riva", 35000), [])]
    assert kinds == ["threshold"]


def test_threshold_fires_only_on_crossing(riva_target) -> None:
    # Was above, now below: fires (plus new_low and drop as side effects of the move).
    kinds = {a.kind for a in evaluate(riva_target, _reading("riva", 35000), _prior(40036))}
    assert "threshold" in kinds
    # Already below last time: does not re-fire.
    kinds = {a.kind for a in evaluate(riva_target, _reading("riva", 35000), _prior(40036, 35500))}
    assert "threshold" not in kinds


def test_new_low_and_drop(riva_target) -> None:
    alerts = evaluate(riva_target, _reading("riva", 37000), _prior(40036, 39000))
    kinds = {a.kind for a in alerts}
    assert kinds == {"new_low", "drop"}  # 39000 -> 37000 is a 5.1% drop
    assert all(a.previous == 39000 for a in alerts)
    assert "₹37,000" in next(a.message for a in alerts if a.kind == "new_low")


def test_small_drop_is_not_an_alert(riva_target) -> None:
    alerts = evaluate(riva_target, _reading("riva", 39500), _prior(39000, 40000))
    assert alerts == []


def test_unavailable_reading_never_alerts(riva_target) -> None:
    assert evaluate(riva_target, _reading("riva", None), _prior(40036)) == []


def test_unpriced_prior_rows_are_ignored(riva_target) -> None:
    alerts = evaluate(riva_target, _reading("riva", 39000), [{"price": None}, {"price": 40000}])
    # 2.5% drop is under the threshold; 39,000 is still a new low against the one priced row.
    assert [a.kind for a in alerts] == ["new_low"]
    assert alerts[0].previous == 40000


def test_foreign_currency_is_converted_before_comparing(riva_target) -> None:
    from dataclasses import replace

    target = replace(riva_target, alert_below=95000)  # INR
    thb = replace(_reading("riva", 32000), currency="THB", fx_rate=2.8)  # ₹89,600
    alerts = evaluate(target, thb, [{"price": 40500, "currency": "THB", "fx_rate": 2.8}])
    kinds = {a.kind for a in alerts}
    assert kinds == {"threshold", "new_low", "drop"}
    assert alerts[0].price == 89600.0
    assert "₹89,600 (THB 32,000)" in alerts[0].message


def test_missing_rate_skips_evaluation(riva_target) -> None:
    from dataclasses import replace

    thb = replace(_reading("riva", 32000), currency="THB", fx_rate=None)
    assert evaluate(riva_target, thb, []) == []


def test_exchange_rate_drift_alone_does_not_alert(riva_target) -> None:
    from dataclasses import replace

    target = replace(riva_target, alert_below=95000)
    thb = replace(_reading("riva", 40500), currency="THB", fx_rate=2.80)
    prior = [{"price": 40500, "currency": "THB", "fx_rate": 2.8135}]  # same baht, stronger rupee
    assert evaluate(target, thb, prior) == []
