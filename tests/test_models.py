from __future__ import annotations

import pytest

from hotelwatch.models import ScanTarget, Target, WatchlistError, load_watchlist

BASE = {
    "id": "t1",
    "name": "Hotel · Room",
    "url": "https://www.swiftbook.io/inst/#home?propertyId=abc==&JDRN=Y",
    "provider": "Swiftbook",
    "room": "Room",
    "check_in": "2027-01-29",
    "check_out": "2027-02-02",
}
SCAN = {
    "id": "s1",
    "name": "Hotel · Room",
    "url": BASE["url"],
    "provider": "swiftbook",
    "room": "Room",
    "nights": 4,
    "from": "2026-12-01",
    "to": "2026-12-10",
}


def test_from_dict_defaults_and_normalisation() -> None:
    t = Target.from_dict(BASE)
    assert t.nights == 4
    assert t.adults == 2
    assert t.children == ()
    assert t.provider == "swiftbook"
    assert t.country == "IN"
    assert t.alert_below is None
    assert t.rate_plan is None


def test_from_dict_parses_optional_fields() -> None:
    t = Target.from_dict(
        {**BASE, "adults": 3, "children": [4], "alert_below": "35000", "rate_plan": ""}
    )
    assert t.adults == 3
    assert t.children == (4,)
    assert t.alert_below == 35000.0
    assert t.rate_plan is None


@pytest.mark.parametrize(
    ("patch", "needle"),
    [
        ({"room": ""}, "missing room"),
        ({"check_out": "2027-01-29"}, "after check_in"),
        ({"check_in": "29/01/2027"}, "YYYY-MM-DD"),
        ({"adults": 0}, "at least 1"),
        ({"alert_below": -5}, "positive"),
    ],
)
def test_from_dict_rejects_bad_input(patch: dict, needle: str) -> None:
    with pytest.raises(WatchlistError, match=needle):
        Target.from_dict({**BASE, **patch})


def test_scan_target_validation() -> None:
    s = ScanTarget.from_dict(SCAN)
    assert len(s.check_in_dates()) == 10
    with pytest.raises(WatchlistError, match="nights"):
        ScanTarget.from_dict({**SCAN, "nights": 0})
    with pytest.raises(WatchlistError, match="before"):
        ScanTarget.from_dict({**SCAN, "to": "2026-11-01"})
    with pytest.raises(WatchlistError, match="longer than a year"):
        ScanTarget.from_dict({**SCAN, "to": "2028-01-01"})


def test_load_watchlist_mixes_targets_and_scans() -> None:
    wl = load_watchlist({"targets": [BASE], "scans": [SCAN]})
    assert [t.id for t in wl.targets] == ["t1"]
    assert [s.id for s in wl.scans] == ["s1"]
    assert load_watchlist({"scans": [SCAN]}).targets == ()


def test_load_watchlist_rejects_duplicates_and_empty() -> None:
    with pytest.raises(WatchlistError, match="duplicate"):
        load_watchlist({"targets": [BASE], "scans": [{**SCAN, "id": "t1"}]})
    with pytest.raises(WatchlistError, match="at least one"):
        load_watchlist({"targets": []})


def test_public_dict_has_no_internal_fields() -> None:
    d = Target.from_dict(BASE).to_public_dict()
    assert d["nights"] == 4
    assert "country" not in d
    assert "country" not in ScanTarget.from_dict(SCAN).to_public_dict()
