/**
 * Shared settings bounds, deliberately free of any dependency.
 *
 * settings/schema.js owns validation but requires zod, and a CommonJS
 * `require('zod')` cannot be tree-shaken — so any renderer-reachable module
 * that pulled a bound from there dragged ~407 KB of zod into app-bundle.js
 * (which never validates anything). Keep this file dependency-free so the
 * Electron/Capacitor renderers and the headless service can read a bound
 * without paying for the validator.
 */

// Maximum scheduled-fill trigger entries per challenge, for both the
// times-of-day list and the before-end offsets list. schema.js enforces it,
// the cadence/decision paths slice to it defensively, and the UI stops
// offering an "add" row at it.
const MAX_SCHEDULED_FILL_ENTRIES = 6;

module.exports = { MAX_SCHEDULED_FILL_ENTRIES };
