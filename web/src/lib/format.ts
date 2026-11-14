export const DAY = 86400e3;

const nf = (currency: string, max = 0) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: max });

const cache = new Map<string, Intl.NumberFormat>();
export const money = (currency = "INR") => {
  if (!cache.has(currency)) cache.set(currency, nf(currency));
  return cache.get(currency)!;
};
export const inr = (v: number | null | undefined) => (v == null ? "—" : money("INR").format(v));

const compactInr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  notation: "compact",
  maximumFractionDigits: 1,
});
export const inrCompact = (v: number | null | undefined) => (v == null ? "—" : compactInr.format(v));

export const fmtDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
export const fmtDateYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
export const fmtShortDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
export const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
export const fmtMonth = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
export const fmtMonthShort = new Intl.DateTimeFormat(undefined, { month: "short" });
export const fmtDateTime = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export const localDate = (iso: string) => new Date(iso + "T00:00:00");
export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const todayIso = () => isoDay(new Date());
export const addDays = (iso: string, n: number) => {
  const d = localDate(iso);
  d.setDate(d.getDate() + n);
  return isoDay(d);
};

export function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 14 * 86400) return `${Math.round(s / 86400)}d ago`;
  return fmtDate.format(new Date(iso));
}

export const pctChange = (from: number | null | undefined, to: number | null | undefined) =>
  from && to != null ? ((to - from) / from) * 100 : null;

export const pctText = (pct: number) => {
  const a = Math.abs(pct);
  return `${pct < 0 ? "↓" : "↑"} ${a < 10 ? a.toFixed(1) : Math.round(a)}%`;
};

export const basisLabel = (b: string) => (b === "after_tax" ? "incl. taxes & fees" : "before tax");

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export const nightsLabel = (n: number) => plural(n, "night");

export const guestsLabel = (t: { adults: number; children?: number[] }) => {
  const kids = t.children?.length ?? 0;
  return `${plural(t.adults, "adult")}${kids ? ` · ${plural(kids, "child", "children")}` : ""}`;
};

export const stayRange = (a: string, b: string) => `${fmtDate.format(localDate(a))} → ${fmtDate.format(localDate(b))}`;

export const hotelKey = (name: string) => name.split(" · ")[0].trim();
export const roomTitle = (name: string) => name.split(" · ").slice(1).join(" · ") || name;

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** TripAdvisor's CDN resizes on the fly, but only to widths in whole hundreds (640 fails, 700
 *  works); ask for a card-sized image instead of the multi-megabyte original. */
export const photo = (url: string | null, w = 600) =>
  url ? `${url.split("?")[0]}?w=${Math.max(100, Math.ceil(w / 100) * 100)}` : null;
