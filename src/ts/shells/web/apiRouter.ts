/**
 * The /api/ surface: the Server-Sent Events stream every browser listens on,
 * the logout endpoint, and the window.api invokes — one channel each, with
 * the renderer's argument protocol (decodeArgs, security.ts) applied. The
 * route admits a request here only after the checks in security.ts.
 */

import { invokeHandler } from '../../core/ipc/invokeHandler';
import { logout as sharedLogout, LogoutNotSavedError } from '../../core/services/auth';
import { LOGOUT_NOT_SAVED } from '../../core/ipc/logoutCode';
import * as logger from '../../core/logger';
import { errorMessage } from '../../core/errorMessage';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IpcHandler } from '../../core/ipc/invokeHandler';

import { sendJson, fail } from './responses';
import { isSameOrigin, readJsonBody, decodeArgs } from './security';

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

export { openEventStream, handleApi };
