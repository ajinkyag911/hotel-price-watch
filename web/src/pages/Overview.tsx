import { useMemo } from "react";
import type { FinderData, HotelGroup, WatchData } from "../lib/types";
import { changeFeed, groupHotels, hotelHash, isOtaSource, priceText, visibleDeal } from "../lib/data";
import { ago, fmtDate, fmtShortDay, inr, inrCompact, localDate, todayIso } from "../lib/format";
import { DealCard } from "../components/DealCard";
import { Feed } from "../components/Feed";
import { Sparkline } from "../components/Charts";
import { IconArrowRight, IconBell, IconCalendar, IconChevronRight, IconSpark, IconTrendDown } from "../components/Icons";
import { Delta, Pill, SectionHead } from "../components/ui";

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

export function HotelRow({ g }: { g: HotelGroup }) {
  const primary = g.targets.find((t) => t.readings.length && !isOtaSource(t)) ?? g.targets.find((t) => t.readings.length);
  return (
    <a className="hotel-row" href={hotelHash(g.key)}>
      <div className="hotel-row-main">
        <h3>{g.name}</h3>
        <ul>
          {g.targets.map((t) => {
            const s = t.stats;
            return (
              <li key={t.id}>
                <span className="hr-label">
                  <span className="hr-room">{isOtaSource(t) ? "Travel sites" : t.room}</span> · {fmtDate.format(localDate(t.check_in))} → {fmtDate.format(localDate(t.check_out))}
                </span>
                <span className="hr-value">
                  {s.current == null ? (
                    <span className="muted">{t.readings.length ? "Unavailable" : "No reading yet"}</span>
                  ) : (
                    <>
                      <strong>{inr(s.current)}</strong>
                      <Delta pct={s.change_pct_vs_prev} />
                      {s.below_alert ? <Pill tone="good">Below alert</Pill> : !s.available ? <Pill>Last seen</Pill> : null}
                    </>
                  )}
                </span>
              </li>
            );
          })}
          {g.scans.map((sc) => {
            const last = sc.history[sc.history.length - 1];
            return (
              <li key={sc.id}>
                <span className="hr-label">
                  <span className="hr-room">
                    {isOtaSource(sc) ? "Travel sites · " : g.scans.length > 1 ? `${sc.room} · ` : ""}
                    {sc.nights}-night stays
                  </span>{" "}
                  · {fmtDate.format(localDate(sc.from))} → {fmtDate.format(localDate(sc.to))}
                </span>
                <span className="hr-value">
                  {!last || last.min == null ? (
                    <span className="muted">No scan yet</span>
                  ) : (
                    <>
                      <span className="muted">from </span>
                      <strong>{inr(last.min)}</strong>
                      <span className="muted"> · {fmtDate.format(localDate(last.min_date!))}</span>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="hotel-row-side">
        {primary && <Sparkline values={primary.readings.slice(-30).map((r) => r.price)} />}
        <IconChevronRight size={18} />
      </div>
    </a>
  );
}

export function OverviewPage({ watch, finder }: { watch: WatchData; finder: FinderData | null }) {
  const groups = useMemo(() => groupHotels(watch), [watch]);
  const feed = useMemo(() => changeFeed(watch), [watch]);
  const today = todayIso();
  const normalMax = finder?.config.max_nightly_inr ?? 15000;
  const topDeals = (finder?.hotels ?? []).filter((h) => visibleDeal(h, normalMax, normalMax)).slice(0, 4);
  const supers = (finder?.hotels ?? []).filter((h) => h.super_value).length;
  const alerts = watch.targets.filter((t) => t.stats.below_alert);
  const nextStay = [...watch.targets].filter((t) => t.check_in >= today && !isOtaSource(t)).sort((a, b) => a.check_in.localeCompare(b.check_in))[0];
  const daysTo = nextStay ? Math.round((localDate(nextStay.check_in).getTime() - localDate(today).getTime()) / 86400e3) : null;
  // Biggest single drop in the last 7 days across the watchlist.
  const weekAgo = Date.now() - 7 * 86400e3;
  const drops = feed
    .filter((g) => g.time >= weekAgo)
    .flatMap((g) => g.items.filter((i) => i.kind === "down").map((i) => ({ g, i })))
    .sort((a, b) => (a.i.pct ?? 0) - (b.i.pct ?? 0));
  const biggest = drops[0];

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="live-dot" /> Watching live · updated {ago(watch.generated_at)}
          </p>
          <h1>{greeting()}.</h1>
          <p className="lede">
            Stayhawk is circling {groups.length} hotels you watch{finder ? ` and ${finder.hotels.length} top-rated stays across ${finder.locations.map((l) => l.name).join(", ")}` : ""}. Here's what's worth your attention.
          </p>
          <div className="actions">
            <a className="btn btn-primary" href="#/deals">
              Explore deals <IconArrowRight size={16} />
            </a>
            <a className="btn btn-outline" href="#/watchlist">
              Your watchlist
            </a>
          </div>
        </div>
        <div className="hero-kpis">
          <a className="kpi" href={topDeals[0] ? `#/deal/${encodeURIComponent(topDeals[0].key)}` : "#/deals"}>
            <span className="kpi-icon amber"><IconSpark size={18} /></span>
            <span className="kpi-label">Top deal today</span>
            <span className="kpi-value">{topDeals[0]?.best ? `${inrCompact(topDeals[0].best.nightly)}/night` : "—"}</span>
            <span className="kpi-note">{topDeals[0] ? `${topDeals[0].name} · score ${topDeals[0].score}` : "Finder hasn't run yet"}</span>
          </a>
          <a className="kpi" href={biggest ? biggest.i.href : "#/activity"}>
            <span className="kpi-icon good"><IconTrendDown size={18} /></span>
            <span className="kpi-label">Biggest drop this week</span>
            <span className="kpi-value">{biggest ? `↓ ${Math.abs(biggest.i.pct ?? 0).toFixed(1)}%` : "—"}</span>
            <span className="kpi-note">
              {biggest ? `${biggest.g.hotel} · ${biggest.i.label} · now ${priceText(biggest.i.to, biggest.g.rate, biggest.g.currency)}` : "No drops in the last 7 days"}
            </span>
          </a>
          <a className="kpi" href={alerts[0] ? `#/hotel/${encodeURIComponent(alerts[0].name.split(" · ")[0])}/${encodeURIComponent(alerts[0].id)}` : "#/watchlist"}>
            <span className="kpi-icon brand"><IconBell size={18} /></span>
            <span className="kpi-label">Price alerts</span>
            <span className="kpi-value">{alerts.length ? `${alerts.length} below target` : "All quiet"}</span>
            <span className="kpi-note">
              {alerts.length ? alerts.map((a) => a.name.split(" · ")[0]).join(", ") : `${watch.targets.filter((t) => t.alert_below != null).length} alerts armed`}
            </span>
          </a>
          <a className="kpi" href={nextStay ? `#/hotel/${encodeURIComponent(nextStay.name.split(" · ")[0])}/${encodeURIComponent(nextStay.id)}` : "#/watchlist"}>
            <span className="kpi-icon"><IconCalendar size={18} /></span>
            <span className="kpi-label">Next watched stay</span>
            <span className="kpi-value">{daysTo != null ? `${daysTo} days` : "—"}</span>
            <span className="kpi-note">{nextStay ? `${nextStay.name.split(" · ")[0]} · ${fmtShortDay.format(localDate(nextStay.check_in))}` : "Nothing upcoming"}</span>
          </a>
        </div>
      </section>

      {finder && (
        <section>
          <SectionHead
            title="Top deals right now"
            sub={`${supers} super-value stays found across ${finder.locations.length} destinations`}
            action={
              <a className="link" href="#/deals">
                All deals <IconArrowRight size={14} />
              </a>
            }
          />
          <div className="deal-grid">
            {topDeals.map((h) => (
              <DealCard key={h.key} h={h} data={finder} />
            ))}
          </div>
          <div className="dest-row">
            {finder.locations.map((l) => (
              <a key={l.id} className={`dest dest-${l.id}`} href={`#/deals/${l.id}`}>
                <span className="dest-name">{l.name}</span>
                <span className="dest-sub">{l.country}</span>
                <span className="dest-stat">
                  {l.in_budget ?? l.priced} in budget · typically {inrCompact(l.median_nightly)}/night
                </span>
                <IconArrowRight size={16} />
              </a>
            ))}
          </div>
        </section>
      )}

      <div className="two-col">
        <section>
          <SectionHead
            title="Your watchlist"
            sub={`${groups.length} hotels · ${watch.targets.length} stays · ${watch.scans.length} date scans`}
            action={
              <a className="link" href="#/watchlist">
                Manage <IconArrowRight size={14} />
              </a>
            }
          />
          <div className="hotel-list">
            {groups.map((g) => (
              <HotelRow key={g.key} g={g} />
            ))}
          </div>
        </section>
        <section className="card">
          <SectionHead
            title="What changed"
            action={
              <a className="link" href="#/activity">
                All activity <IconArrowRight size={14} />
              </a>
            }
          />
          <Feed groups={feed} limit={5} empty="No price changes yet. Every scan is compared with the one before it." />
        </section>
      </div>
    </div>
  );
}
