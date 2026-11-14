import { useEffect, useMemo } from "react";
import type { HotelGroup, WatchData } from "../lib/types";
import { changeFeed, isOtaSource, priceText, scanRows } from "../lib/data";
import { fmtShortDay, inr, localDate, stayRange } from "../lib/format";
import { useStringPref } from "../lib/hooks";
import { Feed } from "../components/Feed";
import { ScanCard } from "../components/ScanCard";
import { StayCard, type Range } from "../components/StayCard";
import { IconArrowLeft, IconExternal } from "../components/Icons";
import { Empty, Segmented, SectionHead, Stat } from "../components/ui";

export function HotelPage({ data, group, item, date }: { data: WatchData; group: HotelGroup | undefined; item?: string; date?: string }) {
  const [range, setRange] = useStringPref("sh.range", "all");
  const feed = useMemo(() => (group ? changeFeed(data, group.key) : []), [data, group]);
  // Deep links (#/hotel/<name>/<item>) scroll to the stay or scan; a date is handled by the scan card.
  useEffect(() => {
    if (!item || date) return;
    requestAnimationFrame(() =>
      (document.getElementById(`stay-${item}`) ?? document.getElementById(`scan-${item}`))?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  }, [item, date]);
  if (!group) {
    return (
      <div className="page">
        <a className="back" href="#/watchlist">
          <IconArrowLeft size={16} /> Watchlist
        </a>
        <Empty title="Hotel not found">It may have been removed from the watchlist.</Empty>
      </div>
    );
  }
  const own = [...group.targets, ...group.scans].find((x) => !isOtaSource(x));
  const ota = [...group.targets, ...group.scans].find((x) => isOtaSource(x));
  const glance = [
    ...group.scans.map((scan) => {
      const rows = scanRows(scan).filter((r) => r.now != null);
      const label = `Cheapest ${scan.nights}-night check-in${isOtaSource(scan) ? " · travel sites" : ""}`;
      if (!rows.length) return <Stat key={scan.id} label={label} value="—" note={`${isOtaSource(scan) ? "Any room" : scan.room} · nothing available`} tone="muted" href={`#/hotel/${encodeURIComponent(group.key)}/${encodeURIComponent(scan.id)}`} />;
      const min = Math.min(...rows.map((r) => r.now!));
      const ties = rows.filter((r) => r.now === min);
      return (
        <Stat
          key={scan.id}
          label={label}
          value={priceText(min, scan.fx_rate, scan.currency || "INR")}
          note={`${isOtaSource(scan) ? "Any room" : scan.room} · ${fmtShortDay.format(localDate(ties[0].date))}${ties.length > 1 ? ` + ${ties.length - 1} more` : ""}`}
          tone="good"
          href={`#/hotel/${encodeURIComponent(group.key)}/${encodeURIComponent(scan.id)}/${ties[0].date}`}
        />
      );
    }),
    ...group.targets.map((t) => {
      const s = t.stats;
      const label = `${isOtaSource(t) ? "Travel sites" : "Your stay"} · ${stayRange(t.check_in, t.check_out)}`;
      const href = `#/hotel/${encodeURIComponent(group.key)}/${encodeURIComponent(t.id)}`;
      const room = isOtaSource(t) ? "Any room" : t.room;
      if (s.current == null) return <Stat key={t.id} label={label} value="—" note={`${room} · ${t.readings.length ? "unavailable so far" : "no reading yet"}`} tone="muted" href={href} />;
      if (!s.available) return <Stat key={t.id} label={label} value="Unavailable" note={`${room} · last ${inr(s.current)}`} tone="muted" href={href} />;
      return <Stat key={t.id} label={label} value={inr(s.current)} note={`${room} · lowest seen ${inr(s.lowest)}`} href={href} />;
    }),
  ];

  return (
    <div className="page">
      <a className="back" href="#/watchlist">
        <IconArrowLeft size={16} /> Watchlist
      </a>
      <header className="page-head">
        <div>
          <p className="eyebrow">Watched hotel</p>
          <h1>{group.name}</h1>
        </div>
        <div className="actions">
          {own && (
            <a className="btn btn-primary" href={own.url} target="_blank" rel="noopener">
              Hotel booking page <IconExternal size={15} />
            </a>
          )}
          {ota && (
            <a className="btn btn-outline" href={ota.url} target="_blank" rel="noopener">
              TripAdvisor <IconExternal size={15} />
            </a>
          )}
        </div>
      </header>

      <div className="stats stats-auto">{glance}</div>

      {feed.length > 0 && (
        <section className="card">
          <SectionHead title="Recent changes" />
          <Feed groups={feed} limit={3} />
        </section>
      )}

      <div className="range-bar">
        <span className="muted small">History range</span>
        <Segmented
          label="Time range for history charts"
          size="sm"
          value={range as Range}
          onChange={(v) => setRange(v)}
          options={[
            { value: "7", label: "7D" },
            { value: "30", label: "30D" },
            { value: "90", label: "90D" },
            { value: "all", label: "All" },
          ]}
        />
      </div>

      {group.targets.length > 0 && (
        <section className="stack">
          <SectionHead title="Watched stays" sub="Your exact dates, checked every six hours." />
          {group.targets.map((t) => (
            <StayCard key={t.id} t={t} range={range as Range} flash={item === t.id} />
          ))}
        </section>
      )}

      {group.scans.length > 0 && (
        <section className="stack">
          <SectionHead
            title="Cheapest dates"
            sub="Every upcoming check-in in the window, priced daily for a fixed stay length. Open a row for its full history, or switch to the calendar."
          />
          {group.scans.map((s) => (
            <ScanCard key={s.id} scan={s} range={range as Range} focusDate={item === s.id ? date : undefined} />
          ))}
        </section>
      )}
    </div>
  );
}
