"""Append-only JSONL history plus the compact JSON the chart page reads."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from statistics import median
from typing import Any

from hotelwatch.models import Reading, ScanTarget, Target, Watchlist
from hotelwatch.scan import ScanResult


def _append_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    if not records:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _load_jsonl(path: Path, sort_key: str) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    rows.sort(key=lambda r: r[sort_key])
    return rows


def append_readings(path: Path, readings: list[Reading]) -> None:
    _append_jsonl(path, [r.to_record() for r in readings])


def load_history(path: Path) -> list[dict[str, Any]]:
    return _load_jsonl(path, "observed_at")


def append_scan_results(path: Path, results: list[ScanResult]) -> None:
    _append_jsonl(path, [r.to_record() for r in results])


def load_scans(path: Path) -> list[dict[str, Any]]:
    return _load_jsonl(path, "run_at")


# -- spot targets --------------------------------------------------------------------------------


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


def _target_block(t: Target, rows: list[dict[str, Any]]) -> dict[str, Any]:
    points = [
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
        for row in rows
    ]
    latest = rows[-1] if rows else {}
    return {
        **t.to_public_dict(),
        "currency": latest.get("currency") or "INR",
        "price_basis": latest.get("price_basis", "before_tax"),
        "stats": _stats(points, t.alert_below),
        "readings": points,
    }


# -- scans ---------------------------------------------------------------------------------------


def _scan_block(s: ScanTarget, runs: list[dict[str, Any]]) -> dict[str, Any]:
    history = []
    for run in runs:
        priced = [p for p in run["points"] if p["price"] is not None]
        if not priced:
            history.append({"t": run["run_at"], "min": None, "min_date": None, "available": 0})
            continue
        best = min(priced, key=lambda p: p["price"])
        history.append(
            {
                "t": run["run_at"],
                "min": best["price"],
                "min_date": best["check_in"],
                "median": round(median(p["price"] for p in priced), 2),
                "available": len(priced),
            }
        )
    latest = runs[-1] if runs else None
    # A run can lose dates to transient refusals. The grid shows, for every check-in date, the
    # newest point any run produced, each stamped with when it was scanned.
    merged: dict[str, dict[str, Any]] = {}
    for run in reversed(runs):
        for p in run["points"]:
            merged.setdefault(p["check_in"], {**p, "t": run["run_at"]})
    points = [merged[d] for d in sorted(merged)]
    return {
        **s.to_public_dict(),
        "currency": (latest or {}).get("currency") or "INR",
        "price_basis": (latest or {}).get("price_basis", "before_tax"),
        "latest": (
            {
                "run_at": latest["run_at"],
                "failures": latest.get("failures", 0),
                "fresh": len(latest["points"]),
                "points": points,
            }
            if latest
            else None
        ),
        "history": history,
    }


def build_site_data(
    watchlist: Watchlist,
    history: list[dict[str, Any]],
    scans: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    by_target: dict[str, list[dict[str, Any]]] = {t.id: [] for t in watchlist.targets}
    for row in history:
        if row["target_id"] in by_target:
            by_target[row["target_id"]].append(row)
    by_scan: dict[str, list[dict[str, Any]]] = {s.id: [] for s in watchlist.scans}
    for run in scans or []:
        if run["scan_id"] in by_scan:
            by_scan[run["scan_id"]].append(run)
    return {
        "generated_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "targets": [_target_block(t, by_target[t.id]) for t in watchlist.targets],
        "scans": [_scan_block(s, by_scan[s.id]) for s in watchlist.scans],
    }


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
