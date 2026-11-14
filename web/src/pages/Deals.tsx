import { useMemo } from "react";
import type { FinderData, FinderHotel } from "../lib/types";
import { ago, inr, inrCompact } from "../lib/format";
import { visibleDeal } from "../lib/data";
import { usePref } from "../lib/hooks";
import { DealCard } from "../components/DealCard";
import { IconChevronDown, IconFilter, IconSpark } from "../components/Icons";
import { Chip, Empty } from "../components/ui";

type Sort = "value" | "price" | "discount" | "rating";

const SORTS: Record<Sort, (a: FinderHotel, b: FinderHotel) => number> = {
  value: (a, b) => b.score - a.score,
  price: (a, b) => (a.best?.nightly ?? Infinity) - (b.best?.nightly ?? Infinity),
  discount: (a, b) => (b.peer_discount_pct ?? -Infinity) - (a.peer_discount_pct ?? -Infinity),
  rating: (a, b) => b.rating - a.rating || b.reviews - a.reviews,
};

const DEFAULTS = { cap: 0, minRating: 0, types: [] as string[], superOnly: false, sort: "value" as Sort };

export function DealsPage({ data, location }: { data: FinderData | null; location: string | null }) {
  const [prefs, setPrefs] = usePref("sh.deals", DEFAULTS);
  const cap = prefs.cap || data?.config.max_nightly_inr || 15000;
  const minRating = prefs.minRating || data?.config.min_rating || 4.3;
  const loc = data && location && data.locations.some((l) => l.id === location) ? location : null;
  const list = useMemo(
    () =>
      (data?.hotels ?? [])
        .filter((h) => !loc || h.location === loc)
        .filter((h) => visibleDeal(h, cap, data?.config.max_nightly_inr ?? 15000))
        .filter((h) => h.rating >= minRating)
        .filter((h) => !prefs.types.length || prefs.types.includes(h.type))
        .filter((h) => !prefs.superOnly || h.super_value)
        .sort(SORTS[prefs.sort]),
    [data, loc, cap, minRating, prefs],
  );
  if (!data) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Deals</h1>
        </header>
        <Empty title="The deal finder hasn't run yet">
          The first daily run prices about 30 top-rated hotels in each destination. Results show up here after it finishes.
        </Empty>
      </div>
    );
  }
  const types = [...new Set(data.hotels.map((h) => h.type))].sort();

  const normalMax = data.config.max_nightly_inr;
  const hidden = data.hotels.filter((h) => (!loc || h.location === loc) && !visibleDeal(h, cap, normalMax)).length;
  const supers = list.filter((h) => h.super_value).length;
  const stretches = list.filter((h) => h.best && h.best.nightly > cap).length;
  const current = loc ? data.locations.find((l) => l.id === loc)! : null;

  return (
    <div className="page">
      <header className="page-head deals-head">
        <div>
          <p className="eyebrow">
            <IconSpark size={14} /> Deal finder · {data.config.nights}-night stays · {data.config.adults} adults
          </p>
          <h1>{current ? `Best value in ${current.name}` : "Super-value stays"}</h1>
          <p className="lede">
            Top-rated hotels and resorts ({data.config.min_rating}★+, {data.config.min_reviews}+ reviews) at {inrCompact(data.config.min_nightly_inr ?? 2000)}–{inrCompact(data.config.max_nightly_inr)} a night (up to {inrCompact(data.config.stretch_nightly_inr ?? 20000)} when the deal is exceptional), priced daily across every check-in from{" "}
            {new Date(data.config.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} to{" "}
            {new Date(data.config.to).toLocaleDateString(undefined, { month: "short", day: "numeric" })} on Booking.com, Agoda and Trip.com. Scored on price against similar hotels nearby, rating, and drops against each hotel's own usual price.
          </p>
        </div>
        <p className="updated muted small">Updated {ago(data.generated_at)}</p>
      </header>

      <nav className="loc-tabs" aria-label="Destinations">
        <a href="#/deals" className={!loc ? "active" : ""} aria-current={!loc ? "page" : undefined}>
          <span className="loc-tab-name">All</span>
          <span className="loc-tab-sub">{data.hotels.filter((h) => h.best).length} hotels</span>
        </a>
        {data.locations.map((l) => (
          <a key={l.id} href={`#/deals/${l.id}`} className={loc === l.id ? "active" : ""} aria-current={loc === l.id ? "page" : undefined}>
            <span className="loc-tab-name">{l.name}</span>
            <span className="loc-tab-sub">
              {l.in_budget ?? l.priced} in budget{l.median_nightly ? ` · typ. ${inrCompact(l.median_nightly)}/n` : ""}
            </span>
          </a>
        ))}
      </nav>

      <div className="filters card-flat">
        <div className="filter">
          <label htmlFor="cap" className="filter-label">
            Max per night <strong>{inr(cap)}</strong>
          </label>
          <input
            id="cap"
            type="range"
            min={data.config.min_nightly_inr ?? 2000}
            max={data.config.stretch_nightly_inr ?? 20000}
            step={500}
            value={cap}
            onChange={(e) => setPrefs({ ...prefs, cap: Number(e.target.value) })}
          />
        </div>
        <div className="filter">
          <span className="filter-label">Rating</span>
          <div className="chips">
            {[4.3, 4.5, 4.7].map((r) => (
              <Chip key={r} on={minRating === r} onClick={() => setPrefs({ ...prefs, minRating: r })}>
                {r}★+
              </Chip>
            ))}
          </div>
        </div>
        <div className="filter">
          <span className="filter-label">Type</span>
          <div className="chips">
            {types.map((t) => (
              <Chip
                key={t}
                on={prefs.types.includes(t)}
                onClick={() =>
                  setPrefs({ ...prefs, types: prefs.types.includes(t) ? prefs.types.filter((x) => x !== t) : [...prefs.types, t] })
                }
              >
                {t}
              </Chip>
            ))}
          </div>
        </div>
        <div className="filter filter-end">
          <Chip on={prefs.superOnly} onClick={() => setPrefs({ ...prefs, superOnly: !prefs.superOnly })}>
            Super value only
          </Chip>
          <label className="select">
            <span className="sr-only">Sort</span>
            <select value={prefs.sort} onChange={(e) => setPrefs({ ...prefs, sort: e.target.value as Sort })}>
              <option value="value">Best value</option>
              <option value="price">Lowest price</option>
              <option value="discount">Biggest discount</option>
              <option value="rating">Top rated</option>
            </select>
            <IconChevronDown size={14} />
          </label>
        </div>
      </div>

      <p className="result-line">
        <IconFilter size={14} /> {list.length} {list.length === 1 ? "stay" : "stays"}
        {supers ? ` · ${supers} super value` : ""}
        {stretches ? <span className="muted"> · incl. {stretches} worth stretching to {inrCompact(data.config.stretch_nightly_inr ?? 20000)}</span> : null}
        {hidden ? <span className="muted"> · {hidden} hidden by price</span> : null}
        {(prefs.cap || prefs.minRating || prefs.types.length || prefs.superOnly) ? (
          <button type="button" className="link-btn" onClick={() => setPrefs(DEFAULTS)}>
            Reset filters
          </button>
        ) : null}
      </p>

      {list.length ? (
        <div className="deal-grid">
          {list.map((h) => (
            <DealCard key={h.key} h={h} data={data} />
          ))}
        </div>
      ) : (
        <Empty title="Nothing matches these filters">Try a higher price cap or a lower rating.</Empty>
      )}

      <p className="fine-print">
        Prices are the cheapest room each site lists for {data.config.adults} adults, totalled for {data.config.nights} nights, in ₹. Taxes and fees may be extra depending on the site. Hotel
        details and ratings via TripAdvisor; prices via the Xotelo API. Each day the finder refreshes every 7th check-in date, so the whole window is re-priced weekly.
      </p>
    </div>
  );
}
