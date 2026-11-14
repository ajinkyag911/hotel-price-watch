"""Command line: `hotelwatch run | scan | build | validate | show`."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from hotelwatch import __version__, finder
from hotelwatch.alerts import evaluate, send_ntfy, write_alerts
from hotelwatch.fx import Converter
from hotelwatch.http import BlockedError, HttpError
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


def _finder_paths(args: argparse.Namespace) -> tuple[Path, Path, Path]:
    """finder.json sits next to watchlist.json, its data next to history, its site file next
    to the main site file, unless overridden."""
    config = args.finder_config or args.watchlist.parent / "finder.json"
    data_dir = args.finder_dir or args.history.parent / "finder"
    site = args.finder_site or args.site.parent / "finder.json"
    return config, data_dir, site


def _rebuild_finder_site(args: argparse.Namespace) -> bool:
    config, data_dir, site = _finder_paths(args)
    if not config.exists():
        return False
    finder.write_finder_site(finder.read_finder_config(config), data_dir, site)
    return True


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
    config, _, _ = _finder_paths(args)
    if config.exists():
        cfg = finder.read_finder_config(config)
        print(
            f"ok  finder: {', '.join(loc.name for loc in cfg.locations)} · "
            f"{_nights(cfg.nights)} · check-ins {cfg.from_date} → {cfg.to_date}"
        )
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    wl = _read_watchlist(args.watchlist)
    history = load_history(args.history)
    providers: dict[str, object] = {}
    fx = Converter()
    readings: list[Reading] = []
    alerts = []
    failures = 0
    blocked = 0

    for t in wl.targets:
        prior = [r for r in history if r["target_id"] == t.id]
        try:
            provider = providers.setdefault(t.provider, get_provider(t.provider))
            reading = provider.fetch(t)  # type: ignore[attr-defined]
        except BlockedError as exc:
            # The site's bot check refused us even after retries. Not a bug on our side, so it
            # doesn't fail the run; the next run retries and any fallback target keeps data flowing.
            blocked += 1
            log.warning("%s: blocked by the site's bot check, will retry next run (%s)", t.id, exc)
            continue
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
    log.info("wrote %d reading(s); %d failure(s); %d blocked", len(readings), failures, blocked)
    if blocked:
        print(f"::warning::{blocked} target(s) blocked by a site bot check; will retry next run")
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

    # A scan the bot check blocked outright has nothing to say; storing it would make the page
    # read "nothing available" instead of keeping the last real prices.
    blocked_out = [r for r in results if not r.points and r.blocked]
    for r in blocked_out:
        log.warning("%s: blocked by the site's bot check; keeping the previous results", r.scan_id)
        print(f"::warning::{r.scan_id} blocked by a site bot check; will retry next run")
    kept = [r for r in results if r not in blocked_out]
    append_scan_results(args.scans, kept)
    _rebuild_site(args, wl)
    total_failures = sum(r.failures for r in kept)
    log.info("wrote %d scan result(s); %d failed date(s)", len(kept), total_failures)
    # Partial failures are tolerated; a scan with no data at all (and not blocked) is a job failure.
    return 1 if any(not r.points for r in kept) else 0


def cmd_build(args: argparse.Namespace) -> int:
    _rebuild_site(args, _read_watchlist(args.watchlist))
    print(f"wrote {args.site}")
    if _rebuild_finder_site(args):
        print(f"wrote {_finder_paths(args)[2]}")
    return 0


def cmd_find_fetch(args: argparse.Namespace) -> int:
    config, data_dir, _ = _finder_paths(args)
    cfg = finder.read_finder_config(config)
    loc = cfg.location(args.location)
    now = datetime.now(UTC)
    catalog = finder._read_json(finder.catalog_path(data_dir, loc.id), None)
    if args.max_hotels and catalog:
        catalog = {**catalog, "hotels": catalog["hotels"][: args.max_hotels]}
    if not finder.catalog_is_fresh(catalog, cfg.catalog_max_age_days, now):
        try:
            catalog = finder.build_catalog(
                cfg, loc, fetch=finder.fetch_json, max_hotels=args.max_hotels
            )
        except (HttpError, OSError) as exc:
            if not catalog:
                log.error("%s: could not list hotels: %s", loc.id, exc)
                return 1
            log.warning("%s: catalog refresh failed, using the stored one: %s", loc.id, exc)
    assert catalog is not None
    obs = finder.fetch_location(
        cfg, loc, catalog, today=now.date(), fetch=finder.fetch_json, stride=args.stride,
        workers=args.workers, spacing=args.spacing,
    )  # fmt: skip
    if args.dry_run:
        print(json.dumps(obs, indent=1, ensure_ascii=False)[:5000])
    else:
        finder._write_json(args.out, obs)
        log.info("wrote %s", args.out)
    # A run where every request failed is a job failure; partial failures are tolerated.
    return 1 if obs["requests"] and obs["failures"] == obs["requests"] else 0


def cmd_find_merge(args: argparse.Namespace) -> int:
    config, data_dir, site = _finder_paths(args)
    cfg = finder.read_finder_config(config)
    today = datetime.now(UTC).date()
    total = 0
    for path in args.files:
        try:
            obs = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            log.error("%s: %s", path, exc)
            continue
        cfg.location(obs["location"])  # reject observations for unknown places
        n = finder.merge_observations(data_dir, obs, today)
        log.info("%s: merged %d observation(s) from %s", obs["location"], n, path)
        total += n
    finder.write_finder_site(cfg, data_dir, site)
    log.info("wrote %s", site)
    return 0 if total or not args.files else 1


def cmd_track(args: argparse.Namespace) -> int:
    config, _, _ = _finder_paths(args)
    cfg = finder.read_finder_config(config)
    event = json.loads(args.event.read_text())
    try:
        req = finder.parse_track_request(event, cfg)
        added, scan_id = finder.add_tracked_hotel(args.watchlist, req, cfg)
        _read_watchlist(args.watchlist)  # the result must still validate
    except (finder.TrackError, WatchlistError) as exc:
        message = f"Could not add this hotel: {exc}"
        rc = 1
    else:
        if added:
            message = (
                f"Now tracking **{req['name']}** ({req['location'].name}) as `{scan_id}`: "
                f"every {cfg.nights}-night check-in from {cfg.from_date} to {cfg.to_date}, "
                "priced daily from Booking.com, Agoda and Trip.com."
            )
        else:
            message = f"**{req['name']}** is already tracked as `{scan_id}`."
        rc = 0
    print(message)
    if args.message_out:
        args.message_out.write_text(message + "\n")
    if args.result_out:
        args.result_out.write_text(json.dumps({"ok": rc == 0, "added": rc == 0 and added}))
    return rc


def cmd_show(args: argparse.Namespace) -> int:
    wl = _read_watchlist(args.watchlist)
    data = build_site_data(wl, load_history(args.history), load_scans(args.scans))
    for t in data["targets"]:
        s = t["stats"]
        if s.get("current") is None:
            state = "unavailable" if t["readings"] else "no readings yet"
            print(f"{t['name']}: {state}")
            continue
        print(
            f"{t['name']}\n  current {s['current']:,.0f} INR  lowest {s['lowest']:,.0f}"
            f"  highest {s['highest']:,.0f}  readings {s['readings']}  plan: {s['current_plan']}"
        )
    for sc in data["scans"]:
        last = sc["history"][-1] if sc["history"] else None
        if not last or last["min"] is None:
            print(f"{sc['name']} (scan): no results yet")
            continue
        print(
            f"{sc['name']} (scan, {_nights(sc['nights'])})\n  cheapest check-in "
            f"{last['min_date']} at {last['min']:,.0f} INR  "
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
    p.add_argument("--finder-config", type=Path, help="default: finder.json beside the watchlist")
    p.add_argument("--finder-dir", type=Path, help="default: finder/ beside the history file")
    p.add_argument("--finder-site", type=Path, help="default: finder.json beside the site file")
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

    sub.add_parser(
        "build", help="rebuild site data from the stored history and scans"
    ).set_defaults(func=cmd_build)
    sub.add_parser("validate", help="check watchlist.json").set_defaults(func=cmd_validate)

    find = sub.add_parser("find", help="deal finder: discover and price hotels in set places")
    find_sub = find.add_subparsers(dest="find_command", required=True)
    fetch = find_sub.add_parser("fetch", help="price one location's hotels for today's dates")
    fetch.add_argument("--location", required=True)
    fetch.add_argument("--out", type=Path, default=Path("obs.json"))
    fetch.add_argument("--max-hotels", type=int, help="cap the catalog (default: config)")
    fetch.add_argument("--stride", type=int, help="price every Nth check-in (default: config)")
    fetch.add_argument("--workers", type=int, default=2)
    fetch.add_argument("--spacing", type=float, default=0.5, help="seconds between requests")
    fetch.add_argument("--dry-run", action="store_true", help="print instead of writing --out")
    fetch.set_defaults(func=cmd_find_fetch)
    merge = find_sub.add_parser("merge", help="fold observation files into the stored grid")
    merge.add_argument("files", nargs="*", type=Path)
    merge.set_defaults(func=cmd_find_merge)

    track = sub.add_parser("track", help="add a hotel from a 'Track:' GitHub issue event")
    track.add_argument("--event", type=Path, required=True, help="path to the event JSON")
    track.add_argument("--message-out", type=Path, help="write the reply comment here")
    track.add_argument("--result-out", type=Path, help="write {ok, added} JSON here")
    track.set_defaults(func=cmd_track)
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
    except finder.FinderError as exc:
        log.error("finder: %s", exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
