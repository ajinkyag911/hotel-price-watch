import { useEffect, useMemo, useState } from "react";
import type { FinderData, WatchData } from "./lib/types";
import { groupHotels, loadFinder, loadWatch, repoUrl } from "./lib/data";
import { ago, fmtDateTime } from "./lib/format";
import { useRoute, useTheme, type Theme } from "./lib/hooks";
import { IconEye, IconGithub, IconHome, IconMonitor, IconMoon, IconPulse, IconTag, IconSun, Logo } from "./components/Icons";
import { Empty, Skeleton } from "./components/ui";
import { OverviewPage } from "./pages/Overview";
import { DealsPage } from "./pages/Deals";
import { DealPage } from "./pages/Deal";
import { HotelPage } from "./pages/Hotel";
import { ActivityPage, WatchlistPage } from "./pages/Lists";

const NAV = [
  { href: "#/", page: "overview", label: "Overview", icon: IconHome },
  { href: "#/deals", page: "deals", label: "Deals", icon: IconTag },
  { href: "#/watchlist", page: "watchlist", label: "Watchlist", icon: IconEye },
  { href: "#/activity", page: "activity", label: "Activity", icon: IconPulse },
] as const;

const THEMES: { value: Theme; icon: typeof IconSun; label: string }[] = [
  { value: "system", icon: IconMonitor, label: "System theme" },
  { value: "light", icon: IconSun, label: "Light theme" },
  { value: "dark", icon: IconMoon, label: "Dark theme" },
];

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const [watch, setWatch] = useState<WatchData | null>(null);
  const [finder, setFinder] = useState<FinderData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadWatch().then(setWatch, (e) => setError(String(e)));
    loadFinder().then(setFinder, () => setFinder(null));
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.page, route.page === "hotel" ? route.key : route.page === "deal" ? route.key : ""]);

  const groups = useMemo(() => (watch ? groupHotels(watch) : []), [watch]);
  const active = route.page === "deal" ? "deals" : route.page === "hotel" ? "watchlist" : route.page;

  useEffect(() => {
    const titles: Record<string, string> = { overview: "Overview", deals: "Deals", watchlist: "Watchlist", activity: "Activity" };
    const name =
      route.page === "hotel" ? route.key : route.page === "deal" ? finder?.hotels.find((h) => h.key === route.key)?.name ?? "Deal" : titles[route.page];
    document.title = `${name} · Stayhawk`;
  }, [route, finder]);

  const nextTheme = THEMES[(THEMES.findIndex((t) => t.value === theme) + 1) % THEMES.length];
  const ThemeIcon = THEMES.find((t) => t.value === theme)!.icon;

  let body;
  if (error) body = <Empty title="Couldn't load price data">{error}. The first scheduled run creates it.</Empty>;
  else if (!watch)
    body = (
      <div className="page">
        <Skeleton h={220} />
        <div className="deal-grid">
          <Skeleton h={300} />
          <Skeleton h={300} />
          <Skeleton h={300} />
        </div>
      </div>
    );
  else if (route.page === "deals") body = <DealsPage data={finder} location={route.location} />;
  else if (route.page === "deal") body = <DealPage data={finder} watch={watch} dealKey={route.key} />;
  else if (route.page === "watchlist") body = <WatchlistPage data={watch} />;
  else if (route.page === "activity") body = <ActivityPage data={watch} />;
  else if (route.page === "hotel")
    body = <HotelPage key={route.key} data={watch} group={groups.find((g) => g.key === route.key)} item={route.item} date={route.date} />;
  else body = <OverviewPage watch={watch} finder={finder} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/" aria-label="Stayhawk home">
            <Logo size={30} />
            <span className="wordmark">Stayhawk</span>
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <a key={n.page} href={n.href} className={active === n.page ? "active" : ""} aria-current={active === n.page ? "page" : undefined}>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="topbar-right">
            {watch && (
              <span className="status" title={`Watchlist updated ${fmtDateTime.format(new Date(watch.generated_at))}`}>
                <span className="live-dot" /> {ago(watch.generated_at)}
              </span>
            )}
            <button type="button" className="icon-btn" onClick={() => setTheme(nextTheme.value)} aria-label={`Switch to ${nextTheme.label.toLowerCase()}`} title={THEMES.find((t) => t.value === theme)!.label}>
              <ThemeIcon size={18} />
            </button>
            <a className="icon-btn" href={repoUrl()} target="_blank" rel="noopener" aria-label="Source on GitHub">
              <IconGithub size={18} />
            </a>
          </div>
        </div>
      </header>

      <main className="main">{body}</main>

      <footer className="footer">
        <div className="footer-inner">
          <div className="brand small">
            <Logo size={22} />
            <span className="wordmark">Stayhawk</span>
          </div>
          <p>
            All prices in ₹. Hotels priced in another currency are converted at the latest exchange rate, so history only moves when the hotel changes its own price. Each card says
            whether totals are before or after tax. Watched stays every 6 hours · date scans and deal finder daily.
          </p>
        </div>
      </footer>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((n) => (
          <a key={n.page} href={n.href} className={active === n.page ? "active" : ""} aria-current={active === n.page ? "page" : undefined}>
            <n.icon size={20} />
            <span>{n.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
