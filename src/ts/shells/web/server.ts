/**
 * Web shell — serves the React renderer over HTTP so the app runs in an
 * ordinary browser (and under Playwright) instead of an Electron window. The
 * browser half is bridge/web.ts: every window.api invoke is a POST to
 * /api/invoke/<channel>, and events (settings-changed, log-message, update-*)
 * arrive over one Server-Sent Events stream at /api/events.
 *
 * Localhost only: whatever reaches the port drives the whole window.api
 * surface — the GuruShots session, currency spends — so the server listens on
 * the loopback interface, answers only a localhost Host header (a DNS-rebinding
 * page carries its own hostname) and refuses cross-origin POSTs. Every /api/ request
 * must also carry the per-run token the server prints in its launch URL (a fragment,
 * which a browser never sends): a header on POSTs, a `t` query parameter on the event
 * stream (EventSource cannot set headers). A page that is not the launch URL's own
 * cannot learn it.
 *
 * The shell's server modules: serverLifecycle.ts builds and runs the HTTP
 * server and its route, security.ts holds the request checks, apiRouter.ts the
 * /api/ endpoints, staticFiles.ts the dist/ serving, webHandlers.ts the invoke
 * channel table, responses.ts the JSON replies.
 */

// The web platform installs before any core module loads; the server
// registers its per-run fan-out and wipe stop on it (setWebShellRun).
import './platform';

export { createWebServer, startWebServer } from './serverLifecycle';
export { buildWebHandlers } from './webHandlers';
