"use strict";
// GET /api/metrics  -> validation metrics and feature importance from metrics.json
const data = require("../lib/data");
const { wrap } = require("../lib/respond");

module.exports = wrap(() => data.loadMetrics());
