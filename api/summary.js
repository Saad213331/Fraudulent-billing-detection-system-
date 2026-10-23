"use strict";
// GET /api/summary?threshold=0.25  -> totals, risk counts, medians and histogram
const data = require("../lib/data");
const { wrap, readThreshold } = require("../lib/respond");

module.exports = wrap((req) => data.summary(readThreshold(req)));
