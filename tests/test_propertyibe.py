from __future__ import annotations

from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

from hotelwatch.models import Target
from hotelwatch.providers import detect_provider
from hotelwatch.providers.base import ProviderError
from hotelwatch.providers.propertyibe import PropertyIbeProvider, parse_rooms

FIXTURES = Path(__file__).parent / "fixtures"
URL = "https://booking.tolanihotels.com/propertyibe2/?propertyId=859&onlineId=4"


@pytest.fixture
def rate_views() -> str:
    return (FIXTURES / "propertyibe_rate_views.html").read_text()


@pytest.fixture
def rates_page() -> str:
    return (FIXTURES / "propertyibe_rates_page_snippet.html").read_text()


@pytest.fixture
def tolani_target() -> Target:
    return Target(
        id="tolani",
        name="Tolani · Deluxe Garden Villa",
        url=URL,
        provider="propertyibe",
        room="Deluxe Garden Villa",
        check_in=date(2027, 1, 6),
        check_out=date(2027, 1, 11),
        adults=2,
        country="TH",
    )


def _partial_response(rate_views_html: str, view_state: str) -> str:
    return (
        "<?xml version='1.0' encoding='UTF-8'?><partial-response><changes>"
        f'<update id="rate_views_form"><![CDATA[{rate_views_html}]]></update>'
        f'<update id="j_id1:javax.faces.ViewState:0"><![CDATA[{view_state}]]></update>'
        "</changes></partial-response>"
    )


class FakeClient:
    def __init__(self, rates_page: str, responses: list[str]) -> None:
        self.rates_page = rates_page
        self.responses = list(responses)
        self.gets: list[str] = []
        self.posts: list[dict] = []

    def get(self, url: str, headers=None) -> str:
        self.gets.append(url)
        return self.rates_page if url.endswith("rates?cid=1") else "<html>home</html>"

    def post(self, url: str, data: dict, headers=None) -> str:
        self.posts.append({"url": url, "data": data, "headers": headers or {}})
        return self.responses.pop(0)


# -- URL handling ---------------------------------------------------------------------------------


def test_detects_and_parses_url() -> None:
    assert detect_provider(URL) == "propertyibe"
    assert PropertyIbeProvider.parse_url(URL) == (
        "https://booking.tolanihotels.com/propertyibe2/",
        "859",
        "4",
    )
    with pytest.raises(ProviderError):
        PropertyIbeProvider.parse_url("https://example.com/book?propertyId=1")


# -- parsing -------------------------------------------------------------------------------------


def test_parse_cheapest_plan(rate_views: str, tolani_target: Target) -> None:
    r = parse_rooms(rate_views, tolani_target)
    assert r.available
    assert r.currency == "THB"
    assert r.price_basis == "after_tax"
    assert r.price == 40500.0  # 8,100 per night x 5, taxes included
    assert r.price_after_tax == 40500.0
    assert r.plan_name == "Early Bird Room with Breakfast"
    assert r.promo == "Book 30 days in advance, Save 40%"
    assert len(r.plans) == 4
    best = r.plans[0]
    assert best.refundable is True
    assert list(best.nightly_before_tax) == [
        "2027-01-06", "2027-01-07", "2027-01-08", "2027-01-09", "2027-01-10"
    ]  # fmt: skip
    assert set(best.nightly_before_tax.values()) == {8100.0}


def test_parse_honours_rate_plan_filter(rate_views: str, tolani_target: Target) -> None:
    r = parse_rooms(rate_views, replace(tolani_target, rate_plan="spa"))
    assert r.plan_name == "Spa Exclusive - Book Early & Save"
    assert r.price == 55500.0
    assert {p.name for p in r.plans} == {"Spa Exclusive - Book Early & Save", "Spa Escape"}


def test_parse_other_room(rate_views: str, tolani_target: Target) -> None:
    r = parse_rooms(rate_views, replace(tolani_target, room="tropical pool villa"))
    assert r.available
    assert r.price > 40500.0


def test_room_not_offered_is_unavailable_with_hint(rate_views: str, tolani_target: Target) -> None:
    r = parse_rooms(rate_views, replace(tolani_target, room="Deluxe Pool Villa"))
    assert not r.available
    assert r.price is None
    assert "Tropical Pool Villa" in (r.note or "")


def test_ambiguous_room_raises(rate_views: str, tolani_target: Target) -> None:
    with pytest.raises(ProviderError, match="ambiguous"):
        parse_rooms(rate_views, replace(tolani_target, room="Villa"))


def test_empty_room_list_is_unavailable(tolani_target: Target) -> None:
    r = parse_rooms('<form id="rate_views_form"><div id="list_room"></div></form>', tolani_target)
    assert not r.available
    assert r.note


# -- session flow --------------------------------------------------------------------------------


def test_session_posts_primefaces_request_and_rotates_viewstate(
    rates_page: str, rate_views: str, tolani_target: Target
) -> None:
    client = FakeClient(
        rates_page,
        [_partial_response(rate_views, "VS-2"), _partial_response(rate_views, "VS-3")],
    )
    provider = PropertyIbeProvider(client=client, delay=0, sleep=lambda s: None)

    first = provider.fetch(tolani_target)
    assert first.price == 40500.0
    assert client.gets == [
        "https://booking.tolanihotels.com/propertyibe2/?propertyId=859&onlineId=4",
        "https://booking.tolanihotels.com/propertyibe2/rates?cid=1",
    ]
    post = client.posts[0]
    assert post["url"] == "https://booking.tolanihotels.com/propertyibe2/rates?cid=1"
    d = post["data"]
    assert d["javax.faces.partial.ajax"] == "true"
    assert d["javax.faces.source"] == "updateSearchResult"
    assert d["updateSearchResult"] == "updateSearchResult"
    assert d["s_checkin"] == "2027-01-06"
    assert d["s_checkout"] == "2027-01-11"
    assert d["s_numofadult"] == "2"
    assert d["s_numofchild"] == "0"
    assert d["javax.faces.ViewState"]  # from the rates page
    assert post["headers"]["Faces-Request"] == "partial/ajax"

    provider.fetch(replace(tolani_target, check_in=date(2027, 1, 7), check_out=date(2027, 1, 12)))
    assert client.posts[1]["data"]["javax.faces.ViewState"] == "VS-2"
    assert len(client.gets) == 2  # session reused, no new bootstrap


def test_expired_session_is_restarted_once(
    rates_page: str, rate_views: str, tolani_target: Target
) -> None:
    expired = (
        "<partial-response><error><error-name>ViewExpiredException</error-name></error>"
        "</partial-response>"
    )
    client = FakeClient(rates_page, [expired, _partial_response(rate_views, "VS-9")])
    provider = PropertyIbeProvider(client=client, delay=0, sleep=lambda s: None)
    r = provider.fetch(tolani_target)
    assert r.available
    assert len(client.gets) == 4  # bootstrap twice
    assert len(client.posts) == 2


def test_refused_request_pauses_and_retries_with_new_session(
    rates_page: str, rate_views: str, tolani_target: Target
) -> None:
    from hotelwatch.http import HttpError

    class RefusingClient(FakeClient):
        def post(self, url, data, headers=None):
            if len(self.posts) == 0:
                self.posts.append({"url": url, "data": data, "headers": headers or {}})
                raise HttpError(f"HTTP 403 from {url}")
            return super().post(url, data, headers)

    sleeps: list[float] = []
    client = RefusingClient(rates_page, [_partial_response(rate_views, "VS-2")])
    provider = PropertyIbeProvider(client=client, delay=0, sleep=sleeps.append)
    r = provider.fetch(tolani_target)
    assert r.price == 40500.0
    assert PropertyIbeProvider.REFUSED_PAUSE in sleeps
    assert len(client.gets) == 4  # bootstrapped twice
    assert len(client.posts) == 2


def test_delay_can_come_from_environment(monkeypatch, rates_page: str) -> None:
    monkeypatch.setenv("HOTELWATCH_DELAY", "2.5")
    assert PropertyIbeProvider(client=FakeClient(rates_page, []))._delay == 2.5


def test_throttle_sleeps_between_requests(rates_page: str, rate_views: str, tolani_target) -> None:
    sleeps: list[float] = []
    client = FakeClient(rates_page, [_partial_response(rate_views, "a")] * 2)
    provider = PropertyIbeProvider(client=client, delay=5.0, sleep=sleeps.append)
    provider.fetch(tolani_target)
    provider.fetch(tolani_target)
    assert len(sleeps) == 1 and 0 < sleeps[0] <= 5.0
