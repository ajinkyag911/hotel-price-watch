/* Hotel price watch — chart page. Vanilla JS, no dependencies. */

const DATA_URL = "data/history.json";
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_H = 260;
const MARGIN = { top: 28, right: 88, bottom: 28, left: 56 };
// Sequential blue ramp (light → dark = cheap → expensive); dark-mode steps chosen for the dark surface.
const RAMP = {
  light: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
  dark: ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#86b6ef"],
};
const CHEAPEST_N = 5;

const state = { data: null, range: "all" };

const money = (currency) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 });
const compact = (currency) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 });
const fmtDateTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fmtDateYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtWeekdayDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtMonth = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

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
const isDark = () =>
  document.documentElement.dataset.theme === "dark" ||
  (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const roomTitle = (name) => name.split(" · ").slice(1).join(" · ") || name;
const INR = money("INR");
const nativeNote = (currency, amount, rate) =>
  currency && currency !== "INR" && amount != null
    ? `${money(currency).format(amount)}${rate ? ` at ₹${rate.toFixed(2)}` : ""}`
    : "";
const basisLabel = (basis) => (basis === "after_tax" ? "incl. taxes & fees" : "before tax");
const localDate = (iso) => new Date(iso + "T00:00:00");

function guestsLabel(t) {
  const kids = t.children.length;
  return `${t.adults} adult${t.adults === 1 ? "" : "s"}${kids ? `, ${kids} child${kids === 1 ? "" : "ren"}` : ""}`;
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

/* ---------- shared pieces ---------- */

function renderTile(container, label, value, opts = {}) {
  const tile = el("div", "tile");
  tile.append(el("div", "label", label));
  const v = el("div", "value" + (opts.small ? " small" : ""), value);
  if (opts.delta) v.append(el("span", "delta " + (opts.delta.dir || ""), opts.delta.text));
  tile.append(v);
  if (opts.note) tile.append(el("div", "note", opts.note));
  if (opts.badge) tile.append(el("span", "badge " + opts.badge.kind, opts.badge.text));
  container.append(tile);
}

function placeTooltip(tooltip, wrap, x, y) {
  tooltip.hidden = false;
  const ttW = tooltip.offsetWidth;
  const left = x + 12 + ttW > wrap.clientWidth ? x - ttW - 12 : x + 12;
  tooltip.style.left = `${Math.max(0, left)}px`;
  if (y != null) tooltip.style.top = `${y}px`;
}

/* ---------- spot-price card ---------- */

function renderCard(target) {
  const currency = target.currency || "INR";
  const fmt = INR;
  const frag = document.getElementById("card").content.cloneNode(true);
  const card = frag.querySelector(".card");
  card.id = `stay-${target.id}`;
  card.querySelector(".card-title").textContent = roomTitle(target.name);
  card.querySelector(".card-meta").textContent =
    `${fmtDate.format(localDate(target.check_in))} → ${fmtDateYear.format(localDate(target.check_out))} · ` +
    `${target.nights} night${target.nights === 1 ? "" : "s"} · ${guestsLabel(target)}` +
    `${target.rate_plan ? ` · ${target.rate_plan} plans` : ""} · totals ${basisLabel(target.price_basis)}` +
    `${currency !== "INR" ? ` · priced in ${currency}, shown in ₹ at the latest rate` : ""}`;
  card.querySelector(".book-link").href = target.url;

  const s = target.stats;
  const tiles = card.querySelector(".tiles");
  if (s.current == null) {
    renderTile(tiles, "Current", "—", { note: target.readings.length ? "Unavailable so far" : "No readings yet" });
  } else {
    let delta;
    if (s.change_pct_vs_prev != null && s.change_pct_vs_prev !== 0) {
      const down = s.change_pct_vs_prev < 0;
      delta = { dir: down ? "down" : "up", text: `${down ? "↓" : "↑"} ${Math.abs(s.change_pct_vs_prev)}%` };
    }
    const native = nativeNote(currency, s.current_native, s.current_fx_rate);
    renderTile(tiles, "Current", fmt.format(s.current), {
      delta,
      note: s.available
        ? `${native ? native + " · " : ""}${s.current_plan ?? ""}${s.current_promo ? ` · ${s.current_promo}` : ""}`
        : "Last seen price · currently unavailable",
    });
    renderTile(tiles, "Lowest seen", fmt.format(s.lowest), { note: `on ${fmtDateYear.format(new Date(s.lowest_at))}` });
    if (target.alert_below != null) {
      renderTile(tiles, "Alert below", fmt.format(target.alert_below), {
        badge: s.below_alert
          ? { kind: "good", text: "✓ Below alert" }
          : { kind: "neutral", text: `${fmt.format(s.current - target.alert_below)} above` },
      });
    }
    renderTile(tiles, "Readings", String(s.readings), { note: `since ${fmtDateYear.format(new Date(target.readings[0].t))}` });
  }

  const figure = card.querySelector(".chart");
  if (!target.readings.length) {
    figure.classList.add("is-empty");
    card.querySelector(".readings").remove();
  }
  const svg = card.querySelector(".chart-svg");
  const tooltip = card.querySelector(".tooltip");
  const caption = card.querySelector(".chart-caption");
  const draw = () =>
    drawLineChart(svg, tooltip, caption, {
      label: target.name,
      currency,
      alertBelow: target.alert_below,
      basis: target.price_basis,
      readings: filterReadings(target.readings, state.range),
    });
  new ResizeObserver(draw).observe(figure);
  draw();
  card._redraw = draw;

  const headRow = card.querySelector("thead tr");
  const afterTax = target.price_basis === "after_tax";
  for (const [text, cls] of [
    ["Observed", ""],
    [afterTax ? "Total incl. taxes" : "Before tax", "num"],
    ...(afterTax ? [] : [["After tax", "num"]]),
    ...(currency !== "INR" ? [[`In ${currency}`, "num"]] : []),
    ["Plan", ""],
    ["Offer", ""],
  ]) {
    headRow.append(el("th", cls, text));
  }
  const tbody = card.querySelector("tbody");
  for (const r of [...target.readings].reverse()) {
    const tr = el("tr");
    tr.append(el("td", null, fmtDateTime.format(new Date(r.t))));
    if (r.price == null) {
      const td = el("td", "soldout", r.native != null ? "No exchange rate" : "Unavailable");
      td.colSpan = (afterTax ? 3 : 4) + (currency !== "INR" ? 1 : 0);
      tr.append(td);
    } else {
      tr.append(el("td", "num", fmt.format(r.price)));
      if (!afterTax) tr.append(el("td", "num", r.after_tax != null ? fmt.format(r.after_tax) : "—"));
      if (currency !== "INR") tr.append(el("td", "num", money(currency).format(r.native)));
      tr.append(el("td", null, r.plan ?? "—"));
      tr.append(el("td", null, r.promo ?? "—"));
    }
    tbody.append(tr);
  }
  return card;
}

/* ---------- line chart (shared by spot cards and scan trends) ---------- */

function drawLineChart(svg, tooltip, caption, { label, currency, alertBelow, basis, readings }) {
  // Values are INR; ``currency`` is only used to label the engine's native figure.
  svg.replaceChildren();
  tooltip.hidden = true;
  const width = svg.clientWidth || 600;
  const height = CHART_H;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", `${label}: price over time`);

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

  const fmt = INR;
  const cmp = compact("INR");
  // Right margin holds the end label and the alert label; size it for the longest one.
  const longest = Math.max(
    fmt.format(Math.max(...points.map((p) => p.price))).length,
    alertBelow != null ? cmp.format(alertBelow).length + 6 : 0,
  );
  const x0 = MARGIN.left, x1 = width - Math.max(MARGIN.right, 16 + longest * 7.4);
  const y0 = MARGIN.top, y1 = height - MARGIN.bottom;

  const times = points.map((p) => p.time);
  let tMin = Math.min(...times), tMax = Math.max(...times);
  if (tMin === tMax) { tMin -= 43200e3; tMax += 43200e3; }
  const domainVals = points.map((p) => p.price);
  if (alertBelow != null) domainVals.push(alertBelow);
  let pMin = Math.min(...domainVals), pMax = Math.max(...domainVals);
  const pad = (pMax - pMin || pMax * 0.05 || 1) * 0.15;
  pMin -= pad; pMax += pad;
  const ticks = niceTicks(pMin, pMax);
  pMin = Math.min(pMin, ticks[0]); pMax = Math.max(pMax, ticks[ticks.length - 1]);

  const sx = (t) => x0 + ((t - tMin) / (tMax - tMin)) * (x1 - x0);
  const sy = (p) => y1 - ((p - pMin) / (pMax - pMin)) * (y1 - y0);

  for (const v of ticks) {
    const y = sy(v);
    svg.append(svgEl("line", { class: "grid", x1: x0, x2: x1, y1: y, y2: y }));
    const txt = svgEl("text", { class: "tick", x: x0 - 8, y: y + 4, "text-anchor": "end" });
    txt.textContent = cmp.format(v);
    svg.append(txt);
  }
  svg.append(svgEl("line", { class: "baseline", x1: x0, x2: x1, y1: y1, y2: y1 }));

  const spanDays = (tMax - tMin) / 86400e3;
  const xfmt =
    spanDays > 180 ? new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" })
    : spanDays > 2 ? fmtDate
    : spanDays > 0.5 ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit" })
    : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  let prevLabel = null;
  for (const t of timeTicks(tMin, tMax, x1 - x0)) {
    const text = xfmt.format(new Date(t));
    if (text === prevLabel) continue;
    prevLabel = text;
    const txt = svgEl("text", { class: "tick", x: sx(t), y: y1 + 18, "text-anchor": "middle" });
    txt.textContent = text;
    svg.append(txt);
  }

  if (alertBelow != null) {
    const y = sy(alertBelow);
    svg.append(svgEl("line", { class: "alert-line", x1: x0, x2: x1, y1: y, y2: y }));
    const lbl = svgEl("text", { class: "label muted", x: x1 + 8, y: y + 4 });
    lbl.textContent = `Alert ${cmp.format(alertBelow)}`;
    svg.append(lbl);
  }

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

  const last = points[points.length - 1];
  const low = points.reduce((a, b) => (b.price < a.price ? b : a));
  if (low.price < last.price) {
    svg.append(svgEl("circle", { class: "dot low", cx: sx(low.time), cy: sy(low.price), r: 4 }));
    const lbl = svgEl("text", { class: "label muted", x: sx(low.time), y: sy(low.price) + 18, "text-anchor": "middle" });
    lbl.textContent = `Low ${fmt.format(low.price)}`;
    svg.append(lbl);
  }
  svg.append(svgEl("circle", { class: "dot", cx: sx(last.time), cy: sy(last.price), r: 4 }));
  const endLbl = svgEl("text", { class: "label", x: sx(last.time) + 10, y: sy(last.price) + 4 });
  endLbl.textContent = fmt.format(last.price);
  svg.append(endLbl);

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
      el("div", "tt-value", fmt.format(p.price)),
      el("div", "tt-row", `${p.plan ?? "—"}${basis !== "after_tax" && p.after_tax != null ? ` · ${fmt.format(p.after_tax)} incl. tax` : ""}`),
      ...(p.native != null && p.fx_rate && p.fx_rate !== 1 ? [el("div", "tt-row plain", nativeNote(currency, p.native, p.fx_rate))] : []),
      el("div", "tt-row plain", `${p.promo ? p.promo + " · " : ""}${fmtDateTime.format(new Date(p.time))}`),
    );
    placeTooltip(tooltip, svg, (x / width) * svg.clientWidth, 8);
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

/* ---------- scan card: calendar heatmap + cheapest dates + trend ---------- */

function renderScanCard(scan) {
  const currency = scan.currency || "INR";
  const fmt = INR;
  const frag = document.getElementById("scan-card").content.cloneNode(true);
  const card = frag.querySelector(".card");
  card.dataset.scanId = scan.id;
  card.querySelector(".card-title").textContent = roomTitle(scan.name);
  card.querySelector(".card-meta").textContent =
    `${scan.nights}-night stays · check-ins ${fmtDate.format(localDate(scan.from))} → ${fmtDateYear.format(localDate(scan.to))} · ` +
    `${guestsLabel(scan)}${scan.rate_plan ? ` · ${scan.rate_plan} plans` : ""} · totals ${basisLabel(scan.price_basis)}` +
    `${currency !== "INR" ? ` · priced in ${currency}, shown in ₹ at the latest rate` : ""}`;
  card.querySelector(".book-link").href = scan.url;

  const tiles = card.querySelector(".tiles");
  const latest = scan.latest;
  const today = isoDay(new Date());
  const upcoming = latest ? latest.points.filter((p) => p.check_in >= today) : [];
  const priced = upcoming.filter((p) => p.price != null);
  const heat = card.querySelector(".heatmap");
  const legend = card.querySelector(".heatmap-legend");
  const cheapestBody = card.querySelector(".cheapest tbody");

  if (!latest || !priced.length) {
    renderTile(tiles, "Cheapest check-in", "—", { note: latest ? "Nothing available in the window" : "First scan has not run yet" });
    heat.append(el("p", "chart-empty", latest ? "No priced dates" : "No scan yet"));
    card.querySelector(".cheapest").remove();
  } else {
    const sorted = [...priced].sort((a, b) => a.price - b.price || a.check_in.localeCompare(b.check_in));
    const best = sorted[0];
    const prices = priced.map((p) => p.price);
    const med = prices.slice().sort((a, b) => a - b)[Math.floor(prices.length / 2)];
    const prevRun = scan.history.length > 1 ? scan.history[scan.history.length - 2] : null;
    let delta;
    if (prevRun && prevRun.min != null && prevRun.min !== best.price) {
      const pct = ((best.price - prevRun.min) / prevRun.min) * 100;
      delta = { dir: pct < 0 ? "down" : "up", text: `${pct < 0 ? "↓" : "↑"} ${Math.abs(pct).toFixed(1)}%` };
    }
    const ties = priced.filter((p) => p.native === best.native).length;
    renderTile(tiles, "Cheapest check-in", fmt.format(best.price), {
      delta,
      note: `${fmtWeekdayDate.format(localDate(best.check_in))}${ties > 1 ? ` + ${ties - 1} more date${ties === 2 ? "" : "s"}` : ""}${best.native != null && currency !== "INR" ? ` · ${money(currency).format(best.native)}` : ""}${best.promo ? ` · ${best.promo}` : ""}`,
    });
    renderTile(tiles, "Median across dates", fmt.format(med), { note: `${priced.length} of ${upcoming.length} dates available` });
    renderChangedTile(tiles, scan);
    renderTile(tiles, "Last scanned", fmtDateTime.format(new Date(latest.run_at)), {
      small: true,
      note: latest.failures
        ? `${latest.failures} date${latest.failures === 1 ? "" : "s"} did not answer; older values shown for those`
        : `${scan.history.length} scan${scan.history.length === 1 ? "" : "s"} so far`,
    });

    const cheapestIds = new Set(sorted.slice(0, CHEAPEST_N).map((p) => p.check_in));
    drawHeatmap(heat, legend, card.querySelector(".heatmap-wrap .tooltip"), scan, latest.points, cheapestIds, currency);

    for (const p of sorted.slice(0, CHEAPEST_N)) {
      const tr = el("tr");
      tr.append(el("td", null, fmtWeekdayDate.format(localDate(p.check_in))));
      tr.append(el("td", "num", `${fmt.format(p.price)}${currency !== "INR" ? ` (${money(currency).format(p.native)})` : ""}`));
      tr.append(el("td", null, p.plan ?? "—"));
      tr.append(el("td", null, p.promo ?? "—"));
      cheapestBody.append(tr);
    }
  }

  wireBoard(card, scan);
  card._redraw = () => renderBoard(card, scan);

  const trend = card.querySelector(".trend");
  const trendReadings = scan.history.map((h) => ({
    t: h.t,
    price: h.min,
    plan: h.min_date ? `Cheapest check-in ${fmtDate.format(localDate(h.min_date))}` : null,
    promo: h.available != null ? `${h.available} dates available` : null,
    available: h.min != null,
  }));
  if (trendReadings.length < 2) {
    trend.remove();
  } else {
    const svg = trend.querySelector(".chart-svg");
    const tooltip = trend.querySelector(".tooltip");
    const caption = trend.querySelector(".chart-caption");
    const draw = () =>
      drawLineChart(svg, tooltip, caption, {
        label: `${scan.name}: cheapest total`,
        currency,
        alertBelow: null,
        basis: "after_tax",
        readings: filterReadings(trendReadings, state.range),
      });
    new ResizeObserver(draw).observe(trend);
    draw();
    card._redraw = () => { draw(); renderBoard(card, scan); };
  }
  return card;
}

function renderChangedTile(tiles, scan) {
  if (scan.history.length < 2) {
    renderTile(tiles, "Changed in latest scan", "—", { note: "Changes show from the second scan" });
    return;
  }
  const latestT = Date.parse(scan.latest.run_at);
  const counts = { down: 0, up: 0, soldout: 0, back: 0 };
  for (const r of scanRows(scan)) if (r.kind && r.changedAt === latestT) counts[r.kind]++;
  const n = counts.down + counts.up + counts.soldout + counts.back;
  const note = [
    counts.down && `↓ ${counts.down} cheaper`,
    counts.up && `↑ ${counts.up} pricier`,
    counts.soldout && `${counts.soldout} sold out`,
    counts.back && `${counts.back} back on sale`,
  ].filter(Boolean).join(" · ");
  renderTile(tiles, "Changed in latest scan", n ? `${n} date${n === 1 ? "" : "s"}` : "None", {
    note: n ? note : "Same prices as the scan before",
  });
}

function drawHeatmap(container, legend, tooltip, scan, points, cheapestIds, currency) {
  container.replaceChildren();
  legend.replaceChildren();
  const fmt = INR;
  const ramp = RAMP[isDark() ? "dark" : "light"];
  const byDate = new Map(points.map((p) => [p.check_in, p]));
  const priced = points.filter((p) => p.price != null).map((p) => p.price).sort((a, b) => a - b);
  const pMin = priced[0], pMax = priced[priced.length - 1];
  const stepFor = (price) => {
    if (pMax === pMin) return 0;
    // Quantile bins so a few outliers don't wash out the rest.
    const rank = priced.findIndex((v) => v >= price);
    return Math.min(ramp.length - 1, Math.floor((rank / priced.length) * ramp.length));
  };

  const start = localDate(scan.from), end = localDate(scan.to);
  const months = [];
  for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(d);

  const weekdays = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  for (const month of months) {
    const block = el("div", "month");
    block.append(el("div", "month-title", fmtMonth.format(month)));
    const grid = el("div", "month-grid");
    for (const w of weekdays) grid.append(el("div", "wd", w));
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) grid.append(el("div", "cell blank"));
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const date = new Date(month.getFullYear(), month.getMonth(), day);
      const iso = isoDay(date);
      const p = byDate.get(iso);
      const cell = el("button", "cell", String(day));
      cell.type = "button";
      if (date < start || date > end) {
        cell.classList.add("blank");
        cell.disabled = true;
      } else if (!p) {
        cell.classList.add("missing");
        cell.title = "Not scanned";
      } else if (p.price == null) {
        cell.classList.add("soldout");
      } else {
        const step = stepFor(p.price);
        cell.style.background = ramp[step];
        if (luminance(ramp[step]) < 0.35) cell.classList.add("on-dark");
        if (cheapestIds.has(iso)) cell.classList.add("cheapest");
      }
      if (p) {
        const show = () => {
          tooltip.replaceChildren(
            el("div", "tt-value", p.price != null ? fmt.format(p.price) : "Unavailable"),
            ...(p.native != null && currency !== "INR" ? [el("div", "tt-row plain", nativeNote(currency, p.native, p.fx_rate))] : []),
            el("div", "tt-row plain", `${fmtWeekdayDate.format(date)} · ${scan.nights} night${scan.nights === 1 ? "" : "s"}`),
            ...(p.t ? [el("div", "tt-row plain", `scanned ${fmtDateTime.format(new Date(p.t))}`)] : []),
            ...(p.plan ? [el("div", "tt-row plain", `${p.plan}${p.promo ? ` · ${p.promo}` : ""}`)] : []),
          );
          const wrap = container.parentElement;
          const r = cell.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
          placeTooltip(tooltip, wrap, r.left - wr.left + r.width / 2, r.bottom - wr.top + 6);
        };
        const hide = () => { tooltip.hidden = true; };
        cell.addEventListener("pointerenter", show);
        cell.addEventListener("focus", show);
        cell.addEventListener("pointerleave", hide);
        cell.addEventListener("blur", hide);
        cell.setAttribute("aria-label", `${fmtWeekdayDate.format(date)}: ${p.price != null ? fmt.format(p.price) : "unavailable"}`);
      }
      grid.append(cell);
    }
    block.append(grid);
    container.append(block);
  }

  if (priced.length) {
    legend.append(el("span", "legend-label", fmt.format(pMin)));
    const bar = el("div", "legend-bar");
    for (const c of ramp) { const s = el("span"); s.style.background = c; bar.append(s); }
    legend.append(bar);
    legend.append(el("span", "legend-label", fmt.format(pMax)));
    const key = el("span", "legend-key");
    key.append(el("span", "swatch cheapest"), document.createTextNode(` ${CHEAPEST_N} cheapest`));
    key.append(el("span", "swatch soldout"), document.createTextNode(" unavailable"));
    legend.append(key);
  }
}

/* ---------- price changes: per-date history (scans) and consecutive readings (stays) ---------- */

const DAY = 86400e3;
const fmtShortDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const CMP = compact("INR");
const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 14 * 86400) return `${Math.round(s / 86400)}d ago`;
  return fmtDate.format(new Date(iso));
}

// History is compared in the hotel's own currency and shown in ₹ at the latest rate, so a
// currency move never looks like a price change.
const toInr = (native, rate) => (native == null || !rate ? null : Math.round(native * rate));
const priceText = (native, rate, currency) =>
  native == null ? "Sold out" : rate ? INR.format(toInr(native, rate)) : money(currency).format(native);
const pctChange = (from, to) => (from && to != null ? ((to - from) / from) * 100 : null);
const pctText = (pct) => `${pct < 0 ? "↓" : "↑"} ${Math.abs(pct) < 10 ? Math.abs(pct).toFixed(1) : Math.round(Math.abs(pct))}%`;

function changeKind(from, to) {
  if (from == null && to == null) return null;
  if (from == null) return "back";
  if (to == null) return "soldout";
  return to < from ? "down" : to > from ? "up" : null;
}

function rangeStart(first) {
  return state.range === "all" ? first : Math.max(first, Date.now() - Number(state.range) * DAY);
}
const rangeLabel = () => (state.range === "all" ? "since tracking began" : `in the last ${state.range} days`);

/** One row per upcoming check-in date, with its change history and summary figures. */
function scanRows(scan) {
  if (!scan.latest) return [];
  const today = isoDay(new Date());
  return scan.latest.points
    .filter((p) => p.check_in >= today)
    .map((p) => {
      const h = (p.h ?? [[p.t, p.native]]).map(([t, v]) => ({ t, time: Date.parse(t), v }));
      const last = h[h.length - 1];
      const prev = h.length > 1 ? h[h.length - 2] : null;
      const priced = h.filter((x) => x.v != null).map((x) => x.v);
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

/* ---------- step chart: a price holds until the next change ---------- */

function stepPoints(h, t0, t1) {
  let i = -1;
  h.forEach((x, k) => { if (x.time <= t0) i = k; });
  const pts = i >= 0 ? [{ ...h[i], time: t0 }] : [];
  for (const x of h) if (x.time > t0 && x.time <= t1) pts.push(x);
  return pts;
}

function drawStep(svg, row, t0, t1, { w, h, m = { t: 4, r: 4, b: 4, l: 4 }, minFrac = 0.1, dotR = 2.5 }) {
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const flat = t1 - t0 < 60e3;
  const pts = flat ? [{ ...row.h[row.h.length - 1], time: t0 }] : stepPoints(row.h, t0, t1);
  const vals = pts.filter((p) => p.v != null).map((p) => p.v);
  const x0 = m.l, x1 = w - m.r, y0 = m.t, y1 = h - m.b;
  const sx = flat ? (t) => (t <= t0 ? x0 : x1) : (t) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, hi * minFrac) || 1;
  const mid = (lo + hi) / 2;
  lo = mid - span / 2; hi = mid + span / 2;
  const sy = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

  let d = "";
  let prevPriced = false;
  pts.forEach((p, k) => {
    const xa = sx(p.time), xb = sx(k + 1 < pts.length ? pts[k + 1].time : t1);
    if (p.v == null) {
      svg.append(svgEl("line", { class: "step-gap", x1: xa, x2: xb, y1: y1 - 1, y2: y1 - 1 }));
      prevPriced = false;
      return;
    }
    const y = sy(p.v).toFixed(1);
    d += `${prevPriced ? "L" : "M"}${xa.toFixed(1)},${y} L${xb.toFixed(1)},${y} `;
    prevPriced = true;
  });
  if (d) svg.append(svgEl("path", { class: "step-line", d }));
  const last = pts[pts.length - 1];
  if (last && last.v != null) svg.append(svgEl("circle", { class: "step-dot", cx: x1, cy: sy(last.v), r: dotR }));
  return { pts, sx, sy, x0, x1, y0, y1, lo: Math.min(...vals), hi: Math.max(...vals), priced: vals.length > 0 };
}

/* ---------- price board ---------- */

const BOARD_DEFAULTS = { view: "board", sort: "date", changedOnly: false, hideSoldOut: false };
const boardPrefs = (() => {
  try { return { ...BOARD_DEFAULTS, ...JSON.parse(localStorage.getItem("hpw.board") || "{}") }; }
  catch { return { ...BOARD_DEFAULTS }; }
})();
const saveBoardPrefs = () => {
  try { localStorage.setItem("hpw.board", JSON.stringify(boardPrefs)); } catch { /* storage unavailable */ }
};

const BOARD_COLS = 7;

const SORTS = {
  date: (a, b) => a.date.localeCompare(b.date),
  price: (a, b) => (a.now ?? Infinity) - (b.now ?? Infinity) || a.date.localeCompare(b.date),
  drop: (a, b) => (a.pct ?? Infinity) - (b.pct ?? Infinity) || a.date.localeCompare(b.date),
  recent: (a, b) => (b.changedAt ?? -Infinity) - (a.changedAt ?? -Infinity) || a.date.localeCompare(b.date),
};

function lastChangeCell(row, rate, currency) {
  const td = el("td", "change");
  if (!row.kind) {
    td.append(el("span", "muted", "no change"));
    return td;
  }
  const when = el("span", "when", ago(row.h[row.h.length - 1].t));
  if (row.kind === "down" || row.kind === "up") {
    td.append(el("span", `delta ${row.kind}`, pctText(row.pct)), when);
    td.title = `was ${priceText(row.prev, rate, currency)}`;
  } else if (row.kind === "back") {
    td.append(el("span", "pill neutral", "back on sale"), when);
  } else {
    td.append(el("span", "muted", `sold out · was ${priceText(row.prev, rate, currency)}`), when);
  }
  return td;
}

function renderBoard(card, scan) {
  const rate = scan.fx_rate, currency = scan.currency || "INR";
  const board = card._board;
  const rows = scanRows(scan);
  const tbody = card.querySelector(".board-table tbody");
  const count = card.querySelector(".board-count");
  for (const box of tbody.querySelectorAll(".date-detail")) box._observer?.disconnect();
  tbody.replaceChildren();
  if (!rows.length) {
    count.textContent = scan.latest ? "No upcoming dates in the window." : "No scan yet.";
    card.querySelector(".board-scroll").hidden = true;
    return;
  }
  card.querySelector(".board-scroll").hidden = false;

  const tEnd = Date.parse(scan.latest.run_at);
  const tStart = Math.min(rangeStart(Date.parse(scan.history[0].t)), tEnd);
  const changedInRange = (r) => r.h.some((x, i) => i > 0 && x.time >= tStart && changeKind(r.h[i - 1].v, x.v));
  card.querySelector(".col-hist").textContent =
    tEnd - tStart < 60e3 ? "History" : `History since ${fmtDate.format(new Date(tStart))}`;

  const minNow = Math.min(...rows.filter((r) => r.now != null).map((r) => r.now));
  renderCheapestLine(card, scan, rows, minNow);

  const changed = rows.filter(changedInRange);
  const shown = rows
    .filter((r) => !board.changedOnly || changedInRange(r))
    .filter((r) => !board.hideSoldOut || r.now != null)
    .sort(SORTS[board.sort]);
  count.textContent =
    `${shown.length === rows.length ? `${rows.length} dates` : `${shown.length} of ${rows.length} dates`} · ` +
    `${changed.length} changed ${rangeLabel()} · checked ${ago(scan.latest.run_at)}`;

  if (!shown.length) {
    const tr = el("tr", "board-empty");
    const td = el("td", null, "No dates match these filters. ");
    td.colSpan = BOARD_COLS;
    const clear = el("button", "link-button", "Clear filters");
    clear.type = "button";
    clear.addEventListener("click", () => setBoardPref(card, scan, { changedOnly: false, hideSoldOut: false }));
    td.append(clear);
    tr.append(td);
    tbody.append(tr);
    return;
  }

  let month = null;
  for (const row of shown) {
    if (board.sort === "date") {
      const m = row.date.slice(0, 7);
      if (m !== month) {
        month = m;
        const tr = el("tr", "month-row");
        const th = el("th", null, fmtMonth.format(localDate(row.date)));
        th.colSpan = BOARD_COLS;
        th.scope = "colgroup";
        tr.append(th);
        tbody.append(tr);
      }
    }
    const cheapest = row.now != null && row.now === minNow;
    const tr = el("tr", "board-row" + (row.now == null ? " is-soldout" : "") + (cheapest ? " is-cheapest" : ""));
    tr.dataset.date = row.date;
    const dateCell = el("th", "date", fmtShortDay.format(localDate(row.date)));
    dateCell.scope = "row";
    tr.append(dateCell);

    const priceCell = el("td", "num price");
    priceCell.append(el("strong", null, priceText(row.now, rate, currency)));
    if (row.now != null && row.distinct > 1 && row.now === row.lo) priceCell.append(el("span", "pill good", "lowest seen"));
    if (cheapest) priceCell.append(el("span", "cheapest-tag cheapest-tag--inline", "Cheapest"));
    if (row.now != null && currency !== "INR") priceCell.append(el("span", "native", money(currency).format(row.now)));
    tr.append(priceCell);

    const vs = el("td", "num col-vs");
    if (cheapest) vs.append(el("span", "cheapest-tag", "Cheapest"));
    else if (row.now == null) vs.append(el("span", "muted", "—"));
    else {
      const diff = row.now - minNow;
      vs.append(el("span", null, `+${rate ? INR.format(toInr(diff, rate)) : money(currency).format(diff)}`));
      vs.append(el("span", "vs-pct", `+${Math.round((diff / minNow) * 100)}%`));
    }
    tr.append(vs);

    tr.append(lastChangeCell(row, rate, currency));
    tr.append(el("td", "num col-seen muted",
      row.distinct > 1 && rate ? `${CMP.format(toInr(row.lo, rate))} – ${CMP.format(toInr(row.hi, rate))}` : "—"));

    const histCell = el("td", "col-hist");
    const spark = svgEl("svg", { class: "step", "aria-hidden": "true" });
    histCell.append(spark);
    tr.append(histCell);

    const toggleCell = el("td", "col-toggle");
    const btn = el("button", "row-toggle", "›");
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", `Price history for ${fmtWeekdayDate.format(localDate(row.date))}`);
    toggleCell.append(btn);
    tr.append(toggleCell);
    tbody.append(tr);
    drawStep(spark, row, tStart, tEnd, { w: 132, h: 28 });

    const toggle = () => toggleDetail(card, scan, row, tr, btn, tStart, tEnd);
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    tr.addEventListener("click", toggle);
    if (board.expanded.has(row.date)) toggle();
  }
}

const CHEAPEST_LISTED = 4;

function renderCheapestLine(card, scan, rows, minNow) {
  const box = card.querySelector(".board-cheapest");
  box.replaceChildren();
  if (!Number.isFinite(minNow)) {
    box.append(el("span", "muted", "No upcoming date is available right now."));
    return;
  }
  const rate = scan.fx_rate, currency = scan.currency || "INR";
  const dates = rows.filter((r) => r.now === minNow);
  box.append(el("span", "board-cheapest__label", "Cheapest now"));
  box.append(el("strong", "board-cheapest__price", priceText(minNow, rate, currency)));
  const list = el("span", "board-cheapest__dates");
  dates.slice(0, CHEAPEST_LISTED).forEach((r, i) => {
    if (i) list.append(document.createTextNode(", "));
    const b = el("button", "link-button", fmtShortDay.format(localDate(r.date)));
    b.type = "button";
    b.title = "Show this date's history";
    b.addEventListener("click", () => card._focusDate(r.date));
    list.append(b);
  });
  if (dates.length > CHEAPEST_LISTED) list.append(document.createTextNode(` and ${dates.length - CHEAPEST_LISTED} more`));
  box.append(list);
  if (card._board.sort !== "price") {
    const sortBtn = el("button", "chip", "Sort cheapest first");
    sortBtn.type = "button";
    sortBtn.addEventListener("click", () => setBoardPref(card, scan, { sort: "price" }));
    box.append(sortBtn);
  }
}

function toggleDetail(card, scan, row, tr, btn, tStart, tEnd) {
  const board = card._board;
  const open = tr.nextElementSibling?.classList.contains("row-detail");
  if (open) {
    tr.nextElementSibling.querySelector(".date-detail")._observer?.disconnect();
    tr.nextElementSibling.remove();
    board.expanded.delete(row.date);
    btn.setAttribute("aria-expanded", "false");
    tr.classList.remove("is-open");
    return;
  }
  board.expanded.add(row.date);
  btn.setAttribute("aria-expanded", "true");
  tr.classList.add("is-open");
  const detail = el("tr", "row-detail");
  const td = el("td");
  td.colSpan = BOARD_COLS;
  detail.append(td);
  tr.after(detail);
  td.append(renderDateDetail(scan, row, tStart, tEnd));
}

function renderDateDetail(scan, row, tStart, tEnd) {
  const rate = scan.fx_rate, currency = scan.currency || "INR";
  const box = el("div", "date-detail");

  const chartBox = el("div", "date-chart");
  const svg = svgEl("svg", { class: "step big", role: "img", tabindex: "0",
    "aria-label": `${fmtWeekdayDate.format(localDate(row.date))}: price history` });
  const tooltip = el("div", "tooltip");
  tooltip.hidden = true;
  chartBox.append(svg, tooltip);
  box.append(chartBox);

  const draw = () => {
    const w = Math.max(240, chartBox.clientWidth || 480), h = 132;
    const g = drawStep(svg, row, tStart, tEnd, { w, h, m: { t: 12, r: 12, b: 22, l: 58 }, minFrac: 0.06, dotR: 4 });
    for (const v of g.priced ? [...new Set([g.lo, g.hi])] : []) {
      const txt = svgEl("text", { class: "tick", x: g.x0 - 8, y: g.sy(v) + 4, "text-anchor": "end" });
      txt.textContent = rate ? CMP.format(toInr(v, rate)) : money(currency).format(v);
      svg.prepend(txt, svgEl("line", { class: "grid", x1: g.x0, x2: g.x1, y1: g.sy(v), y2: g.sy(v) }));
    }
    for (const [t, anchor, x] of [[tStart, "start", g.x0], [tEnd, "end", g.x1]]) {
      const txt = svgEl("text", { class: "tick", x, y: h - 4, "text-anchor": anchor });
      txt.textContent = tEnd - tStart < 60e3 ? fmtDateTime.format(new Date(tEnd)) : fmtDate.format(new Date(t));
      svg.append(txt);
      if (tEnd - tStart < 60e3) break;
    }
    const cross = svgEl("line", { class: "crosshair", y1: g.y0, y2: g.y1, visibility: "hidden" });
    const hit = svgEl("rect", { class: "hit", x: g.x0, y: 0, width: g.x1 - g.x0, height: h });
    svg.append(cross, hit);
    const pts = g.pts;
    let focus = -1;
    const show = (k, x) => {
      const p = pts[k];
      if (!p) return;
      focus = k;
      const px = x ?? g.sx(p.time);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
      const prev = k > 0 ? pts[k - 1].v : undefined;
      const kind = k > 0 ? changeKind(prev, p.v) : null;
      const until = k + 1 < pts.length ? fmtDateTime.format(new Date(pts[k + 1].time)) : "now";
      tooltip.replaceChildren(
        el("div", "tt-value", priceText(p.v, rate, currency)),
        ...(kind === "down" || kind === "up" ? [el("div", "tt-row plain", `${pctText(pctChange(prev, p.v))} from ${priceText(prev, rate, currency)}`)] : []),
        el("div", "tt-row plain", `${fmtDateTime.format(new Date(Math.max(p.time, tStart)))} → ${until}`),
      );
      placeTooltip(tooltip, chartBox, (px / w) * svg.clientWidth, 4);
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); tooltip.hidden = true; focus = -1; };
    hit.addEventListener("pointermove", (e) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * w;
      let k = 0;
      pts.forEach((p, i) => { if (g.sx(p.time) <= x) k = i; });
      show(k, Math.min(Math.max(x, g.x0), g.x1));
    });
    hit.addEventListener("pointerleave", hide);
    svg.onkeydown = (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        show(focus < 0 ? pts.length - 1 : Math.min(pts.length - 1, Math.max(0, focus + (e.key === "ArrowRight" ? 1 : -1))));
      } else if (e.key === "Escape") hide();
    };
    svg.onblur = hide;
  };
  box._observer = new ResizeObserver(draw);
  box._observer.observe(chartBox);

  const side = el("div", "date-side");
  const facts = el("dl", "facts");
  const fact = (k, v) => { if (v) facts.append(el("dt", null, k), el("dd", null, v)); };
  fact("Check-in", `${fmtWeekdayDate.format(localDate(row.date))} · ${scan.nights} night${scan.nights === 1 ? "" : "s"}`);
  fact("Plan", row.now != null ? row.p.plan : null);
  fact("Offer", row.now != null ? row.p.promo : null);
  if (row.now != null && currency !== "INR") fact("Hotel's price", money(currency).format(row.now));
  fact("Last checked", fmtDateTime.format(new Date(row.p.t)));
  side.append(facts);

  side.append(el("h5", null, row.h.length > 1 ? `Price changes (${row.h.length - 1})` : "Price changes"));
  const log = el("ol", "change-log");
  [...row.h].reverse().forEach((x, i, arr) => {
    const prev = arr[i + 1];
    const li = el("li");
    li.append(el("time", null, fmtDateTime.format(new Date(x.t))));
    li.lastChild.dateTime = x.t;
    li.append(el("span", "num", priceText(x.v, rate, currency)));
    const kind = prev ? changeKind(prev.v, x.v) : null;
    if (kind === "down" || kind === "up") li.append(el("span", `delta ${kind}`, pctText(pctChange(prev.v, x.v))));
    else if (!prev) li.append(el("span", "muted", "first seen"));
    else if (kind === "back") li.append(el("span", "muted", "back on sale"));
    log.append(li);
  });
  side.append(log);
  if (row.h.length === 1) side.append(el("p", "muted small", "Unchanged at every scan so far."));
  const book = el("a", "book-link", "Booking page ↗");
  book.href = scan.url; book.target = "_blank"; book.rel = "noopener";
  book.addEventListener("click", (e) => e.stopPropagation());
  side.append(book);
  box.append(side);
  return box;
}

function setBoardPref(card, scan, patch) {
  Object.assign(card._board, patch);
  for (const k of Object.keys(patch)) if (k in BOARD_DEFAULTS) boardPrefs[k] = patch[k];
  saveBoardPrefs();
  syncToolbar(card);
  renderBoard(card, scan);
}

function syncToolbar(card) {
  const b = card._board;
  for (const btn of card.querySelectorAll(".seg button")) btn.setAttribute("aria-checked", String(btn.dataset.view === b.view));
  card.querySelector(".board-view").hidden = b.view !== "board";
  card.querySelector(".calendar-view").hidden = b.view !== "calendar";
  card.querySelector(".board-controls").hidden = b.view !== "board";
  card.querySelector(".board-controls select").value = b.sort;
  for (const chip of card.querySelectorAll(".chip")) chip.setAttribute("aria-pressed", String(Boolean(b[chip.dataset.filter])));
}

function wireBoard(card, scan) {
  card._board = { ...boardPrefs, expanded: new Set() };
  for (const btn of card.querySelectorAll(".seg button")) {
    btn.addEventListener("click", () => setBoardPref(card, scan, { view: btn.dataset.view }));
  }
  card.querySelector(".board-controls select").addEventListener("change", (e) => setBoardPref(card, scan, { sort: e.target.value }));
  for (const chip of card.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => setBoardPref(card, scan, { [chip.dataset.filter]: !card._board[chip.dataset.filter] }));
  }
  syncToolbar(card);
  renderBoard(card, scan);
  // Deep link from the change feed: show this date's row opened, whatever the saved filters say.
  card._focusDate = (date) => {
    const b = card._board;
    if (!scanRows(scan).some((r) => r.date === date)) return false;  // past or outside the window
    Object.assign(b, { view: "board", changedOnly: false, hideSoldOut: false });
    b.expanded.add(date);
    syncToolbar(card);
    renderBoard(card, scan);
    const tr = card.querySelector(`.board-row[data-date="${date}"]`);
    if (!tr) return false;
    tr.scrollIntoView({ block: "center" });
    tr.classList.add("flash");
    return true;
  };
}

/* ---------- change feed ---------- */

const KIND_ORDER = { down: 0, back: 1, up: 2, soldout: 3 };

function changeFeed(data, onlyKey) {
  const groups = [];
  const today = isoDay(new Date());
  for (const scan of data.scans ?? []) {
    const key = hotelKey(scan.name);
    if (onlyKey && key !== onlyKey) continue;
    const byRun = new Map();
    for (const row of scanRows(scan)) {
      let low = Infinity;
      row.h.forEach((x, i) => {
        const prev = i ? row.h[i - 1].v : undefined;
        const kind = i ? changeKind(prev, x.v) : null;
        if (kind) {
          if (!byRun.has(x.t)) byRun.set(x.t, []);
          byRun.get(x.t).push({
            label: fmtShortDay.format(localDate(row.date)),
            sortKey: row.date,
            from: prev, to: x.v, kind, pct: pctChange(prev, x.v),
            newLow: kind === "down" && x.v < low,
            href: `${hotelHash(key)}/${encodeURIComponent(scan.id)}/${row.date}`,
          });
        }
        if (x.v != null) low = Math.min(low, x.v);
      });
    }
    for (const [t, items] of byRun) {
      groups.push({
        t, hotel: key, href: `${hotelHash(key)}/${encodeURIComponent(scan.id)}`,
        sub: `${roomTitle(scan.name)} · ${scan.nights}-night stays`,
        rate: scan.fx_rate, currency: scan.currency || "INR", items,
      });
    }
  }
  for (const t of data.targets) {
    const key = hotelKey(t.name);
    if ((onlyKey && key !== onlyKey) || t.check_in < today) continue;
    const rate = t.fx_rate;
    let low = Infinity;
    t.readings.forEach((r, i) => {
      const prev = i ? t.readings[i - 1].native : undefined;
      const kind = i ? changeKind(prev, r.native) : null;
      if (kind) {
        groups.push({
          t: r.t, hotel: key, href: `${hotelHash(key)}/${encodeURIComponent(t.id)}`,
          sub: `${roomTitle(t.name)} · watched stay`, rate, currency: t.currency || "INR",
          items: [{
            label: `${fmtDate.format(localDate(t.check_in))} → ${fmtDate.format(localDate(t.check_out))}`,
            sortKey: t.check_in, from: prev, to: r.native, kind, pct: pctChange(prev, r.native),
            newLow: kind === "down" && r.native < low,
            href: `${hotelHash(key)}/${encodeURIComponent(t.id)}`,
          }],
        });
      }
      if (r.native != null) low = Math.min(low, r.native);
    });
  }
  for (const g of groups) {
    g.time = Date.parse(g.t);
    g.items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      || (a.kind === "up" ? b.pct - a.pct : (a.pct ?? 0) - (b.pct ?? 0)) || a.sortKey.localeCompare(b.sortKey));
  }
  return groups.sort((a, b) => b.time - a.time);
}

const FEED_PREVIEW = 3;

// Following a link to the hash already shown fires no hashchange; jump to the item anyway.
function sameHashRerender(e) {
  if (location.hash === e.currentTarget.getAttribute("href")) {
    e.preventDefault();
    render();
  }
}

function feedGroup(g) {
  const li = el("li", "feed-group");
  const when = el("time", "feed-when", ago(g.t));
  when.dateTime = g.t;
  when.title = fmtDateTime.format(new Date(g.t));
  li.append(when);
  const main = el("div", "feed-main");
  const head = el("div", "feed-head");
  const a = el("a", "feed-hotel", g.hotel);
  a.href = g.href;
  a.addEventListener("click", sameHashRerender);
  head.append(a, el("span", "feed-sub", g.sub));
  main.append(head);

  if (g.items.length > FEED_PREVIEW) {
    const counts = {};
    for (const it of g.items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
    const summary = el("p", "feed-summary", `${g.items.length} dates changed: `);
    const parts = [
      ["down", (n) => `↓ ${n} cheaper`, "delta down"],
      ["back", (n) => `${n} back on sale`, ""],
      ["up", (n) => `↑ ${n} pricier`, "delta up"],
      ["soldout", (n) => `${n} sold out`, "muted"],
    ].filter(([k]) => counts[k]);
    parts.forEach(([k, text, cls], i) => {
      if (i) summary.append(document.createTextNode(" · "));
      summary.append(el("span", cls, text(counts[k])));
    });
    main.append(summary);
  }

  const list = el("ul", "feed-items");
  g.items.forEach((it, i) => {
    const row = el("li");
    if (i >= FEED_PREVIEW) row.hidden = true;
    const link = el("a", "feed-date", it.label);
    link.href = it.href;
    link.addEventListener("click", sameHashRerender);
    row.append(link);
    const prices = el("span", "feed-prices");
    if (it.kind === "soldout") {
      prices.append(el("span", "muted", `${priceText(it.from, g.rate, g.currency)} → sold out`));
    } else if (it.kind === "back") {
      prices.append(el("span", "muted", "sold out → "), el("strong", null, priceText(it.to, g.rate, g.currency)));
    } else {
      prices.append(el("span", "muted", `${priceText(it.from, g.rate, g.currency)} → `), el("strong", null, priceText(it.to, g.rate, g.currency)));
      prices.append(el("span", `delta ${it.kind}`, pctText(it.pct)));
    }
    if (it.newLow) prices.append(el("span", "pill good", "new low"));
    row.append(prices);
    list.append(row);
  });
  main.append(list);
  if (g.items.length > FEED_PREVIEW) {
    const more = el("button", "link-button", `Show all ${g.items.length}`);
    more.type = "button";
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const open = more.getAttribute("aria-expanded") !== "true";
      [...list.children].forEach((c, i) => { if (i >= FEED_PREVIEW) c.hidden = !open; });
      more.setAttribute("aria-expanded", String(open));
      more.textContent = open ? "Show fewer" : `Show all ${g.items.length}`;
    });
    main.append(more);
  }
  li.append(main);
  return li;
}

function renderFeed(groups, { title, limit, step, emptyText }) {
  const section = el("section", "feed");
  section.append(el("h2", "section-title", title));
  if (!groups.length) {
    section.append(el("p", "section-sub", emptyText));
    return section;
  }
  const list = el("ol", "feed-list");
  section.append(list);
  let shown = 0;
  const more = el("button", "link-button feed-more");
  more.type = "button";
  const showMore = (n) => {
    for (const g of groups.slice(shown, shown + n)) list.append(feedGroup(g));
    shown = Math.min(groups.length, shown + n);
    more.hidden = shown >= groups.length;
    more.textContent = `Show older changes (${groups.length - shown})`;
  };
  more.addEventListener("click", () => showMore(step));
  showMore(limit);
  section.append(more);
  return section;
}

/* ---------- one exchange rate for all history ---------- */

// Re-express every ₹ figure at the latest rate (the hotel's own price is kept in ``native``).
// Converting each reading at its own day's rate made currency drift look like price changes.
function normalizeFx(data) {
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
    const low = priced.reduce((a, b) => (b.price < a.price ? b : a));
    Object.assign(t.stats, {
      current: priced[priced.length - 1].price,
      current_fx_rate: rate,
      lowest: low.price,
      lowest_at: low.t,
      highest: Math.max(...priced.map((r) => r.price)),
      first: priced[0].price,
      below_alert: t.alert_below != null && priced[priced.length - 1].price < t.alert_below,
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

/* ---------- page: overview list + per-hotel detail, hash-routed ---------- */

const hotelKey = (name) => name.split(" · ")[0].trim();
const hotelHash = (key) => `#/hotel/${encodeURIComponent(key)}`;

function groupHotels(data) {
  const map = new Map();
  const add = (item, kind) => {
    const key = hotelKey(item.name);
    if (!map.has(key)) map.set(key, { key, name: key, targets: [], scans: [] });
    map.get(key)[kind].push(item);
  };
  for (const t of data.targets) add(t, "targets");
  for (const s of data.scans ?? []) add(s, "scans");
  return [...map.values()];
}

function route() {
  const m = location.hash.match(/^#\/hotel\/([^/]+)(?:\/([^/]+))?(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  return m ? { key: decodeURIComponent(m[1]), item: m[2] && decodeURIComponent(m[2]), date: m[3] } : null;
}

function focusItem({ item, date }) {
  const scanCard = [...document.querySelectorAll(".scan-card")].find((c) => c.dataset.scanId === item);
  if (scanCard) {
    if (!(date && scanCard._focusDate(date))) scanCard.scrollIntoView({ block: "start" });
    return;
  }
  const stay = document.getElementById(`stay-${item}`);
  if (stay) {
    stay.scrollIntoView({ block: "start" });
    stay.classList.add("flash");
  }
}

function sparkline(readings) {
  const pts = readings.filter((r) => r.price != null).slice(-30);
  const w = 120, h = 32;
  const svg = svgEl("svg", { class: "spark", viewBox: `0 0 ${w} ${h}`, "aria-hidden": "true" });
  if (pts.length < 2) return svg;
  const lo = Math.min(...pts.map((p) => p.price)), hi = Math.max(...pts.map((p) => p.price));
  const sx = (i) => 2 + (i / (pts.length - 1)) * (w - 4);
  const sy = (v) => (hi === lo ? h / 2 : 4 + (1 - (v - lo) / (hi - lo)) * (h - 8));
  svg.append(svgEl("path", { class: "spark-line", d: pts.map((p, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${sy(p.price).toFixed(1)}`).join(" ") }));
  svg.append(svgEl("circle", { class: "spark-dot", cx: sx(pts.length - 1), cy: sy(pts[pts.length - 1].price), r: 2.5 }));
  return svg;
}

function overviewRow(group) {
  const a = el("a", "hotel-row");
  a.href = hotelHash(group.key);
  const left = el("div", "hotel-row__main");
  left.append(el("h2", "hotel-row__name", group.name));
  const lines = el("ul", "hotel-row__lines");

  for (const t of group.targets) {
    const fmt = INR;
    const li = el("li", "line");
    const label = el("span", "line__label");
    label.append(el("span", "line__room", t.room.split(" · ").pop()));
    label.append(document.createTextNode(` · ${fmtDate.format(localDate(t.check_in))} → ${fmtDate.format(localDate(t.check_out))}, ${t.nights}n`));
    li.append(label);
    const val = el("span", "line__value");
    const s = t.stats;
    if (s.current == null) {
      val.append(el("span", "muted", t.readings.length ? "Unavailable" : "No reading yet"));
    } else {
      val.append(el("strong", null, fmt.format(s.current)));
      if (s.change_pct_vs_prev) {
        const down = s.change_pct_vs_prev < 0;
        val.append(el("span", "delta " + (down ? "down" : "up"), `${down ? "↓" : "↑"}${Math.abs(s.change_pct_vs_prev)}%`));
      }
      if (s.below_alert) val.append(el("span", "pill good", "below alert"));
      else if (!s.available) val.append(el("span", "pill neutral", "last seen"));
    }
    li.append(val);
    lines.append(li);
  }
  for (const sc of group.scans) {
    const fmt = INR;
    const li = el("li", "line");
    const label = el("span", "line__label");
    const room = group.scans.length > 1 ? `${sc.room} · ` : "";
    label.append(el("span", "line__room", `${room}${sc.nights}-night stays`));
    label.append(document.createTextNode(` · ${fmtDate.format(localDate(sc.from))} → ${fmtDate.format(localDate(sc.to))}`));
    li.append(label);
    const val = el("span", "line__value");
    const last = sc.history[sc.history.length - 1];
    if (!last || last.min == null) {
      val.append(el("span", "muted", "No scan yet"));
    } else {
      val.append(document.createTextNode("cheapest "));
      val.append(el("strong", null, fmt.format(last.min)));
      val.append(document.createTextNode(` on ${fmtDate.format(localDate(last.min_date))}`));
    }
    li.append(val);
    lines.append(li);
  }
  left.append(lines);
  a.append(left);

  const right = el("div", "hotel-row__side");
  const primary = group.targets.find((t) => t.readings.length);
  if (primary) right.append(sparkline(primary.readings));
  right.append(el("span", "chev", "›"));
  a.append(right);
  return a;
}

function navSummary(group) {
  const t = group.targets.find((x) => x.stats.current != null);
  if (t) return `${INR.format(t.stats.current)} · ${t.nights}n`;
  const s = group.scans.find((x) => x.history.length && x.history[x.history.length - 1].min != null);
  if (s) return `from ${INR.format(s.history[s.history.length - 1].min)}`;
  return "no data yet";
}

function renderNav(data, activeKey) {
  const nav = document.getElementById("hotel-nav");
  nav.replaceChildren();
  const overview = el("a", "nav-item" + (activeKey ? "" : " active"));
  overview.href = "#/";
  overview.append(el("span", "nav-item__name", "Overview"));
  overview.append(el("span", "nav-item__sub", `${groupHotels(data).length} hotels`));
  if (!activeKey) overview.setAttribute("aria-current", "page");
  nav.append(overview);
  nav.append(el("div", "nav-label", "Hotels"));
  for (const g of groupHotels(data)) {
    const a = el("a", "nav-item" + (g.key === activeKey ? " active" : ""));
    a.href = hotelHash(g.key);
    if (g.key === activeKey) a.setAttribute("aria-current", "page");
    a.append(el("span", "nav-item__name", g.name));
    const sub = el("span", "nav-item__sub", navSummary(g));
    const flagged = g.targets.some((t) => t.stats.below_alert);
    if (flagged) sub.prepend(el("span", "nav-dot", ""));
    a.append(sub);
    nav.append(a);
  }
}

function renderOverview(data) {
  const view = document.getElementById("view");
  view.replaceChildren();
  document.title = "Hotel price watch";
  document.querySelector(".filters").hidden = true;
  const groups = groupHotels(data);
  view.append(el("h1", "detail-title", "Overview"));
  if (!groups.length) {
    view.append(el("p", "empty", "Nothing in the watchlist yet."));
    return;
  }
  const strip = el("p", "summary-strip",
    `${groups.length} hotel${groups.length === 1 ? "" : "s"} · ${data.targets.length} stay${data.targets.length === 1 ? "" : "s"} watched · ${(data.scans ?? []).length} date scan${(data.scans ?? []).length === 1 ? "" : "s"}`);
  view.append(strip);
  view.append(renderFeed(changeFeed(data), {
    title: "What changed",
    limit: 5,
    step: 10,
    emptyText: "No price changes yet. Every scan is compared with the one before it, and changes show up here.",
  }));
  view.append(el("h2", "section-title", "Hotels"));
  const list = el("div", "overview");
  for (const g of groups) list.append(overviewRow(g));
  view.append(list);
  view.append(el("p", "page-footer", "All prices in ₹. Hotels priced in another currency are converted at the latest exchange rate, so the history only moves when the hotel changes its own price; the original figure is shown alongside. Each card says whether totals are before or after tax."));
}

function hotelGlance(group) {
  const box = el("div", "glance");
  const item = (href, label, value, note, opts = {}) => {
    const a = el("a", "glance-item" + (opts.good ? " is-good" : ""));
    a.href = href;
    a.addEventListener("click", sameHashRerender);
    a.append(el("span", "glance-label", label), el("span", "glance-value" + (opts.muted ? " muted" : ""), value));
    if (note) a.append(el("span", "glance-note", note));
    box.append(a);
  };
  for (const scan of group.scans) {
    const rows = scanRows(scan).filter((r) => r.now != null);
    const label = `Cheapest ${scan.nights}-night check-in`;
    if (!rows.length) {
      item(`${hotelHash(group.key)}/${encodeURIComponent(scan.id)}`, label, "—", `${scan.room} · nothing available`, { muted: true });
      continue;
    }
    const min = Math.min(...rows.map((r) => r.now));
    const ties = rows.filter((r) => r.now === min);
    item(
      `${hotelHash(group.key)}/${encodeURIComponent(scan.id)}/${ties[0].date}`,
      label,
      priceText(min, scan.fx_rate, scan.currency || "INR"),
      `${scan.room} · ${fmtShortDay.format(localDate(ties[0].date))}${ties.length > 1 ? ` + ${ties.length - 1} more` : ""}`,
      { good: true },
    );
  }
  for (const t of group.targets) {
    const s = t.stats;
    const label = `Your stay · ${fmtDate.format(localDate(t.check_in))} → ${fmtDate.format(localDate(t.check_out))}`;
    const href = `${hotelHash(group.key)}/${encodeURIComponent(t.id)}`;
    if (s.current == null) item(href, label, "—", `${t.room} · ${t.readings.length ? "unavailable so far" : "no reading yet"}`, { muted: true });
    else if (!s.available) item(href, label, "Unavailable", `${t.room} · last ${INR.format(s.current)}`, { muted: true });
    else item(href, label, INR.format(s.current), `${t.room} · lowest seen ${INR.format(s.lowest)}`);
  }
  return box;
}

function renderDetail(group) {
  const view = document.getElementById("view");
  view.replaceChildren();
  document.title = `${group.name} · Hotel price watch`;
  const head = el("div", "detail-head");
  head.append(el("h1", "detail-title", group.name));
  const link = el("a", "book-link", "Booking page ↗");
  link.href = (group.targets[0] || group.scans[0]).url;
  link.target = "_blank"; link.rel = "noopener";
  head.append(link);
  view.append(head);
  view.append(hotelGlance(group));
  const feed = changeFeed(state.data, group.key);
  if (feed.length) view.append(renderFeed(feed, { title: "Recent changes", limit: 3, step: 10, emptyText: "" }));
  document.querySelector(".filters").hidden = false;
  view.append(document.querySelector(".filters"));
  if (group.targets.length) {
    view.append(el("h2", "section-title", "Watched stays"));
    for (const t of group.targets) view.append(renderCard(t));
  }
  if (group.scans.length) {
    view.append(el("h2", "section-title", "Cheapest dates"));
    view.append(el("p", "section-sub", "Every upcoming check-in date in the window, priced daily for a fixed stay length. The board shows each date's price now and how it has moved; open a row for its full history. The calendar shows the same prices by weekday."));
    for (const s of group.scans) view.append(renderScanCard(s));
  }
}

function render() {
  const { data } = state;
  if (!data) return;
  // Park the range filter outside the view so replacing the view never destroys it.
  document.getElementById("filters-slot").append(document.querySelector(".filters"));
  const r = route();
  const group = r && groupHotels(data).find((g) => g.key === r.key);
  renderNav(data, group ? group.key : null);
  if (group) renderDetail(group);
  else {
    if (r) history.replaceState(null, "", "#/");
    renderOverview(data);
  }
  document.getElementById("view").scrollTo?.(0, 0);
  window.scrollTo(0, 0);
  if (group && r.item) focusItem(r);
}

function setRange(range) {
  state.range = range;
  for (const b of document.querySelectorAll(".filters button")) b.setAttribute("aria-checked", String(b.dataset.range === range));
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
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  window.addEventListener("hashchange", render);
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = normalizeFx(await res.json());
    const updated = document.getElementById("updated");
    updated.textContent = fmtDateTime.format(new Date(state.data.generated_at));
    updated.dateTime = state.data.generated_at;
    render();
  } catch (err) {
    document.getElementById("view").replaceChildren(
      el("p", "empty", "Could not load price data yet. The first scheduled run creates it."),
    );
    console.error(err);
  }
}

init();
