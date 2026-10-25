"""Append-only JSONL history plus the compact JSON the chart page reads."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from hotelwatch.models import Reading, Target


def append_readings(path: Path, readings: list[Reading]) -> None:
    if not readings:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for r in readings:
            fh.write(json.dumps(r.to_record(), ensure_ascii=False) + "\n")


def load_history(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    rows.sort(key=lambda r: r["observed_at"])
    return rows


def _stats(points: list[dict[str, Any]], alert_below: float | None) -> dict[str, Any]:
    priced = [p for p in points if p["price"] is not None]
    if not priced:
        return {"current": None, "available": False}
    current = priced[-1]
    lowest = min(priced, key=lambda p: p["price"])
    highest = max(priced, key=lambda p: p["price"])
    prev = priced[-2] if len(priced) > 1 else None
    change_pct = (
        round((current["price"] - prev["price"]) / prev["price"] * 100, 1)
        if prev and prev["price"]
        else None
    )
    return {
        "current": current["price"],
        "current_after_tax": current["after_tax"],
        "current_plan": current["plan"],
        "current_promo": current["promo"],
        "available": points[-1]["available"],
        "lowest": lowest["price"],
        "lowest_at": lowest["t"],
        "highest": highest["price"],
        "first": priced[0]["price"],
        "change_pct_vs_prev": change_pct,
        "below_alert": alert_below is not None and current["price"] < alert_below,
        "readings": len(points),
    }


def build_site_data(targets: list[Target], history: list[dict[str, Any]]) -> dict[str, Any]:
    by_target: dict[str, list[dict[str, Any]]] = {t.id: [] for t in targets}
    for row in history:
        if row["target_id"] in by_target:
            by_target[row["target_id"]].append(
                {
                    "t": row["observed_at"],
                    "price": row["price"],
                    "after_tax": row["price_after_tax"],
                    "plan": row["plan_name"],
                    "promo": row["promo"],
                    "available": row["available"],
                    "plans": [
                        {
                            "name": p["name"],
                            "before_tax": p["before_tax"],
                            "after_tax": p["after_tax"],
                            "refundable": p["refundable"],
                            "promo": p["promo"],
                        }
                        for p in row.get("plans", [])
                    ],
                }
            )
    currency = next((r["currency"] for r in reversed(history) if r.get("currency")), "INR")
    return {
        "generated_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "currency": currency,
        "targets": [
            {
                **t.to_public_dict(),
                "stats": _stats(by_target[t.id], t.alert_below),
                "readings": by_target[t.id],
            }
            for t in targets
        ],
    }


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
