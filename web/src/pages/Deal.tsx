import { useState } from "react";
import type { FinderData, WatchData } from "../lib/types";
import { addDays, ago, fmtDateTime, fmtShortDay, inr, localDate, photo, todayIso } from "../lib/format";
import { trackUrl } from "../lib/data";
import { Heatmap, LineChart } from "../components/Charts";
import { DealCard, locationName } from "../components/DealCard";
import { IconArrowLeft, IconCheck, IconExternal, IconPin, IconPlus } from "../components/Icons";
import { Delta, Empty, Photo, Pill, Rating, ScoreRing, SectionHead, Stat } from "../components/ui";

export function DealPage({ data, watch, dealKey }: { data: FinderData | null; watch: WatchData | null; dealKey: string }) {
  const h = data?.hotels.find((x) => x.key === dealKey);
  const [pick, setPick] = useState<string | null>(null);
  if (!data || !h) {
    return (
      <div className="page">
        <a className="back" href="#/deals">
          <IconArrowLeft size={16} /> All deals
        </a>
        <Empty title="This hotel isn't in the latest finder results">It may have dropped out of the top-rated list for its destination.</Empty>
      </div>
    );
  }
  const n = data.config.nights;
  const today = todayIso();
  const from = data.config.from > today ? data.config.from : addDays(today, 1);
  const byDate = new Map(h.dates.map((d) => [d.d, d]));
  const cells = [];
  for (let d = from; d <= data.config.to; d = addDays(d, 1)) {
    const x = byDate.get(d);
    cells.push(x ? { date: d, value: x.p } : { date: d, value: null, missing: true });
  }
  const selected = byDate.get(pick ?? h.best?.check_in ?? "") ?? null;
  const tracked = (watch?.scans ?? []).some((s) => s.url.includes(h.key.split("-")[1])) || (watch?.targets ?? []).some((t) => t.url.includes(h.key.split("-")[1]));
  const similar = data.hotels.filter((x) => x.location === h.location && x.key !== h.key && x.best).slice(0, 3);
  const img = photo(h.image, 1200);
  const priced = h.dates.filter((d) => d.p != null).length;

  return (
    <div className="page deal-page">
      <a className="back" href={`#/deals/${h.location}`}>
        <IconArrowLeft size={16} /> {locationName(data, h.location)} deals
      </a>

      <section className="deal-hero">
        <div className="deal-hero-media">
          <Photo src={img} alt={h.name} eager />
          {h.super_value && <span className="ribbon lg">Super value</span>}
        </div>
        <div className="deal-hero-body">
          <p className="eyebrow">
            <IconPin size={14} /> {locationName(data, h.location)} · {h.type}
          </p>
          <h1>{h.name}</h1>
          <div className="deal-meta">
            <Rating value={h.rating} count={h.reviews} />
            {h.stretch && h.super_value && <Pill tone="amber">Worth the stretch</Pill>}
            {h.labels.map((l) => (
              <Pill key={l}>{l}</Pill>
            ))}
          </div>
          <div className="deal-score-row">
            <ScoreRing score={h.score} size={64} />
            <div>
              <strong>Deal score {h.score}</strong>
              <ul className="reasons">
                {h.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="actions">
            <a className="btn btn-primary" href={h.url} target="_blank" rel="noopener">
              See prices on TripAdvisor <IconExternal size={15} />
            </a>
            {tracked ? (
              <span className="btn btn-outline is-static">
                <IconCheck size={15} /> In your watchlist
              </span>
            ) : (
              <a className="btn btn-outline" href={trackUrl(h)} target="_blank" rel="noopener" title="Opens a pre-filled GitHub issue; submitting it adds this hotel to the watchlist">
                <IconPlus size={15} /> Track this hotel
              </a>
            )}
          </div>
        </div>
      </section>

      <div className="stats stats-4">
        <Stat
          label="Best price"
          value={h.best ? inr(h.best.total) : "—"}
          note={h.best ? `${inr(h.best.nightly)}/night · ${fmtShortDay.format(localDate(h.best.check_in))} · ${h.best.site}` : "No prices yet"}
          tone="good"
          big
        />
        <Stat
          label="vs similar hotels"
          value={h.peer_discount_pct != null ? `${h.peer_discount_pct >= 0 ? "" : "+"}${Math.abs(Math.round(h.peer_discount_pct))}% ${h.peer_discount_pct >= 0 ? "cheaper" : "pricier"}` : "—"}
          note={h.peer_median_nightly ? `similar-rated median ${inr(h.peer_median_nightly)}/night` : undefined}
          tone={h.peer_discount_pct != null && h.peer_discount_pct > 0 ? "good" : undefined}
        />
        <Stat
          label="vs its usual"
          value={h.drop_pct != null ? <Delta pct={-h.drop_pct} className="lg" /> : "Building history"}
          note={h.median_nightly ? `usually ${inr(h.median_nightly)}/night` : undefined}
          tone={h.drop_pct == null ? "muted" : undefined}
        />
        <Stat label="Dates priced" value={`${priced} of ${cells.length}`} note="every 7th date refreshes daily" />
      </div>

      <section className="card">
        <SectionHead title="Price calendar" sub={`Total for ${n} nights by check-in date. Pick a date to see its prices.`} />
        <Heatmap
          from={from}
          to={data.config.to}
          cells={cells}
          selected={selected?.d ?? null}
          highlight={new Set(h.best ? [h.best.check_in] : [])}
          onPick={setPick}
          tooltip={(c) => (
            <>
              <span className="tt-k">{fmtShortDay.format(localDate(c.date))}</span>
              <strong>{c.missing ? "Not priced yet" : c.value != null ? inr(c.value) : "Unavailable"}</strong>
            </>
          )}
        />
        {selected && (
          <div className="date-detail">
            <div className="date-detail-head">
              <div>
                <strong>{fmtShortDay.format(localDate(selected.d))}</strong> → {fmtShortDay.format(localDate(addDays(selected.d, n)))} · {n} nights
              </div>
              <div className="date-detail-now">
                {selected.p != null ? inr(selected.p) : "Unavailable"}
                {selected.site && <span className="muted"> on {selected.site}</span>}
                {selected.prev != null && selected.p != null && <Delta pct={((selected.p - selected.prev) / selected.prev) * 100} />}
              </div>
            </div>
            <div className="mini-stats">
              <span>Lowest seen <strong>{inr(selected.lo)}</strong></span>
              <span>Highest seen <strong>{inr(selected.hi)}</strong></span>
              <span>First seen <strong>{inr(selected.first)}</strong></span>
              {selected.seen && (
                <span title={fmtDateTime.format(new Date(selected.seen))}>
                  Checked <strong>{ago(selected.seen)}</strong>
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      {h.history.filter((x) => x.min != null).length > 1 && (
        <section className="card">
          <SectionHead title="Cheapest stay over time" sub="The lowest total across all priced dates, per daily run." />
          <LineChart
            height={200}
            ariaLabel={`Cheapest ${n}-night total for ${h.name} over time`}
            points={h.history.map((x) => ({ time: Date.parse(x.t), value: x.min }))}
            tooltip={(p) => (
              <>
                <span className="tt-k">{fmtDateTime.format(new Date(p.time))}</span>
                <strong>{p.value != null ? inr(p.value) : "—"}</strong>
              </>
            )}
          />
        </section>
      )}

      {similar.length > 0 && (
        <section>
          <SectionHead title={`More in ${locationName(data, h.location)}`} action={<a className="link" href={`#/deals/${h.location}`}>See all</a>} />
          <div className="deal-grid">
            {similar.map((x) => (
              <DealCard key={x.key} h={x} data={data} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
