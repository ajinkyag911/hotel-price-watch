from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

from hotelwatch.models import PlanQuote, Reading, ScanTarget, Watchlist
from hotelwatch.scan import ScanPoint, ScanResult
from hotelwatch.storage import (
    append_readings,
    append_scan_results,
    build_site_data,
    load_history,
    load_scans,
    write_json,
)


def _reading(price: float | None, when: datetime, plan: str = "A", basis="before_tax") -> Reading:
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
        price_basis=basis,
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
    assert rows[1]["price_basis"] == "before_tax"


def test_load_missing_files_are_empty(tmp_path: Path) -> None:
    assert load_history(tmp_path / "nope.jsonl") == []
    assert load_scans(tmp_path / "nope.jsonl") == []


def test_site_data_target_stats(riva_target) -> None:
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
    data = build_site_data(Watchlist((riva_target,), ()), rows)
    target = data["targets"][0]
    assert target["currency"] == "INR"
    assert target["price_basis"] == "before_tax"
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
    assert target["readings"][0]["native"] == 42000 and target["readings"][0]["fx_rate"] == 1.0
    assert target["nights"] == 4
    assert data["scans"] == []


def test_site_data_converts_foreign_currency(riva_target) -> None:
    t0 = datetime(2026, 10, 25, tzinfo=UTC)
    row = _reading(40500, t0).to_record()
    row.update(currency="THB", fx_rate=2.8, price_basis="after_tax")
    no_rate = _reading(41000, t0.replace(hour=6)).to_record()
    no_rate.update(currency="THB", fx_rate=None)
    target = build_site_data(Watchlist((riva_target,), ()), [row, no_rate])["targets"][0]
    assert target["currency"] == "THB"
    first, second = target["readings"]
    assert first["price"] == 113400.0 and first["native"] == 40500 and first["fx_rate"] == 2.8
    assert first["plans"][0]["before_tax"] == 113400.0
    assert second["price"] is None and second["available"] is False  # unconvertible → gap
    assert target["stats"]["current"] == 113400.0
    assert target["stats"]["current_native"] == 40500


def test_target_change_ignores_fx_drift(riva_target) -> None:
    t0 = datetime(2026, 10, 25, tzinfo=UTC)
    rows = []
    for hour, rate in ((0, 2.8), (6, 2.9)):
        row = _reading(40500, t0.replace(hour=hour)).to_record()
        row.update(currency="THB", fx_rate=rate)
        rows.append(row)
    stats = build_site_data(Watchlist((riva_target,), ()), rows)["targets"][0]["stats"]
    assert stats["current"] != stats["first"]  # INR moved with the rate…
    assert stats["change_pct_vs_prev"] == 0.0  # …but the hotel's price did not


def test_site_data_without_readings(riva_target) -> None:
    t = build_site_data(Watchlist((riva_target,), ()), [])["targets"][0]
    assert t["stats"] == {"current": None, "available": False}
    assert t["currency"] == "INR"


def test_site_data_scans(tmp_path: Path) -> None:
    scan = ScanTarget(
        id="s", name="n", url="u", provider="fake", room="r", nights=5,
        from_date=date(2027, 1, 1), to_date=date(2027, 1, 3),
    )  # fmt: skip
    r1 = ScanResult(
        scan_id="s", run_at=datetime(2026, 10, 25, tzinfo=UTC), nights=5, currency="THB",
        price_basis="after_tax", failures=0, fx_rate=2.0,
        points=(
            ScanPoint("2027-01-01", 50000.0, "A", None, True),
            ScanPoint("2027-01-02", 40000.0, "A", "deal", True),
            ScanPoint("2027-01-03", None, None, None, False),
        ),
    )  # fmt: skip
    r2 = ScanResult(
        scan_id="s", run_at=datetime(2026, 10, 26, tzinfo=UTC), nights=5, currency="THB",
        price_basis="after_tax", failures=1, fx_rate=2.5,
        points=(ScanPoint("2027-01-01", 45000.0, "A", None, True),),
    )  # fmt: skip
    path = tmp_path / "scans.jsonl"
    append_scan_results(path, [r2, r1])  # out of order on purpose
    runs = load_scans(path)
    assert [r["run_at"][:10] for r in runs] == ["2026-10-25", "2026-10-26"]

    block = build_site_data(Watchlist((), (scan,)), [], runs)["scans"][0]
    assert block["currency"] == "THB" and block["price_basis"] == "after_tax"
    # Newest value per date wins; dates the latest run missed fall back to the earlier run.
    pts = {p["check_in"]: p for p in block["latest"]["points"]}
    # INR at each run's own rate; native figure kept.
    assert pts["2027-01-01"]["price"] == 112500.0 and pts["2027-01-01"]["native"] == 45000.0
    assert pts["2027-01-01"]["t"].startswith("2026-10-26")
    assert pts["2027-01-02"]["price"] == 80000.0 and pts["2027-01-02"]["t"].startswith("2026-10-25")
    assert pts["2027-01-03"]["available"] is False
    assert block["latest"]["failures"] == 1 and block["latest"]["fresh"] == 1
    assert block["fx_rate"] == 2.5
    assert block["history"][0] == {
        "t": "2026-10-25T00:00:00+00:00",
        "min": 80000.0,
        "min_native": 40000.0,
        "min_date": "2027-01-02",
        "median": 90000.0,
        "fx_rate": 2.0,
        "available": 2,
    }
    assert block["history"][1]["min"] == 112500.0
    # Change history per date, in the engine's currency, collapsed to actual changes.
    assert pts["2027-01-01"]["h"] == [
        ["2026-10-25T00:00:00+00:00", 50000.0],
        ["2026-10-26T00:00:00+00:00", 45000.0],
    ]
    assert pts["2027-01-02"]["h"] == [["2026-10-25T00:00:00+00:00", 40000.0]]
    assert pts["2027-01-03"]["h"] == [["2026-10-25T00:00:00+00:00", None]]


def test_scan_history_ignores_fx_drift_and_old_window(tmp_path: Path) -> None:
    scan = ScanTarget(
        id="s", name="n", url="u", provider="fake", room="r", nights=5,
        from_date=date(2027, 1, 2), to_date=date(2027, 1, 3),
    )  # fmt: skip
    cases = [(25, 2.0, 40000.0), (26, 2.5, 40000.0), (27, 2.5, None), (28, 2.6, 38000.0)]
    runs = [
        ScanResult(
            scan_id="s",
            run_at=datetime(2026, 10, day, tzinfo=UTC),
            nights=5,
            currency="THB",
            price_basis="after_tax",
            failures=0,
            fx_rate=rate,
            points=(
                ScanPoint("2027-01-01", 1.0, "A", None, True),  # no longer in the window
                ScanPoint("2027-01-02", price, "A" if price else None, None, price is not None),
            ),
        )
        for day, rate, price in cases
    ]
    path = tmp_path / "scans.jsonl"
    append_scan_results(path, runs)
    block = build_site_data(Watchlist((), (scan,)), [], load_scans(path))["scans"][0]
    pts = block["latest"]["points"]
    assert [p["check_in"] for p in pts] == ["2027-01-02"]
    assert [v for _, v in pts[0]["h"]] == [40000.0, None, 38000.0]


def test_write_json_is_compact(tmp_path: Path) -> None:
    out = tmp_path / "x" / "y.json"
    write_json(out, {"a": [1, 2]})
    assert out.read_text() == '{"a":[1,2]}\n'
