import { useMemo, useState } from "react";
import type { WatchData } from "../lib/types";
import { changeFeed, groupHotels } from "../lib/data";
import { Feed } from "../components/Feed";
import { Chip, SectionHead } from "../components/ui";
import { HotelRow } from "./Overview";

export function WatchlistPage({ data }: { data: WatchData }) {
  const groups = useMemo(() => groupHotels(data), [data]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Watchlist</p>
          <h1>Hotels you watch</h1>
          <p className="lede">
            Exact stays are checked every six hours; date scans re-price every check-in in their window once a day. Add a hotel from any deal with “Track this hotel”, or edit
            watchlist.json.
          </p>
        </div>
      </header>
      <div className="hotel-list">
        {groups.map((g) => (
          <HotelRow key={g.key} g={g} />
        ))}
      </div>
    </div>
  );
}

export function ActivityPage({ data }: { data: WatchData }) {
  const groups = useMemo(() => groupHotels(data), [data]);
  const [only, setOnly] = useState<string | null>(null);
  const feed = useMemo(() => changeFeed(data, only ?? undefined), [data, only]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Activity</p>
          <h1>Every price change</h1>
          <p className="lede">Each scan is compared with the one before it. Newest first; changes from one scan are grouped together.</p>
        </div>
      </header>
      <div className="chips wrap">
        <Chip on={!only} onClick={() => setOnly(null)}>
          All hotels
        </Chip>
        {groups.map((g) => (
          <Chip key={g.key} on={only === g.key} onClick={() => setOnly(g.key)}>
            {g.name}
          </Chip>
        ))}
      </div>
      <section className="card">
        <SectionHead title={`${feed.length} updates`} />
        <Feed groups={feed} limit={15} step={20} />
      </section>
    </div>
  );
}
