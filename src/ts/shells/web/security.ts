/**
 * The checks a web-shell request passes before it is served: the Host header
 * must be local, an /api/ request must carry the per-run token (a header on
 * POSTs, the `t` query parameter on the event stream, which EventSource cannot
 * set headers on), a POST must be same-origin, its body is read under a size
 * cap, and the renderer's argument protocol is decoded. The security model
 * these serve is described in server.ts.
 */

import * as crypto from 'node:crypto';

import { isPlainObject } from '../../core/plainObject';
import { isInteger } from '../../core/numbers';

import type { IncomingMessage } from 'node:http';

const TOKEN_HEADER = 'x-web-shell-token';
const TOKEN_QUERY_PARAM = 't';
// The stable code a request without the right token is refused with, for the page to explain (see bridge/web.ts).
const WEB_SHELL_TOKEN_REFUSED = 'web-shell-token';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
// Generous for a scenario import or a full settings save, small enough that a
// runaway client cannot balloon the process.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

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

export {
    WEB_SHELL_TOKEN_REFUSED,
    newShellToken,
    isShellToken,
    requestToken,
    isLocalHost,
    isSameOrigin,
    isCrossSiteStream,
    readJsonBody,
    decodeArgs,
};
