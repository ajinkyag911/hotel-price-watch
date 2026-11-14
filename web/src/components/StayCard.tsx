import { useMemo } from "react";
import type { Target } from "../lib/types";
import { DAY, basisLabel, fmtDateTime, fmtDateYear, guestsLabel, inr, inrCompact, money, nightsLabel, pctChange, stayRange } from "../lib/format";
import { isOtaSource } from "../lib/data";
import { LineChart } from "./Charts";
import { IconExternal } from "./Icons";
import { Delta, Pill, Stat } from "./ui";

export type Range = "7" | "30" | "90" | "all";

export const inRange = (t: number, range: Range) => range === "all" || t >= Date.now() - Number(range) * DAY;

export function StayCard({ t, range, flash }: { t: Target; range: Range; flash?: boolean }) {
  const s = t.stats;
  const native = t.currency && t.currency !== "INR";
  const readings = useMemo(() => t.readings.filter((r) => inRange(Date.parse(r.t), range)), [t.readings, range]);
  const latest = t.readings[t.readings.length - 1];
  const vsFirst = s.first != null && s.current != null ? pctChange(s.first, s.current) : null;
  const ota = isOtaSource(t);

  return (
    <article className={`card stay-card${flash ? " flash" : ""}`} id={`stay-${t.id}`}>
      <header className="card-head">
        <div>
          <p className="eyebrow">{ota ? "Cheapest room on Booking.com, Agoda, Trip.com" : "Watched stay"}</p>
          <h3>{ota ? "Any room · best travel-site price" : t.room}</h3>
          <p className="meta">
            {stayRange(t.check_in, t.check_out)} · {nightsLabel(t.nights)} · {guestsLabel(t)}
            {t.rate_plan ? ` · ${t.rate_plan} plans` : ""} · totals {basisLabel(t.price_basis)}
          </p>
        </div>
        <a className="btn btn-outline btn-sm" href={t.url} target="_blank" rel="noopener">
          {ota ? "TripAdvisor" : "Booking page"} <IconExternal size={14} />
        </a>
      </header>

      <div className="stats">
        {s.current == null ? (
          <Stat label="Current" value="—" note={t.readings.length ? "Unavailable so far" : "No readings yet"} tone="muted" />
        ) : (
          <Stat
            label={s.available ? "Current total" : "Last seen"}
            value={
              <>
                {inr(s.current)} <Delta pct={s.change_pct_vs_prev} />
              </>
            }
            note={
              <>
                {native && s.current_native != null ? `${money(t.currency).format(s.current_native)} · ` : ""}
                {s.current_plan ?? ""}
                {s.below_alert && (
                  <>
                    {" "}
                    <Pill tone="good">Below alert</Pill>
                  </>
                )}
                {!s.available && (
                  <>
                    {" "}
                    <Pill>Unavailable now</Pill>
                  </>
                )}
              </>
            }
            big
          />
        )}
        <Stat label="Lowest seen" value={inr(s.lowest)} note={s.lowest_at ? `on ${fmtDateYear.format(new Date(s.lowest_at))}` : undefined} tone="good" />
        <Stat
          label="Since tracking began"
          value={vsFirst == null ? "—" : Math.abs(vsFirst) < 0.05 ? "No change" : <Delta pct={vsFirst} className="lg" />}
          note={s.first != null ? `first ${inr(s.first)}` : undefined}
        />
        <Stat
          label="Alert"
          value={t.alert_below != null ? `< ${inrCompact(t.alert_below)}` : "Off"}
          note={t.alert_below != null && s.current != null ? `${inr(Math.abs(s.current - t.alert_below))} ${s.current < t.alert_below ? "under" : "to go"}` : "Set alert_below in watchlist.json"}
          tone={t.alert_below == null ? "muted" : undefined}
        />
      </div>

      {readings.length === 1 && t.readings.length === 1 ? (
        <p className="muted chart-empty small">First reading taken {fmtDateTime.format(new Date(readings[0].t))}. The chart fills in from the next check.</p>
      ) : readings.length > 0 ? (
        <LineChart
          ariaLabel={`Total price for ${t.room}, ${stayRange(t.check_in, t.check_out)}`}
          alertBelow={t.alert_below}
          points={readings.map((r) => ({ time: Date.parse(r.t), value: r.price }))}
          tooltip={(p) => {
            const r = readings.find((x) => Date.parse(x.t) === p.time)!;
            return (
              <>
                <span className="tt-k">{fmtDateTime.format(new Date(r.t))}</span>
                <strong>{r.price != null ? inr(r.price) : "Unavailable"}</strong>
                {r.price != null && native && r.native != null && <span className="tt-k">{money(t.currency).format(r.native)}</span>}
                {r.plan && <span className="tt-k">{r.plan}</span>}
                {t.price_basis !== "after_tax" && r.after_tax != null && <span className="tt-k">{inr(r.after_tax)} incl. tax</span>}
              </>
            );
          }}
        />
      ) : (
        <p className="muted chart-empty">No readings in this range.</p>
      )}

      {latest?.plans?.length > 0 && (
        <details className="more">
          <summary>{latest.plans.length > 1 ? `All ${latest.plans.length} ${ota ? "travel sites" : "rate plans"} in the latest check` : "Latest check details"}</summary>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{ota ? "Site" : "Plan"}</th>
                  <th className="num">Total</th>
                  {!ota && <th className="num">Incl. tax</th>}
                  {!ota && <th>Refundable</th>}
                  {!ota && <th>Offer</th>}
                </tr>
              </thead>
              <tbody>
                {[...latest.plans]
                  .sort((a, b) => (a.before_tax ?? Infinity) - (b.before_tax ?? Infinity))
                  .map((p, i) => (
                    <tr key={i}>
                      <td>{p.name}</td>
                      <td className="num">{inr(p.before_tax)}</td>
                      {!ota && <td className="num">{inr(p.after_tax)}</td>}
                      {!ota && <td>{p.refundable ? "Yes" : "No"}</td>}
                      {!ota && <td>{p.promo ?? "—"}</td>}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <details className="more">
        <summary>All readings ({t.readings.length})</summary>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Checked</th>
                <th className="num">Total</th>
                {native && <th className="num">{t.currency}</th>}
                <th>{ota ? "Site" : "Plan"}</th>
                <th>Offer</th>
              </tr>
            </thead>
            <tbody>
              {[...t.readings].reverse().map((r) => (
                <tr key={r.t}>
                  <td>{fmtDateTime.format(new Date(r.t))}</td>
                  <td className="num">{r.price != null ? inr(r.price) : <span className="muted">Unavailable</span>}</td>
                  {native && <td className="num">{r.native != null ? money(t.currency).format(r.native) : "—"}</td>}
                  <td>{r.plan ?? "—"}</td>
                  <td>{r.promo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </article>
  );
}
