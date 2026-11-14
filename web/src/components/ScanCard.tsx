import { useEffect, useMemo, useRef, useState } from "react";
import type { Scan, ScanRow } from "../lib/types";
import { isOtaSource, priceText, scanRows, toInr } from "../lib/data";
import { ago, basisLabel, fmtDate, fmtDateTime, fmtShortDay, guestsLabel, inr, inrCompact, localDate, median, money, nightsLabel, pctChange, pctText } from "../lib/format";
import { usePref } from "../lib/hooks";
import { Heatmap, LineChart, Sparkline, StepChart } from "./Charts";
import { IconCalendar, IconChevronDown, IconExternal, IconList } from "./Icons";
import { Chip, Delta, Pill, Segmented, Stat } from "./ui";
import { inRange, type Range } from "./StayCard";

type Sort = "date" | "price" | "drop" | "recent";
const SORTS: Record<Sort, (a: ScanRow, b: ScanRow) => number> = {
  date: (a, b) => a.date.localeCompare(b.date),
  price: (a, b) => (a.now ?? Infinity) - (b.now ?? Infinity) || a.date.localeCompare(b.date),
  drop: (a, b) => (a.pct ?? Infinity) - (b.pct ?? Infinity) || a.date.localeCompare(b.date),
  recent: (a, b) => (b.changedAt ?? -Infinity) - (a.changedAt ?? -Infinity) || a.date.localeCompare(b.date),
};

const PREFS = { view: "board" as "board" | "calendar", sort: "date" as Sort, changedOnly: false, hideSoldOut: false };

function DateDetail({ scan, row, range }: { scan: Scan; row: ScanRow; range: Range }) {
  const rate = scan.fx_rate;
  const cur = scan.currency || "INR";
  const fmt = (v: number) => inrCompact(toInr(v, rate) ?? v);
  const t1 = Date.now();
  const first = row.h[0]?.time ?? t1;
  const t0 = range === "all" ? first : Math.max(first, t1 - Number(range) * 86400e3);
  const changes = row.h
    .map((x, i) => ({ ...x, prev: i ? row.h[i - 1].v : undefined }))
    .slice(1)
    .reverse();
  return (
    <div className="date-detail">
      <div className="date-detail-head">
        <div>
          <strong>{fmtShortDay.format(localDate(row.date))}</strong> check-in · {nightsLabel(scan.nights)}
        </div>
        <div className="date-detail-now">
          {priceText(row.now, rate, cur)}
          {row.p.plan && <span className="muted"> · {row.p.plan}</span>}
          {row.p.promo && <Pill tone="amber">{row.p.promo}</Pill>}
        </div>
      </div>
      <StepChart h={row.h} t0={t0} t1={t1} format={fmt} />
      {changes.length > 0 ? (
        <ul className="change-list">
          {changes.map((c, i) => (
            <li key={i}>
              <time>{fmtDateTime.format(new Date(c.t))}</time>
              <span>
                {c.prev == null ? "sold out" : priceText(c.prev, rate, cur)} → <strong>{c.v == null ? "sold out" : priceText(c.v, rate, cur)}</strong>
              </span>
              <Delta pct={pctChange(c.prev, c.v)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Same price since first seen {fmtDateTime.format(new Date(row.h[0].t))}.</p>
      )}
    </div>
  );
}

export function ScanCard({ scan, range, focusDate }: { scan: Scan; range: Range; focusDate?: string }) {
  const [prefs, setPrefs] = usePref(`sh.board.${scan.id}`, PREFS);
  const [open, setOpen] = useState<string | null>(focusDate ?? null);
  const ref = useRef<HTMLElement>(null);
  const rows = useMemo(() => scanRows(scan), [scan]);
  const rate = scan.fx_rate;
  const cur = scan.currency || "INR";
  const ota = isOtaSource(scan);
  const priced = rows.filter((r) => r.now != null);
  const minNow = priced.length ? Math.min(...priced.map((r) => r.now!)) : null;
  const ties = priced.filter((r) => r.now === minNow);
  const med = median(priced.map((r) => r.now!));
  const latestRun = scan.latest?.run_at;
  const changed = rows.filter((r) => r.changedAt != null && latestRun && r.changedAt === Date.parse(latestRun));
  const cheaper = changed.filter((r) => r.kind === "down").length;
  const pricier = changed.filter((r) => r.kind === "up").length;

  useEffect(() => {
    if (!focusDate) return;
    setOpen(focusDate);
    requestAnimationFrame(() => {
      const el = document.getElementById(`row-${scan.id}-${focusDate}`);
      (el ?? ref.current)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [focusDate, scan.id]);

  const shown = rows
    .filter((r) => !prefs.changedOnly || r.changedAt != null)
    .filter((r) => !prefs.hideSoldOut || r.now != null)
    .sort(SORTS[prefs.sort]);

  const history = scan.history.filter((h) => inRange(Date.parse(h.t), range));
  const openRow = open ? rows.find((r) => r.date === open) : null;

  return (
    <article className="card scan-card" ref={ref} id={`scan-${scan.id}`}>
      <header className="card-head">
        <div>
          <p className="eyebrow">{ota ? "Cheapest dates · travel sites" : "Cheapest dates"}</p>
          <h3>{ota ? "Any room · Booking.com, Agoda, Trip.com" : scan.room}</h3>
          <p className="meta">
            {nightsLabel(scan.nights)} · check-ins {fmtDate.format(localDate(scan.from))} → {fmtDate.format(localDate(scan.to))} · {guestsLabel(scan)}
            {scan.rate_plan ? ` · ${scan.rate_plan} plans` : ""} · totals {basisLabel(scan.price_basis)}
          </p>
        </div>
        <a className="btn btn-outline btn-sm" href={scan.url} target="_blank" rel="noopener">
          {ota ? "TripAdvisor" : "Booking page"} <IconExternal size={14} />
        </a>
      </header>

      <div className="stats">
        <Stat
          label="Cheapest check-in"
          value={minNow == null ? "—" : priceText(minNow, rate, cur)}
          note={
            minNow == null
              ? scan.latest
                ? "Nothing available in the window"
                : "First scan has not run yet"
              : `${fmtShortDay.format(localDate(ties[0].date))}${ties.length > 1 ? ` + ${ties.length - 1} more` : ""}${cur !== "INR" ? ` · ${money(cur).format(minNow)}` : ""}`
          }
          tone={minNow == null ? "muted" : "good"}
          big
        />
        <Stat label="Median across dates" value={med == null ? "—" : priceText(med, rate, cur)} note={`${priced.length} of ${rows.length} dates available`} />
        <Stat
          label="Latest scan"
          value={changed.length ? `${changed.length} changed` : "No changes"}
          note={
            <>
              {cheaper ? <span className="t-good">↓ {cheaper} cheaper </span> : null}
              {pricier ? <span className="t-bad">↑ {pricier} pricier </span> : null}
              {latestRun ? `· ${ago(latestRun)}` : ""}
            </>
          }
        />
        <Stat
          label="Scan health"
          value={scan.latest ? `${scan.latest.fresh} priced` : "—"}
          note={scan.latest?.failures ? `${scan.latest.failures} dates failed last run` : "All dates fetched"}
          tone={scan.latest?.failures ? "muted" : undefined}
        />
      </div>

      <div className="toolbar">
        <Segmented
          label="View"
          size="sm"
          value={prefs.view}
          onChange={(view) => setPrefs({ ...prefs, view })}
          options={[
            { value: "board", label: <><IconList size={15} /> Board</> },
            { value: "calendar", label: <><IconCalendar size={15} /> Calendar</> },
          ]}
        />
        {prefs.view === "board" && (
          <div className="toolbar-right">
            <label className="select">
              <span className="sr-only">Sort</span>
              <select value={prefs.sort} onChange={(e) => setPrefs({ ...prefs, sort: e.target.value as Sort })}>
                <option value="date">By date</option>
                <option value="price">Cheapest first</option>
                <option value="drop">Biggest drop</option>
                <option value="recent">Recently changed</option>
              </select>
              <IconChevronDown size={14} />
            </label>
            <Chip on={prefs.changedOnly} onClick={() => setPrefs({ ...prefs, changedOnly: !prefs.changedOnly })}>
              Changed only
            </Chip>
            <Chip on={prefs.hideSoldOut} onClick={() => setPrefs({ ...prefs, hideSoldOut: !prefs.hideSoldOut })}>
              Hide sold out
            </Chip>
          </div>
        )}
      </div>

      {prefs.view === "board" ? (
        <div className="board">
          <p className="board-count muted small">
            {shown.length} of {rows.length} check-in dates
          </p>
          <div className="table-wrap board-scroll">
            <table className="table board-table">
              <thead>
                <tr>
                  <th>Check-in</th>
                  <th className="num">Price now</th>
                  <th className="num hide-sm">vs cheapest</th>
                  <th>Last change</th>
                  <th className="num hide-sm">Range seen</th>
                  <th className="hide-sm">History</th>
                  <th aria-label="Details" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const isOpen = open === r.date;
                  const vs = r.now != null && minNow ? ((r.now - minNow) / minNow) * 100 : null;
                  return [
                    <tr
                      key={r.date}
                      id={`row-${scan.id}-${r.date}`}
                      className={`board-row${isOpen ? " open" : ""}${r.now === minNow && minNow != null ? " cheapest" : ""}${r.now == null ? " soldout" : ""}`}
                      onClick={() => setOpen(isOpen ? null : r.date)}
                    >
                      <td>
                        <span className="date-cell">{fmtShortDay.format(localDate(r.date))}</span>
                      </td>
                      <td className="num">
                        <strong>{priceText(r.now, rate, cur)}</strong>
                        {r.p.promo && <span className="promo-dot" title={r.p.promo} />}
                      </td>
                      <td className="num hide-sm">
                        {vs == null ? "—" : vs < 0.05 ? <Pill tone="good">Cheapest</Pill> : <span className="muted">+{vs < 10 ? vs.toFixed(1) : Math.round(vs)}%</span>}
                      </td>
                      <td>
                        {r.kind == null ? (
                          <span className="muted small">{r.h.length > 1 ? "—" : "Unchanged"}</span>
                        ) : r.kind === "soldout" ? (
                          <span className="muted small">Sold out · {ago(r.h[r.h.length - 1].t)}</span>
                        ) : r.kind === "back" ? (
                          <span className="small">Back on sale · {ago(r.h[r.h.length - 1].t)}</span>
                        ) : (
                          <span className="small">
                            <span className={`delta ${r.kind}`}>{pctText(r.pct!)}</span> <span className="muted">{ago(r.h[r.h.length - 1].t)}</span>
                          </span>
                        )}
                      </td>
                      <td className="num hide-sm muted small">
                        {r.lo == null ? "—" : r.lo === r.hi ? priceText(r.lo, rate, cur) : `${inrCompact(toInr(r.lo, rate))} – ${inrCompact(toInr(r.hi, rate))}`}
                      </td>
                      <td className="hide-sm">
                        <Sparkline values={r.h.map((x) => x.v)} width={88} height={24} />
                      </td>
                      <td className="toggle">
                        <IconChevronDown size={16} className={isOpen ? "rot" : ""} />
                      </td>
                    </tr>,
                    isOpen ? (
                      <tr key={`${r.date}-d`} className="board-detail">
                        <td colSpan={7}>
                          <DateDetail scan={scan} row={r} range={range} />
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="calendar">
          <Heatmap
            from={scan.from}
            to={scan.to}
            selected={open}
            highlight={new Set(ties.map((t) => t.date))}
            onPick={(d) => setOpen(d === open ? null : d)}
            cells={rows.map((r) => ({ date: r.date, value: r.now }))}
            tooltip={(c) => (
              <>
                <span className="tt-k">{fmtShortDay.format(localDate(c.date))}</span>
                <strong>{priceText(c.value, rate, cur)}</strong>
              </>
            )}
          />
          {openRow && <DateDetail scan={scan} row={openRow} range={range} />}
        </div>
      )}

      {history.length > 1 && (
        <div className="trend">
          <h4>Cheapest available total over time</h4>
          <LineChart
            height={180}
            ariaLabel="Cheapest available total across the window, per scan"
            points={history.map((h) => ({ time: Date.parse(h.t), value: h.min }))}
            tooltip={(p) => {
              const h = history.find((x) => Date.parse(x.t) === p.time)!;
              return (
                <>
                  <span className="tt-k">{fmtDateTime.format(new Date(h.t))}</span>
                  <strong>{h.min != null ? inr(h.min) : "Nothing available"}</strong>
                  {h.min_date && <span className="tt-k">on {fmtShortDay.format(localDate(h.min_date))}</span>}
                  {h.median != null && <span className="tt-k">median {inr(h.median)}</span>}
                </>
              );
            }}
          />
        </div>
      )}
    </article>
  );
}
