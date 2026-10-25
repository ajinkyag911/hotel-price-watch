"""Command line: `hotelwatch run | validate | show`."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from hotelwatch import __version__
from hotelwatch.alerts import evaluate, send_ntfy, write_alerts
from hotelwatch.models import Reading, WatchlistError, load_watchlist
from hotelwatch.providers import ProviderError, get_provider
from hotelwatch.storage import append_readings, build_site_data, load_history, write_json

log = logging.getLogger("hotelwatch")

DEFAULTS = {
    "watchlist": Path("watchlist.json"),
    "history": Path("data/history.jsonl"),
    "site": Path("docs/data/history.json"),
    "alerts": Path("data/alerts.json"),
}


def _read_watchlist(path: Path):
    try:
        return load_watchlist(json.loads(path.read_text()))
    except FileNotFoundError:
        raise WatchlistError(f"{path} not found") from None
    except json.JSONDecodeError as exc:
        raise WatchlistError(f"{path} is not valid JSON: {exc}") from exc


def cmd_validate(args: argparse.Namespace) -> int:
    targets = _read_watchlist(args.watchlist)
    for t in targets:
        get_provider(t.provider)
        print(f"ok  {t.id}: {t.room} · {t.check_in} → {t.check_out} ({t.nights} nights)")
    print(f"{len(targets)} target(s) valid")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    targets = _read_watchlist(args.watchlist)
    history = load_history(args.history)
    providers = {}
    readings: list[Reading] = []
    alerts = []
    failures = 0

    for t in targets:
        prior = [r for r in history if r["target_id"] == t.id]
        try:
            provider = providers.setdefault(t.provider, get_provider(t.provider))
            reading = provider.fetch(t)
        except (ProviderError, RuntimeError) as exc:
            failures += 1
            log.error("%s: %s", t.id, exc)
            continue
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
    write_json(args.site, build_site_data(targets, load_history(args.history)))
    write_alerts(args.alerts, alerts)
    if alerts and send_ntfy(alerts):
        log.info("sent %d alert(s) via ntfy", len(alerts))
    log.info("wrote %d reading(s); %d failure(s)", len(readings), failures)
    return 1 if failures else 0


def cmd_show(args: argparse.Namespace) -> int:
    targets = _read_watchlist(args.watchlist)
    data = build_site_data(targets, load_history(args.history))
    for t in data["targets"]:
        s = t["stats"]
        if s.get("current") is None:
            print(f"{t['name']}: no readings yet")
            continue
        print(
            f"{t['name']}\n  current {s['current']:,.0f}  lowest {s['lowest']:,.0f}  "
            f"highest {s['highest']:,.0f}  readings {s['readings']}  plan: {s['current_plan']}"
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hotelwatch", description=__doc__)
    p.add_argument("--version", action="version", version=__version__)
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--watchlist", type=Path, default=DEFAULTS["watchlist"])
    p.add_argument("--history", type=Path, default=DEFAULTS["history"])
    sub = p.add_subparsers(dest="command", required=True)

    run = sub.add_parser(
        "run", help="fetch prices, append history, rebuild site data, evaluate alerts"
    )
    run.add_argument("--site", type=Path, default=DEFAULTS["site"])
    run.add_argument("--alerts", type=Path, default=DEFAULTS["alerts"])
    run.add_argument("--dry-run", action="store_true", help="fetch and print, write nothing")
    run.set_defaults(func=cmd_run)

    sub.add_parser("validate", help="check watchlist.json").set_defaults(func=cmd_validate)
    sub.add_parser("show", help="print current stats from history").set_defaults(func=cmd_show)
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
