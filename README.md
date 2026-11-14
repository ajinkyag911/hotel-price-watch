# Stayhawk

Hotel prices, watched. Tracks the price of specific hotel rooms for specific dates, scans whole
date windows to find the cheapest check-in, keeps the history, charts it, alerts when a price
drops, and finds super-value stays in Goa, Phuket and Langkawi. Runs on GitHub Actions; the app
is served by GitHub Pages. No server, no cost.

Live: https://ajinkyag911.github.io/hotel-price-watch/

## How it works

```
watchlist.json ─┬─► hotelwatch run   (every 6 h) ──► data/history.jsonl   spot readings
                │                                      data/alerts.json    only when something fired
                └─► hotelwatch scan  (daily)     ──► data/scans.jsonl     one price per check-in date
                                                  └─► docs/data/history.json   what the page reads
```

* **Targets** are one room for one stay. Each run records the headline total the booking page
  shows for that stay, plus every rate plan behind it.
* **Scans** are one room for a fixed stay length across a window of check-in dates. Each run
  prices every date in the window. The page shows a price board (one row per check-in date:
  price now, last change, range seen, and a step chart of its history, expandable to the full
  change log), a calendar heatmap of today's prices, and how the cheapest option has moved.
* **What changed.** The overview opens with a feed of price changes, newest first: each scan's
  changes grouped into one entry, plus changes to watched stays. Every date links to its row.
* **Providers** know one booking engine each and are selected by the `provider` field:
  * `swiftbook` — STAAH SwiftBook (`swiftbook.io/inst/#home?propertyId=…`). Prices before tax.
  * `propertyibe` — the "propertyibe2" JavaServer Faces engine (e.g. `booking.tolanihotels.com/propertyibe2/`).
    Prices include taxes and fees.
  * `xotelo` — the free [Xotelo](https://xotelo.com) API over TripAdvisor's rate comparison; the
    `url` is the hotel's TripAdvisor page. Gives the **cheapest room** on each travel site
    (Booking.com, Agoda, Trip.com…) as a stay total; `rate_plan` can pin one site. A fallback for
    hotels whose own engine can't be read. Taxes may be extra, depending on the site.

  Each reading carries `price_basis` (`before_tax` or `after_tax`) and the page labels it.
  Add an engine by implementing `fetch(target) -> Reading` in `src/hotelwatch/providers/` and
  registering it in `providers/__init__.py`.
* **Currency.** Everything is shown in INR. Engines that quote in another currency are converted
  at that day's rate, fetched once per run (open.er-api.com, falling back to the ECB rates on
  api.frankfurter.dev) and stored with the reading as `fx_rate`. Price changes and alerts are
  judged on the native figure, and the page converts all history at the latest rate, so a
  currency move never looks like the hotel changing its price. `alert_below` is always in INR.
* **Alerts** fire when a spot price crosses below `alert_below`, hits a new all-time low, or
  drops 5% or more since the previous reading. The workflow opens or comments on a GitHub issue
  labelled `price-alert` (GitHub emails you) and pushes to an [ntfy](https://ntfy.sh) topic if
  the `NTFY_TOPIC` repository secret is set.

Sites behind bot challenges (Booking.com, for one) are deliberately not supported; this tool
only talks to engines that answer a plain HTTP client.

## Deal finder

`finder.json` names the places to search (Goa, Phuket, Langkawi), the stay (4 nights, 2 adults,
check-ins 1 Dec 2026 → 31 Mar 2027) and the bar a hotel must clear (TripAdvisor 4.3+ from 200+
reviews, hotels and resorts, ₹15,000/night budget). The `Deal finder` workflow runs daily:

```
finder.json ─► hotelwatch find fetch --location goa   (one job per place, in parallel)
                 catalog: top 30 by Bayesian rating, refreshed weekly ─► data/finder/catalog-goa.json
                 prices: every 7th check-in, rotating daily, so a week covers the window
             ─► hotelwatch find merge obs-*.json      ─► data/finder/grid-<place>.json
                                                       ─► data/finder/history.jsonl
                                                       ─► docs/data/finder.json   what the page reads
```

Prices come from Xotelo's free API over TripAdvisor's rate comparison: the **cheapest room** on
each travel site, as a stay total in INR; taxes may be extra. Each hotel gets a 0–100 score:

| Weight | Signal |
|---|---|
| 40 | price vs similar-rated hotels (±0.25★) in the same place, up to 40% cheaper |
| 25 | rating, 4.3 → 5.0 |
| 20 | best date vs the hotel's own typical lowest price, up to 20% under (needs 2+ runs) |
| 15 | how many reviews back the rating |

A **super value** is a stay within budget scoring 75+, or 30%+ under its peers at 4.5★ or
better. `reasons` spells out why in plain words for the page.

**Track a hotel.** The page's Track button opens a prefilled issue titled `Track: <hotel>` with a
JSON block. The `Track a hotel` workflow acts only on issues by the repository owner, validates
the block (TripAdvisor URL, hotel key, known place) and adds a `xotelo` scan for the finder's
window to `watchlist.json`, then replies and closes the issue. Locally:
`hotelwatch track --event event.json`.

## Add a hotel

Append to `targets` (a specific stay) or `scans` (a date window) in `watchlist.json` and push.

```json
{
  "id": "unique-slug",
  "name": "Hotel · Room name",
  "url": "<booking engine URL>",
  "provider": "swiftbook",
  "room": "Room name as shown on the booking page",
  "rate_plan": "Breakfast and Dinner",
  "check_in": "2027-01-29",
  "check_out": "2027-02-02",
  "adults": 2,
  "children": [],
  "alert_below": 36000,
  "country": "IN"
}
```

A scan replaces `check_in`/`check_out`/`alert_below` with `nights`, `from` and `to` (check-in
dates, inclusive, at most a year). `rate_plan` is an optional substring filter; omit it to track
the cheapest plan. `country` is the guest country some engines price by. Run
`hotelwatch validate` before pushing.

## Web app

The front end lives in `web/` (React + TypeScript + Vite, no runtime dependencies beyond React)
and builds into `docs/`, which GitHub Pages serves. The build never touches `docs/data/` — that
is generated by the Python side and committed by the workflows — so data updates need no
rebuild. Rebuild and commit `docs/` only when the front end changes:

```sh
cd web
npm ci
npm run dev      # http://localhost:5173, reads the real docs/data/*.json
npm run build    # type-checks, then writes docs/index.html and docs/assets/
```

Pages: **Overview** (headline numbers, top deals, watchlist, change feed), **Deals** (finder
results by destination with price cap, rating, type and sort filters), a page per deal (photo,
score and reasons, price calendar, per-date prices, "Track this hotel"), **Watchlist**, a page per
watched hotel (stays with price history and alert line; cheapest-date board and calendar), and
**Activity** (every price change). Light and dark themes; works on phones.

## Local development

```sh
uv venv --python 3.12 .venv && uv pip install -e ".[dev]" --python .venv/bin/python
.venv/bin/pytest
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/hotelwatch run --dry-run          # fetch spot prices and print, write nothing
.venv/bin/hotelwatch scan --only <scan-id>  # price one window and record it
.venv/bin/hotelwatch build                   # rebuild docs/data/history.json (and finder.json) from data/
.venv/bin/hotelwatch find fetch --location goa --stride 14 --out obs-goa.json
.venv/bin/hotelwatch find merge obs-goa.json # fold into data/finder/ and rebuild finder.json
python3 -m http.server -d docs 8765         # view the page at http://localhost:8765
```

## Notes

* GitHub disables scheduled workflows after 60 days without repository activity. The
  workflows' own commits count as activity, so this only matters if every target stops
  producing readings.
* Workflows commit through `scripts/commit-data.sh`: it rebases the append-only JSONL file
  (`.gitattributes` unions it) and rebuilds the generated site file instead of merging it, so
  runs that overlap never conflict.
* `X-Api-Key` for SwiftBook is a public key embedded in the booking page's JavaScript.
  Override with the `SWIFTBOOK_API_KEY` environment variable if it rotates.
* The propertyibe provider keeps one server session per property and waits 0.6 s between
  requests, so a 90-day scan takes a couple of minutes.
* **Bot checks.** When a site answers with a bot check (a Cloudflare challenge, `cf-mitigated:
  challenge`), the provider still retries as usual but never tries to solve or get around it.
  A spot target that stays blocked is logged as a warning and retried next run; it doesn't fail
  the job. A scan stops after 3 blocked dates in a row, and a scan blocked outright isn't stored,
  so the page keeps the previous prices. The Xotelo targets keep Tolani's prices flowing meanwhile.
