import type {
  ChangeKind,
  FinderData,
  HotelGroup,
  Scan,
  ScanRow,
  WatchData,
} from "./types";
import { fmtDate, fmtShortDay, hotelKey, inr, localDate, money, pctChange, roomTitle, todayIso } from "./format";

export const toInr = (native: number | null | undefined, rate: number | null | undefined) =>
  native == null || !rate ? null : Math.round(native * rate);

/** Price as shown in ₹ at the scan's rate; the hotel's own figure stays in `native`. */
export const priceText = (native: number | null | undefined, rate: number | null | undefined, currency = "INR") =>
  native == null ? "Sold out" : rate ? inr(toInr(native, rate)) : money(currency).format(native);

// Re-express every ₹ figure at the latest rate (the hotel's own price is kept in `native`).
// Converting each reading at its own day's rate made currency drift look like price changes.
export function normalizeFx(data: WatchData): WatchData {
  for (const t of data.targets) {
    const rate = t.fx_rate;
    if (!rate || (t.currency || "INR") === "INR") continue;
    for (const r of t.readings) {
      const scale = r.fx_rate ? rate / r.fx_rate : null;
      r.price = toInr(r.native, rate);
      r.after_tax = toInr(r.native_after_tax, rate);
      for (const plan of r.plans ?? []) {
        plan.before_tax = scale && plan.before_tax != null ? Math.round(plan.before_tax * scale) : null;
        plan.after_tax = scale && plan.after_tax != null ? Math.round(plan.after_tax * scale) : null;
      }
      r.fx_rate = rate;
    }
    const priced = t.readings.filter((r) => r.price != null);
    if (!priced.length || t.stats.current == null) continue;
    const low = priced.reduce((a, b) => (b.price! < a.price! ? b : a));
    Object.assign(t.stats, {
      current: priced[priced.length - 1].price,
      current_fx_rate: rate,
      lowest: low.price,
      lowest_at: low.t,
      highest: Math.max(...priced.map((r) => r.price!)),
      first: priced[0].price,
      below_alert: t.alert_below != null && priced[priced.length - 1].price! < t.alert_below,
    });
  }
  for (const scan of data.scans ?? []) {
    const rate = scan.fx_rate;
    if (!rate || (scan.currency || "INR") === "INR") continue;
    for (const h of scan.history) {
      if (h.min != null) h.min = toInr(h.min_native, rate);
      if (h.median != null && h.fx_rate) h.median = Math.round((h.median * rate) / h.fx_rate);
      h.fx_rate = rate;
    }
    for (const p of scan.latest?.points ?? []) {
      p.price = toInr(p.native, rate);
      p.fx_rate = rate;
    }
  }
  return data;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

export const loadWatch = async () => normalizeFx(await getJson<WatchData>("data/history.json"));
export const loadFinder = () => getJson<FinderData>("data/finder.json");

// ---- grouping ----

export const hotelHash = (key: string) => `#/hotel/${encodeURIComponent(key)}`;

export function groupHotels(data: WatchData): HotelGroup[] {
  const map = new Map<string, HotelGroup>();
  const add = (item: { name: string }, kind: "targets" | "scans") => {
    const key = hotelKey(item.name);
    if (!map.has(key)) map.set(key, { key, name: key, targets: [], scans: [] });
    (map.get(key)![kind] as unknown[]).push(item);
  };
  for (const t of data.targets) add(t, "targets");
  for (const s of data.scans ?? []) add(s, "scans");
  return [...map.values()];
}

/** Second source for a hotel whose own engine is blocked: the Xotelo "cheapest room" series. */
export const isOtaSource = (x: { provider: string }) => x.provider === "xotelo";

// ---- scans: per-date change history ----

export function changeKind(from: number | null | undefined, to: number | null | undefined): ChangeKind | null {
  if (from == null && to == null) return null;
  if (from == null) return "back";
  if (to == null) return "soldout";
  return to < from ? "down" : to > from ? "up" : null;
}

/** One row per upcoming check-in date, with its change history and summary figures. */
export function scanRows(scan: Scan): ScanRow[] {
  if (!scan.latest) return [];
  const today = todayIso();
  return scan.latest.points
    .filter((p) => p.check_in >= today)
    .map((p) => {
      const h = (p.h ?? [[p.t, p.native]]).map(([t, v]) => ({ t, time: Date.parse(t), v }));
      const last = h[h.length - 1];
      const prev = h.length > 1 ? h[h.length - 2] : null;
      const priced = h.filter((x) => x.v != null).map((x) => x.v as number);
      return {
        p,
        date: p.check_in,
        h,
        now: last.v,
        prev: prev ? prev.v : undefined,
        changedAt: prev ? last.time : null,
        kind: prev ? changeKind(prev.v, last.v) : null,
        pct: prev ? pctChange(prev.v, last.v) : null,
        lo: priced.length ? Math.min(...priced) : null,
        hi: priced.length ? Math.max(...priced) : null,
        distinct: new Set(priced).size,
      };
    });
}

// ---- change feed ----

export interface FeedItem {
  label: string;
  sortKey: string;
  from: number | null | undefined;
  to: number | null;
  kind: ChangeKind;
  pct: number | null;
  newLow: boolean;
  href: string;
}

export interface FeedGroup {
  t: string;
  time: number;
  hotel: string;
  href: string;
  sub: string;
  rate: number | null;
  currency: string;
  items: FeedItem[];
}

const KIND_ORDER: Record<ChangeKind, number> = { down: 0, back: 1, up: 2, soldout: 3 };

export function changeFeed(data: WatchData, onlyKey?: string): FeedGroup[] {
  const groups: FeedGroup[] = [];
  const today = todayIso();
  for (const scan of data.scans ?? []) {
    const key = hotelKey(scan.name);
    if (onlyKey && key !== onlyKey) continue;
    const byRun = new Map<string, FeedItem[]>();
    for (const row of scanRows(scan)) {
      let low = Infinity;
      row.h.forEach((x, i) => {
        const prev = i ? row.h[i - 1].v : undefined;
        const kind = i ? changeKind(prev, x.v) : null;
        if (kind) {
          if (!byRun.has(x.t)) byRun.set(x.t, []);
          byRun.get(x.t)!.push({
            label: fmtShortDay.format(localDate(row.date)),
            sortKey: row.date,
            from: prev,
            to: x.v,
            kind,
            pct: pctChange(prev, x.v),
            newLow: kind === "down" && x.v! < low,
            href: `${hotelHash(key)}/${encodeURIComponent(scan.id)}/${row.date}`,
          });
        }
        if (x.v != null) low = Math.min(low, x.v);
      });
    }
    for (const [t, items] of byRun) {
      groups.push({
        t,
        time: Date.parse(t),
        hotel: key,
        href: `${hotelHash(key)}/${encodeURIComponent(scan.id)}`,
        sub: `${isOtaSource(scan) ? "Travel sites" : roomTitle(scan.name)} · ${scan.nights}-night stays`,
        rate: scan.fx_rate,
        currency: scan.currency || "INR",
        items,
      });
    }
  }
  for (const t of data.targets) {
    const key = hotelKey(t.name);
    if ((onlyKey && key !== onlyKey) || t.check_in < today) continue;
    let low = Infinity;
    t.readings.forEach((r, i) => {
      const prev = i ? t.readings[i - 1].native : undefined;
      const kind = i ? changeKind(prev, r.native) : null;
      if (kind) {
        groups.push({
          t: r.t,
          time: Date.parse(r.t),
          hotel: key,
          href: `${hotelHash(key)}/${encodeURIComponent(t.id)}`,
          sub: `${isOtaSource(t) ? "Travel sites" : roomTitle(t.name)} · watched stay`,
          rate: t.fx_rate,
          currency: t.currency || "INR",
          items: [
            {
              label: `${fmtDate.format(localDate(t.check_in))} → ${fmtDate.format(localDate(t.check_out))}`,
              sortKey: t.check_in,
              from: prev,
              to: r.native,
              kind,
              pct: pctChange(prev, r.native),
              newLow: kind === "down" && r.native! < low,
              href: `${hotelHash(key)}/${encodeURIComponent(t.id)}`,
            },
          ],
        });
      }
      if (r.native != null) low = Math.min(low, r.native);
    });
  }
  for (const g of groups) {
    g.items.sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (a.kind === "up" ? (b.pct ?? 0) - (a.pct ?? 0) : (a.pct ?? 0) - (b.pct ?? 0)) ||
        a.sortKey.localeCompare(b.sortKey),
    );
  }
  return groups.sort((a, b) => b.time - a.time);
}

// ---- repo / track links ----

export function repoInfo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  if (m && repo) return { owner: m[1], repo };
  return { owner: "ajinkyag911", repo: "hotel-price-watch" };
}

export const repoUrl = () => {
  const { owner, repo } = repoInfo();
  return `https://github.com/${owner}/${repo}`;
};

/** Opens a pre-filled GitHub issue; the track workflow adds the hotel to the watchlist. */
export function trackUrl(h: { key: string; name: string; url: string; location: string }) {
  const body = [
    "<!-- stayhawk-track -->",
    `Add **${h.name}** to the Stayhawk watchlist (cheapest room on Booking.com, Agoda, Trip.com; 4-night stays).`,
    "",
    "```json",
    JSON.stringify({ key: h.key, name: h.name, url: h.url, location: h.location }),
    "```",
  ].join("\n");
  const q = new URLSearchParams({ title: `Track: ${h.name}`, body });
  return `${repoUrl()}/issues/new?${q.toString()}`;
}
