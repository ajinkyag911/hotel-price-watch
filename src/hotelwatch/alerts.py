"""Alert rules and delivery.

Rules (each fires at most once per run per target):
* ``threshold``  price crossed below ``alert_below`` (was at/above it, or no prior reading)
* ``new_low``    price is below every earlier reading
* ``drop``       price fell by at least ``DROP_PCT`` since the previous reading
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from hotelwatch.models import Reading, Target

log = logging.getLogger(__name__)

DROP_PCT = 5.0


@dataclass(frozen=True)
class Alert:
    target_id: str
    target_name: str
    kind: str
    price: float
    previous: float | None
    message: str
    url: str


def _fmt(amount: float, currency: str) -> str:
    symbol = {"INR": "₹", "USD": "$", "EUR": "€", "GBP": "£"}.get(currency, currency + " ")
    return f"{symbol}{amount:,.0f}"


def evaluate(target: Target, reading: Reading, prior: list[dict[str, Any]]) -> list[Alert]:
    if not reading.available or reading.price is None:
        return []
    price = reading.price
    cur = reading.currency
    prior_prices = [p["price"] for p in prior if p.get("price") is not None]
    prev = prior_prices[-1] if prior_prices else None
    alerts: list[Alert] = []

    def add(kind: str, msg: str) -> None:
        alerts.append(
            Alert(
                target_id=target.id,
                target_name=target.name,
                kind=kind,
                price=price,
                previous=prev,
                message=msg,
                url=target.url,
            )
        )

    if (
        target.alert_below is not None
        and price < target.alert_below
        and (prev is None or prev >= target.alert_below)
    ):
        add(
            "threshold",
            f"{target.name}: {_fmt(price, cur)} is under your "
            f"{_fmt(target.alert_below, cur)} alert",
        )
    if prior_prices and price < min(prior_prices):
        add(
            "new_low",
            f"{target.name}: new low {_fmt(price, cur)} (was {_fmt(min(prior_prices), cur)})",
        )
    if prev and prev > 0:
        drop = (prev - price) / prev * 100
        if drop >= DROP_PCT:
            add(
                "drop",
                f"{target.name}: down {drop:.0f}% to {_fmt(price, cur)} from {_fmt(prev, cur)}",
            )
    return alerts


def write_alerts(path: Path, alerts: list[Alert]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if alerts:
        path.write_text(
            json.dumps([asdict(a) for a in alerts], indent=1, ensure_ascii=False) + "\n"
        )
    elif path.exists():
        path.unlink()


def send_ntfy(
    alerts: list[Alert], topic: str | None = None, server: str = "https://ntfy.sh"
) -> bool:
    """Push alerts to an ntfy topic if one is configured. Returns True if sent."""
    topic = topic or os.environ.get("NTFY_TOPIC")
    if not topic or not alerts:
        return False
    body = "\n".join(a.message for a in alerts)
    req = urllib.request.Request(
        f"{server.rstrip('/')}/{topic}",
        data=body.encode(),
        headers={
            "Title": "Hotel price alert",
            "Priority": "high",
            "Tags": "hotel,chart_with_downwards_trend",
            "Click": alerts[0].url,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20):
            return True
    except OSError as exc:
        log.warning("ntfy delivery failed: %s", exc)
        return False
