"""Alert rules and delivery.

The budget rule compares in INR; the movement rules compare in the engine's own currency so a
drifting exchange rate never looks like the hotel changing its price.

Rules (each fires at most once per run per target):
* ``threshold``  INR price crossed below ``alert_below`` (was at/above it, or no prior reading)
* ``new_low``    native price is below every earlier reading
* ``drop``       native price fell by at least ``DROP_PCT`` since the previous reading
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from hotelwatch.fx import to_inr
from hotelwatch.models import Reading, Target

log = logging.getLogger(__name__)

DROP_PCT = 5.0


@dataclass(frozen=True)
class Alert:
    target_id: str
    target_name: str
    kind: str
    price: float  # INR
    previous: float | None  # INR
    message: str
    url: str


def fmt_inr(amount: float) -> str:
    return f"₹{amount:,.0f}"


def _native(reading: Reading) -> str:
    if reading.currency == "INR" or reading.price is None:
        return ""
    return f" ({reading.currency} {reading.price:,.0f})"


def row_inr(row: dict[str, Any]) -> float | None:
    """INR value of a stored history row; INR rows need no rate."""
    if row.get("price") is None:
        return None
    if (row.get("currency") or "INR") == "INR":
        return float(row["price"])
    return to_inr(row["price"], row.get("fx_rate"))


def evaluate(target: Target, reading: Reading, prior: list[dict[str, Any]]) -> list[Alert]:
    if not reading.available or reading.price is None:
        return []
    rate = 1.0 if reading.currency == "INR" else reading.fx_rate
    price = to_inr(reading.price, rate)
    if price is None:
        log.warning("%s: no exchange rate, skipping alert evaluation", target.id)
        return []
    prior_inr = [v for v in (row_inr(p) for p in prior) if v is not None]
    prev = prior_inr[-1] if prior_inr else None
    same_currency = [
        p
        for p in prior
        if (p.get("currency") or "INR") == reading.currency and p.get("price") is not None
    ]
    prior_native = [float(p["price"]) for p in same_currency]
    prev_native = prior_native[-1] if prior_native else None
    prev_native_inr = row_inr(same_currency[-1]) if same_currency else None
    alerts: list[Alert] = []
    native = _native(reading)

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
            f"{target.name}: {fmt_inr(price)}{native} is under your "
            f"{fmt_inr(target.alert_below)} alert",
        )
    if prior_native and reading.price < min(prior_native):
        low_row = min(same_currency, key=lambda p: p["price"])
        was = row_inr(low_row)
        add(
            "new_low",
            f"{target.name}: new low {fmt_inr(price)}{native}"
            + (f" (was {fmt_inr(was)})" if was is not None else ""),
        )
    if prev_native and prev_native > 0:
        drop = (prev_native - reading.price) / prev_native * 100
        if drop >= DROP_PCT:
            add(
                "drop",
                f"{target.name}: down {drop:.0f}% to {fmt_inr(price)}{native}"
                + (f" from {fmt_inr(prev_native_inr)}" if prev_native_inr is not None else ""),
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
