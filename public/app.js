// All scoring runs here from precomputed per-PR credits so sliders and the autonomy toggle re-rank live.
// Rules mirror scripts/analyze.ts and the "How it's scored" overlay.
const LENSES = [
  { key: "shipped", label: "Shipped to users", cls: "s1" },
  { key: "fixed", label: "Fixed what hurt", cls: "s2" },
  { key: "leverage", label: "Multiplied others", cls: "s3" },
  { key: "risk", label: "Carried risk, held", cls: "s4" },
];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pctf = (x) => Math.round(x * 100);
const fmt = (x, d = 1) => Number(x).toFixed(d);
const ordinal = (n) => { const v = n % 100; return n + (v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"); };
let DATA, state = { weights: null, includeFA: false, selected: null }, ROWS = [];

const normalize = (w) => { const s = LENSES.reduce((a, L) => a + w[L.key], 0) || 1; return Object.fromEntries(LENSES.map((L) => [L.key, w[L.key] / s])); };
const topK = (arrs, k) => arrs.flat().sort((a, b) => b - a).slice(0, k).reduce((a, b) => a + b, 0);

function rawScores(e) {
  const inc = state.includeFA, m = DATA.meta;
  const lens = (L, k) => topK([L.hd, inc ? L.fa : []], k) + 0.001 * (L.totalHd + (inc ? L.totalFa : 0));
  return { shipped: lens(e.shipped, m.topK), fixed: lens(e.fixed, m.topK), leverage: e.reviewScore + topK([e.infra.hd, inc ? e.infra.fa : []], m.infraK), risk: lens(e.risk, m.topK) };
}
const compositeOf = (r, W) => LENSES.reduce((a, L) => a + W[L.key] * r.pct[L.key], 0);

function compute() {
  const m = DATA.meta, W = normalize(state.weights);
  const rows = DATA.engineers.map((e) => {
    const counted = e.counts.hd + (state.includeFA ? e.counts.fa : 0);
    const span = state.includeFA ? e.spanAllDays : e.spanDays;
    return { e, counted, eligible: (counted >= m.minPRs && span >= m.minSpanDays) || e.substantive >= m.minReviews, raw: rawScores(e), pct: {} };
  }).filter((r) => r.eligible);
  const n = rows.length;
  for (const L of LENSES) { const vals = rows.map((r) => r.raw[L.key]).sort((a, b) => a - b); for (const r of rows) { const x = r.raw[L.key]; let lo = 0, hi = vals.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] < x) lo = mid + 1; else hi = mid; } r.pct[L.key] = x <= 0 ? 0 : lo / Math.max(1, n - 1); } }
  for (const r of rows) r.composite = compositeOf(r, W);
  rows.sort((a, b) => b.composite - a.composite);
  rows.forEach((r, i) => (r.rank = i + 1));
  ROWS = rows;
  return rows;
}

function render() {
  const rows = compute(), W = normalize(state.weights), m = DATA.meta, t = m.totals;
  if (!state.selected || !rows.some((r) => r.e.login === state.selected)) state.selected = rows[0]?.e.login ?? null;
  $("#stats").innerHTML = `<div><div class="n" style="font-size:13px;line-height:24px">${m.window.start} → ${m.window.end}</div><div class="l">merged window</div></div>` + [[t.mergedPRs, "merged PRs read"], [t.counted + (state.includeFA ? t.fullyAutonomousAssigned : 0), "credited to a human"], [t.fullyAutonomous, "fully autonomous"], [rows.length, "engineers eligible"]].map(([n, l]) => `<div><div class="n">${n.toLocaleString()}</div><div class="l">${l}</div></div>`).join("");
  $("#legend").innerHTML = LENSES.map((L) => `<span class="${L.cls}">${L.label}</span>`).join("");
  $("#top5").innerHTML = rows.slice(0, 5).map((r) => {
    const e = r.e, agent = e.counts.hd ? pctf(e.counts.agentAssisted / e.counts.hd) : 0;
    const segs = LENSES.map((L) => `<i class="${L.cls}" style="width:${(W[L.key] * r.pct[L.key] * 100).toFixed(2)}%;background:var(--${L.cls})" title="${L.label}: ${pctf(r.pct[L.key])}th percentile × ${pctf(W[L.key])}% weight"></i>`).join("");
    return `<li class="row${r.e.login === state.selected ? " sel" : ""}" data-login="${esc(e.login)}">
      <div class="rk">${r.rank}</div><img src="https://github.com/${esc(e.login)}.png?size=72" alt="" loading="lazy">
      <div class="main"><div class="head"><a class="login" href="https://github.com/PostHog/posthog/pulls?q=is%3Apr+is%3Amerged+assignee%3A${esc(e.login)}" target="_blank" rel="noopener">${esc(e.login)}</a>
        <span class="muted small">${LENSES.map((L) => `${L.label.split(" ")[0]} ${pctf(r.pct[L.key])}`).join(" · ")}</span>
        <span class="comp">${pctf(r.composite)}<small>/100</small></span></div>
      <div class="bar" role="img" aria-label="composite ${pctf(r.composite)}">${segs}</div>
      <div class="chips"><span>${r.counted} credited PRs</span><span>${agent}% agent-assisted</span><span>${e.substantive} substantive reviews${e.oversight ? ` (${e.oversight} of agent PRs)` : ""}</span>${e.reverted ? `<span class="st weak">${e.reverted} reverted</span>` : ""}</div></div></li>`;
  }).join("");
  $("#nextTable tbody").innerHTML = rows.slice(5, 20).map((r) => `<tr data-login="${esc(r.e.login)}"><td>${r.rank}</td><td><a href="#" data-sel="${esc(r.e.login)}">${esc(r.e.login)}</a></td><td class="num"><b>${pctf(r.composite)}</b></td>${LENSES.map((L) => `<td class="num">${pctf(r.pct[L.key])} <span class="muted">(${fmt(r.raw[L.key], 1)})</span></td>`).join("")}<td class="num">${r.counted}</td><td class="num">${r.e.substantive}</td></tr>`).join("");
  renderWhy(rows.find((r) => r.e.login === state.selected));
}

function renderWhy(r) {
  const el = $("#why");
  if (!r) { el.innerHTML = "<p class='muted'>Select an engineer.</p>"; return; }
  const e = r.e, ev = e.evidence, W = normalize(state.weights);
  const agent = e.counts.hd ? pctf(e.counts.agentAssisted / e.counts.hd) : 0;
  const head = `<h2><img src="https://github.com/${esc(e.login)}.png?size=48" alt="">#${r.rank} ${esc(e.login)} <span class="muted small">composite ${pctf(r.composite)}/100</span></h2>
    <p class="meta">${r.counted} credited PRs over ${state.includeFA ? e.spanAllDays : e.spanDays} days (${agent}% agent-assisted${e.counts.fa ? `, ${e.counts.fa} fully-autonomous ${state.includeFA ? "included" : "not counted"}` : ""}) · ${e.substantive} substantive reviews across ${e.distinctAuthors} authors${e.oversight ? `, ${e.oversight} overseeing agent PRs` : ""} · ${e.reverted} reverted, ${e.hotfixed} hot-fixed</p>`;
  if (!ev) { el.innerHTML = head + "<p class='muted'>Detailed evidence is stored for the 40 highest-ranked engineers only; rerun the analysis to widen it.</p>"; return; }
  const scopes = ev.scopes.length ? `<div class="scopes">${ev.scopes.map((s) => `<span>${esc(s.scope)} · ${s.n}</span>`).join("")}</div>` : "";
  const li = (c) => `<li><span><a href="${esc(c.url)}" target="_blank" rel="noopener">#${c.pr}</a> ${esc(c.title)}<br><span class="w">${esc(c.why)}</span></span><span class="c">${fmt(c.credit, 2)}${c.bucket === "fa" ? " ⚙" : ""}</span></li>`;
  const pick = (list) => list.filter((c) => c.bucket === "hd" || state.includeFA).slice(0, 4);
  const block = (idx, L, raw, items, extra = "") => `<div class="lens l${idx}"><h3>${L.label}<span class="pct">${ordinal(pctf(r.pct[L.key]))}<small> pct · raw ${fmt(raw, 1)} · weight ${pctf(W[L.key])}%</small></span></h3>${extra}<ul>${items}</ul></div>`;
  const reviews = ev.reviews.map((v) => `<li><span><a href="${esc(v.url)}" target="_blank" rel="noopener">#${v.pr}</a> ${esc(v.title)}<br><span class="w">${v.state} on @${esc(v.author)}'s PR, ${v.inline} inline comment${v.inline === 1 ? "" : "s"}${v.pushedAfter ? ", author pushed commits after" : ""}${v.oversight ? ", agent-authored PR" : ""}</span></span><span class="c">${fmt(v.credit, 2)}</span></li>`).join("");
  const infra = pick(ev.infra).map(li).join("");
  el.innerHTML = head + scopes +
    block(1, LENSES[0], r.raw.shipped, pick(ev.shipped).map(li).join("") || "<li class='muted'>No shipped features credited.</li>") +
    block(2, LENSES[1], r.raw.fixed, pick(ev.fixed).map(li).join("") || "<li class='muted'>No fixes credited.</li>") +
    block(3, LENSES[2], r.raw.leverage, reviews + infra || "<li class='muted'>No substantive reviews or shared-tooling PRs.</li>", `<p class="muted small" style="margin:0 0 4px">Review score ${fmt(e.reviewScore, 1)} from ${e.substantive} reviews across ${e.distinctAuthors} authors (${e.pushedAfter} followed by new commits).</p>`) +
    block(4, LENSES[3], r.raw.risk, pick(ev.risk).map(li).join("") || "<li class='muted'>No risk credited.</li>");
}

function buildControls() {
  $("#sliders").innerHTML = LENSES.map((L) => `<label><span>${L.label} <b data-w="${L.key}">${pctf(state.weights[L.key])}%</b></span><input type="range" min="0" max="100" value="${pctf(state.weights[L.key])}" data-k="${L.key}"></label>`).join("");
  $("#sliders").addEventListener("input", (ev) => { const k = ev.target.dataset.k; if (!k) return; state.weights[k] = Number(ev.target.value) / 100; const W = normalize(state.weights); for (const L of LENSES) $(`[data-w="${L.key}"]`).textContent = pctf(W[L.key]) + "%"; render(); });
  $("#faToggle").addEventListener("change", (ev) => { state.includeFA = ev.target.checked; render(); });
  $("#resetBtn").addEventListener("click", () => { state.weights = { ...DATA.meta.weights }; for (const L of LENSES) { $(`input[data-k="${L.key}"]`).value = pctf(state.weights[L.key]); $(`[data-w="${L.key}"]`).textContent = pctf(state.weights[L.key]) + "%"; } render(); });
  $("#top5").addEventListener("click", (ev) => { if (ev.target.closest("a")) return; const li = ev.target.closest("li[data-login]"); if (li) { state.selected = li.dataset.login; render(); } });
  $("#nextTable").addEventListener("click", (ev) => { const a = ev.target.closest("a[data-sel]"); if (a) { ev.preventDefault(); state.selected = a.dataset.sel; render(); $("#why").scrollTop = 0; } });
  $("#howBtn").addEventListener("click", () => ($("#overlay").hidden = false));
  $("#closeBtn").addEventListener("click", () => ($("#overlay").hidden = true));
  $("#overlay").addEventListener("click", (ev) => { if (ev.target === $("#overlay")) $("#overlay").hidden = true; });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") $("#overlay").hidden = true; });
}

fetch("data.json").then((r) => r.json()).then((d) => { DATA = d; state.weights = { ...d.meta.weights }; buildControls(); render(); }).catch((err) => { $("#stats").textContent = "Could not load data.json: " + err; });
