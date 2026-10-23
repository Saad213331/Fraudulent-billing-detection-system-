"use strict";
// GET /api/all  -> every scored provider (the browser does filtering and the threshold slider)
const data = require("../lib/data");
const { wrap } = require("../lib/respond");

module.exports = wrap(() => ({ threshold: data.defaultThreshold(), providers: data.allProviders() }));
