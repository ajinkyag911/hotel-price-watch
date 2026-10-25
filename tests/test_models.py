from __future__ import annotations

import pytest

from hotelwatch.models import Target, WatchlistError, load_watchlist

BASE = {
    "id": "t1",
    "name": "Hotel · Room",
    "url": "https://www.swiftbook.io/inst/#home?propertyId=abc==&JDRN=Y",
    "provider": "Swiftbook",
    "room": "Room",
    "check_in": "2027-01-29",
    "check_out": "2027-02-02",
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


def test_load_watchlist_rejects_duplicates_and_empty() -> None:
    with pytest.raises(WatchlistError, match="duplicate"):
        load_watchlist({"targets": [BASE, BASE]})
    with pytest.raises(WatchlistError, match="non-empty"):
        load_watchlist({"targets": []})


def test_public_dict_has_no_internal_fields() -> None:
    d = Target.from_dict(BASE).to_public_dict()
    assert d["nights"] == 4
    assert "country" not in d
