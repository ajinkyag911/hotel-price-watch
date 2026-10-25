from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from hotelwatch.models import PlanQuote, Reading
from hotelwatch.storage import append_readings, build_site_data, load_history, write_json


def _reading(price: float | None, when: datetime, plan: str = "A") -> Reading:
    return Reading(
        target_id="riva",
        observed_at=when,
        currency="INR",
        available=price is not None,
        price=price,
        price_after_tax=(price or 0) * 1.18 if price else None,
        plan_name=plan if price else None,
        plan_rate_id="1" if price else None,
        promo="Early Bird" if price else None,
        plans=(PlanQuote("1", plan, price or 0, (price or 0) * 1.18, True, "Early Bird", {}),)
        if price
        else (),
    )


def test_append_and_load_roundtrip_sorted(tmp_path: Path) -> None:
    hist = tmp_path / "h.jsonl"
    later = datetime(2026, 10, 26, tzinfo=UTC)
    earlier = datetime(2026, 10, 25, tzinfo=UTC)
    append_readings(hist, [_reading(40036, later)])
    append_readings(hist, [_reading(41000, earlier)])
    rows = load_history(hist)
    assert [r["price"] for r in rows] == [41000, 40036]
    assert rows[0]["observed_at"] == "2026-10-25T00:00:00+00:00"
    assert rows[1]["plans"][0]["name"] == "A"


def test_load_missing_history_is_empty(tmp_path: Path) -> None:
    assert load_history(tmp_path / "nope.jsonl") == []


def test_site_data_stats(riva_target) -> None:
    t0 = datetime(2026, 10, 25, tzinfo=UTC)
    rows = [
        r.to_record()
        for r in (
            _reading(42000, t0),
            _reading(None, t0.replace(hour=6)),
            _reading(40036, t0.replace(hour=12)),
            _reading(35310, t0.replace(hour=18), plan="B"),
        )
    ]
    data = build_site_data([riva_target], rows)
    assert data["currency"] == "INR"
    target = data["targets"][0]
    s = target["stats"]
    assert s["current"] == 35310
    assert s["current_plan"] == "B"
    assert s["lowest"] == 35310
    assert s["highest"] == 42000
    assert s["first"] == 42000
    assert s["change_pct_vs_prev"] == -11.8
    assert s["below_alert"] is True
    assert s["readings"] == 4
    assert target["readings"][1]["available"] is False
    assert target["nights"] == 4


def test_site_data_without_readings(riva_target) -> None:
    s = build_site_data([riva_target], [])["targets"][0]["stats"]
    assert s == {"current": None, "available": False}


def test_write_json_is_compact(tmp_path: Path) -> None:
    out = tmp_path / "x" / "y.json"
    write_json(out, {"a": [1, 2]})
    assert out.read_text() == '{"a":[1,2]}\n'
