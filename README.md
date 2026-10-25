# Hotel price watch

Tracks the price of specific hotel rooms for specific dates, scans whole date windows to find
the cheapest check-in, keeps the history, charts it, and alerts when a price drops. Runs on
GitHub Actions; the chart is served by GitHub Pages. No server, no cost.

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
  prices every date in the window, so the page can show a calendar heatmap of today's prices,
  the five cheapest check-ins, and how the cheapest option has moved over time.
* **Providers** know one booking engine each and are selected by the `provider` field:
  * `swiftbook` — STAAH SwiftBook (`swiftbook.io/inst/#home?propertyId=…`). Prices before tax.
  * `propertyibe` — the "propertyibe2" JavaServer Faces engine (e.g. `booking.tolanihotels.com/propertyibe2/`).
    Prices include taxes and fees.

  Each reading carries `price_basis` (`before_tax` or `after_tax`) and the page labels it.
  Add an engine by implementing `fetch(target) -> Reading` in `src/hotelwatch/providers/` and
  registering it in `providers/__init__.py`.
* **Currency.** Everything is shown in INR. Engines that quote in another currency are converted
  at that day's rate, fetched once per run (open.er-api.com, falling back to the ECB rates on
  api.frankfurter.dev) and stored with the reading as `fx_rate`, so history never shifts when
  rates move. The native figure is kept and shown alongside. `alert_below` is always in INR.
* **Alerts** fire when a spot price crosses below `alert_below`, hits a new all-time low, or
  drops 5% or more since the previous reading. The workflow opens or comments on a GitHub issue
  labelled `price-alert` (GitHub emails you) and pushes to an [ntfy](https://ntfy.sh) topic if
  the `NTFY_TOPIC` repository secret is set.

Sites behind bot challenges (Booking.com, for one) are deliberately not supported; this tool
only talks to engines that answer a plain HTTP client.

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

## Local development

```sh
uv venv --python 3.12 .venv && uv pip install -e ".[dev]" --python .venv/bin/python
.venv/bin/pytest
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/hotelwatch run --dry-run          # fetch spot prices and print, write nothing
.venv/bin/hotelwatch scan --only <scan-id>  # price one window and record it
python3 -m http.server -d docs 8765         # view the page at http://localhost:8765
```

## Notes

* GitHub disables scheduled workflows after 60 days without repository activity. The
  workflows' own commits count as activity, so this only matters if every target stops
  producing readings.
* `X-Api-Key` for SwiftBook is a public key embedded in the booking page's JavaScript.
  Override with the `SWIFTBOOK_API_KEY` environment variable if it rotates.
* The propertyibe provider keeps one server session per property and waits 0.6 s between
  requests, so a 90-day scan takes a couple of minutes.
