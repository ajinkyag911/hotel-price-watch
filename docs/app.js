/* Hotel price watch — chart page. Vanilla JS, no dependencies. */

const DATA_URL = "data/history.json";
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_H = 260;
const MARGIN = { top: 28, right: 88, bottom: 28, left: 56 };

const state = { data: null, range: "all" };

const fmtMoney = (currency) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 });
const fmtCompact = (currency) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 });
const fmtDateTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fmtDateYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function stayLabel(t) {
  const ci = new Date(t.check_in + "T00:00:00");
  const co = new Date(t.check_out + "T00:00:00");
  const guests = `${t.adults} adult${t.adults === 1 ? "" : "s"}${t.children.length ? `, ${t.children.length} child${t.children.length === 1 ? "" : "ren"}` : ""}`;
  return `${fmtDate.format(ci)} → ${fmtDateYear.format(co)} · ${t.nights} night${t.nights === 1 ? "" : "s"} · ${guests}${t.rate_plan ? ` · ${t.rate_plan} plans` : ""}`;
}

function filterReadings(readings, range) {
  if (range === "all") return readings;
  const cutoff = Date.now() - Number(range) * 86400e3;
  return readings.filter((r) => new Date(r.t).getTime() >= cutoff);
}

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function timeTicks(t0, t1, width) {
  const count = Math.max(2, Math.min(6, Math.floor(width / 110)));
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(t0 + ((t1 - t0) * i) / count);
  return ticks;
}

/* ---------- card ---------- */

function renderTile(container, label, value, opts = {}) {
  const tile = el("div", "tile");
  tile.append(el("div", "label", label));
  const v = el("div", "value" + (opts.small ? " small" : ""), value);
  if (opts.delta) {
    const d = el("span", "delta " + (opts.delta.dir || ""), opts.delta.text);
    v.append(d);
  }
  tile.append(v);
  if (opts.note) tile.append(el("div", "note", opts.note));
  if (opts.badge) tile.append(el("span", "badge " + opts.badge.kind, opts.badge.text));
  container.append(tile);
}

function renderCard(target, currency) {
  const money = fmtMoney(currency);
  const frag = document.getElementById("card").content.cloneNode(true);
  const card = frag.querySelector(".card");
  card.querySelector(".card-title").textContent = target.name;
  card.querySelector(".card-meta").textContent = stayLabel(target);
  const link = card.querySelector(".book-link");
  link.href = target.url;

  const s = target.stats;
  const tiles = card.querySelector(".tiles");
  if (s.current == null) {
    renderTile(tiles, "Current", "—", { note: "No readings yet" });
  } else {
    let delta;
    if (s.change_pct_vs_prev != null && s.change_pct_vs_prev !== 0) {
      const down = s.change_pct_vs_prev < 0;
      delta = { dir: down ? "down" : "up", text: `${down ? "↓" : "↑"} ${Math.abs(s.change_pct_vs_prev)}%` };
    }
    renderTile(tiles, "Current", money.format(s.current), {
      delta,
      note: s.available
        ? `${s.current_plan ?? ""}${s.current_promo ? ` · ${s.current_promo}` : ""}`
        : "Last seen price · currently unavailable",
    });
    renderTile(tiles, "Lowest seen", money.format(s.lowest), {
      note: `on ${fmtDateYear.format(new Date(s.lowest_at))}`,
    });
    if (target.alert_below != null) {
      renderTile(tiles, "Alert below", money.format(target.alert_below), {
        badge: s.below_alert
          ? { kind: "good", text: "✓ Below alert" }
          : { kind: "neutral", text: `${money.format(s.current - target.alert_below)} above` },
      });
    }
    renderTile(tiles, "Readings", String(s.readings), {
      note: `since ${fmtDateYear.format(new Date(target.readings[0].t))}`,
    });
  }

  const figure = card.querySelector(".chart");
  if (!target.readings.length) {
    figure.classList.add("is-empty");
    card.querySelector(".readings").remove();
  }
  const svg = card.querySelector(".chart-svg");
  const tooltip = card.querySelector(".tooltip");
  const caption = card.querySelector(".chart-caption");
  const draw = () => drawChart(svg, tooltip, caption, target, currency, filterReadings(target.readings, state.range));
  new ResizeObserver(draw).observe(figure);
  draw();
  card._redraw = draw;

  const tbody = card.querySelector("tbody");
  for (const r of [...target.readings].reverse()) {
    const tr = el("tr");
    tr.append(el("td", null, fmtDateTime.format(new Date(r.t))));
    if (r.price == null) {
      const td = el("td", "soldout", "Unavailable");
      td.colSpan = 4;
      tr.append(td);
    } else {
      tr.append(el("td", "num", money.format(r.price)));
      tr.append(el("td", "num", r.after_tax != null ? money.format(r.after_tax) : "—"));
      tr.append(el("td", null, r.plan ?? "—"));
      tr.append(el("td", null, r.promo ?? "—"));
    }
    tbody.append(tr);
  }
  return card;
}

/* ---------- chart ---------- */

function drawChart(svg, tooltip, caption, target, currency, readings) {
  svg.replaceChildren();
  tooltip.hidden = true;
  const width = svg.clientWidth || 600;
  const height = CHART_H;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", `${target.name}: price over time`);

  const points = readings.filter((r) => r.price != null).map((r) => ({ ...r, time: new Date(r.t).getTime() }));
  if (points.length === 0) {
    const fo = svgEl("foreignObject", { x: 0, y: 0, width, height });
    const msg = el("div", "chart-empty", readings.length ? "No priced readings in this range" : "No readings yet");
    msg.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    fo.append(msg);
    svg.append(fo);
    caption.textContent = "";
    return;
  }

  const money = fmtMoney(currency);
  const compact = fmtCompact(currency);
  const x0 = MARGIN.left, x1 = width - MARGIN.right;
  const y0 = MARGIN.top, y1 = height - MARGIN.bottom;

  const times = points.map((p) => p.time);
  let tMin = Math.min(...times), tMax = Math.max(...times);
  if (tMin === tMax) { tMin -= 43200e3; tMax += 43200e3; }
  const prices = points.map((p) => p.price);
  const domainVals = [...prices];
  if (target.alert_below != null) domainVals.push(target.alert_below);
  let pMin = Math.min(...domainVals), pMax = Math.max(...domainVals);
  const pad = (pMax - pMin || pMax * 0.05 || 1) * 0.15;
  pMin -= pad; pMax += pad;
  const ticks = niceTicks(pMin, pMax);
  pMin = Math.min(pMin, ticks[0]); pMax = Math.max(pMax, ticks[ticks.length - 1]);

  const sx = (t) => x0 + ((t - tMin) / (tMax - tMin)) * (x1 - x0);
  const sy = (p) => y1 - ((p - pMin) / (pMax - pMin)) * (y1 - y0);

  // gridlines + y ticks
  for (const v of ticks) {
    const y = sy(v);
    svg.append(svgEl("line", { class: "grid", x1: x0, x2: x1, y1: y, y2: y }));
    const txt = svgEl("text", { class: "tick", x: x0 - 8, y: y + 4, "text-anchor": "end" });
    txt.textContent = compact.format(v);
    svg.append(txt);
  }
  svg.append(svgEl("line", { class: "baseline", x1: x0, x2: x1, y1: y1, y2: y1 }));

  // x ticks
  const spanDays = (tMax - tMin) / 86400e3;
  const xfmt = spanDays > 180 ? new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" }) : spanDays > 2 ? fmtDate : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit" });
  for (const t of timeTicks(tMin, tMax, x1 - x0)) {
    const txt = svgEl("text", { class: "tick", x: sx(t), y: y1 + 18, "text-anchor": "middle" });
    txt.textContent = xfmt.format(new Date(t));
    svg.append(txt);
  }

  // alert hairline
  if (target.alert_below != null) {
    const y = sy(target.alert_below);
    svg.append(svgEl("line", { class: "alert-line", x1: x0, x2: x1, y1: y, y2: y }));
    const lbl = svgEl("text", { class: "label muted", x: x1 + 8, y: y + 4 });
    lbl.textContent = `Alert ${compact.format(target.alert_below)}`;
    svg.append(lbl);
  }

  // wash + line, broken across unavailable gaps
  const segments = [];
  let cur = [];
  for (const r of readings) {
    if (r.price == null) { if (cur.length) segments.push(cur); cur = []; continue; }
    cur.push({ ...r, time: new Date(r.t).getTime() });
  }
  if (cur.length) segments.push(cur);
  for (const seg of segments) {
    const d = seg.map((p, i) => `${i ? "L" : "M"}${sx(p.time).toFixed(1)},${sy(p.price).toFixed(1)}`).join(" ");
    if (seg.length > 1) {
      const wash = `${d} L${sx(seg[seg.length - 1].time).toFixed(1)},${y1} L${sx(seg[0].time).toFixed(1)},${y1} Z`;
      svg.append(svgEl("path", { class: "wash", d: wash }));
    }
    svg.append(svgEl("path", { class: "line", d }));
  }

  // markers: lowest (hollow) + latest (filled), with direct labels
  const last = points[points.length - 1];
  const low = points.reduce((a, b) => (b.price < a.price ? b : a));
  if (low.price < last.price) {
    svg.append(svgEl("circle", { class: "dot low", cx: sx(low.time), cy: sy(low.price), r: 4 }));
    const lbl = svgEl("text", { class: "label muted", x: sx(low.time), y: sy(low.price) + 18, "text-anchor": "middle" });
    lbl.textContent = `Low ${money.format(low.price)}`;
    svg.append(lbl);
  }
  svg.append(svgEl("circle", { class: "dot", cx: sx(last.time), cy: sy(last.price), r: 4 }));
  const endLbl = svgEl("text", { class: "label", x: sx(last.time) + 10, y: sy(last.price) + 4 });
  endLbl.textContent = money.format(last.price);
  svg.append(endLbl);

  // hover layer: crosshair + tooltip, nearest-x
  const crosshair = svgEl("line", { class: "crosshair", x1: 0, x2: 0, y1: y0, y2: y1, visibility: "hidden" });
  const hoverDot = svgEl("circle", { class: "dot", r: 5, visibility: "hidden" });
  const hit = svgEl("rect", { class: "hit", x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  svg.append(crosshair, hoverDot, hit);

  let focusIdx = -1;
  const show = (idx) => {
    const p = points[idx];
    if (!p) return;
    focusIdx = idx;
    const x = sx(p.time);
    crosshair.setAttribute("x1", x); crosshair.setAttribute("x2", x);
    crosshair.setAttribute("visibility", "visible");
    hoverDot.setAttribute("cx", x); hoverDot.setAttribute("cy", sy(p.price));
    hoverDot.setAttribute("visibility", "visible");
    tooltip.replaceChildren(
      el("div", "tt-value", money.format(p.price)),
      el("div", "tt-row", `${p.plan ?? "—"}${p.after_tax != null ? ` · ${money.format(p.after_tax)} incl. tax` : ""}`),
      el("div", "tt-row plain", `${p.promo ? p.promo + " · " : ""}${fmtDateTime.format(new Date(p.time))}`),
    );
    tooltip.hidden = false;
    const wrapW = svg.clientWidth;
    const ttW = tooltip.offsetWidth;
    const left = x + 12 + ttW > wrapW ? x - ttW - 12 : x + 12;
    tooltip.style.left = `${Math.max(0, left)}px`;
  };
  const hide = () => {
    crosshair.setAttribute("visibility", "hidden");
    hoverDot.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
    focusIdx = -1;
  };
  hit.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0, bestD = Infinity;
    points.forEach((p, i) => { const d = Math.abs(sx(p.time) - px); if (d < bestD) { bestD = d; best = i; } });
    show(best);
  });
  hit.addEventListener("pointerleave", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = focusIdx < 0 ? points.length - 1 : Math.min(points.length - 1, Math.max(0, focusIdx + (e.key === "ArrowRight" ? 1 : -1)));
      show(next);
    } else if (e.key === "Escape") hide();
  });
  svg.addEventListener("blur", hide);

  caption.textContent = `${points.length} reading${points.length === 1 ? "" : "s"} · ${fmtDateYear.format(new Date(tMin))} – ${fmtDateYear.format(new Date(tMax))}`;
}

/* ---------- page ---------- */

function render() {
  const main = document.getElementById("targets");
  main.replaceChildren();
  const { data } = state;
  if (!data || !data.targets.length) {
    main.append(el("p", "empty", "No hotels in the watchlist yet."));
    return;
  }
  for (const t of data.targets) main.append(renderCard(t, data.currency || "INR"));
}

function setRange(range) {
  state.range = range;
  for (const b of document.querySelectorAll(".filters button")) {
    b.setAttribute("aria-checked", String(b.dataset.range === range));
  }
  try { localStorage.setItem("hpw.range", range); } catch { /* storage unavailable */ }
  for (const card of document.querySelectorAll(".card")) card._redraw?.();
}

function wireRepoLink() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  if (m && repo) {
    const a = document.getElementById("repo-link");
    a.href = `https://github.com/${m[1]}/${repo}`;
    a.hidden = false;
  }
}

async function init() {
  wireRepoLink();
  try { const saved = localStorage.getItem("hpw.range"); if (saved) state.range = saved; } catch { /* ignore */ }
  for (const b of document.querySelectorAll(".filters button")) {
    b.setAttribute("aria-checked", String(b.dataset.range === state.range));
    b.addEventListener("click", () => setRange(b.dataset.range));
  }
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    const updated = document.getElementById("updated");
    updated.textContent = fmtDateTime.format(new Date(state.data.generated_at));
    updated.dateTime = state.data.generated_at;
    render();
  } catch (err) {
    document.getElementById("targets").replaceChildren(
      el("p", "empty", "Could not load price data yet. The first scheduled run creates it."),
    );
    console.error(err);
  }
}

init();
