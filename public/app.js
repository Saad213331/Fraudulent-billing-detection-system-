"use strict";
// Front end for the fraud dashboard. Plain JavaScript, no libraries.
// All providers are loaded once, so the threshold slider updates everything live in the browser.

const FEATURES = ["n_claims", "n_bene", "reimb_sum", "reimb_mean", "reimb_max", "ip_ratio", "dup_ratio",
  "round_ratio", "n_proc_mean", "n_diag_mean", "claims_per_bene", "reimb_per_bene"];
const KEY_FEATURES = ["reimb_sum", "reimb_mean", "n_claims", "ip_ratio", "dup_ratio", "round_ratio",
  "n_proc_mean", "n_diag_mean"];
const LABELS = {
  n_claims: "Claims", n_bene: "Beneficiaries", reimb_sum: "Total reimbursed", reimb_mean: "Mean claim amount",
  reimb_max: "Largest claim", ip_ratio: "Inpatient share", dup_ratio: "Duplicate-claim share",
  round_ratio: "Round-amount share", n_proc_mean: "Avg procedures per claim", n_diag_mean: "Avg diagnoses per claim",
  claims_per_bene: "Claims per beneficiary", reimb_per_bene: "Reimbursed per beneficiary",
};
const MONEY = ["reimb_sum", "reimb_mean", "reimb_max", "reimb_per_bene"];
const RATIO = ["ip_ratio", "dup_ratio", "round_ratio"];

const S = {
  all: [], medians: {}, metrics: null, modelThr: 0.5, thr: 0.5,
  search: "", risk: "all", sortField: "fraud_probability", sortDir: "desc",
  page: 1, pageSize: 25, selected: null, upload: null, current: "providers",
};

const $ = (id) => document.getElementById(id);

// ---------- small helpers ----------

// Escape text before putting it into HTML
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const money = (v) => "$" + nf0.format(v);
const percent = (v, digits = 1) => (v * 100).toFixed(digits) + "%";

function fmtFeature(key, v) {
  if (MONEY.includes(key)) return money(v);
  if (RATIO.includes(key)) return percent(v);
  return nf2.format(v);
}

// Risk rule (same as the server): High if p >= threshold, Medium if p >= threshold / 2, else Low
function riskOf(p) {
  if (p >= S.thr) return "High";
  if (p >= S.thr / 2) return "Medium";
  return "Low";
}
const badge = (level) => `<span class="badge badge-${level.toLowerCase()}">${level}</span>`;

async function getJson(url) {
  const res = await fetch(url);
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

function showBanner(message) {
  $("banner").textContent = message;
  $("banner").hidden = !message;
}

// ---------- providers page ----------

function filtered() {
  const q = S.search.trim().toLowerCase();
  const rows = S.all.filter((p) =>
    (!q || p.Provider.toLowerCase().includes(q)) &&
    (S.risk === "all" || riskOf(p.fraud_probability).toLowerCase() === S.risk));
  const dir = S.sortDir === "asc" ? 1 : -1;
  const k = S.sortField;
  rows.sort((a, b) => {
    const c = typeof a[k] === "string" ? a[k].localeCompare(b[k]) : a[k] - b[k];
    return c ? c * dir : a.Provider.localeCompare(b.Provider);
  });
  return rows;
}

function renderKpis() {
  const flagged = S.all.filter((p) => p.fraud_probability >= S.thr);
  const counts = { High: 0, Medium: 0, Low: 0 };
  for (const p of S.all) counts[riskOf(p.fraud_probability)]++;
  $("kpi-total").textContent = nf0.format(S.all.length);
  $("kpi-flagged").textContent = nf0.format(flagged.length);
  $("kpi-pct").textContent = S.all.length ? percent(flagged.length / S.all.length) : "0%";
  $("kpi-money").textContent = money(flagged.reduce((s, p) => s + p.reimb_sum, 0));
  $("risk-line").textContent = `High: ${counts.High}  |  Medium: ${counts.Medium}  |  Low: ${counts.Low}`;
}

function providerRow(p) {
  const level = riskOf(p.fraud_probability);
  return `<tr tabindex="0" data-id="${esc(p.Provider)}" class="${S.selected === p.Provider ? "sel" : ""}">
    <td>${esc(p.Provider)}</td>
    <td><div class="probcell"><div class="probbar"><span style="width:${(p.fraud_probability * 100).toFixed(1)}%"></span></div>${percent(p.fraud_probability)}</div></td>
    <td>${badge(level)}</td>
    <td class="num">${nf0.format(p.n_claims)}</td>
    <td class="num">${money(p.reimb_sum)}</td>
    <td class="num hide-sm">${money(p.reimb_mean)}</td>
    <td class="num hide-sm">${percent(p.ip_ratio)}</td>
    <td class="num hide-sm">${percent(p.dup_ratio)}</td></tr>`;
}

function renderTable() {
  const rows = filtered();
  const totalPages = Math.max(1, Math.ceil(rows.length / S.pageSize));
  S.page = Math.min(Math.max(1, S.page), totalPages);
  const start = (S.page - 1) * S.pageSize;
  const slice = rows.slice(start, start + S.pageSize);
  $("providers-body").innerHTML = slice.length
    ? slice.map(providerRow).join("")
    : `<tr><td class="empty" colspan="8">No providers match your filters.</td></tr>`;
  $("pager-info").textContent = rows.length
    ? `Showing ${start + 1} to ${start + slice.length} of ${nf0.format(rows.length)}` : "No results";
  $("pager-page").textContent = `Page ${S.page} of ${totalPages}`;
  $("prev").disabled = S.page <= 1;
  $("next").disabled = S.page >= totalPages;
  document.querySelectorAll(".sort").forEach((b) => {
    const active = b.dataset.sort === S.sortField;
    b.classList.toggle("active", active);
    b.classList.toggle("asc", active && S.sortDir === "asc");
    b.closest("th").setAttribute("aria-sort", active ? (S.sortDir === "asc" ? "ascending" : "descending") : "none");
  });
}

// ---------- provider detail panel ----------

function renderDetail() {
  const p = S.all.find((x) => x.Provider === S.selected);
  $("detail").hidden = !p;
  if (!p) return;
  const level = riskOf(p.fraud_probability);
  const below = S.all.filter((x) => x.fraud_probability <= p.fraud_probability).length;
  $("detail-title").textContent = p.Provider;

  const bars = KEY_FEATURES.map((f) => {
    const v = p[f], m = S.medians[f] || 0, top = Math.max(v, m) || 1;
    const ratio = m > 0 ? `${nf2.format(v / m)}x median` : "";
    return `<div class="cmp">
      <div class="cmp-h"><span>${LABELS[f]}</span><span>${fmtFeature(f, v)} <small>${ratio}</small></span></div>
      <div class="cmp-bar"><span class="you" style="width:${Math.max(2, (v / top) * 100)}%"></span></div>
      <div class="cmp-bar"><span class="med" style="width:${Math.max(2, (m / top) * 100)}%"></span></div>
    </div>`;
  }).join("");
  const table = FEATURES.map((f) => `<tr><td>${LABELS[f]}</td><td>${fmtFeature(f, p[f])}</td></tr>`).join("");

  $("detail-body").innerHTML = `
    <div class="big-prob">${percent(p.fraud_probability)}</div>
    <div class="detail-meta">${badge(level)} &nbsp; Predicted fraud: <strong>${p.fraud_probability >= S.thr ? "Yes" : "No"}</strong><br>
      Higher than ${percent(below / S.all.length, 0)} of scored providers</div>
    <h3>Key features vs median provider</h3>
    <p class="legend"><span style="color:var(--accent)">&#9632;</span> This provider &nbsp; <span style="color:var(--grey-bar)">&#9632;</span> Median of all providers</p>
    ${bars}
    <h3>All features</h3>
    <table class="kv"><tbody>${table}</tbody></table>`;
}

function openDetail(id) {
  S.selected = id;
  renderTable();
  renderDetail();
}

// ---------- model insights page ----------

function renderInsights() {
  const m = S.metrics;
  if (!m) {
    $("metric-cards").innerHTML = `<div class="card">Metrics are not available. Run <code>python export_scores.py</code>.</div>`;
    $("importance-chart").innerHTML = "";
  } else {
    const v = m.metrics || {};
    const cards = [
      ["Accuracy", v.accuracy], ["Precision", v.precision], ["Recall", v.recall], ["F1 score", v.f1],
      ["ROC-AUC", v.roc_auc], ["PR-AUC", v.pr_auc],
    ].map(([label, value]) => `<div class="card kpi"><span class="kpi-label">${label}</span><strong>${value === undefined ? "-" : Number(value).toFixed(3)}</strong></div>`);
    cards.push(`<div class="card kpi"><span class="kpi-label">Model threshold</span><strong>${Number(m.threshold).toFixed(3)}</strong></div>`);
    cards.push(`<div class="card kpi"><span class="kpi-label">Train / validation providers</span><strong>${nf0.format(v.n_train_providers || 0)} / ${nf0.format(v.n_val_providers || 0)}</strong></div>`);
    cards.push(`<div class="card kpi"><span class="kpi-label">Generated</span><strong style="font-size:18px">${esc(m.generated || "-")}</strong></div>`);
    $("metric-cards").innerHTML = cards.join("");
    $("importance-chart").innerHTML = importanceChart(m.importance || {});
  }
  $("histogram").innerHTML = histogramChart();
}

function importanceChart(imp) {
  const items = Object.entries(imp).sort((a, b) => b[1] - a[1]);
  if (!items.length) return `<p class="hint">No feature importance available.</p>`;
  const rowH = 24, left = 200, barMax = 380, width = left + barMax + 70;
  const max = items[0][1] || 1;
  const rows = items.map(([name, value], i) => {
    const y = i * rowH + 6;
    const w = Math.max(2, (value / max) * barMax);
    return `<text class="chart-label" x="${left - 8}" y="${y + 13}" text-anchor="end">${esc(name.length > 28 ? name.slice(0, 27) + "..." : name)}<title>${esc(name)}</title></text>
      <rect class="bar-main" x="${left}" y="${y}" width="${w}" height="16" rx="3"></rect>
      <text class="chart-axis" x="${left + w + 6}" y="${y + 13}">${value.toFixed(3)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${items.length * rowH + 12}" role="img" aria-label="Feature importance bar chart">${rows}</svg>`;
}

function histogramChart() {
  const bins = 20;
  const counts = new Array(bins).fill(0);
  for (const p of S.all) counts[Math.min(bins - 1, Math.floor(p.fraud_probability * bins))]++;
  const W = 560, H = 260, l = 40, r = 10, t = 12, b = 34;
  const pw = W - l - r, ph = H - t - b;
  const max = Math.max(1, ...counts);
  const bw = pw / bins;
  const bars = counts.map((c, i) => {
    const h = (c / max) * ph;
    const flagged = (i + 1) / bins > S.thr;
    return `<rect class="${flagged ? "bar-flag" : "bar-calm"}" x="${l + i * bw + 1}" y="${t + ph - h}" width="${bw - 2}" height="${h}"><title>${(i / bins).toFixed(2)} to ${((i + 1) / bins).toFixed(2)}: ${c} providers</title></rect>`;
  }).join("");
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((v) =>
    `<text class="chart-axis" x="${l + v * pw}" y="${H - 12}" text-anchor="middle">${v}</text>`).join("");
  const x = l + S.thr * pw;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram of fraud probability">
    <line class="axis-line" x1="${l}" y1="${t + ph}" x2="${l + pw}" y2="${t + ph}"></line>
    <text class="chart-axis" x="4" y="${t + 8}">${max}</text>
    ${bars}${ticks}
    <line class="thr-line" x1="${x}" y1="${t}" x2="${x}" y2="${t + ph}"></line>
    <text class="chart-label" x="${Math.min(x + 4, W - 80)}" y="${t + 12}">threshold ${S.thr.toFixed(3)}</text>
    <text class="chart-axis" x="${l + pw / 2}" y="${H - 1}" text-anchor="middle">fraud probability</text></svg>`;
}

// ---------- upload page (optional endpoint) ----------

function setUploadStatus(text, isError) {
  const el = $("upload-status");
  el.textContent = text;
  el.style.color = isError ? "var(--high)" : "";
}

function renderUpload() {
  const rows = S.upload;
  $("upload-result").hidden = !rows;
  $("upload-download").hidden = !rows;
  if (!rows) return;
  const flagged = rows.filter((p) => p.fraud_probability >= S.thr).length;
  $("upload-summary").textContent = `${nf0.format(rows.length)} providers scored | ${nf0.format(flagged)} flagged at threshold ${S.thr.toFixed(3)}`;
  const top = [...rows].sort((a, b) => b.fraud_probability - a.fraud_probability).slice(0, 100);
  $("upload-body").innerHTML = top.map((p) => `<tr><td>${esc(p.Provider)}</td>
    <td><div class="probcell"><div class="probbar"><span style="width:${(p.fraud_probability * 100).toFixed(1)}%"></span></div>${percent(p.fraud_probability)}</div></td>
    <td>${badge(riskOf(p.fraud_probability))}</td><td class="num">${nf0.format(p.n_claims)}</td><td class="num">${money(p.reimb_sum)}</td></tr>`).join("");
  $("upload-note").textContent = rows.length > 100 ? "Showing the 100 highest-risk providers. Download the CSV for all of them." : "";
}

async function runUpload() {
  const file = $("upload-file").files[0];
  if (!file) { setUploadStatus("Choose a CSV file first.", true); return; }
  $("upload-run").disabled = true;
  setUploadStatus("Scoring... this can take a minute for large files.", false);
  try {
    const res = await fetch("/api/predict", { method: "POST", headers: { "Content-Type": "text/csv" }, body: file });
    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    S.upload = body.providers;
    setUploadStatus(`Done. ${body.count} providers scored.`, false);
    renderUpload();
  } catch (e) {
    S.upload = null;
    renderUpload();
    setUploadStatus(e.message, true);
  } finally {
    $("upload-run").disabled = false;
  }
}

// ---------- CSV download ----------

function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadRows(rows, filename) {
  const cols = ["Provider", "fraud_probability", "predicted_fraud", "risk_level", ...FEATURES];
  const lines = [cols.join(",")];
  for (const p of rows) {
    const extra = { predicted_fraud: p.fraud_probability >= S.thr ? "Yes" : "No", risk_level: riskOf(p.fraud_probability) };
    lines.push(cols.map((c) => csvCell(c in extra ? extra[c] : p[c])).join(","));
  }
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- threshold, routing, events ----------

function setThreshold(value) {
  S.thr = Math.min(1, Math.max(0, value));
  $("thr-slider").value = S.thr;
  $("thr-value").textContent = S.thr.toFixed(3);
  renderKpis();
  renderTable();
  renderDetail();
  if (S.current === "insights") $("histogram").innerHTML = histogramChart();
  if (S.current === "upload") renderUpload();
}

function route() {
  const page = (location.hash.match(/^#\/(\w+)/) || [])[1];
  S.current = ["providers", "insights", "upload"].includes(page) ? page : "providers";
  for (const name of ["providers", "insights", "upload"]) $("page-" + name).hidden = name !== S.current;
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.page === S.current));
  if (S.current === "insights") renderInsights();
  if (S.current === "upload") renderUpload();
}

function bindEvents() {
  $("thr-slider").addEventListener("input", (e) => setThreshold(Number(e.target.value)));
  $("thr-reset").addEventListener("click", () => setThreshold(S.modelThr));
  $("search").addEventListener("input", (e) => { S.search = e.target.value; S.page = 1; renderTable(); });
  $("risk-filter").addEventListener("change", (e) => { S.risk = e.target.value; S.page = 1; renderTable(); });
  $("page-size").addEventListener("change", (e) => { S.pageSize = Number(e.target.value); S.page = 1; renderTable(); });
  $("prev").addEventListener("click", () => { S.page--; renderTable(); });
  $("next").addEventListener("click", () => { S.page++; renderTable(); });
  $("download-view").addEventListener("click", () => downloadRows(filtered(), "filtered_providers.csv"));
  $("upload-download").addEventListener("click", () => S.upload && downloadRows(S.upload, "uploaded_scores.csv"));
  $("upload-run").addEventListener("click", runUpload);
  $("detail-close").addEventListener("click", () => { S.selected = null; renderTable(); renderDetail(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.selected) { S.selected = null; renderTable(); renderDetail(); }
  });
  document.querySelector("thead").addEventListener("click", (e) => {
    const btn = e.target.closest(".sort");
    if (!btn) return;
    const field = btn.dataset.sort;
    S.sortDir = S.sortField === field && S.sortDir === "desc" ? "asc" : "desc";
    S.sortField = field;
    S.page = 1;
    renderTable();
  });
  $("providers-body").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openDetail(tr.dataset.id);
  });
  $("providers-body").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && e.key === "Enter") openDetail(tr.dataset.id);
  });
  window.addEventListener("hashchange", route);
}

async function init() {
  bindEvents();
  try {
    const [all, summary] = await Promise.all([getJson("/api/all"), getJson("/api/summary")]);
    S.all = all.providers;
    S.modelThr = all.threshold;
    S.thr = all.threshold;
    S.medians = summary.medians;
  } catch (e) {
    showBanner(e.message);
  }
  try { S.metrics = await getJson("/api/metrics"); } catch (e) { S.metrics = null; }
  setThreshold(S.thr);
  route();
}

init();
