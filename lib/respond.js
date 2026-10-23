"use strict";
// Small helpers shared by the Vercel API functions in /api.
const data = require("./data");

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(text);
}

// Read the optional ?threshold= parameter (a number from 0 to 1)
function readThreshold(req) {
  const url = new URL(req.url, "http://localhost");
  const raw = url.searchParams.get("threshold");
  if (raw === null || raw === "") return data.defaultThreshold();
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0 || t > 1) {
    const err = new Error("threshold must be a number between 0 and 1");
    err.status = 400;
    throw err;
  }
  return t;
}

// Wrap a handler so that every error becomes a JSON response and the function never crashes
function wrap(fn) {
  return (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
      return send(res, 200, fn(req));
    } catch (err) {
      return send(res, err.status || 500, { error: err.message || "Server error" });
    }
  };
}

module.exports = { send, wrap, readThreshold };
