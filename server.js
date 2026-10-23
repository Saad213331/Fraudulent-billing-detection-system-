"use strict";
// Zero-dependency dashboard server (built-in Node modules only).
// Run: node server.js   (PORT env var overrides the default port 3000)

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const data = require("./lib/data");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300 MB
const PYTHON_TIMEOUT_MS = 10 * 60 * 1000;   // 10 minutes

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
};

// ---------- helpers ----------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Read and validate the threshold query parameter (0 to 1)
function readThreshold(params) {
  const raw = params.get("threshold");
  if (raw === null || raw === "") return data.defaultThreshold();
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0 || t > 1) throw httpError(400, "threshold must be a number between 0 and 1");
  return t;
}

function readListQuery(params) {
  const risk = (params.get("risk") || "all").toLowerCase();
  if (!["all", "high", "medium", "low"].includes(risk)) throw httpError(400, "risk must be all, high, medium or low");

  const [sort = "fraud_probability", dir = "desc"] = (params.get("sort") || "fraud_probability:desc").split(":");
  if (!data.SORTABLE.includes(sort)) throw httpError(400, `sort must be one of: ${data.SORTABLE.join(", ")}`);
  if (!["asc", "desc"].includes(dir)) throw httpError(400, "sort direction must be asc or desc");

  const page = params.get("page") === null ? 1 : Number(params.get("page"));
  const pageSize = params.get("pageSize") === null ? 25 : Number(params.get("pageSize"));
  if (!Number.isInteger(page) || page < 1) throw httpError(400, "page must be an integer >= 1");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw httpError(400, "pageSize must be an integer from 1 to 200");

  const search = (params.get("search") || "").trim().slice(0, 100);
  return { search, risk, sort, dir, page, pageSize, threshold: readThreshold(params) };
}

// ---------- upload endpoint (stretch) ----------

// Try several Python commands until one starts. A project venv is preferred.
function pythonCandidates() {
  const list = [];
  if (process.env.PYTHON) list.push(process.env.PYTHON);
  for (const dir of ["venv", ".venv"]) {
    list.push(path.join(__dirname, dir, "Scripts", "python.exe"));
    list.push(path.join(__dirname, dir, "bin", "python"));
  }
  list.push("python", "python3", "py");
  // Keep bare commands (like "python") and only those full paths that really exist; remove duplicates
  const usable = list.filter((p) => !p.includes(path.sep) || fs.existsSync(p));
  return [...new Set(usable)];
}

function runPython(args) {
  const candidates = pythonCandidates();
  return new Promise((resolve, reject) => {
    const tryNext = (i) => {
      if (i >= candidates.length) {
        return reject(httpError(500, "Python was not found. Activate the venv or set the PYTHON environment variable."));
      }
      const child = spawn(candidates[i], args, { cwd: __dirname });
      const out = [];
      const err = [];
      let started = true;
      const timer = setTimeout(() => child.kill(), PYTHON_TIMEOUT_MS);
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        started = false;
        if (e.code === "ENOENT") tryNext(i + 1); else reject(httpError(500, `Could not start Python: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (started) resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
    };
    tryNext(0);
  });
}

// Save the request body to a temp file, with a size limit
function saveUpload(req) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `claims_${Date.now()}_${Math.random().toString(36).slice(2)}.csv`);
    const stream = fs.createWriteStream(file);
    let bytes = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      stream.destroy();
      fs.unlink(file, () => {});
      reject(err);
    };
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) { fail(httpError(413, "File is too large (limit 300 MB).")); req.destroy(); }
    });
    req.on("error", fail);
    stream.on("error", fail);
    stream.on("finish", () => { if (!failed) resolve({ file, bytes }); });
    req.pipe(stream);
  });
}

async function handlePredict(req, res) {
  const { file, bytes } = await saveUpload(req);
  try {
    if (bytes === 0) throw httpError(400, "The uploaded file is empty.");
    const result = await runPython(["predict.py", file]);
    let body = null;
    try { body = JSON.parse(result.stdout); } catch (e) { /* not JSON */ }
    if (result.code !== 0 || !body || body.error) {
      const status = result.code === 2 ? 400 : 500;
      throw httpError(status, (body && body.error) || result.stderr.trim().split("\n").pop() || "Prediction failed.");
    }
    sendJson(res, 200, { count: body.providers.length, threshold: body.threshold, providers: body.providers });
  } finally {
    fs.unlink(file, () => {});
  }
}

// ---------- routing ----------

async function handleApi(req, res, url) {
  const route = url.pathname;
  const params = url.searchParams;

  if (route === "/api/predict") {
    if (req.method !== "POST") throw httpError(405, "Use POST for /api/predict");
    return handlePredict(req, res);
  }
  if (req.method !== "GET") throw httpError(405, "Method not allowed");

  if (route === "/api/summary") return sendJson(res, 200, data.summary(readThreshold(params)));
  if (route === "/api/metrics") return sendJson(res, 200, data.loadMetrics());
  if (route === "/api/all") return sendJson(res, 200, { threshold: data.defaultThreshold(), providers: data.allProviders() });
  if (route === "/api/providers") return sendJson(res, 200, data.listProviders(readListQuery(params)));

  const m = route.match(/^\/api\/provider\/(.+)$/);
  if (m) {
    let id;
    try { id = decodeURIComponent(m[1]); } catch (e) { throw httpError(400, "Invalid provider id"); }
    const found = data.getProvider(id, readThreshold(params));
    if (!found) throw httpError(404, `Provider "${id}" not found`);
    return sendJson(res, 200, found);
  }
  throw httpError(404, "Unknown API route");
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return sendJson(res, 400, { error: "Bad path" }); }
  if (rel === "/") rel = "/index.html";
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  // Block path traversal: the file must be inside public/
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(full, (err, buf) => {
    if (err) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    // Every error becomes a JSON response; the server never crashes on bad input
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || "Server error" });
    else res.end();
    if (!err.status) console.error(err);
  }
});

// Listen on localhost only (the data is sensitive and not meant for the network)
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  try {
    const c = data.loadScored();
    console.log(`Loaded ${c.providers.length} scored providers`);
  } catch (e) {
    console.log(`Warning: ${e.message}`);
  }
});
