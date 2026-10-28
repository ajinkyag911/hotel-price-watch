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
  card.querySelector(".card-title").textContent = roomTitle(target.name);
  card.querySelector(".card-meta").textContent =
    `${fmtDate.format(localDate(target.check_in))} → ${fmtDateYear.format(localDate(target.check_out))} · ` +
    `${target.nights} night${target.nights === 1 ? "" : "s"} · ${guestsLabel(target)}` +
    `${target.rate_plan ? ` · ${target.rate_plan} plans` : ""} · totals ${basisLabel(target.price_basis)}` +
    `${currency !== "INR" ? ` · priced in ${currency}, shown in ₹ at the day's rate` : ""}`;
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
  card.querySelector(".card-title").textContent = roomTitle(scan.name);
  card.querySelector(".card-meta").textContent =
    `${scan.nights}-night stays · check-ins ${fmtDate.format(localDate(scan.from))} → ${fmtDateYear.format(localDate(scan.to))} · ` +
    `${guestsLabel(scan)}${scan.rate_plan ? ` · ${scan.rate_plan} plans` : ""} · totals ${basisLabel(scan.price_basis)}` +
    `${currency !== "INR" ? ` · priced in ${currency}, shown in ₹ at the day's rate` : ""}`;
  card.querySelector(".book-link").href = scan.url;

  const tiles = card.querySelector(".tiles");
  const latest = scan.latest;
  const priced = latest ? latest.points.filter((p) => p.price != null) : [];
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
    renderTile(tiles, "Cheapest check-in", fmt.format(best.price), {
      delta,
      note: `${fmtWeekdayDate.format(localDate(best.check_in))}${best.native != null && currency !== "INR" ? ` · ${money(currency).format(best.native)}` : ""}${best.promo ? ` · ${best.promo}` : ""}`,
    });
    renderTile(tiles, "Median across dates", fmt.format(med), { note: `${priced.length} of ${latest.points.length} dates available` });
    renderTile(tiles, "Most expensive", fmt.format(sorted[sorted.length - 1].price), {
      note: fmtWeekdayDate.format(localDate(sorted[sorted.length - 1].check_in)),
    });
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
    card._redraw = draw;
  }
  return card;
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
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
  const m = location.hash.match(/^#\/hotel\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
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
    label.append(el("span", "line__room", `${sc.nights}-night stays`));
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
  const list = el("div", "overview");
  for (const g of groups) list.append(overviewRow(g));
  view.append(list);
  view.append(el("p", "page-footer", "All prices in ₹, converted at the ECB reference rate of the day each reading was taken. Hotels priced in another currency show the original figure alongside. Each card says whether totals are before or after tax."));
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
  document.querySelector(".filters").hidden = false;
  view.append(document.querySelector(".filters"));
  if (group.targets.length) {
    view.append(el("h2", "section-title", "Watched stays"));
    for (const t of group.targets) view.append(renderCard(t));
  }
  if (group.scans.length) {
    view.append(el("h2", "section-title", "Cheapest dates"));
    view.append(el("p", "section-sub", "Every check-in date in the window, priced daily for a fixed stay length. Colour runs from cheapest to priciest; outlined cells are the five cheapest."));
    for (const s of group.scans) view.append(renderScanCard(s));
  }
}

function render() {
  const { data } = state;
  if (!data) return;
  // Park the range filter outside the view so replacing the view never destroys it.
  document.getElementById("filters-slot").append(document.querySelector(".filters"));
  const key = route();
  const group = key && groupHotels(data).find((g) => g.key === key);
  renderNav(data, group ? group.key : null);
  if (group) renderDetail(group);
  else {
    if (key) history.replaceState(null, "", "#/");
    renderOverview(data);
  }
  document.getElementById("view").scrollTo?.(0, 0);
  window.scrollTo(0, 0);
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
    state.data = await res.json();
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
