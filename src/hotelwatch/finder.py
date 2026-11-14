"""Deal finder: discover well-rated hotels in a few places and surface the best value stays.

Pipeline, one location at a time (each step is a CLI subcommand, see ``cli.py``):

1. **Catalog.** Xotelo's ``/api/list`` (TripAdvisor's listings, by best value and by popularity)
   gives the candidates: hotels and resorts that clear the rating and review bar, ranked by a
   Bayesian rating so a 4.6 with 3,000 reviews beats a 5.0 with 12. Each gets a price estimate
   (observed, or a one-quote probe) and only hotels inside the budget band are kept, with a
   capped number in the stretch band. Refreshed when older than ``catalog_max_age_days``.
2. **Fetch.** Price every catalog hotel for a rotating slice of the check-in window: dates whose
   ordinal is congruent to today's modulo ``date_stride``, so a week of daily runs covers every
   date. Xotelo's ``/api/rates`` returns each travel site's nightly price for the cheapest room;
   we store stay totals in INR. Written to an observations file (one per location, so locations
   can run in parallel jobs).
3. **Merge.** Fold observations into ``data/finder/grid-<loc>.json`` (hotel → check-in → latest
   price plus lowest / highest / first / previous seen), append one summary row per hotel to
   ``data/finder/history.jsonl``, and rebuild ``docs/data/finder.json`` for the page.

Scores are deliberately simple and explained in ``reasons`` so the page can say *why* a stay is
a deal: price against similar-rated hotels nearby, rating, the drop against the hotel's own
history, and how much the rating can be trusted (review count).
"""

from __future__ import annotations

import json
import logging
import math
import re
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from statistics import median
from typing import Any

from hotelwatch.http import FetchJson, HttpError, fetch_json

log = logging.getLogger(__name__)

LIST_URL = "https://data.xotelo.com/api/list"
RATES_URL = "https://data.xotelo.com/api/rates"
KEY_RE = re.compile(r"^g\d+-d\d+$")
PRIOR_RATING = 4.0
PRIOR_REVIEWS = 200
PEER_BAND = 0.25
PEER_CLASS = 2.0  # peers cost between half and double this hotel's usual nightly price
MIN_PEERS = 2
SUPER_SCORE = 65
STRETCH_SCORE = 75  # a stretch-band hotel must be this good to be called a super value
HISTORY_POINTS = 90
COUNTRY_CODES = {"india": "IN", "thailand": "TH", "malaysia": "MY"}


class FinderError(ValueError):
    """finder.json is malformed or a location is unknown."""


# -- config ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Location:
    id: str
    name: str
    country: str
    location_key: str

    @property
    def country_code(self) -> str:
        return COUNTRY_CODES.get(self.country.casefold(), "IN")


@dataclass(frozen=True)
class FinderConfig:
    nights: int
    adults: int
    from_date: date
    to_date: date
    min_rating: float
    min_reviews: int
    types: tuple[str, ...]
    max_nightly_inr: float
    hotels_per_location: int
    date_stride: int
    catalog_max_age_days: int
    locations: tuple[Location, ...]
    min_nightly_inr: float = 2000
    stretch_nightly_inr: float = 20000
    candidates_per_location: int = 150
    max_stretch_hotels: int = 8
    # Slots held back for stretch-band hotels so a strong ₹15–20k deal can surface even where
    # in-budget hotels alone would fill the list.
    reserved_stretch_hotels: int = 0
    probe_max_age_days: int = 30
    max_probes_per_run: int = 150

    def band(self, nightly: float | None) -> str | None:
        """Where a nightly price sits against the budget: too_cheap, in_budget, stretch,
        too_pricey, or None when unknown."""
        if nightly is None:
            return None
        if nightly < self.min_nightly_inr:
            return "too_cheap"
        if nightly <= self.max_nightly_inr:
            return "in_budget"
        if nightly <= self.stretch_nightly_inr:
            return "stretch"
        return "too_pricey"

    def location(self, loc_id: str) -> Location:
        for loc in self.locations:
            if loc.id == loc_id:
                return loc
        known = ", ".join(loc.id for loc in self.locations)
        raise FinderError(f"unknown location {loc_id!r}; known: {known}")

    def public(self) -> dict[str, Any]:
        return {
            "nights": self.nights,
            "adults": self.adults,
            "from": self.from_date.isoformat(),
            "to": self.to_date.isoformat(),
            "max_nightly_inr": self.max_nightly_inr,
            "min_nightly_inr": self.min_nightly_inr,
            "stretch_nightly_inr": self.stretch_nightly_inr,
            "min_rating": self.min_rating,
            "min_reviews": self.min_reviews,
        }


def load_finder_config(raw: dict[str, Any]) -> FinderConfig:
    try:
        locations = tuple(
            Location(
                id=str(loc["id"]),
                name=str(loc["name"]),
                country=str(loc.get("country", "")),
                location_key=str(loc["location_key"]),
            )
            for loc in raw["locations"]
        )
        cfg = FinderConfig(
            nights=int(raw.get("nights", 4)),
            adults=int(raw.get("adults", 2)),
            from_date=date.fromisoformat(raw["from"]),
            to_date=date.fromisoformat(raw["to"]),
            min_rating=float(raw.get("min_rating", 4.3)),
            min_reviews=int(raw.get("min_reviews", 200)),
            types=tuple(str(t) for t in raw.get("types", ["Hotel", "Resort"])),
            max_nightly_inr=float(raw.get("max_nightly_inr", 15000)),
            hotels_per_location=int(raw.get("hotels_per_location", 30)),
            date_stride=int(raw.get("date_stride", 7)),
            catalog_max_age_days=int(raw.get("catalog_max_age_days", 7)),
            locations=locations,
            min_nightly_inr=float(raw.get("min_nightly_inr", 2000)),
            stretch_nightly_inr=float(raw.get("stretch_nightly_inr", 20000)),
            candidates_per_location=int(raw.get("candidates_per_location", 150)),
            max_stretch_hotels=int(raw.get("max_stretch_hotels", 8)),
            reserved_stretch_hotels=int(raw.get("reserved_stretch_hotels", 0)),
            probe_max_age_days=int(raw.get("probe_max_age_days", 30)),
            max_probes_per_run=int(raw.get("max_probes_per_run", 150)),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise FinderError(f"finder.json: {exc}") from exc
    if cfg.nights < 1 or cfg.adults < 1:
        raise FinderError("finder.json: nights and adults must be at least 1")
    if cfg.to_date < cfg.from_date:
        raise FinderError("finder.json: 'to' must not be before 'from'")
    if cfg.date_stride < 1 or cfg.hotels_per_location < 1:
        raise FinderError("finder.json: date_stride and hotels_per_location must be positive")
    if not 0 <= cfg.min_nightly_inr < cfg.max_nightly_inr <= cfg.stretch_nightly_inr:
        raise FinderError(
            "finder.json: need 0 <= min_nightly_inr < max_nightly_inr <= stretch_nightly_inr"
        )
    if not 0 <= cfg.reserved_stretch_hotels <= cfg.max_stretch_hotels:
        raise FinderError(
            "finder.json: reserved_stretch_hotels must be between 0 and max_stretch_hotels"
        )
    if cfg.candidates_per_location < 1 or cfg.max_stretch_hotels < 0:
        raise FinderError("finder.json: candidates_per_location must be positive")
    if not locations:
        raise FinderError("finder.json: at least one location is required")
    ids = [loc.id for loc in locations]
    if len(set(ids)) != len(ids):
        raise FinderError("finder.json: duplicate location ids")
    return cfg


def read_finder_config(path: Path) -> FinderConfig:
    try:
        return load_finder_config(json.loads(path.read_text()))
    except FileNotFoundError:
        raise FinderError(f"{path} not found") from None
    except json.JSONDecodeError as exc:
        raise FinderError(f"{path} is not valid JSON: {exc}") from exc


# -- helpers --------------------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def _write_json(path: Path, data: Any, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if pretty:
        text = json.dumps(data, ensure_ascii=False, indent=1)
    else:
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text + "\n")


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def bayes_rating(rating: float, reviews: int) -> float:
    return (rating * reviews + PRIOR_RATING * PRIOR_REVIEWS) / (reviews + PRIOR_REVIEWS)


class Pacer:
    """Spaces requests globally across worker threads."""

    def __init__(self, spacing: float, sleep=time.sleep) -> None:
        self._spacing = spacing
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next)
            self._next = slot + self._spacing
        if slot > now:
            self._sleep(slot - now)


# -- catalog --------------------------------------------------------------------------------------


def _hotel_from_listing(item: dict[str, Any]) -> dict[str, Any] | None:
    key = str(item.get("key") or "")
    if not KEY_RE.match(key):
        return None
    summary = item.get("review_summary") or {}
    geo = item.get("geo") or {}
    try:
        rating = float(summary.get("rating") or 0)
        reviews = int(summary.get("count") or 0)
    except (TypeError, ValueError):
        return None
    return {
        "key": key,
        "name": str(item.get("name") or "").strip(),
        "type": str(item.get("accommodation_type") or ""),
        "rating": rating,
        "reviews": reviews,
        "url": str(item.get("url") or ""),
        "image": item.get("image") or None,
        "lat": geo.get("latitude"),
        "lng": geo.get("longitude"),
        "labels": [str(x) for x in item.get("merchandising_labels") or []],
    }


def list_candidates(
    cfg: FinderConfig,
    loc: Location,
    fetch: FetchJson = fetch_json,
    page_size: int = 100,
    max_pages: int = 10,
    sorts: tuple[str, ...] = ("best_value", "popularity"),
) -> tuple[list[dict[str, Any]], int]:
    """Hotels clearing the quality bar, best Bayesian rating first, up to
    ``candidates_per_location``. Returns (candidates, listings seen)."""
    seen: dict[str, dict[str, Any]] = {}
    types = {t.casefold() for t in cfg.types}

    def passing() -> list[dict[str, Any]]:
        return [
            h
            for h in seen.values()
            if h["rating"] >= cfg.min_rating
            and h["reviews"] >= cfg.min_reviews
            and h["type"].casefold() in types
        ]

    # Two orderings reach different hotels: "best_value" favours deals, "popularity" the
    # well-reviewed places small islands like Langkawi need to fill a shortlist. Page each until
    # the pool is big enough or the listing runs out.
    for sort in sorts:
        for page in range(max_pages):
            query = urllib.parse.urlencode(
                {
                    "location_key": loc.location_key,
                    "limit": page_size,
                    "offset": page * page_size,
                    "sort": sort,
                }
            )
            data = fetch(f"{LIST_URL}?{query}")
            if not isinstance(data, dict) or data.get("error"):
                err = data.get("error") if isinstance(data, dict) else data
                raise HttpError(f"Xotelo list error for {loc.id}: {err}")
            result = data.get("result") or {}
            items = result.get("list") or []
            for item in items:
                hotel = _hotel_from_listing(item)
                if hotel and hotel["key"] not in seen:
                    seen[hotel["key"]] = hotel
            total = int(result.get("total_count") or 0)
            if len(items) < page_size or (page + 1) * page_size >= total:
                break
            if len(passing()) >= cfg.candidates_per_location * 2:
                break  # enough to choose from; the second ordering still adds variety
    pool = passing()
    pool.sort(key=lambda h: (-bayes_rating(h["rating"], h["reviews"]), h["name"]))
    return pool[: cfg.candidates_per_location], len(seen)


def probe_dates(cfg: FinderConfig, today: date) -> list[date]:
    """A representative mid-week check-in three or more weeks out, plus a fallback a month later
    for hotels with nothing on the first date."""
    start = max(cfg.from_date, today + timedelta(days=21))
    first = start + timedelta(days=(1 - start.weekday()) % 7)  # Tuesday
    out = [d for d in (first, first + timedelta(days=28)) if d <= cfg.to_date]
    if not out and start <= cfg.to_date:
        out = [start]
    return out


def _grid_usual_nightly(cells: dict[str, Any], nights: int, today: date) -> float | None:
    priced = [c["p"] for d, c in cells.items() if d >= today.isoformat() and c.get("p")]
    if len(priced) < 3:
        return None
    return round(median(priced) / nights)


def build_catalog(
    cfg: FinderConfig,
    loc: Location,
    fetch: FetchJson = fetch_json,
    *,
    previous: dict[str, Any] | None = None,
    grid: dict[str, Any] | None = None,
    today: date | None = None,
    max_hotels: int | None = None,
    workers: int = 2,
    spacing: float = 0.5,
    sleep=time.sleep,
) -> dict[str, Any]:
    """Pick the hotels to watch in one place: quality first, then budget.

    Every candidate gets a price estimate: its observed usual nightly price when the grid has
    three or more priced dates, else a probe (one quote on a representative date, kept for
    ``probe_max_age_days``). Hotels priced between ``min_nightly_inr`` and
    ``stretch_nightly_inr`` are kept, best Bayesian rating first, with at most
    ``max_stretch_hotels`` above ``max_nightly_inr``. Hotels that never return a price are
    skipped. Re-running weekly swaps out hotels whose prices drift out of the band.
    """
    today = today or datetime.now(UTC).date()
    now = datetime.now(UTC)
    limit = max_hotels or cfg.hotels_per_location
    candidates, listed = list_candidates(cfg, loc, fetch)

    old_probes: dict[str, dict[str, Any]] = {}
    for h in (previous or {}).get("candidates") or (previous or {}).get("hotels") or []:
        if h.get("probed_at"):
            old_probes[h["key"]] = h
    grid_cells = (grid or {}).get("hotels") or {}

    def fresh_probe(key: str) -> dict[str, Any] | None:
        old = old_probes.get(key)
        if not old or old.get("probe_nightly") is None:
            return None  # never priced last time: worth asking again
        try:
            age = now - datetime.fromisoformat(old["probed_at"])
        except (KeyError, ValueError):
            return None
        return old if age < timedelta(days=cfg.probe_max_age_days) else None

    to_probe: list[dict[str, Any]] = []
    for h in candidates:
        observed = _grid_usual_nightly(grid_cells.get(h["key"], {}), cfg.nights, today)
        old = fresh_probe(h["key"])
        if old:
            h["probe_nightly"], h["probed_at"] = old["probe_nightly"], old["probed_at"]
        if observed is not None:
            h["estimate_nightly"], h["estimate_source"] = observed, "observed"
        elif old:
            h["estimate_nightly"], h["estimate_source"] = old["probe_nightly"], "probe"
        else:
            to_probe.append(h)
    skipped_probes = to_probe[cfg.max_probes_per_run :]
    to_probe = to_probe[: cfg.max_probes_per_run]

    dates = probe_dates(cfg, today)
    pacer = Pacer(spacing, sleep)

    def probe(h: dict[str, Any]) -> None:
        h["probe_nightly"] = None
        for d in dates:
            try:
                obs = price_one(fetch, h["key"], d, cfg, pacer)
            except (HttpError, OSError, ValueError) as exc:
                log.warning("%s probe %s %s: %s", loc.id, h["key"], d, exc)
                continue
            if obs["p"] is not None:
                h["probe_nightly"] = round(obs["p"] / cfg.nights)
                break
        h["probed_at"] = now_iso()
        if h["probe_nightly"] is not None:
            h["estimate_nightly"], h["estimate_source"] = h["probe_nightly"], "probe"

    if to_probe and dates:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            list(pool.map(probe, to_probe))

    bands: dict[str | None, list[dict[str, Any]]] = {}
    for h in candidates:
        h["band"] = cfg.band(h.get("estimate_nightly"))
        bands.setdefault(h["band"], []).append(h)
    in_budget = bands.get("in_budget", [])
    stretch = bands.get("stretch", [])
    # In-budget hotels fill the list first, apart from reserved_stretch_hotels slots held for
    # the best stretch picks; stretch then takes any room left, never more than
    # max_stretch_hotels. Places with few in-budget hotels get a shorter list.
    reserved = min(cfg.reserved_stretch_hotels, len(stretch))
    chosen = in_budget[: limit - reserved]
    chosen += stretch[: min(cfg.max_stretch_hotels, limit - len(chosen))]
    chosen.sort(key=lambda h: (-bayes_rating(h["rating"], h["reviews"]), h["name"]))
    log.info(
        "%s: %d listed, %d candidates, %d probed (%d deferred), %d in budget, %d stretch, "
        "dropped %d too cheap, %d too pricey, %d never priced; keeping %d (%d stretch)",
        loc.id, listed, len(candidates), len(to_probe), len(skipped_probes), len(in_budget),
        len(stretch), len(bands.get("too_cheap", [])), len(bands.get("too_pricey", [])),
        len(bands.get(None, [])), len(chosen), sum(1 for h in chosen if h["band"] == "stretch"),
    )  # fmt: skip
    return {
        "location": loc.id,
        "fetched_at": now_iso(),
        "stats": {
            "listed": listed,
            "candidates": len(candidates),
            "probed": len(to_probe),
            "in_budget": len(in_budget),
            "stretch": len(stretch),
            "too_cheap": len(bands.get("too_cheap", [])),
            "too_pricey": len(bands.get("too_pricey", [])),
            "never_priced": len(bands.get(None, [])),
        },
        "hotels": chosen,
        "candidates": candidates,
    }


def catalog_is_fresh(catalog: dict[str, Any] | None, max_age_days: int, now: datetime) -> bool:
    if not catalog or not catalog.get("hotels"):
        return False
    try:
        fetched = datetime.fromisoformat(catalog["fetched_at"])
    except (KeyError, ValueError):
        return False
    return now - fetched < timedelta(days=max_age_days)


# -- fetching prices -----------------------------------------------------------------------------


def check_in_dates(cfg: FinderConfig, today: date, stride: int | None = None) -> list[date]:
    stride = stride or cfg.date_stride
    start = max(cfg.from_date, today + timedelta(days=1))
    out = []
    d = start
    while d <= cfg.to_date:
        if d.toordinal() % stride == today.toordinal() % stride:
            out.append(d)
        d += timedelta(days=1)
    return out


def parse_site_totals(data: Any, nights: int) -> dict[str, float]:
    if not isinstance(data, dict):
        raise HttpError("unexpected Xotelo rates response")
    if data.get("error"):
        err = data["error"]
        raise HttpError(f"Xotelo error: {err.get('message') if isinstance(err, dict) else err}")
    sites: dict[str, float] = {}
    for r in (data.get("result") or {}).get("rates") or []:
        try:
            nightly = float(r["rate"])
        except (KeyError, TypeError, ValueError):
            continue
        if nightly > 0:
            name = str(r.get("name") or r.get("code") or "?")
            sites[name] = round(nightly * nights)
    return sites


def price_one(
    fetch: FetchJson, key: str, check_in: date, cfg: FinderConfig, pacer: Pacer | None
) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "hotel_key": key,
            "chk_in": check_in.isoformat(),
            "chk_out": (check_in + timedelta(days=cfg.nights)).isoformat(),
            "currency": "INR",
            "adults": cfg.adults,
        }
    )
    if pacer:
        pacer.wait()
    sites = parse_site_totals(fetch(f"{RATES_URL}?{query}"), cfg.nights)
    best = min(sites.items(), key=lambda kv: kv[1]) if sites else None
    return {
        "key": key,
        "d": check_in.isoformat(),
        "p": best[1] if best else None,
        "site": best[0] if best else None,
        "sites": dict(sorted(sites.items(), key=lambda kv: kv[1])),
        "seen": now_iso(),
    }


def fetch_location(
    cfg: FinderConfig,
    loc: Location,
    catalog: dict[str, Any],
    *,
    today: date,
    fetch: FetchJson = fetch_json,
    stride: int | None = None,
    workers: int = 2,
    spacing: float = 0.5,
    sleep=time.sleep,
) -> dict[str, Any]:
    dates = check_in_dates(cfg, today, stride)
    jobs = [(h["key"], d) for h in catalog["hotels"] for d in dates]
    pacer = Pacer(spacing, sleep)
    observations: list[dict[str, Any]] = []
    failures = 0
    lock = threading.Lock()

    def work(job: tuple[str, date]) -> None:
        nonlocal failures
        key, d = job
        try:
            obs = price_one(fetch, key, d, cfg, pacer)
        except (HttpError, OSError, ValueError) as exc:
            with lock:
                failures += 1
            log.warning("%s %s %s: %s", loc.id, key, d, exc)
            return
        with lock:
            observations.append(obs)

    log.info(
        "%s: pricing %d hotels x %d dates = %d requests",
        loc.id,
        len(catalog["hotels"]),
        len(dates),
        len(jobs),
    )
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        list(pool.map(work, jobs))
    observations.sort(key=lambda o: (o["key"], o["d"]))
    priced = sum(1 for o in observations if o["p"] is not None)
    log.info(
        "%s: %d priced, %d unavailable, %d failed",
        loc.id,
        priced,
        len(observations) - priced,
        failures,
    )
    return {
        "location": loc.id,
        "run_at": now_iso(),
        "nights": cfg.nights,
        "adults": cfg.adults,
        "dates": [d.isoformat() for d in dates],
        "requests": len(jobs),
        "failures": failures,
        "catalog": catalog,
        "observations": observations,
    }


# -- merging --------------------------------------------------------------------------------------


def merge_cell(cell: dict[str, Any] | None, obs: dict[str, Any]) -> dict[str, Any]:
    p, seen = obs["p"], obs["seen"]
    if cell is None:
        cell = {
            "p": None,
            "site": None,
            "sites": {},
            "seen": None,
            "lo": None,
            "lo_at": None,
            "hi": None,
            "first": None,
            "first_at": None,
            "prev": None,
            "prev_at": None,
            "n": 0,
        }
    else:
        cell = dict(cell)
        if cell.get("seen") and seen < cell["seen"]:
            return cell  # an older observation never overwrites a newer one
        if cell.get("p") is not None:
            cell["prev"], cell["prev_at"] = cell["p"], cell["seen"]
    cell["p"], cell["site"], cell["sites"], cell["seen"] = p, obs["site"], obs["sites"], seen
    if p is not None:
        cell["n"] = int(cell.get("n") or 0) + 1
        if cell.get("first") is None:
            cell["first"], cell["first_at"] = p, seen
        if cell.get("lo") is None or p < cell["lo"]:
            cell["lo"], cell["lo_at"] = p, seen
        if cell.get("hi") is None or p > cell["hi"]:
            cell["hi"] = p
    return cell


def grid_path(finder_dir: Path, loc_id: str) -> Path:
    return finder_dir / f"grid-{loc_id}.json"


def catalog_path(finder_dir: Path, loc_id: str) -> Path:
    return finder_dir / f"catalog-{loc_id}.json"


def history_path(finder_dir: Path) -> Path:
    return finder_dir / "history.jsonl"


def merge_observations(finder_dir: Path, obs_file: dict[str, Any], today: date) -> int:
    loc_id = obs_file["location"]
    gpath = grid_path(finder_dir, loc_id)
    grid = _read_json(gpath, {"location": loc_id, "updated_at": None, "hotels": {}})
    hotels: dict[str, dict[str, Any]] = grid.setdefault("hotels", {})
    for obs in obs_file.get("observations") or []:
        cells = hotels.setdefault(obs["key"], {})
        cells[obs["d"]] = merge_cell(cells.get(obs["d"]), obs)
    cutoff = today.isoformat()
    catalog = obs_file.get("catalog")
    keep_keys = {h["key"] for h in catalog["hotels"]} if catalog else set(hotels)
    for key in list(hotels):
        if key not in keep_keys:
            del hotels[key]
            continue
        hotels[key] = {d: c for d, c in sorted(hotels[key].items()) if d >= cutoff}
    grid["updated_at"] = obs_file.get("run_at") or now_iso()
    _write_json(gpath, grid)
    if catalog:
        _write_json(catalog_path(finder_dir, loc_id), catalog, pretty=True)

    rows = []
    for key, cells in sorted(hotels.items()):
        priced = [(d, c["p"]) for d, c in cells.items() if c.get("p") is not None]
        if not priced:
            continue
        best_d, best_p = min(priced, key=lambda x: (x[1], x[0]))
        rows.append(
            {
                "run_at": grid["updated_at"],
                "location": loc_id,
                "key": key,
                "min": best_p,
                "min_date": best_d,
                "median": round(median(p for _, p in priced)),
                "priced": len(priced),
            }
        )
    hpath = history_path(finder_dir)
    hpath.parent.mkdir(parents=True, exist_ok=True)
    with hpath.open("a", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(obs_file.get("observations") or [])


# -- site data ------------------------------------------------------------------------------------


def _load_history_rows(finder_dir: Path) -> list[dict[str, Any]]:
    path = history_path(finder_dir)
    if not path.exists():
        return []
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    rows.sort(key=lambda r: r["run_at"])
    return rows


def _pct(base: float | None, value: float | None) -> float | None:
    if not base or value is None:
        return None
    return round((base - value) / base * 100, 1)


def _fmt_day(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b')}"


def _stars(rating: float) -> str:
    return f"{rating:g}★"


def _hotel_block(
    cfg: FinderConfig,
    hotel: dict[str, Any],
    cells: dict[str, Any],
    history: list[dict[str, Any]],
    today: date,
) -> dict[str, Any]:
    nights = cfg.nights
    dates = [
        {
            "d": d,
            "p": c.get("p"),
            "site": c.get("site"),
            "lo": c.get("lo"),
            "hi": c.get("hi"),
            "first": c.get("first"),
            "prev": c.get("prev"),
            "seen": c.get("seen"),
        }
        for d, c in sorted(cells.items())
        if d >= today.isoformat()
    ]
    priced = [x for x in dates if x["p"] is not None]
    best = None
    median_nightly = None
    if priced:
        b = min(priced, key=lambda x: (x["p"], x["d"]))
        best = {
            "check_in": b["d"],
            "total": b["p"],
            "nightly": round(b["p"] / nights),
            "site": b["site"],
        }
        median_nightly = round(median(x["p"] for x in priced) / nights)
    mins = [r["min"] for r in history]
    drop_pct = None
    if best and len(mins) >= 2:
        drop_pct = _pct(median(mins[-30:]), best["total"])
    return {
        "key": hotel["key"],
        "location": hotel["location"],
        "name": hotel["name"],
        "type": hotel["type"],
        "rating": hotel["rating"],
        "reviews": hotel["reviews"],
        "url": hotel["url"],
        "image": hotel.get("image"),
        "lat": hotel.get("lat"),
        "lng": hotel.get("lng"),
        "labels": hotel.get("labels") or [],
        "best": best,
        "median_nightly": median_nightly,
        "peer_median_nightly": None,
        "peer_discount_pct": None,
        "drop_pct": drop_pct,
        "score": 0,
        "super_value": False,
        "stretch": False,
        "reasons": [],
        "dates": dates,
        "history": [{"t": r["run_at"], "min": r["min"]} for r in history[-HISTORY_POINTS:]],
    }


def _score(cfg: FinderConfig, h: dict[str, Any], loc_name: str) -> None:
    peer_disc = h["peer_discount_pct"] or 0.0
    drop = h["drop_pct"] or 0.0
    # How far the best date sits under this hotel's own usual nightly price.
    under = 0.0
    if h["best"] and h["median_nightly"]:
        under = _pct(h["median_nightly"] * cfg.nights, h["best"]["total"]) or 0.0
    score = (
        30 * _clamp(peer_disc / 30)
        + 20 * _clamp(under / 25)
        + 15 * _clamp(drop / 15)
        + 20 * _clamp((h["rating"] - 4.3) / 0.6)
        + 15 * _clamp(math.log10(max(h["reviews"], 1)) / 4)
    )
    h["score"] = round(max(0.0, min(100.0, score))) if h["best"] else 0
    band = cfg.band(h["best"]["nightly"]) if h["best"] else None
    within_budget = band == "in_budget"
    h["stretch"] = band == "stretch"
    # Super value: in budget, strong overall, and a real price edge (vs comparable hotels, vs
    # its own usual price on other dates, or vs its own history). A stretch-band stay (over the
    # budget but under the stretch limit) only counts when the deal is exceptional.
    stretch_worth_it = (
        h["stretch"] and h["score"] >= STRETCH_SCORE and (peer_disc >= 25 or under >= 20)
    )
    h["super_value"] = bool(
        (
            within_budget
            and h["score"] >= SUPER_SCORE
            and (peer_disc >= 20 or under >= 15 or drop >= 10)
        )
        or stretch_worth_it
    )
    reasons = []
    if h["peer_discount_pct"] is not None and h["peer_discount_pct"] >= 5:
        reasons.append(
            f"{round(h['peer_discount_pct'])}% below similar {_stars(h['rating'])} hotels in "
            f"{loc_name}"
        )
    if h["best"] and h["median_nightly"]:
        under = _pct(h["median_nightly"] * cfg.nights, h["best"]["total"])
        if under is not None and under >= 5:
            reasons.append(
                f"Cheapest on {_fmt_day(h['best']['check_in'])} — {round(under)}% under its usual"
            )
    if h["drop_pct"] is not None and h["drop_pct"] >= 5:
        reasons.append(f"{round(h['drop_pct'])}% below its typical lowest price")
    if h["best"]:
        cell = next((x for x in h["dates"] if x["d"] == h["best"]["check_in"]), None)
        if cell and cell["prev"] and cell["p"] is not None and cell["p"] < cell["prev"]:
            reasons.append(
                f"Down {round(_pct(cell['prev'], cell['p']) or 0)}% since the last check"
            )
    if h["rating"] >= 4.7:
        reasons.append(f"Rated {_stars(h['rating'])} by {h['reviews']:,} guests")
    if stretch_worth_it:
        why = (
            f"{round(peer_disc)}% below similar hotels"
            if peer_disc >= 25
            else f"{round(under)}% under its usual on {_fmt_day(h['best']['check_in'])}"
        )
        reasons.insert(0, f"Worth the stretch: {why}")
    elif band in ("stretch", "too_pricey"):
        reasons.append(f"Over your ₹{cfg.max_nightly_inr:,.0f}/night budget")
    h["reasons"] = reasons


def build_finder_site(cfg: FinderConfig, finder_dir: Path, today: date | None = None) -> dict:
    today = today or datetime.now(UTC).date()
    history = _load_history_rows(finder_dir)
    hist_by_key: dict[str, list[dict[str, Any]]] = {}
    for row in history:
        hist_by_key.setdefault(row["key"], []).append(row)

    locations = []
    hotels_out: list[dict[str, Any]] = []
    for loc in cfg.locations:
        catalog = _read_json(catalog_path(finder_dir, loc.id), None)
        grid = _read_json(grid_path(finder_dir, loc.id), None)
        cat_hotels = (catalog or {}).get("hotels") or []
        cells_by_key = (grid or {}).get("hotels") or {}
        blocks = [
            _hotel_block(
                cfg,
                {**h, "location": loc.id},
                cells_by_key.get(h["key"], {}),
                hist_by_key.get(h["key"], []),
                today,
            )
            for h in cat_hotels
        ]
        for h in blocks:
            if h["median_nightly"] is None:
                continue
            # Similar = same rating band AND same price class (half to double this hotel's usual
            # nightly). Without the class limit a ₹3k guesthouse looks "70% off" next to ₹40k
            # resorts with the same rating, which is a cheaper hotel, not a deal.
            mine = h["median_nightly"]
            peers = [
                p["median_nightly"]
                for p in blocks
                if p is not h
                and p["median_nightly"] is not None
                and abs(p["rating"] - h["rating"]) <= PEER_BAND
                and mine / PEER_CLASS <= p["median_nightly"] <= mine * PEER_CLASS
            ]
            if len(peers) >= MIN_PEERS:
                h["peer_median_nightly"] = round(median(peers))
                h["peer_discount_pct"] = _pct(h["peer_median_nightly"], h["median_nightly"])
        for h in blocks:
            _score(cfg, h, loc.name)
        priced = [h for h in blocks if h["best"]]
        in_band = [h for h in priced if cfg.band(h["median_nightly"]) == "in_budget"]
        usual = in_band or priced
        locations.append(
            {
                "id": loc.id,
                "name": loc.name,
                "country": loc.country,
                "hotels": len(blocks),
                "priced": len(priced),
                "in_budget": sum(
                    1 for h in priced if cfg.band(h["best"]["nightly"]) == "in_budget"
                ),
                "median_nightly": (
                    round(median(h["median_nightly"] for h in usual)) if usual else None
                ),
                "updated_at": (grid or {}).get("updated_at"),
            }
        )
        hotels_out.extend(blocks)
    hotels_out.sort(key=lambda h: (-h["score"], h["best"] is None, h["name"]))
    return {
        "generated_at": now_iso(),
        "config": cfg.public(),
        "locations": locations,
        "hotels": hotels_out,
    }


def write_finder_site(cfg: FinderConfig, finder_dir: Path, site: Path) -> None:
    _write_json(site, build_finder_site(cfg, finder_dir))


# -- tracking a hotel from the page ---------------------------------------------------------------

_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


class TrackError(ValueError):
    pass


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")
    return s[:40].rstrip("-") or "hotel"


def parse_track_request(event: dict[str, Any], cfg: FinderConfig) -> dict[str, Any]:
    issue = event.get("issue") or {}
    owner = ((event.get("repository") or {}).get("owner") or {}).get("login")
    author = (issue.get("user") or {}).get("login")
    if not owner or author != owner:
        raise TrackError("only the repository owner can add hotels")
    if not str(issue.get("title") or "").startswith("Track:"):
        raise TrackError("issue title must start with 'Track:'")
    m = _JSON_BLOCK_RE.search(str(issue.get("body") or ""))
    if not m:
        raise TrackError("no ```json block in the issue body")
    try:
        req = json.loads(m.group(1))
    except json.JSONDecodeError as exc:
        raise TrackError(f"the json block is not valid JSON: {exc}") from exc
    key = str(req.get("key") or "")
    if not KEY_RE.match(key):
        raise TrackError(f"bad hotel key {key!r}")
    url = str(req.get("url") or "")
    host = urllib.parse.urlsplit(url).hostname or ""
    if urllib.parse.urlsplit(url).scheme != "https" or not (
        host == "tripadvisor.com" or host.endswith(".tripadvisor.com")
    ):
        raise TrackError("url must be an https TripAdvisor link")
    name = re.sub(r"\s+", " ", str(req.get("name") or "")).strip()[:120]
    if not name:
        raise TrackError("name is required")
    try:
        loc = cfg.location(str(req.get("location") or ""))
    except FinderError as exc:
        raise TrackError(str(exc)) from exc
    # The rates call uses the key from the URL, so make sure the hotel id in both agree.
    if key.split("-")[1] not in url:
        raise TrackError("key and url point at different hotels")
    return {"key": key, "url": url, "name": name, "location": loc}


def add_tracked_hotel(
    watchlist_path: Path, req: dict[str, Any], cfg: FinderConfig
) -> tuple[bool, str]:
    """Append a xotelo scan for the hotel. Returns (added, scan id)."""
    loc: Location = req["location"]
    scan_id = f"{loc.id}-{_slug(req['name'])}-{cfg.nights}n"
    wl = json.loads(watchlist_path.read_text())
    scans = wl.setdefault("scans", [])
    hotel_id = req["key"].split("-")[1]
    for s in scans:
        if s.get("id") == scan_id or (
            s.get("provider") == "xotelo" and hotel_id in s.get("url", "")
        ):
            return False, s.get("id", scan_id)
    # The xotelo provider reads the g…-d… pair from the URL; any geo id works for rates.
    url = req["url"]
    scans.append(
        {
            "id": scan_id,
            "name": f"{req['name']} · cheapest room on Booking.com, Agoda, Trip.com",
            "url": url,
            "provider": "xotelo",
            "room": "Cheapest room",
            "nights": cfg.nights,
            "from": cfg.from_date.isoformat(),
            "to": cfg.to_date.isoformat(),
            "adults": cfg.adults,
            "country": loc.country_code,
        }
    )
    watchlist_path.write_text(json.dumps(wl, indent=2, ensure_ascii=False) + "\n")
    return True, scan_id
