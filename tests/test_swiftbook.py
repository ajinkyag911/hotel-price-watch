from __future__ import annotations

import copy
from dataclasses import replace

import pytest

from hotelwatch.providers import detect_provider, get_provider
from hotelwatch.providers.base import ProviderError
from hotelwatch.providers.swiftbook import SwiftbookProvider

ROOM_ID = "128448"


def test_detects_swiftbook_urls(riva_target) -> None:
    assert detect_provider(riva_target.url) == "swiftbook"
    assert detect_provider("https://example.com/book") is None
    assert SwiftbookProvider.property_token(riva_target.url) == "382MjlOX1HhWa8BZLxcp5d96Q3Ng=="


def test_registry_rejects_unknown_provider() -> None:
    with pytest.raises(ProviderError, match="unknown provider"):
        get_provider("nope")


def test_fetch_picks_cheapest_plan_when_no_filter(riva_target, fake_fetch) -> None:
    reading = SwiftbookProvider(fetch=fake_fetch).fetch(riva_target)
    assert reading.available
    # Free-breakfast plans: 9333 + 9333 + 8842 + 7802
    assert reading.price == 35310.0
    assert reading.price_after_tax == 41666.0
    assert reading.currency == "INR"
    assert reading.promo == "Early Bird-37%-14 Days"
    # Refundable wins the tie against the non-refundable twin at the same price.
    assert reading.plan_name == "Staycation Package – Free Breakfast"
    assert len(reading.plans) == 4


def test_fetch_honours_rate_plan_filter(riva_target, fake_fetch) -> None:
    target = replace(riva_target, rate_plan="breakfast and dinner")
    reading = SwiftbookProvider(fetch=fake_fetch).fetch(target)
    # Matches the price shown on the booking page for this plan.
    assert reading.price == 40036.0
    assert reading.plan_name == "Staycation Package – Breakfast and Dinner"
    assert {p.name for p in reading.plans} == {
        "Staycation Package – Breakfast and Dinner",
        "Staycation Package – Breakfast and Dinner - NRF",
    }


def test_request_body_and_headers(riva_target, fake_fetch) -> None:
    SwiftbookProvider(fetch=fake_fetch, api_key="k").fetch(riva_target)
    rates_call = next(c for c in fake_fetch.calls if "csbe" in c["url"])
    assert rates_call["method"] == "POST"
    assert rates_call["headers"]["X-Api-Key"] == "k"
    assert rates_call["body"]["CheckInDate"] == "2027-01-29"
    assert rates_call["body"]["CheckOutDate"] == "2027-02-02"
    assert rates_call["body"]["Rooms"] == [{"Adult": 2, "Children": []}]
    prop_call = next(c for c in fake_fetch.calls if "PropertyJson" in c["url"])
    assert prop_call["url"].endswith("/EN/2476.json")


def test_property_json_is_cached_between_fetches(riva_target, fake_fetch) -> None:
    p = SwiftbookProvider(fetch=fake_fetch)
    p.fetch(riva_target)
    p.fetch(riva_target)
    assert sum("PropertyJson" in c["url"] for c in fake_fetch.calls) == 1


def test_room_matching_is_case_and_space_insensitive(riva_target, fake_fetch) -> None:
    target = replace(riva_target, room="  superior deluxe room   with balcony ")
    assert SwiftbookProvider(fetch=fake_fetch).fetch(target).available


def test_unknown_room_lists_available_rooms(riva_target, fake_fetch) -> None:
    target = replace(riva_target, room="Penthouse")
    with pytest.raises(ProviderError, match=r"no match.*Executive Suite"):
        SwiftbookProvider(fetch=fake_fetch).fetch(target)


def test_ambiguous_room_is_an_error(riva_target, fake_fetch) -> None:
    # "Premium River View" is a prefix of two rooms.
    target = replace(riva_target, room="Premium River View")
    with pytest.raises(ProviderError, match="ambiguous"):
        SwiftbookProvider(fetch=fake_fetch).fetch(target)


def test_room_missing_from_rates_is_unavailable(riva_target, fake_fetch) -> None:
    payload = copy.deepcopy(fake_fetch.rates)
    payload["Product"][0]["Rooms"] = [
        r for r in payload["Product"][0]["Rooms"] if r["RoomId"] != ROOM_ID
    ]
    fake_fetch.rates = payload
    reading = SwiftbookProvider(fetch=fake_fetch).fetch(riva_target)
    assert not reading.available
    assert reading.price is None
    assert reading.note


def test_partial_match_is_unavailable(riva_target, fake_fetch) -> None:
    payload = copy.deepcopy(fake_fetch.rates)
    room = next(r for r in payload["Product"][0]["Rooms"] if r["RoomId"] == ROOM_ID)
    room["Roommatch"] = "partialmatch"
    fake_fetch.rates = payload
    assert not SwiftbookProvider(fetch=fake_fetch).fetch(riva_target).available


def test_plan_with_zero_rate_night_is_skipped(riva_target, fake_fetch) -> None:
    payload = copy.deepcopy(fake_fetch.rates)
    room = next(r for r in payload["Product"][0]["Rooms"] if r["RoomId"] == ROOM_ID)
    for plan in room["RatePlans"]:
        if plan["RateId"] in ("464800000000004", "464800000000016"):
            plan["Rates"][0]["Dates"]["2027-01-31"]["RateBeforeTax"] = "0"
    fake_fetch.rates = payload
    reading = SwiftbookProvider(fetch=fake_fetch).fetch(riva_target)
    assert reading.price == 40036.0


def test_malformed_payload_raises(riva_target, fake_fetch) -> None:
    fake_fetch.rates = {"error": "nope"}
    with pytest.raises(ProviderError, match="unexpected rates payload"):
        SwiftbookProvider(fetch=fake_fetch).fetch(riva_target)
