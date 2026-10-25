from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from hotelwatch.models import Target

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


class FakeFetch:
    """Stands in for http.fetch_json; serves canned JSON and records calls."""

    def __init__(self, rates: Any, prop: Any) -> None:
        self.rates = rates
        self.prop = prop
        self.calls: list[dict[str, Any]] = []

    def __call__(self, url: str, **kwargs: Any) -> Any:
        self.calls.append({"url": url, **kwargs})
        if "csbe.staah.net" in url:
            return self.rates
        if "PropertyJson" in url:
            return self.prop
        raise AssertionError(f"unexpected URL {url}")


@pytest.fixture
def rates_payload() -> Any:
    return load_fixture("swiftbook_bedataguest.json")


@pytest.fixture
def property_payload() -> Any:
    return load_fixture("swiftbook_property.json")


@pytest.fixture
def fake_fetch(rates_payload: Any, property_payload: Any) -> FakeFetch:
    return FakeFetch(rates_payload, property_payload)


@pytest.fixture
def riva_target() -> Target:
    return Target(
        id="riva",
        name="Riva Beach Resort · Superior Deluxe Room with Balcony",
        url="https://www.swiftbook.io/inst/#home?propertyId=382MjlOX1HhWa8BZLxcp5d96Q3Ng==&JDRN=Y",
        provider="swiftbook",
        room="Superior Deluxe Room with Balcony",
        check_in=date(2027, 1, 29),
        check_out=date(2027, 2, 2),
        adults=2,
        alert_below=36000,
    )
