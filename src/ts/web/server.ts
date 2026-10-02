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
 * page carries its own hostname) and refuses cross-origin POSTs.
 */

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
import { clearAuthToken } from '../services/auth';
import { initializeHeaders } from '../api/randomizer';
import * as settings from '../settings';
import * as logger from '../logger';
import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { isInteger } from '../numbers';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IpcHandler } from '../ipc/registerHandlers';
import type { ShellUpdateHandlers } from '../ipc/releaseUpdates';
import type { GuiLogSink } from '../logger';

const LOOPBACK_HOST = '127.0.0.1';
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
 */
const buildWebHandlers = (emit: Emit): Record<string, IpcHandler> => {
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

const serveStatic = (distDir: string, pathname: string, res: ServerResponse) => {
    const relative = pathname === '/' ? 'web.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(distDir, relative);
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

// Same as Electron's logout: always drop the token, and put the mock flag back
// to the environment default.
const logout = async (res: ServerResponse) => {
    try {
        await clearAuthToken();
    } catch (err) {
        logger.withCategory('authentication').error('Logout failed to clear token', err);
    }
    settings.setSetting('mock', settings.getEnvironmentInfo().defaultMock);
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

interface WebServerOptions {
    /** The built renderer (dist/): web.html, web-bundle.js, styles.css. */
    distDir: string;
}

/**
 * Build the server without listening. The returned `emit` pushes an event to
 * every connected browser.
 */
const createWebServer = ({ distDir }: WebServerOptions) => {
    const root = path.resolve(distDir);
    const clients = new Set<ServerResponse>();
    const emit: Emit = (channel, payload) => {
        const frame = `event: ${channel}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
        for (const client of clients) client.write(frame);
    };
    const handlers = buildWebHandlers(emit);

    const route = async (req: IncomingMessage, res: ServerResponse) => {
        const { pathname } = new URL(String(req.url), 'http://localhost');
        if (!isLocalHost(req.headers.host)) fail(res, 403, 'Refused: non-local Host header');
        else if (req.method === 'GET' && pathname === '/api/events') openEventStream(res, clients);
        else if (pathname.startsWith('/api/')) await handleApi(handlers, req, res, pathname);
        else if (req.method !== 'GET' && req.method !== 'HEAD') fail(res, 405, 'Method not allowed');
        else serveStatic(root, pathname, res);
    };

    const server = http.createServer((req, res) => {
        route(req, res).catch((error: unknown) => {
            logger.withCategory('api').error('Web request failed', error);
            fail(res, 500, 'Internal error');
        });
    });
    return { server, emit };
};

interface StartOptions extends WebServerOptions {
    port: number;
}

/**
 * Boot the shared state the Electron main process boots, then listen on the
 * loopback interface.
 * @returns the listening server and the URL it answers on
 */
const startWebServer = async ({ port, distDir }: StartOptions) => {
    initializeHeaders();
    try {
        settings.seedIntentProfiles();
    } catch (err) {
        logger.withCategory('settings').warning('Intent profile seeding failed (non-fatal):', err);
    }
    const { server, emit } = createWebServer({ distDir });
    // logger.ts fans live entries out through this global (see log.handlers).
    (globalThis as typeof globalThis & { sendLogToGUI?: GuiLogSink }).sendLogToGUI = (entry) =>
        emit('log-message', entry);

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, LOOPBACK_HOST, () => resolve());
    });
    const address = server.address() as { port: number };
    const url = `http://localhost:${address.port}/`;
    logger.withCategory('ui').info(`Web UI listening on ${url}`, { userData: settings.getUserDataPath() });
    return { server, url };
};

export { createWebServer, startWebServer, buildWebHandlers };
