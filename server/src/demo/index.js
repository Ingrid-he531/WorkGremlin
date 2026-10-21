'use strict';

/**
 * Demo mode entry point.
 *
 * Demo is no longer a real project / seeded rows. See provider.js: it is a read-only in-memory
 * session exposed through `/api/v1/demo/session`, while the renderer injects that virtual session
 * into the normal floor + session table.
 */

const { createDemoProvider } = require('./provider');

module.exports = { createDemoProvider };
