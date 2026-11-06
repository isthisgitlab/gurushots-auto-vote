/**
 * The web server's lifecycle. createWebServer builds the loopback HTTP server
 * and its request route without listening; startWebServer boots the shared
 * state the Electron main process boots, listens, and owns the close chain —
 * the marker release and the stay-logged-in clear — that both the launcher's
 * stop and a wipe stop wait on. The route admits a request only through the
 * checks in security.ts (the security model is described in server.ts).
 */

// The web platform installs before any core module loads; the server
// registers its per-run fan-out and wipe stop on it (setWebShellRun).
import { setWebShellRun } from './platform';
import * as http from 'node:http';
import * as path from 'node:path';

import { initializeHeaders } from '../../core/api/randomizer';
import * as settings from '../../core/settings';
import { holdWebServerLock } from '../../platforms/node/cliSessionLock';
import { clearLeftoverToken, clearTokenBeforeExit } from './loginClears';
import * as logger from '../../core/logger';
import { displayVersion } from '../../core/appVersion';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GuiLogSink } from '../../core/logger';

import { handleApi, openEventStream } from './apiRouter';
import { fail } from './responses';
import {
    WEB_SHELL_TOKEN_REFUSED,
    isCrossSiteStream,
    isLocalHost,
    isShellToken,
    newShellToken,
    requestToken,
} from './security';
import { serveStatic } from './staticFiles';
import { buildWebHandlers } from './webHandlers';
import type { Emit } from './webHandlers';

const LOOPBACK_HOST = '127.0.0.1';

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
    // The window is closed by the exit, so the reply to the wipe is let out first.
    const afterWipe = () => {
        wiped = true;
    };
    const handlers = buildWebHandlers(emit);
    // The platform's windows delegate to this run while it listens; the close
    // chain of a started server unregisters it again.
    setWebShellRun({ emit, afterWipe });

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
        // The callback takes the already-closed error, so a stop() that raced ahead leaves no stray 'error' event.
        server.close(() => undefined);
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
        setWebShellRun(null);
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
    logger.withCategory('ui').infoT('m956d26ca4fee', [logger.getAppName(), displayVersion()]);
    logger.withCategory('ui').info(`Web UI listening on ${origin}`, { userData: settings.getUserDataPath() });
    return { server, token, url: `${origin}#t=${token}`, stop, whenClosed };
};

export { createWebServer, startWebServer };
