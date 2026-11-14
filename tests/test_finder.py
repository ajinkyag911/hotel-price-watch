from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from hotelwatch import cli, finder
from hotelwatch.http import HttpError

CONFIG: dict[str, Any] = {
    "nights": 4,
    "adults": 2,
    "from": "2027-01-01",
    "to": "2027-01-28",
    "min_rating": 4.3,
    "min_reviews": 200,
    "types": ["Hotel", "Resort"],
    "max_nightly_inr": 15000,
    "hotels_per_location": 4,
    "date_stride": 7,
    "catalog_max_age_days": 7,
    "locations": [
        {"id": "goa", "name": "Goa", "country": "India", "location_key": "g297604"},
        {"id": "langkawi", "name": "Langkawi", "country": "Malaysia", "location_key": "g298283"},
    ],
}


def _listing(n: int, rating: float, count: int, kind: str = "Hotel") -> dict[str, Any]:
    return {
        "name": f"Hotel {n}",
        "key": f"g297604-d{n}",
        "accommodation_type": kind,
        "url": f"https://www.tripadvisor.com/Hotel_Review-g306996-d{n}-Reviews-Hotel_{n}.html",
        "review_summary": {"rating": rating, "count": count},
        "geo": {"latitude": 15.0, "longitude": 74.0},
        "image": f"https://img/{n}.jpg",
        "mentions": [],
        "merchandising_labels": ["Beachfront"] if n == 1 else [],
    }


LISTINGS = [
    _listing(1, 4.6, 3000),
    _listing(2, 5.0, 210),
    _listing(3, 4.4, 900, "Resort"),
    _listing(4, 4.8, 50),  # too few reviews
    _listing(5, 4.9, 800, "Hostel"),  # wrong type
    _listing(6, 4.1, 5000),  # rating too low
    _listing(7, 4.5, 400),
]
NIGHTLY = {"1": 10000, "2": 20000, "3": 6000, "7": 9000}


class FakeXotelo:
    def __init__(self, nightly: dict[str, float] | None = None, fail_on: set[str] | None = None):
        self.nightly = nightly or NIGHTLY
        self.fail_on = fail_on or set()
        self.urls: list[str] = []

    def __call__(self, url: str, **kw: Any) -> Any:
        self.urls.append(url)
        if "/api/list" in url:
            return {"error": None, "result": {"total_count": len(LISTINGS), "list": LISTINGS}}
        hid = url.split("hotel_key=")[1].split("&")[0].split("-d")[1]
        if hid in self.fail_on:
            raise HttpError("HTTP 500 from x")
        nightly = self.nightly.get(hid)
        if nightly is None:
            return {"error": None, "result": {"rates": []}}
        return {
            "error": None,
            "result": {
                "rates": [
                    {"code": "BookingCom", "name": "Booking.com", "rate": nightly * 1.2},
                    {"code": "Agoda", "name": "Agoda.com", "rate": nightly},
                ]
            },
        }


@pytest.fixture
def cfg() -> finder.FinderConfig:
    return finder.load_finder_config(CONFIG)


def test_config_validation(cfg) -> None:
    assert cfg.location("langkawi").country_code == "MY"
    with pytest.raises(finder.FinderError, match="unknown location"):
        cfg.location("bali")
    with pytest.raises(finder.FinderError):
        finder.load_finder_config({**CONFIG, "to": "2026-01-01"})
    with pytest.raises(finder.FinderError):
        finder.load_finder_config({**CONFIG, "locations": []})


def test_catalog_filters_and_ranks_by_bayesian_rating(cfg) -> None:
    fake = FakeXotelo()
    cat = finder.build_catalog(cfg, cfg.location("goa"), fetch=fake, spacing=0)
    assert any("sort=best_value" in u for u in fake.urls)
    assert any("sort=popularity" in u for u in fake.urls)
    keys = [h["key"] for h in cat["hotels"]]
    # 4.6 with 3000 reviews beats 5.0 with 210 once the prior pulls the small sample toward 4.0;
    # 4.5 with 400 edges out 4.4 with 900. Hostels, thin and low ratings are filtered out.
    assert keys == ["g297604-d1", "g297604-d2", "g297604-d7", "g297604-d3"]
    assert cat["hotels"][0]["labels"] == ["Beachfront"]


def test_check_in_dates_rotate_and_cover_the_window(cfg) -> None:
    covered: set[date] = set()
    for offset in range(7):
        today = date(2026, 12, 20 + offset)
        dates = finder.check_in_dates(cfg, today)
        assert all(d.toordinal() % 7 == today.toordinal() % 7 for d in dates)
        covered.update(dates)
    assert len(covered) == 28  # every check-in in the window after a week of runs
    assert finder.check_in_dates(cfg, date(2027, 1, 20)) == [date(2027, 1, 27)]


def test_fetch_location_prices_totals_and_counts_failures(cfg) -> None:
    cat = finder.build_catalog(cfg, cfg.location("goa"), fetch=FakeXotelo(), spacing=0)
    fake = FakeXotelo(fail_on={"2"})
    obs = finder.fetch_location(
        cfg,
        cfg.location("goa"),
        cat,
        today=date(2026, 12, 31),
        fetch=fake,
        stride=7,
        workers=2,
        spacing=0,
        sleep=lambda s: None,
    )
    assert obs["dates"] == ["2027-01-07", "2027-01-14", "2027-01-21", "2027-01-28"]
    assert obs["requests"] == 16 and obs["failures"] == 4
    first = next(o for o in obs["observations"] if o["key"] == "g297604-d1")
    assert first["p"] == 40000 and first["site"] == "Agoda.com"
    assert first["sites"] == {"Agoda.com": 40000, "Booking.com": 48000}
    assert all("currency=INR" in u for u in fake.urls if "rates" in u)


def _obs(key: str, d: str, p: float | None, seen: str) -> dict[str, Any]:
    return {
        "key": key,
        "d": d,
        "p": p,
        "site": "Agoda.com" if p else None,
        "sites": {"Agoda.com": p} if p else {},
        "seen": seen,
    }


def test_merge_cell_tracks_lo_hi_first_prev() -> None:
    c = finder.merge_cell(None, _obs("k", "2027-01-07", 100, "2026-12-01T00:00:00+00:00"))
    c = finder.merge_cell(c, _obs("k", "2027-01-07", 80, "2026-12-02T00:00:00+00:00"))
    c = finder.merge_cell(c, _obs("k", "2027-01-07", None, "2026-12-03T00:00:00+00:00"))
    c = finder.merge_cell(c, _obs("k", "2027-01-07", 120, "2026-12-04T00:00:00+00:00"))
    assert (c["p"], c["lo"], c["hi"], c["first"], c["n"]) == (120, 80, 120, 100, 3)
    assert c["prev"] == 80  # the last known price, skipping the sold-out check
    stale = finder.merge_cell(c, _obs("k", "2027-01-07", 1, "2026-11-01T00:00:00+00:00"))
    assert stale == c  # older observations never overwrite newer ones


def _run_pipeline(tmp_path: Path, cfg, today: date, nightly=None) -> dict[str, Any]:
    loc = cfg.location("goa")
    cat = finder.build_catalog(cfg, loc, fetch=FakeXotelo(), spacing=0)
    obs = finder.fetch_location(
        cfg,
        loc,
        cat,
        today=today,
        fetch=FakeXotelo(nightly),
        spacing=0,
        sleep=lambda s: None,
    )
    finder.merge_observations(tmp_path, obs, today)
    return finder.build_finder_site(cfg, tmp_path, today)


def test_merge_and_site_contract(tmp_path: Path, cfg) -> None:
    site = _run_pipeline(tmp_path, cfg, date(2026, 12, 31))
    assert set(site) == {"generated_at", "config", "locations", "hotels"}
    assert site["config"]["max_nightly_inr"] == 15000
    goa = next(loc for loc in site["locations"] if loc["id"] == "goa")
    assert goa["hotels"] == 4 and goa["priced"] == 4 and goa["updated_at"]
    lang = next(loc for loc in site["locations"] if loc["id"] == "langkawi")
    assert lang["hotels"] == 0 and lang["median_nightly"] is None
    h = site["hotels"][0]
    expected = {
        "key",
        "location",
        "name",
        "type",
        "rating",
        "reviews",
        "url",
        "image",
        "lat",
        "lng",
        "labels",
        "best",
        "median_nightly",
        "peer_median_nightly",
        "peer_discount_pct",
        "drop_pct",
        "score",
        "super_value",
        "stretch",
        "reasons",
        "dates",
        "history",
    }
    assert set(h) == expected
    assert site["config"]["min_nightly_inr"] == 2000
    assert site["config"]["stretch_nightly_inr"] == 20000
    assert goa["in_budget"] == 3  # hotel 2 at ₹20,000/night is in the stretch band
    assert set(h["best"]) == {"check_in", "total", "nightly", "site"}
    assert set(h["dates"][0]) == {"d", "p", "site", "lo", "hi", "first", "prev", "seen"}
    assert [x["score"] for x in site["hotels"]] == sorted(
        (x["score"] for x in site["hotels"]), reverse=True
    )
    # Hotel 3 (4.4★, ₹6,000/night) is far cheaper than its 4.5★ and 4.6★ peers (₹9,000, ₹10,000).
    h3 = next(x for x in site["hotels"] if x["key"] == "g297604-d3")
    assert h3["peer_median_nightly"] == 9500 and h3["peer_discount_pct"] == 36.8
    assert h3["super_value"] is False or h3["score"] >= 75
    assert any("below similar" in r for r in h3["reasons"])
    assert h3["drop_pct"] is None  # one run only: no history to compare against
    h2 = next(x for x in site["hotels"] if x["key"] == "g297604-d2")
    assert h2["best"]["nightly"] == 20000
    assert h2["stretch"] is True
    assert h2["super_value"] is False and any("budget" in r for r in h2["reasons"])
    grid = json.loads((tmp_path / "grid-goa.json").read_text())
    assert set(grid["hotels"]) == {"g297604-d1", "g297604-d2", "g297604-d3", "g297604-d7"}
    assert (tmp_path / "catalog-goa.json").exists()
    rows = (tmp_path / "history.jsonl").read_text().splitlines()
    assert len(rows) == 4 and json.loads(rows[0])["priced"] == 4


def test_second_run_drops_past_dates_and_measures_drop(tmp_path: Path, cfg) -> None:
    _run_pipeline(tmp_path, cfg, date(2026, 12, 31))
    cheaper = {**NIGHTLY, "1": 7000}
    site = _run_pipeline(tmp_path, cfg, date(2027, 1, 14), cheaper)
    h1 = next(x for x in site["hotels"] if x["key"] == "g297604-d1")
    assert [x["d"] for x in h1["dates"]] == ["2027-01-14", "2027-01-21", "2027-01-28"]
    assert len(h1["history"]) == 2
    assert h1["drop_pct"] == pytest.approx(17.6)  # 28,000 vs the median of 40,000 and 28,000
    assert any("Down 30% since the last check" in r for r in h1["reasons"])


def _event(body: str, author: str = "ajinkyag911", title: str = "Track: Hotel 1") -> dict:
    return {
        "issue": {"title": title, "body": body, "user": {"login": author}, "number": 7},
        "repository": {"owner": {"login": "ajinkyag911"}},
    }


REQ = {
    "key": "g297604-d1",
    "name": "Hotel 1",
    "url": "https://www.tripadvisor.com/Hotel_Review-g306996-d1-Reviews-Hotel_1.html",
    "location": "goa",
}


def test_track_request_validation(cfg) -> None:
    body = f"Please track\n```json\n{json.dumps(REQ)}\n```\n"
    req = finder.parse_track_request(_event(body), cfg)
    assert req["key"] == "g297604-d1" and req["location"].id == "goa"
    bad = [
        (_event(body, author="someone-else"), "owner"),
        (_event(body, title="Hello"), "Track:"),
        (_event("no block"), "json block"),
        (_event(body.replace("g297604-d1", "x; rm -rf /")), "bad hotel key"),
        (
            _event(body.replace("https://www.tripadvisor.com", "https://evil.example")),
            "TripAdvisor",
        ),
        (_event(body.replace('"goa"', '"bali"')), "unknown location"),
    ]
    for event, match in bad:
        with pytest.raises(finder.TrackError, match=match):
            finder.parse_track_request(event, cfg)


def test_track_cli_adds_once(tmp_path: Path) -> None:
    (tmp_path / "finder.json").write_text(json.dumps(CONFIG))
    wl = {
        "targets": [],
        "scans": [
            {
                "id": "x",
                "name": "x",
                "url": "u",
                "provider": "swiftbook",
                "room": "r",
                "nights": 1,
                "from": "2027-01-01",
                "to": "2027-01-02",
            }
        ],
    }
    (tmp_path / "watchlist.json").write_text(json.dumps(wl))
    event = tmp_path / "event.json"
    event.write_text(json.dumps(_event(f"```json\n{json.dumps(REQ)}\n```")))
    argv = [
        "--watchlist",
        str(tmp_path / "watchlist.json"),
        "track",
        "--event",
        str(event),
        "--message-out",
        str(tmp_path / "reply.md"),
        "--result-out",
        str(tmp_path / "result.json"),
    ]
    assert cli.main(argv) == 0
    scans = json.loads((tmp_path / "watchlist.json").read_text())["scans"]
    assert scans[-1]["id"] == "goa-hotel-1-4n" and scans[-1]["provider"] == "xotelo"
    assert scans[-1]["country"] == "IN" and scans[-1]["from"] == "2027-01-01"
    assert json.loads((tmp_path / "result.json").read_text()) == {"ok": True, "added": True}
    assert "Now tracking" in (tmp_path / "reply.md").read_text()
    assert cli.main(argv) == 0
    assert len(json.loads((tmp_path / "watchlist.json").read_text())["scans"]) == 2
    assert json.loads((tmp_path / "result.json").read_text())["added"] is False


def test_find_cli_fetch_merge_build(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "finder.json").write_text(json.dumps({**CONFIG, "to": "2027-12-31"}))
    (tmp_path / "watchlist.json").write_text(
        json.dumps(
            {
                "targets": [],
                "scans": [
                    {
                        "id": "x",
                        "name": "x",
                        "url": "u",
                        "provider": "swiftbook",
                        "room": "r",
                        "nights": 1,
                        "from": "2027-01-01",
                        "to": "2027-01-02",
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(finder, "fetch_json", FakeXotelo())
    base = [
        "--watchlist",
        str(tmp_path / "watchlist.json"),
        "--history",
        str(tmp_path / "data/history.jsonl"),
        "--scans",
        str(tmp_path / "data/scans.jsonl"),
        "--site",
        str(tmp_path / "docs/data/history.json"),
    ]
    obs = tmp_path / "obs-goa.json"
    assert (
        cli.main(
            [
                *base,
                "find",
                "fetch",
                "--location",
                "goa",
                "--out",
                str(obs),
                "--stride",
                "30",
                "--spacing",
                "0",
            ]
        )
        == 0
    )
    assert json.loads(obs.read_text())["observations"]
    assert cli.main([*base, "find", "merge", str(obs)]) == 0
    site = tmp_path / "docs/data/finder.json"
    assert json.loads(site.read_text())["hotels"]
    site.unlink()
    assert cli.main([*base, "build"]) == 0
    assert site.exists() and (tmp_path / "docs/data/history.json").exists()
    assert cli.main([*base, "find", "fetch", "--location", "bali"]) == 2


# -- budget-aware selection ---------------------------------------------------------------------


class BudgetXotelo:
    """Listings with a given nightly price each; None means the hotel never returns rates."""

    def __init__(self, prices: list[float | None]) -> None:
        self.prices = prices
        self.rate_calls: list[str] = []

    def __call__(self, url: str, **kw: Any) -> Any:
        if "/api/list" in url:
            offset = int(url.split("offset=")[1].split("&")[0])
            items = [_listing(100 + i, 4.9 - i * 0.01, 1000) for i in range(len(self.prices))][
                offset : offset + 100
            ]
            return {"error": None, "result": {"total_count": len(self.prices), "list": items}}
        self.rate_calls.append(url)
        hid = int(url.split("hotel_key=")[1].split("&")[0].split("-d")[1])
        nightly = self.prices[hid - 100]
        rates = [] if nightly is None else [{"name": "Agoda.com", "rate": nightly}]
        return {"error": None, "result": {"rates": rates}}


def _budget_cfg(**kw: Any) -> finder.FinderConfig:
    return finder.load_finder_config(
        {
            **CONFIG,
            "from": "2026-12-01",
            "to": "2027-03-31",
            "hotels_per_location": 10,
            "max_stretch_hotels": 3,
            **kw,
        }
    )


def _band_prices() -> list[float | None]:
    # Best-rated first: 2 too pricey, 4 stretch, 1 never priced, 2 too cheap, 5 in budget.
    return [
        25000,
        30000,
        16000,
        17000,
        18000,
        19000,
        None,
        1500,
        1800,
        5000,
        6000,
        7000,
        8000,
        9000,
    ]


def test_catalog_keeps_budget_band_and_caps_stretch() -> None:
    cfg = _budget_cfg()
    fake = BudgetXotelo(_band_prices())
    cat = finder.build_catalog(
        cfg, cfg.location("goa"), fetch=fake, today=date(2026, 11, 14), spacing=0,
        sleep=lambda s: None,
    )  # fmt: skip
    picked = {h["key"]: h for h in cat["hotels"]}
    nightly = sorted(h["estimate_nightly"] for h in picked.values())
    # 5 in budget fill first, then 3 stretch (the cap), best-rated stretch first.
    assert nightly == [5000, 6000, 7000, 8000, 9000, 16000, 17000, 18000]
    assert all(2000 <= n <= 20000 for n in nightly)
    st = cat["stats"]
    assert (st["candidates"], st["probed"], st["in_budget"], st["stretch"]) == (14, 14, 5, 4)
    assert (st["too_cheap"], st["too_pricey"], st["never_priced"]) == (2, 2, 1)
    # The never-priced hotel was asked on both probe dates; others answered on the first.
    assert len(fake.rate_calls) == 15
    assert "chk_in=2026-12-08" in fake.rate_calls[0]  # first Tuesday 3+ weeks out
    assert finder.probe_dates(cfg, date(2026, 11, 14)) == [date(2026, 12, 8), date(2027, 1, 5)]


def test_catalog_fills_with_in_budget_before_stretch() -> None:
    cfg = _budget_cfg(hotels_per_location=4)
    cat = finder.build_catalog(
        cfg, cfg.location("goa"), fetch=BudgetXotelo(_band_prices()), today=date(2026, 11, 14),
        spacing=0, sleep=lambda s: None,
    )  # fmt: skip
    assert all(h["band"] == "in_budget" for h in cat["hotels"]) and len(cat["hotels"]) == 4


def test_catalog_reserves_slots_for_stretch_picks() -> None:
    # 4 slots, 2 reserved: the 2 best in-budget hotels plus the 2 best-rated stretch hotels.
    cfg = _budget_cfg(hotels_per_location=4, reserved_stretch_hotels=2)
    cat = finder.build_catalog(
        cfg, cfg.location("goa"), fetch=BudgetXotelo(_band_prices()), today=date(2026, 11, 14),
        spacing=0, sleep=lambda s: None,
    )  # fmt: skip
    bands = sorted(h["band"] for h in cat["hotels"])
    assert bands == ["in_budget", "in_budget", "stretch", "stretch"]
    with pytest.raises(finder.FinderError, match="reserved_stretch_hotels"):
        _budget_cfg(reserved_stretch_hotels=9)


def test_probes_are_reused_and_observed_prices_win() -> None:
    cfg = _budget_cfg()
    first = finder.build_catalog(
        cfg, cfg.location("goa"), fetch=BudgetXotelo(_band_prices()), today=date(2026, 11, 14),
        spacing=0, sleep=lambda s: None,
    )  # fmt: skip
    # A week later: prices moved, but fresh probes are reused, so only the never-priced hotel is
    # asked again. Hotel 109 (₹5,000 probe) has been observed at ₹25,000 on 3 dates: swapped out.
    moved = [p * 3 if p else p for p in _band_prices()]
    fake = BudgetXotelo(moved)
    cells = {d: {"p": 100000} for d in ("2027-01-05", "2027-01-12", "2027-01-19")}
    grid = {"hotels": {"g297604-d109": cells}}
    second = finder.build_catalog(
        cfg, cfg.location("goa"), fetch=fake, previous=first, grid=grid,
        today=date(2026, 11, 21), spacing=0, sleep=lambda s: None,
    )  # fmt: skip
    assert len(fake.rate_calls) == 2  # only the never-priced hotel, on both probe dates
    keys = {h["key"] for h in second["hotels"]}
    assert "g297604-d109" not in keys
    assert {h["key"] for h in first["hotels"]} - keys == {"g297604-d109"}
    by_key = {h["key"]: h for h in second["candidates"]}
    assert by_key["g297604-d109"]["estimate_source"] == "observed"
    assert by_key["g297604-d110"]["estimate_source"] == "probe"
    assert by_key["g297604-d110"]["probed_at"] == next(
        h["probed_at"] for h in first["candidates"] if h["key"] == "g297604-d110"
    )


def _scored(cfg, *, nightly: float, median_nightly: float, peer: float | None, rating=4.8):
    h = {
        "key": "k", "rating": rating, "reviews": 5000, "best": {"check_in": "2027-01-12",
        "total": nightly * cfg.nights, "nightly": nightly, "site": "Agoda.com"},
        "median_nightly": median_nightly, "peer_median_nightly": None,
        "peer_discount_pct": peer, "drop_pct": None, "dates": [], "stretch": False,
    }  # fmt: skip
    finder._score(cfg, h, "Goa")
    return h


def test_stretch_super_value_needs_an_exceptional_deal() -> None:
    cfg = _budget_cfg()
    great = _scored(cfg, nightly=18000, median_nightly=26000, peer=35)
    assert great["stretch"] and great["super_value"] and great["score"] >= 75
    assert great["reasons"][0].startswith("Worth the stretch: 35% below similar hotels")
    meh = _scored(cfg, nightly=18000, median_nightly=19000, peer=10)
    assert meh["stretch"] and not meh["super_value"]
    assert any("Over your ₹15,000/night budget" in r for r in meh["reasons"])
    pricey = _scored(cfg, nightly=25000, median_nightly=40000, peer=40)
    assert not pricey["stretch"] and not pricey["super_value"]
    cheap = _scored(cfg, nightly=1500, median_nightly=3000, peer=40)
    assert not cheap["super_value"]  # under the ₹2,000 floor
    ok = _scored(cfg, nightly=9000, median_nightly=12000, peer=30)
    assert ok["super_value"] and not ok["stretch"]


def test_config_rejects_bad_budget_band() -> None:
    with pytest.raises(finder.FinderError, match="stretch"):
        finder.load_finder_config({**CONFIG, "stretch_nightly_inr": 10000})
