"use strict";
// Reads the scored CSV and metrics.json once, keeps them in memory,
// and reloads them only if the files change on disk.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SCORED_FILE = path.join(DATA_DIR, "fraud_scored_providers.csv");
const METRICS_FILE = path.join(DATA_DIR, "metrics.json");

// Numeric columns in the scored CSV
const FEATURES = ["n_claims", "n_bene", "reimb_sum", "reimb_mean", "reimb_max", "ip_ratio", "dup_ratio",
  "round_ratio", "n_proc_mean", "n_diag_mean", "claims_per_bene", "reimb_per_bene"];
const NUMERIC = ["fraud_probability", ...FEATURES];
// Features that are compared with the median in the provider detail view
const KEY_FEATURES = ["reimb_sum", "reimb_mean", "n_claims", "ip_ratio", "dup_ratio", "round_ratio",
  "n_proc_mean", "n_diag_mean"];
const SORTABLE = ["Provider", ...NUMERIC];

// Small CSV parser: handles quoted fields, escaped quotes, and \r\n line ends
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Risk rule: High if p >= threshold, Medium if p >= threshold / 2, otherwise Low
function riskOf(p, threshold) {
  if (p >= threshold) return "High";
  if (p >= threshold / 2) return "Medium";
  return "Low";
}

const cache = { mtime: 0, size: 0, providers: [], byId: new Map(), medians: {}, probSorted: [] };

function loadScored() {
  let stat;
  try {
    stat = fs.statSync(SCORED_FILE);
  } catch (e) {
    const err = new Error("Scored file not found. Run: python export_scores.py");
    err.status = 503;
    throw err;
  }
  if (stat.mtimeMs === cache.mtime && stat.size === cache.size) return cache;

  const text = fs.readFileSync(SCORED_FILE, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(text);
  const header = rows.shift() || [];
  const idx = {};
  header.forEach((name, i) => { idx[name.trim()] = i; });
  for (const col of ["Provider", ...NUMERIC]) {
    if (!(col in idx)) {
      const err = new Error(`Column "${col}" is missing in fraud_scored_providers.csv`);
      err.status = 500;
      throw err;
    }
  }

  const providers = [];
  for (const r of rows) {
    const p = { Provider: r[idx.Provider] };
    let ok = true;
    for (const col of NUMERIC) {
      const v = Number(r[idx[col]]);
      if (!Number.isFinite(v)) { ok = false; break; }
      p[col] = v;
    }
    if (ok && p.Provider) providers.push(p);
  }

  cache.mtime = stat.mtimeMs;
  cache.size = stat.size;
  cache.providers = providers;
  cache.byId = new Map(providers.map((p) => [p.Provider, p]));
  cache.medians = {};
  for (const f of FEATURES) cache.medians[f] = median(providers.map((p) => p[f]));
  cache.probSorted = providers.map((p) => p.fraud_probability).sort((a, b) => a - b);
  return cache;
}

function loadMetrics() {
  try {
    return JSON.parse(fs.readFileSync(METRICS_FILE, "utf8"));
  } catch (e) {
    const err = new Error("metrics.json not found or invalid. Run: python export_scores.py");
    err.status = 503;
    throw err;
  }
}

// Default threshold = the model threshold from metrics.json (0.5 if missing)
function defaultThreshold() {
  try { return Number(loadMetrics().threshold) || 0.5; } catch (e) { return 0.5; }
}

// Add risk_level and predicted_fraud for a given threshold
function withRisk(p, threshold) {
  return { ...p, risk_level: riskOf(p.fraud_probability, threshold),
    predicted_fraud: p.fraud_probability >= threshold ? "Yes" : "No" };
}

function histogram(providers, bins) {
  const counts = new Array(bins).fill(0);
  for (const p of providers) {
    counts[Math.min(bins - 1, Math.floor(p.fraud_probability * bins))]++;
  }
  return counts;
}

function summary(threshold) {
  const c = loadScored();
  const flagged = c.providers.filter((p) => p.fraud_probability >= threshold);
  const risk = { High: 0, Medium: 0, Low: 0 };
  for (const p of c.providers) risk[riskOf(p.fraud_probability, threshold)]++;
  return {
    threshold,
    total_providers: c.providers.length,
    flagged_count: flagged.length,
    flagged_pct: c.providers.length ? flagged.length / c.providers.length : 0,
    flagged_reimbursed: flagged.reduce((s, p) => s + p.reimb_sum, 0),
    risk_counts: risk,
    medians: c.medians,
    histogram: histogram(c.providers, 20),
  };
}

// Validated list query: search, risk filter, sort, pagination
function listProviders(q) {
  const c = loadScored();
  let rows = c.providers;
  if (q.search) {
    const s = q.search.toLowerCase();
    rows = rows.filter((p) => p.Provider.toLowerCase().includes(s));
  }
  if (q.risk !== "all") rows = rows.filter((p) => riskOf(p.fraud_probability, q.threshold).toLowerCase() === q.risk);
  const dir = q.dir === "asc" ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    const x = a[q.sort], y = b[q.sort];
    const cmp = typeof x === "string" ? x.localeCompare(y) : x - y;
    return cmp !== 0 ? cmp * dir : a.Provider.localeCompare(b.Provider);
  });
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / q.pageSize));
  const page = Math.min(q.page, totalPages);
  const slice = rows.slice((page - 1) * q.pageSize, page * q.pageSize).map((p) => withRisk(p, q.threshold));
  return { total, page, pageSize: q.pageSize, totalPages, rows: slice };
}

function getProvider(id, threshold) {
  const c = loadScored();
  const p = c.byId.get(id);
  if (!p) return null;
  const below = c.probSorted.filter((v) => v <= p.fraud_probability).length;
  return {
    provider: withRisk(p, threshold),
    percentile: c.probSorted.length ? below / c.probSorted.length : 0,
    compare: KEY_FEATURES.map((f) => ({
      feature: f, value: p[f], median: c.medians[f],
      ratio: c.medians[f] ? p[f] / c.medians[f] : null,
    })),
  };
}

function allProviders() {
  return loadScored().providers;
}

module.exports = { FEATURES, SORTABLE, loadScored, loadMetrics, defaultThreshold, riskOf, summary,
  listProviders, getProvider, allProviders, parseCsv };
