import { useState, type ReactNode } from "react";
import { pctText } from "../lib/format";
import { IconStar } from "./Icons";

export function Delta({ pct, className = "" }: { pct: number | null | undefined; className?: string }) {
  if (pct == null || !isFinite(pct) || Math.abs(pct) < 0.05) return null;
  return <span className={`delta ${pct < 0 ? "down" : "up"} ${className}`}>{pctText(pct)}</span>;
}

export function Pill({ tone = "neutral", children }: { tone?: "good" | "bad" | "neutral" | "brand" | "amber"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Stat({
  label,
  value,
  note,
  tone,
  href,
  big,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: "good" | "bad" | "muted";
  href?: string;
  big?: boolean;
}) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className={`stat-value${tone ? ` is-${tone}` : ""}${big ? " big" : ""}`}>{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </>
  );
  return href ? (
    <a className="stat stat-link" href={href}>
      {body}
    </a>
  ) : (
    <div className="stat">{body}</div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={`seg seg-${size}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="chip" aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

export function Rating({ value, count }: { value: number; count?: number }) {
  return (
    <span className="rating" title={`${value.toFixed(1)} out of 5 on TripAdvisor${count ? `, ${count.toLocaleString("en-IN")} reviews` : ""}`}>
      <IconStar size={13} />
      <strong>{value.toFixed(1)}</strong>
      {count != null && <span className="muted">({count.toLocaleString("en-IN")})</span>}
    </span>
  );
}

/** 0–100 deal score as a ring; the number carries meaning, the ring is decoration. */
export function ScoreRing({ score, size = 46 }: { score: number; size?: number }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const tier = score >= 75 ? "hot" : score >= 55 ? "good" : "ok";
  return (
    <span className={`score score-${tier}`} style={{ width: size, height: size }} title={`Deal score ${score} of 100`}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="score-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="score-fill"
          strokeDasharray={`${(c * score) / 100} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="score-num">{score}</span>
    </span>
  );
}

export function SectionHead({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-head">
      <div>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} />;
}

/** Remote hotel photo with a quiet placeholder if the CDN refuses it. */
export function Photo({ src, alt = "", eager }: { src: string | null; alt?: string; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <div className="deal-noimg" aria-hidden="true" />;
  return <img src={src} alt={alt} loading={eager ? "eager" : "lazy"} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
