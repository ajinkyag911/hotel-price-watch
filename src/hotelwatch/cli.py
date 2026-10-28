"""Command line: `hotelwatch run | scan | validate | show`."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import replace
from pathlib import Path

from hotelwatch import __version__
from hotelwatch.alerts import evaluate, send_ntfy, write_alerts
from hotelwatch.fx import Converter
from hotelwatch.models import Reading, Watchlist, WatchlistError, load_watchlist
from hotelwatch.providers import ProviderError, get_provider
from hotelwatch.scan import ScanResult, run_scan
from hotelwatch.storage import (
    append_readings,
    append_scan_results,
    build_site_data,
    load_history,
    load_scans,
    write_json,
)

log = logging.getLogger("hotelwatch")

DEFAULTS = {
    "watchlist": Path("watchlist.json"),
    "history": Path("data/history.jsonl"),
    "scans": Path("data/scans.jsonl"),
    "site": Path("docs/data/history.json"),
    "alerts": Path("data/alerts.json"),
}


def _nights(n: int) -> str:
    return f"{n} night" if n == 1 else f"{n} nights"


def _read_watchlist(path: Path) -> Watchlist:
    try:
        return load_watchlist(json.loads(path.read_text()))
    except FileNotFoundError:
        raise WatchlistError(f"{path} not found") from None
    except json.JSONDecodeError as exc:
        raise WatchlistError(f"{path} is not valid JSON: {exc}") from exc


def _rebuild_site(args: argparse.Namespace, watchlist: Watchlist) -> None:
    write_json(
        args.site,
        build_site_data(watchlist, load_history(args.history), load_scans(args.scans)),
    )


def cmd_validate(args: argparse.Namespace) -> int:
    wl = _read_watchlist(args.watchlist)
    for t in wl.targets:
        get_provider(t.provider)
        print(f"ok  {t.id}: {t.room} · {t.check_in} → {t.check_out} ({_nights(t.nights)})")
    for s in wl.scans:
        get_provider(s.provider)
        print(
            f"ok  {s.id}: {s.room} · {_nights(s.nights)} · check-ins {s.from_date} → {s.to_date} "
            f"({len(s.check_in_dates())} dates)"
        )
    print(f"{len(wl.targets)} target(s), {len(wl.scans)} scan(s) valid")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    wl = _read_watchlist(args.watchlist)
    history = load_history(args.history)
    providers: dict[str, object] = {}
    fx = Converter()
    readings: list[Reading] = []
    alerts = []
    failures = 0

    for t in wl.targets:
        prior = [r for r in history if r["target_id"] == t.id]
        try:
            provider = providers.setdefault(t.provider, get_provider(t.provider))
            reading = provider.fetch(t)  # type: ignore[attr-defined]
        except (ProviderError, RuntimeError) as exc:
            failures += 1
            log.error("%s: %s", t.id, exc)
            continue
        reading = replace(reading, fx_rate=fx.rate(reading.currency))
        readings.append(reading)
        new_alerts = evaluate(t, reading, prior)
        alerts.extend(new_alerts)
        price = f"{reading.price:,.0f} {reading.currency}" if reading.price else "unavailable"
        log.info(
            "%s: %s (%s)%s",
            t.id,
            price,
            reading.plan_name or reading.note,
            f" · {len(new_alerts)} alert(s)" if new_alerts else "",
        )

    if args.dry_run:
        for r in readings:
            print(json.dumps(r.to_record(), indent=1, ensure_ascii=False))
        for a in alerts:
            print("ALERT", a.message)
        return 1 if failures else 0

    append_readings(args.history, readings)
    _rebuild_site(args, wl)
    write_alerts(args.alerts, alerts)
    if alerts and send_ntfy(alerts):
        log.info("sent %d alert(s) via ntfy", len(alerts))
    log.info("wrote %d reading(s); %d failure(s)", len(readings), failures)
    return 1 if failures else 0


def cmd_scan(args: argparse.Namespace) -> int:
    wl = _read_watchlist(args.watchlist)
    scans = [s for s in wl.scans if not args.only or s.id in args.only]
    if not scans:
        log.error("no scans to run")
        return 2
    providers: dict[str, object] = {}
    fx = Converter()
    results: list[ScanResult] = []
    for s in scans:
        try:
            provider = providers.setdefault(s.provider, get_provider(s.provider))
        except ProviderError as exc:
            log.error("%s: %s", s.id, exc)
            continue
        result = run_scan(s, provider, fx)  # type: ignore[arg-type]
        results.append(result)
        priced = [p for p in result.points if p.price is not None]
        if priced:
            best = min(priced, key=lambda p: p.price or 0)
            log.info(
                "%s: %d/%d dates priced, cheapest %s at %s %s (%d failure(s))",
                s.id, len(priced), len(s.check_in_dates()), best.check_in,
                f"{best.price:,.0f}", result.currency, result.failures,
            )  # fmt: skip
        else:
            log.warning("%s: no priced dates (%d failure(s))", s.id, result.failures)

    if args.dry_run:
        for r in results:
            print(json.dumps(r.to_record(), indent=1, ensure_ascii=False))
        return 0

    append_scan_results(args.scans, results)
    _rebuild_site(args, wl)
    total_failures = sum(r.failures for r in results)
    log.info("wrote %d scan result(s); %d failed date(s)", len(results), total_failures)
    # Partial failures are tolerated; a scan with no data at all is a job failure.
    return 1 if any(not r.points for r in results) else 0


def cmd_show(args: argparse.Namespace) -> int:
    wl = _read_watchlist(args.watchlist)
    data = build_site_data(wl, load_history(args.history), load_scans(args.scans))
    for t in data["targets"]:
        s = t["stats"]
        if s.get("current") is None:
            print(f"{t['name']}: no readings yet")
            continue
        print(
            f"{t['name']}\n  current {s['current']:,.0f} {t['currency']}  lowest {s['lowest']:,.0f}"
            f"  highest {s['highest']:,.0f}  readings {s['readings']}  plan: {s['current_plan']}"
        )
    for sc in data["scans"]:
        last = sc["history"][-1] if sc["history"] else None
        if not last or last["min"] is None:
            print(f"{sc['name']} (scan): no results yet")
            continue
        print(
            f"{sc['name']} (scan, {_nights(sc['nights'])})\n  cheapest check-in "
            f"{last['min_date']} at {last['min']:,.0f} {sc['currency']}  "
            f"median {last['median']:,.0f}  "
            f"{last['available']} dates available  runs {len(sc['history'])}"
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hotelwatch", description=__doc__)
    p.add_argument("--version", action="version", version=__version__)
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--watchlist", type=Path, default=DEFAULTS["watchlist"])
    p.add_argument("--history", type=Path, default=DEFAULTS["history"])
    p.add_argument("--scans", type=Path, default=DEFAULTS["scans"])
    p.add_argument("--site", type=Path, default=DEFAULTS["site"])
    sub = p.add_subparsers(dest="command", required=True)

    run = sub.add_parser(
        "run", help="fetch spot prices, append history, rebuild site data, evaluate alerts"
    )
    run.add_argument("--alerts", type=Path, default=DEFAULTS["alerts"])
    run.add_argument("--dry-run", action="store_true", help="fetch and print, write nothing")
    run.set_defaults(func=cmd_run)

    scan = sub.add_parser("scan", help="price every check-in date in each scan window")
    scan.add_argument("--only", nargs="*", help="scan ids to run (default: all)")
    scan.add_argument("--dry-run", action="store_true", help="fetch and print, write nothing")
    scan.set_defaults(func=cmd_scan)

    sub.add_parser("validate", help="check watchlist.json").set_defaults(func=cmd_validate)
    sub.add_parser("show", help="print current stats").set_defaults(func=cmd_show)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )
    try:
        return args.func(args)
    except WatchlistError as exc:
        log.error("watchlist: %s", exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
