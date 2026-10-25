# Hotel price watch

Tracks the price of specific hotel rooms for specific dates, keeps the history, charts it,
and alerts when the price drops. Runs on GitHub Actions every six hours; the chart is served
by GitHub Pages. No server, no cost.

## How it works

```
watchlist.json  ──►  hotelwatch run  ──►  data/history.jsonl      (append-only readings)
                           │              docs/data/history.json  (what the chart reads)
                           └──────────►   data/alerts.json        (present only when something fired)
```

* **Providers** know one booking engine each. `swiftbook` covers STAAH SwiftBook pages
  (`swiftbook.io/inst/#home?propertyId=…`). Add another by implementing
  `Provider.fetch(target) -> Reading` in `src/hotelwatch/providers/` and registering it.
* **Price** is the booking engine's before-tax total for the whole stay, which is what the
  page shows under the room. After-tax totals and every rate plan are stored too.
* **Alerts** fire when the price crosses below `alert_below`, hits a new all-time low, or
  drops 5% or more since the previous reading. The workflow opens or comments on a GitHub
  issue labelled `price-alert` (GitHub emails you), and pushes to an [ntfy](https://ntfy.sh)
  topic if the `NTFY_TOPIC` repository secret is set.

## Add a hotel

Append an entry to `watchlist.json` and push. The next run picks it up.

```json
{
  "id": "unique-slug",
  "name": "Hotel · Room name",
  "url": "<booking page URL>",
  "provider": "swiftbook",
  "room": "Room name exactly as shown on the booking page",
  "rate_plan": "Breakfast and Dinner",
  "check_in": "2027-01-29",
  "check_out": "2027-02-02",
  "adults": 2,
  "children": [],
  "alert_below": 36000,
  "country": "IN"
}
```

`rate_plan` is an optional substring filter; leave it out to track the cheapest plan.
`country` affects which rates the engine returns. Run `hotelwatch validate` before pushing.

## Local development

```sh
uv venv --python 3.12 .venv && uv pip install -e ".[dev]" --python .venv/bin/python
.venv/bin/pytest
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/hotelwatch run --dry-run      # fetch and print, write nothing
.venv/bin/hotelwatch run                # append a reading locally
python3 -m http.server -d docs 8765     # view the chart at http://localhost:8765
```

## Notes

* GitHub disables scheduled workflows after 60 days without repository activity. The
  workflow's own commits count as activity, so this only matters if every target stops
  producing readings.
* `X-Api-Key` for SwiftBook is a public key embedded in the booking page's JavaScript.
  Override with the `SWIFTBOOK_API_KEY` environment variable if it rotates.
