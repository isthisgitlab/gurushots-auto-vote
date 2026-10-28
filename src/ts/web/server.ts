/**
 * Web shell — serves the React renderer over HTTP so the app runs in an
 * ordinary browser (and under Playwright) instead of an Electron window. The
 * browser half is bridge/web.ts: every window.api invoke is a POST to
 * /api/invoke/<channel>, and events (settings-changed, log-message, update-*)
 * arrive over one Server-Sent Events stream at /api/events.
 *
 * The handlers are the same ipc/*.handlers.ts modules Electron registers and
 * the Capacitor bridge calls in-process. Only the Electron-bound channels
 * differ: updates come from ipc/releaseUpdates (no self-install), and
 * open-external-url / reload-window / refresh-menu run in the browser.
 *
 * Localhost only: whatever reaches the port drives the whole window.api
 * surface — the GuruShots session, currency spends — so the server listens on
 * the loopback interface, answers only a localhost Host header (a DNS-rebinding
 * page carries its own hostname) and refuses cross-origin POSTs. Every /api/ request
 * must also carry the per-run token the server prints in its launch URL (a fragment,
 * which a browser never sends): a header on POSTs, a `t` query parameter on the event
 * stream (EventSource cannot set headers). A page that is not the launch URL's own
 * cannot learn it.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as settingsHandlers from '../ipc/settings.handlers';
import * as votingHandlers from '../ipc/voting.handlers';
import * as logHandlers from '../ipc/log.handlers';
import * as actionsHandlers from '../ipc/actions.handlers';
import * as computationsHandlers from '../ipc/computations.handlers';
import * as currencyHandlers from '../ipc/currency.handlers';
import * as scenariosHandlers from '../ipc/scenarios.handlers';
import { buildReleaseUpdateHandlers } from '../ipc/releaseUpdates';
import { invokeHandler } from '../ipc/registerHandlers';
import * as updateChecker from '../services/UpdateChecker';
import { logout as sharedLogout, clearTokenUnlessStayingLoggedIn, LogoutNotSavedError } from '../services/auth';
import { LOGOUT_NOT_SAVED } from '../ipc/logoutCode';
import { initializeHeaders } from '../api/randomizer';
import * as settings from '../settings';
import {
    holdWebServerLock,
    isCliSessionActive,
    isDesktopAppActive,
    isWebServerActive,
} from '../settings/cliSessionLock';
import * as logger from '../logger';
import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { isInteger } from '../numbers';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IpcHandler } from '../ipc/registerHandlers';
import type { ShellUpdateHandlers } from '../ipc/releaseUpdates';
import type { GuiLogSink } from '../logger';

const LOOPBACK_HOST = '127.0.0.1';
const TOKEN_HEADER = 'x-web-shell-token';
const TOKEN_QUERY_PARAM = 't';
// The stable code a request without the right token is refused with, for the page to explain (see bridge/web.ts).
const WEB_SHELL_TOKEN_REFUSED = 'web-shell-token';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
// Generous for a scenario import or a full settings save, small enough that a
// runaway client cannot balloon the process.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
};

type Emit = (channel: string, payload?: unknown) => void;

/**
 * Every invoke channel the server answers, keyed by channel name.
 * @param emit - broadcasts an event to every connected browser
 * @param afterWipe - called once a "Delete all local data" has succeeded
 */
const buildWebHandlers = (emit: Emit, { afterWipe }: { afterWipe?: () => void } = {}): Record<string, IpcHandler> => {
    const releaseUpdates = buildReleaseUpdateHandlers({ emit, assetSuffix: async () => null });
    // No updater ships with the web shell: can-auto-update is false, so the
    // renderer's download button opens the releases page instead.
    const manualInstall = async () => ({
        success: false,
        error: 'The web UI does not install updates — download the new release instead',
        fallbackUrl: updateChecker.getReleasesUrl(),
    });
    const updateHandlers = {
        ...releaseUpdates.handlers,
        'download-update': manualInstall,
        'install-update': manualInstall,
        'can-auto-update': async () => ({ success: true, canAutoUpdate: false }),
    } satisfies ShellUpdateHandlers;

    return {
        ...settingsHandlers.buildHandlers({
            broadcastSettingsChange: (newSettings: object) => emit('settings-changed', newSettings),
            afterWipe,
        }),
        ...votingHandlers.buildHandlers(),
        ...logHandlers.buildHandlers(),
        ...actionsHandlers.buildHandlers(),
        ...computationsHandlers.buildHandlers(),
        ...currencyHandlers.buildHandlers(),
        ...scenariosHandlers.buildHandlers(),
        ...updateHandlers,
    };
};

// Serialized before the head is written, so a result JSON cannot encode still
// gets a proper error response.
const sendJson = (res: ServerResponse, status: number, body: object) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(json);
};

// An absent message is fine: the bridge then reports the status code.
const fail = (res: ServerResponse, status: number, error: string | undefined) =>
    sendJson(res, status, { success: false, error });

// 256 bits from the OS: not guessable, new on every run.
const newShellToken = () => crypto.randomBytes(32).toString('hex');

// Constant-time comparison; a token of the wrong length is a refusal without comparing.
const isShellToken = (provided: unknown, token: string) => {
    if (typeof provided !== 'string') return false;
    const given = Buffer.from(provided);
    const expected = Buffer.from(token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

// Where the page puts the token: the event stream's URL (EventSource sets no headers), a header otherwise.
const requestToken = (req: IncomingMessage, pathname: string, searchParams: URLSearchParams) =>
    req.method === 'GET' && pathname === '/api/events'
        ? searchParams.get(TOKEN_QUERY_PARAM)
        : req.headers[TOKEN_HEADER];

const isLocalHost = (host: string | undefined) => {
    if (!host) return false;
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    return LOCAL_HOSTNAMES.has(hostname);
};

// A browser sends Origin on every fetch POST, same-origin included; a request
// with no Origin is not from a web page (curl, a test client).
const isSameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    // aislop-ignore-next-line ai-slop/hardcoded-url -- same-origin check built from the request's own Host header, not a deployment URL
    return origin === undefined || origin === `http://${req.headers.host}`;
};

// An event stream is a GET, which a browser sends without Origin when it is same-origin; a stream opened from another
// site carries an Origin that is not this server's, and Sec-Fetch-Site says `cross-site` or `same-site` (another port
// on this host is same-site, not same-origin).
const isCrossSiteStream = (req: IncomingMessage) => {
    const site = req.headers['sec-fetch-site'];
    return !isSameOrigin(req) || (site !== undefined && site !== 'same-origin' && site !== 'none');
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > MAX_BODY_BYTES) throw new RangeError('Request body too large');
        chunks.push(buf);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as unknown) : null;
};

/**
 * The renderer's arguments: JSON has no undefined, so bridge/web.ts sends each
 * undefined argument as null and lists its position, and it is restored here —
 * a handler's default parameter then applies exactly as it does over Electron IPC.
 */
const decodeArgs = (body: unknown): unknown[] | null => {
    if (!isPlainObject(body) || !Array.isArray(body.args)) return null;
    const decoded = [...body.args];
    if (Array.isArray(body.undefinedAt)) {
        for (const index of body.undefinedAt) {
            if (isInteger(index) && index >= 0 && index < decoded.length) decoded[index] = undefined;
        }
    }
    return decoded;
};

// The dist/ file a URL path serves: the root is the web document, and the
// favicon browsers ask for by convention (no token travels with it) is the
// app icon staged next to it by scripts/build-react.ts.
const staticFileFor = (pathname: string) => {
    if (pathname === '/') return 'web.html';
    if (pathname === '/favicon.ico') return 'favicon.png';
    return decodeURIComponent(pathname).replace(/^\/+/, '');
};

const serveStatic = (distDir: string, pathname: string, res: ServerResponse) => {
    const file = path.resolve(distDir, staticFileFor(pathname));
    if (!file.startsWith(distDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        fail(res, 404, 'Not found');
        return;
    }
    res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
};

const openEventStream = (res: ServerResponse, clients: Set<ServerResponse>) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    res.on('close', () => clients.delete(res));
};

// The shared logout core always drops the token and puts the mock flag back
// to the environment default; this shell only answers JSON.
const logout = async (res: ServerResponse) => {
    try {
        await sharedLogout();
    } catch (err) {
        logger.withCategory('authentication').error('Logout failed to clear token', err);
        // A logout the settings refused did not log anyone out: say so.
        if (err instanceof LogoutNotSavedError) {
            sendJson(res, 200, { result: { success: false, error: LOGOUT_NOT_SAVED } });
            return;
        }
    }
    sendJson(res, 200, { result: { success: true } });
};

const invokeChannel = async (
    handlers: Record<string, IpcHandler>,
    res: ServerResponse,
    pathname: string,
    body: unknown,
) => {
    const channel = pathname.startsWith('/api/invoke/') ? pathname.slice('/api/invoke/'.length) : '';
    // Own keys only: 'constructor' or 'toString' must not reach Object.prototype.
    if (!Object.hasOwn(handlers, channel)) {
        fail(res, 404, `Unknown channel: ${channel || pathname}`);
        return;
    }
    const args = decodeArgs(body);
    if (!args) {
        fail(res, 400, 'Expected { args: [...] }');
        return;
    }
    try {
        sendJson(res, 200, { result: await invokeHandler(handlers[channel], null, args) });
    } catch (error) {
        logger.withCategory('api').error(`Web handler '${channel}' threw`, error);
        fail(res, 500, errorMessage(error) || 'Handler failed');
    }
};

/**
 * A request under /api/ other than the event stream: a same-origin JSON POST,
 * then logout or an invoke.
 */
const handleApi = async (
    handlers: Record<string, IpcHandler>,
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
) => {
    if (req.method !== 'POST') {
        fail(res, 405, 'Method not allowed');
        return;
    }
    if (!isSameOrigin(req) || !req.headers['content-type']?.startsWith('application/json')) {
        fail(res, 403, 'Refused: cross-origin or non-JSON request');
        return;
    }
    let body: unknown;
    try {
        body = await readJsonBody(req);
    } catch (error) {
        fail(res, error instanceof RangeError ? 413 : 400, errorMessage(error));
        return;
    }
    if (pathname === '/api/logout') await logout(res);
    else await invokeChannel(handlers, res, pathname, body);
};

// One string for both web clears: the launch clear and the close clear keep the login for the same
// reason — a sibling shell that is running may be using it.
const SIBLING_KEEP_LOGIN =
    'Kept the saved login token because another session is running and may be using it (CLI, desktop app, or web server)';

/** Whether another process holds any sibling shell's marker; the three checks run together, so a stale-but-live marker costs one settle wait, not three. */
const anySiblingShellActive = (): Promise<boolean> =>
    Promise.all([isCliSessionActive(), isDesktopAppActive(), isWebServerActive()]).then((states) =>
        states.some(Boolean),
    );

/**
 * A login a run left behind (a crash or a kill skips the close-time clear) is cleared before the
 * server listens, so no page can observe a pre-clear token — unless "Stay Logged In" is on. A
 * sibling shell that is running may be using the login, so it is left alone then, and a login made
 * while the marker checks settle is never cleared either (the token is read again first). Never
 * throws: a refused clear is logged, never fatal.
 */
const clearLeftoverToken = async (): Promise<void> => {
    try {
        const leftover = settings.getSetting('token');
        if (settings.getSetting('stayLoggedIn') || !leftover) return;
        logger.printLine('Attempting to clear the saved login before starting…');
        if (await anySiblingShellActive()) {
            logger.withCategory('authentication').info(SIBLING_KEEP_LOGIN, null);
            return;
        }
        if (settings.getSetting('token') !== leftover || settings.getSetting('stayLoggedIn')) return;
        if (await clearTokenUnlessStayingLoggedIn()) {
            logger
                .withCategory('authentication')
                .info('Cleared a saved token left by an earlier run (Stay Logged In is off)', null);
        }
    } catch (error) {
        logger.withCategory('authentication').error('Failed to clear a leftover token at startup:', error);
    }
};

/**
 * The close chain's clear: with Stay Logged In off, the token this run leaves behind is cleared
 * before the process exits — the same gated clear the launch runs, with the stop path's own
 * wording. A wipe stop says nothing here: the wiped store reads no token, so the gate skips
 * silently, and a store the wipe discarded must not be reported as a failed clear either.
 */
const clearTokenBeforeExit = async (wiped: () => boolean): Promise<void> => {
    try {
        const saved = settings.getSetting('token');
        if (settings.getSetting('stayLoggedIn') || !saved) return;
        logger.printLine('Attempting to clear the saved login before exiting…');
        if (await anySiblingShellActive()) {
            logger.withCategory('authentication').info(SIBLING_KEEP_LOGIN, null);
            return;
        }
        if (settings.getSetting('token') !== saved || settings.getSetting('stayLoggedIn')) return;
        if (await clearTokenUnlessStayingLoggedIn()) {
            logger.withCategory('authentication').info('Cleared saved token (Stay Logged In is off)', null);
        }
    } catch (error) {
        if (!wiped()) logger.withCategory('authentication').error('Failed to clear token on shutdown', error);
    }
};

interface WebServerOptions {
    /** The built renderer (dist/): web.html, web-bundle.js, styles.css. */
    distDir: string;
    /** The token every /api/ request must carry; a fresh random one when absent. */
    token?: string;
    /** Called after a local-data wipe, once its reply is sent and the server has stopped. */
    onLocalDataWiped?: () => void;
}

/**
 * Build the server without listening. The returned `emit` pushes an event to
 * every connected browser; `token` is what the pages must send. After a
 * successful local-data wipe the server stops: every store refuses writes, so
 * the web shell has to be started again.
 */
const createWebServer = ({ distDir, token = newShellToken(), onLocalDataWiped }: WebServerOptions) => {
    const root = path.resolve(distDir);
    const clients = new Set<ServerResponse>();
    let wiped = false;
    let stopped = false;
    const emit: Emit = (channel, payload) => {
        const frame = `event: ${channel}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
        for (const client of clients) client.write(frame);
    };
    const handlers = buildWebHandlers(emit, {
        afterWipe: () => {
            wiped = true;
        },
    });

    // Ends every connected browser's event stream (a wipe stop and the launcher's stop both do).
    const endClients = () => {
        for (const client of clients) client.end();
    };

    // Runs when a reply has been sent: after a wipe, ends the event streams and stops listening, once however many
    // replies finish after it. The idle keep-alive sockets go too, so close() is not held open by them.
    const stopIfWiped = () => {
        if (!wiped || stopped) return;
        stopped = true;
        endClients();
        server.closeIdleConnections();
        server.close();
        onLocalDataWiped?.();
    };

    const route = async (req: IncomingMessage, res: ServerResponse) => {
        const { pathname, searchParams } = new URL(String(req.url), 'http://localhost');
        if (!isLocalHost(req.headers.host)) fail(res, 403, 'Refused: non-local Host header');
        else if (pathname.startsWith('/api/') && !isShellToken(requestToken(req, pathname, searchParams), token)) {
            fail(res, 403, WEB_SHELL_TOKEN_REFUSED);
        } else if (req.method === 'GET' && pathname === '/api/events' && isCrossSiteStream(req)) {
            fail(res, 403, 'Refused: cross-site request');
        } else if (req.method === 'GET' && pathname === '/api/events') openEventStream(res, clients);
        else if (pathname.startsWith('/api/')) {
            res.once('finish', stopIfWiped);
            await handleApi(handlers, req, res, pathname);
        } else if (req.method !== 'GET' && req.method !== 'HEAD') fail(res, 405, 'Method not allowed');
        else serveStatic(root, pathname, res);
    };

    const server = http.createServer((req, res) => {
        route(req, res).catch((error: unknown) => {
            logger.withCategory('api').error('Web request failed', error);
            fail(res, 500, 'Internal error');
        });
    });
    return { server, emit, token, wasWiped: () => wiped, endClients };
};

interface StartOptions extends WebServerOptions {
    port: number;
}

/**
 * Boot the shared state the Electron main process boots, then listen on the
 * loopback interface.
 * @returns the listening server, the token its pages need, and the URL that
 *   opens the UI: it carries the token in its fragment, so print it to stdout
 *   only and keep it out of the logs. `stop` stops listening and waits out the
 *   close chain; `whenClosed` is that chain's promise, for the paths that close
 *   the server themselves (a local-data wipe)
 */
const startWebServer = async ({ port, distDir }: StartOptions) => {
    initializeHeaders();
    try {
        settings.seedIntentProfiles();
    } catch (err) {
        logger.withCategory('settings').warning('Intent profile seeding failed (non-fatal):', err);
    }
    // Before the server exists to answer a page: nothing can observe a pre-clear token.
    await clearLeftoverToken();
    const { server, emit, token, wasWiped, endClients } = createWebServer({
        distDir,
        onLocalDataWiped: () =>
            logger.printLine('Local data was deleted. The web shell has stopped: start it again to continue.'),
    });
    // logger.ts fans live entries out through this global (see log.handlers).
    (globalThis as typeof globalThis & { sendLogToGUI?: GuiLogSink }).sendLogToGUI = (entry) =>
        emit('log-message', entry);

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, LOOPBACK_HOST, () => resolve());
    });
    // The marker a local-data wipe from the desktop app or the CLI looks for: this server writes the app's data until it
    // stops (every wipe stops it). A server killed by a signal leaves one that goes stale.
    const releaseWebServerMarker = holdWebServerLock();
    // The close chain: the marker is released (synchronously), then the stay-logged-in clear runs — the launcher's
    // exit and stop() wait for it to settle, so a signal cannot win the race against the clear.
    let settleCloseChain!: () => void;
    const closeChainSettled = new Promise<void>((resolve) => {
        settleCloseChain = resolve;
    });
    let closeHandled = false;
    server.once('close', () => {
        closeHandled = true;
        releaseWebServerMarker();
        void clearTokenBeforeExit(wasWiped).finally(settleCloseChain);
    });
    /** Resolves once the server is closed and its close chain has settled. */
    const whenClosed = async (): Promise<void> => {
        if (!closeHandled)
            await new Promise<void>((resolve) => {
                server.once('close', () => resolve());
            });
        await closeChainSettled;
    };
    /**
     * Stops listening: ends the event streams, drops the idle keep-alive sockets that would hold
     * close() open, and waits out the close chain. Calling it again resolves the same way.
     */
    const stop = async (): Promise<void> => {
        endClients();
        server.closeIdleConnections();
        // A second stop finds the server already closed: the callback takes the error, so no
        // 'error' event fires for the leftover listener of the listen promise to trip over.
        server.close(() => undefined);
        await whenClosed();
    };
    const address = server.address() as { port: number };
    const origin = `http://localhost:${address.port}/`;
    logger.withCategory('ui').info(`Web UI listening on ${origin}`, { userData: settings.getUserDataPath() });
    return { server, token, url: `${origin}#t=${token}`, stop, whenClosed };
};

export { createWebServer, startWebServer, buildWebHandlers };
