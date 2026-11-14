from __future__ import annotations

import io
import urllib.error
from datetime import date

import pytest

from hotelwatch.http import BlockedError, HttpError, _with_retries
from hotelwatch.models import Target
from hotelwatch.providers import detect_provider, get_provider
from hotelwatch.providers.base import ProviderError
from hotelwatch.providers.xotelo import XoteloProvider

URL = (
    "https://www.tripadvisor.com/Hotel_Review-g2314594-d1090119-Reviews-"
    "Tolani_Resort_Koh_Samui-Maret_Ko_Samui_Surat_Thani_Province.html"
)
PAYLOAD = {
    "error": None,
    "result": {
        "chk_in": "2027-01-06",
        "chk_out": "2027-01-11",
        "currency": "THB",
        "rates": [
            {"code": "BookingCom", "name": "Booking.com", "rate": 7302, "tax": None},
            {"code": "Agoda", "name": "Agoda.com", "rate": 6917, "tax": None},
            {"code": "CtripTA", "name": "Trip.com", "rate": 6085, "tax": None},
        ],
    },
}


def _target(**kw) -> Target:
    base = dict(
        id="tolani-ota", name="Tolani", url=URL, provider="xotelo", room="Cheapest room",
        check_in=date(2027, 1, 6), check_out=date(2027, 1, 11), country="TH",
    )  # fmt: skip
    base.update(kw)
    return Target(**base)  # type: ignore[arg-type]


class Fetch:
    def __init__(self, payload) -> None:
        self.payload = payload
        self.urls: list[str] = []

    def __call__(self, url: str, **kw):
        self.urls.append(url)
        return self.payload


def _provider(payload=PAYLOAD) -> tuple[XoteloProvider, Fetch]:
    f = Fetch(payload)
    return XoteloProvider(fetch=f, delay=0, sleep=lambda s: None), f


def test_detects_tripadvisor_urls() -> None:
    assert detect_provider(URL) == "xotelo"
    assert XoteloProvider.hotel_key(URL) == "g2314594-d1090119"
    assert isinstance(get_provider("xotelo"), XoteloProvider)


def test_cheapest_site_wins_and_nightly_rate_becomes_stay_total() -> None:
    p, f = _provider()
    r = p.fetch(_target())
    assert r.available and r.currency == "THB"
    assert r.price == 6085 * 5
    assert r.plan_name == "Trip.com"
    assert [q.name for q in r.plans] == ["Trip.com", "Agoda.com", "Booking.com"]
    assert "hotel_key=g2314594-d1090119" in f.urls[0]
    assert "chk_in=2027-01-06" in f.urls[0] and "currency=THB" in f.urls[0]
    assert "adults=2" in f.urls[0]


def test_rate_plan_follows_one_site() -> None:
    p, _ = _provider()
    r = p.fetch(_target(rate_plan="booking.com"))
    assert r.price == 7302 * 5 and r.plan_name == "Booking.com"


def test_no_rates_is_unavailable_and_errors_raise() -> None:
    p, _ = _provider({"error": None, "result": {"rates": []}})
    assert p.fetch(_target()).available is False
    p, _ = _provider({"error": {"status_code": 400, "message": "bad"}, "result": None})
    with pytest.raises(ProviderError, match="bad"):
        p.fetch(_target())


def _http_error(code: int, headers: dict[str, str]) -> urllib.error.HTTPError:
    from email.message import Message

    msg = Message()
    for k, v in headers.items():
        msg[k] = v
    return urllib.error.HTTPError("u", code, "x", msg, io.BytesIO(b""))


def test_cloudflare_challenge_is_a_blocked_error_and_plain_403_is_not() -> None:
    def challenged():
        raise _http_error(403, {"cf-mitigated": "challenge"})

    def forbidden():
        raise _http_error(403, {})

    with pytest.raises(BlockedError, match="403"):
        _with_retries(challenged, "u", 3, 0)
    with pytest.raises(HttpError) as exc:
        _with_retries(forbidden, "u", 3, 0)
    assert not isinstance(exc.value, BlockedError)
