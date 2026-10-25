from __future__ import annotations

from datetime import date

from hotelwatch.fx import ER_API_URL, Converter, to_inr
from hotelwatch.http import HttpError


class FakeFetch:
    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = responses
        self.calls: list[str] = []

    def __call__(self, url: str, **kwargs):
        self.calls.append(url)
        for prefix, resp in self.responses.items():
            if url.startswith(prefix):
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise HttpError(f"unexpected {url}")


def test_inr_is_identity_without_network() -> None:
    fetch = FakeFetch({})
    assert Converter(fetch).rate("INR") == 1.0
    assert fetch.calls == []


def test_latest_rate_from_er_api_and_cached() -> None:
    fetch = FakeFetch(
        {ER_API_URL.format(base="THB"): {"result": "success", "rates": {"INR": 2.81}}}
    )
    fx = Converter(fetch)
    assert fx.rate("THB") == 2.81
    assert fx.rate("thb") == 2.81
    assert len(fetch.calls) == 1


def test_falls_back_to_frankfurter_when_er_api_fails() -> None:
    fetch = FakeFetch(
        {
            ER_API_URL.format(base="THB"): HttpError("HTTP 500"),
            "https://api.frankfurter.dev/v1/latest": {"rates": {"INR": 2.80}},
        }
    )
    assert Converter(fetch).rate("THB") == 2.80


def test_historical_rate_uses_frankfurter_only() -> None:
    fetch = FakeFetch({"https://api.frankfurter.dev/v1/2026-10-23": {"rates": {"INR": 2.8135}}})
    assert Converter(fetch).rate("THB", date(2026, 10, 23)) == 2.8135
    assert all("frankfurter" in c for c in fetch.calls)


def test_missing_rate_is_none_not_an_error() -> None:
    fetch = FakeFetch({})
    assert Converter(fetch).rate("THB") is None
    assert Converter(fetch).rate("") is None


def test_to_inr_rounding_and_none() -> None:
    assert to_inr(40500, 2.8135) == 113946.75
    assert to_inr(None, 2.8) is None
    assert to_inr(100, None) is None
