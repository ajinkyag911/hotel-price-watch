import type { FinderData, FinderHotel } from "../lib/types";
import { fmtShortDay, inr, localDate, photo } from "../lib/format";
import { PriceStrip } from "./Charts";
import { IconPin, IconTrendDown } from "./Icons";
import { Photo, Pill, Rating, ScoreRing } from "./ui";

export const dealHref = (h: FinderHotel) => `#/deal/${encodeURIComponent(h.key)}`;

export function locationName(data: FinderData | null, id: string) {
  return data?.locations.find((l) => l.id === id)?.name ?? id;
}

export function DealCard({ h, data, compact }: { h: FinderHotel; data: FinderData; compact?: boolean }) {
  const img = photo(h.image, compact ? 500 : 600);
  const discount = h.peer_discount_pct != null && h.peer_discount_pct >= 5 ? Math.round(h.peer_discount_pct) : null;
  return (
    <a className={`deal-card${compact ? " compact" : ""}`} href={dealHref(h)}>
      <div className="deal-media">
        <Photo src={img} />
        <div className="deal-media-top">
          {h.super_value ? <span className="ribbon">Super value</span> : <span />}
          <ScoreRing score={h.score} size={compact ? 40 : 46} />
        </div>
        <div className="deal-media-bottom">
          <span className="loc-chip">
            <IconPin size={13} /> {locationName(data, h.location)}
          </span>
        </div>
      </div>
      <div className="deal-body">
        <div className="deal-title-row">
          <h3 title={h.name}>{h.name}</h3>
        </div>
        <div className="deal-meta">
          <Rating value={h.rating} count={h.reviews} />
          <span className="dot-sep" />
          <span>{h.type}</span>
        </div>
        {h.best ? (
          <div className="deal-price">
            <div>
              <span className="deal-nightly">{inr(h.best.nightly)}</span>
              <span className="muted"> /night</span>
            </div>
            <div className="deal-total muted small">
              {inr(h.best.total)} for {data.config.nights} nights · {fmtShortDay.format(localDate(h.best.check_in))}
            </div>
          </div>
        ) : (
          <div className="deal-price muted small">No prices for these dates yet</div>
        )}
        {!compact && (
          <div className="deal-tags">
            {discount && (
              <Pill tone="good">
                <IconTrendDown size={13} /> {discount}% below similar
              </Pill>
            )}
            {h.drop_pct != null && h.drop_pct >= 5 && <Pill tone="brand">{Math.round(h.drop_pct)}% under its usual</Pill>}
            {h.best && <Pill>{h.best.site}</Pill>}
          </div>
        )}
        {!compact && h.reasons[0] && <p className="deal-reason">{h.reasons[0]}</p>}
        {!compact && <PriceStrip values={h.dates.map((d) => d.p)} best={h.best?.total} />}
      </div>
    </a>
  );
}
