import { useState } from "react";
import { priceText, type FeedGroup } from "../lib/data";
import { ago, fmtDateTime } from "../lib/format";
import { Delta, Pill } from "./ui";

const PREVIEW = 3;

function Group({ g }: { g: FeedGroup }) {
  const [open, setOpen] = useState(false);
  const counts: Record<string, number> = {};
  for (const it of g.items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
  const items = open ? g.items : g.items.slice(0, PREVIEW);
  const dominant = counts.down ? "down" : counts.up ? "up" : counts.back ? "back" : "soldout";
  return (
    <li className={`feed-group k-${dominant}`}>
      <span className="feed-dot" aria-hidden="true" />
      <div className="feed-main">
        <div className="feed-head">
          <a className="feed-hotel" href={g.href}>
            {g.hotel}
          </a>
          <span className="feed-sub">{g.sub}</span>
          <time className="feed-when" dateTime={g.t} title={fmtDateTime.format(new Date(g.t))}>
            {ago(g.t)}
          </time>
        </div>
        {g.items.length > PREVIEW && (
          <p className="feed-summary">
            {g.items.length} dates changed
            {counts.down ? <span className="t-good"> · ↓ {counts.down} cheaper</span> : null}
            {counts.back ? <span> · {counts.back} back on sale</span> : null}
            {counts.up ? <span className="t-bad"> · ↑ {counts.up} pricier</span> : null}
            {counts.soldout ? <span className="muted"> · {counts.soldout} sold out</span> : null}
          </p>
        )}
        <ul className="feed-items">
          {items.map((it, i) => (
            <li key={i}>
              <a className="feed-date" href={it.href}>
                {it.label}
              </a>
              <span className="feed-prices">
                {it.kind === "soldout" ? (
                  <span className="muted">{priceText(it.from, g.rate, g.currency)} → sold out</span>
                ) : it.kind === "back" ? (
                  <>
                    <span className="muted">sold out → </span>
                    <strong>{priceText(it.to, g.rate, g.currency)}</strong>
                  </>
                ) : (
                  <>
                    <span className="muted strike">{priceText(it.from, g.rate, g.currency)}</span>
                    <strong>{priceText(it.to, g.rate, g.currency)}</strong>
                    <Delta pct={it.pct} />
                  </>
                )}
                {it.newLow && <Pill tone="good">New low</Pill>}
              </span>
            </li>
          ))}
        </ul>
        {g.items.length > PREVIEW && (
          <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Show fewer" : `Show all ${g.items.length}`}
          </button>
        )}
      </div>
    </li>
  );
}

export function Feed({ groups, limit = 6, step = 10, empty }: { groups: FeedGroup[]; limit?: number; step?: number; empty?: string }) {
  const [shown, setShown] = useState(limit);
  if (!groups.length) return <p className="muted">{empty ?? "No price changes yet."}</p>;
  return (
    <div className="feed">
      <ol className="feed-list">
        {groups.slice(0, shown).map((g) => (
          <Group key={`${g.href}|${g.t}`} g={g} />
        ))}
      </ol>
      {shown < groups.length && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown(shown + step)}>
          Show older changes ({groups.length - shown})
        </button>
      )}
    </div>
  );
}
