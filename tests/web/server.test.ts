/**
 * Web shell server — serves the renderer and answers window.api over HTTP.
 * Runs a real server on an ephemeral loopback port against a temp dist/ and
 * drives it with node:http, so the Host/Origin guards see exactly the headers
 * a test sends. The ipc handler modules are mocked to small fixed maps.
 */

jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as serverModule from '../../src/ts/web/server';
import type * as settingsHandlersModule from '../../src/ts/ipc/settings.handlers';
import type * as authModule from '../../src/ts/services/auth';
import type * as settingsModule from '../../src/ts/settings';
import type * as randomizerModule from '../../src/ts/api/randomizer';
import type * as updateCheckerModule from '../../src/ts/services/UpdateChecker';
import type * as cliSessionLockModule from '../../src/ts/settings/cliSessionLock';
import type { CategoryLogger, GuiLogSink } from '../../src/ts/logger';

let mockWipeSucceeds = true;
// While set, 'slow-setting' waits for it: a request that is still in flight when a wipe finishes.
let mockSlowGate: Promise<void> | null = null;
let mockSettingsDeps: Parameters<typeof settingsHandlersModule.buildHandlers>[0] | null = null;
jest.mock('../../src/ts/ipc/settings.handlers', () => ({
    buildHandlers: (deps: Parameters<typeof settingsHandlersModule.buildHandlers>[0]) => {
        mockSettingsDeps = deps;
        return {
            'get-setting': async (_event: unknown, key: string, scope = 'global') => ({ key, scope }),
            'slow-setting': async () => {
                await mockSlowGate;
                return 'slow';
            },
            'wipe-local-data': async () => {
                if (!mockWipeSucceeds) return { success: false, error: 'busy' };
                mockSettingsDeps?.afterWipe?.();
                return { success: true };
            },
        };
    },
}));
jest.mock('../../src/ts/ipc/voting.handlers', () => ({
    buildHandlers: () => ({
        'gui-vote': async () => {
            throw new Error('vote exploded');
        },
        'refresh-api': async () => {
            throw new Error('');
        },
        'get-active-challenges': async () => ({ big: BigInt(1) }),
    }),
}));
jest.mock('../../src/ts/ipc/log.handlers', () => ({
    buildHandlers: () => ({ 'get-log-backlog': async () => undefined }),
}));
jest.mock('../../src/ts/ipc/actions.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/ipc/computations.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/ipc/currency.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/ipc/scenarios.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/services/visionVerifier', () => ({ hasBundledModel: async () => true }));
jest.mock('../../src/ts/services/UpdateChecker', () => ({
    checkForUpdates: jest.fn(),
    getReleasesUrl: jest.fn(() => 'https://example.com/releases'),
}));
jest.mock('../../src/ts/services/auth', () => {
    class LogoutNotSavedError extends Error {}
    return { clearAuthToken: jest.fn(async () => true), LogoutNotSavedError };
});
jest.mock('../../src/ts/api/randomizer', () => ({ initializeHeaders: jest.fn() }));
jest.mock('../../src/ts/settings', () => ({
    getSetting: jest.fn(() => ''),
    setSetting: jest.fn(() => true),
    seedIntentProfiles: jest.fn(),
    getEnvironmentInfo: jest.fn(() => ({ defaultMock: false })),
    getUserDataPath: jest.fn(() => '/tmp/user-data'),
}));
// The marker the server holds while it runs: recorded, never written to a user-data directory.
const mockReleaseMarker = jest.fn<void, []>();
jest.mock('../../src/ts/settings/cliSessionLock', () => ({ holdWebServerLock: jest.fn(() => mockReleaseMarker) }));
const mockLog = { error: jest.fn(), warning: jest.fn(), info: jest.fn() };
jest.mock('../../src/ts/logger', () => ({
    withCategory: jest.fn((): Pick<CategoryLogger, 'error' | 'warning' | 'info'> => mockLog),
    printLine: jest.fn(),
}));

const { createWebServer, startWebServer } = require('../../src/ts/web/server') as typeof serverModule;
const auth = jest.mocked(require('../../src/ts/services/auth') as typeof authModule);
const settings = jest.mocked(require('../../src/ts/settings') as typeof settingsModule);
const randomizer = jest.mocked(require('../../src/ts/api/randomizer') as typeof randomizerModule);
const updateChecker = jest.mocked(require('../../src/ts/services/UpdateChecker') as typeof updateCheckerModule);
const { holdWebServerLock } = jest.mocked(
    require('../../src/ts/settings/cliSessionLock') as typeof cliSessionLockModule,
);

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

const TOKEN = 'run-token-0123456789abcdef';
const TOKEN_HEADER = { 'x-web-shell-token': TOKEN };
const JSON_HEADERS = { 'Content-Type': 'application/json', ...TOKEN_HEADER };
const onWiped = jest.fn();

let distDir: string;
let server: http.Server;
let port: number;

/**
 * One request to the server under test, with a localhost Host header unless `host` is given.
 */
const request = (
    method: string,
    urlPath: string,
    { headers = {}, body, host }: { headers?: Record<string, string>; body?: string; host?: string } = {},
): Promise<Reply> =>
    new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                method,
                path: urlPath,
                setHost: false,
                headers: { Host: host ?? `localhost:${port}`, ...headers },
            },
            (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => (data += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
            },
        );
        req.on('error', reject);
        req.end(body);
    });

const invoke = (channel: string, payload: unknown, headers: Record<string, string> = JSON_HEADERS) =>
    request('POST', `/api/invoke/${channel}`, { headers, body: JSON.stringify(payload) });

const parsed = (reply: Reply): unknown => JSON.parse(reply.body);

const listen = async (srv: http.Server) => {
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    return (srv.address() as { port: number }).port;
};

// closeAllConnections: an open event stream never ends by itself.
const close = (srv: http.Server) =>
    new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
    });

let emit: (channel: string, payload?: unknown) => void;

beforeAll(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-web-dist-'));
    fs.writeFileSync(path.join(distDir, 'web.html'), '<html>web</html>');
    fs.writeFileSync(path.join(distDir, 'web-bundle.js'), 'console.log(1)');
    fs.writeFileSync(path.join(distDir, 'model.onnx'), 'bin');
    fs.mkdirSync(path.join(distDir, 'assets'));
});

afterAll(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
});

beforeEach(async () => {
    jest.clearAllMocks();
    mockWipeSucceeds = true;
    mockSlowGate = null;
    ({ server, emit } = createWebServer({ distDir, token: TOKEN, onLocalDataWiped: onWiped }));
    port = await listen(server);
});

afterEach(async () => {
    if (server.listening) await close(server);
});

describe('static files', () => {
    test('/ serves web.html; other files by extension, unknown types as octet-stream', async () => {
        const index = await request('GET', '/');
        expect(index.status).toBe(200);
        expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(index.headers['x-content-type-options']).toBe('nosniff');
        expect(index.body).toBe('<html>web</html>');

        const bundle = await request('GET', '/web-bundle.js');
        expect(bundle.headers['content-type']).toBe('text/javascript; charset=utf-8');

        const model = await request('GET', '/model.onnx');
        expect(model.headers['content-type']).toBe('application/octet-stream');

        const head = await request('HEAD', '/web-bundle.js');
        expect(head.status).toBe(200);
        expect(head.body).toBe('');
    });

    test('missing files, directories and paths outside dist/ are 404', async () => {
        expect((await request('GET', '/nope.js')).status).toBe(404);
        expect((await request('GET', '/assets')).status).toBe(404);
        expect((await request('GET', '/%2e%2e/package.json')).status).toBe(404);
    });

    test('a malformed path escape is a 500, not a crash', async () => {
        const reply = await request('GET', '/%E0%A4%A');
        expect(reply.status).toBe(500);
        expect(mockLog.error).toHaveBeenCalledWith('Web request failed', expect.any(URIError));
    });

    test('an unreadable file ends the response instead of crashing the server', async () => {
        const locked = path.join(distDir, 'locked.js');
        fs.writeFileSync(locked, 'x');
        fs.chmodSync(locked, 0o000);
        try {
            await expect(request('GET', '/locked.js')).rejects.toThrow();
        } finally {
            fs.chmodSync(locked, 0o644);
        }
        expect((await request('GET', '/')).status).toBe(200);
    });

    test('other methods are refused', async () => {
        expect((await request('PUT', '/')).status).toBe(405);
    });
});

describe('request guards', () => {
    test('a non-local or missing Host header is refused (DNS rebinding)', async () => {
        expect((await request('GET', '/', { host: 'evil.example:80' })).status).toBe(403);
        // HTTP/1.0 may omit Host (Node itself rejects a Host-less 1.1 request).
        const bare = await new Promise<string>((resolve) => {
            const socket = net.connect(port, '127.0.0.1', () => socket.end('GET / HTTP/1.0\r\n\r\n'));
            let data = '';
            socket.on('data', (chunk) => (data += chunk.toString()));
            socket.on('end', () => resolve(data));
        });
        expect(bare).toMatch(/^HTTP\/1\.1 403/);
        expect((await request('GET', '/', { host: `127.0.0.1:${port}` })).status).toBe(200);
        expect((await request('GET', '/', { host: `[::1]:${port}` })).status).toBe(200);
    });

    test('API POSTs need a same-origin (or absent) Origin and a JSON body type', async () => {
        const body = JSON.stringify({ args: ['theme'] });
        const cross = await request('POST', '/api/invoke/get-setting', {
            headers: { ...JSON_HEADERS, Origin: 'http://evil.example' },
            body,
        });
        expect(cross.status).toBe(403);

        const same = await request('POST', '/api/invoke/get-setting', {
            headers: { ...JSON_HEADERS, Origin: `http://localhost:${port}` },
            body,
        });
        expect(same.status).toBe(200);

        expect(
            (
                await request('POST', '/api/invoke/get-setting', {
                    headers: { 'Content-Type': 'text/plain', ...TOKEN_HEADER },
                    body,
                })
            ).status,
        ).toBe(403);
        expect((await request('POST', '/api/invoke/get-setting', { headers: TOKEN_HEADER, body })).status).toBe(403);
    });

    test('API paths only take POST', async () => {
        expect((await request('GET', '/api/invoke/get-setting', { headers: TOKEN_HEADER })).status).toBe(405);
    });

    test('an oversized or malformed body is rejected', async () => {
        const big = await request('POST', '/api/invoke/get-setting', {
            headers: JSON_HEADERS,
            body: 'x'.repeat(5 * 1024 * 1024 + 1),
        });
        expect(big.status).toBe(413);
        const bad = await request('POST', '/api/invoke/get-setting', { headers: JSON_HEADERS, body: '{nope' });
        expect(bad.status).toBe(400);
    });
});

describe('access token', () => {
    const body = JSON.stringify({ args: ['theme'] });
    const apiRequests: [string, string, Record<string, string>][] = [
        ['an invoke', '/api/invoke/get-setting', { 'Content-Type': 'application/json' }],
        ['a logout', '/api/logout', { 'Content-Type': 'application/json' }],
        ['an unknown API path', '/api/other', { 'Content-Type': 'application/json' }],
    ];

    test.each(apiRequests)(
        '%s without the token is refused before any handler runs',
        async (_name, urlPath, headers) => {
            const reply = await request('POST', urlPath, { headers, body });
            expect(reply.status).toBe(403);
            expect(parsed(reply)).toEqual({
                success: false,
                error: 'web-shell-token',
            });
            expect(auth.clearAuthToken).not.toHaveBeenCalled();
        },
    );

    test.each(['wrong-token', TOKEN.slice(1), `${TOKEN}x`, ''])(
        'an invoke with the token %j is refused',
        async (given) => {
            const reply = await request('POST', '/api/invoke/get-setting', {
                headers: { 'Content-Type': 'application/json', 'x-web-shell-token': given },
                body,
            });
            expect(reply.status).toBe(403);
        },
    );

    test('a repeated token header is refused', async () => {
        const reply = await new Promise<number>((resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: '/api/invoke/get-setting',
                    headers: { Host: `localhost:${port}`, 'Content-Type': 'application/json' },
                },
                (res) => resolve(res.statusCode ?? 0),
            );
            req.on('error', reject);
            req.setHeader('x-web-shell-token', [TOKEN, TOKEN]);
            req.end(body);
        });
        expect(reply).toBe(403);
    });

    test('the right token is served, on every API route', async () => {
        expect((await invoke('get-setting', { args: ['theme'] })).status).toBe(200);
        const logout = await request('POST', '/api/logout', { headers: JSON_HEADERS, body: '{}' });
        expect(logout.status).toBe(200);
    });

    test('the event stream takes the token in the query, never from a header, and is refused without it', async () => {
        const missing = await request('GET', '/api/events');
        expect(missing.status).toBe(403);
        const wrong = await request('GET', '/api/events?t=nope');
        expect(wrong.status).toBe(403);
        const headerOnly = await request('GET', '/api/events', { headers: TOKEN_HEADER });
        expect(headerOnly.status).toBe(403);
    });

    test('the event stream refuses a cross-site request even with the right token', async () => {
        const stream = (headers: Record<string, string>) =>
            request('GET', `/api/events?t=${TOKEN}`, { headers }).then((reply) => reply.status);
        expect(await stream({ Origin: 'http://evil.example' })).toBe(403);
        expect(await stream({ Origin: `http://localhost:${port + 1}` })).toBe(403);
        expect(await stream({ 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
        expect(await stream({ 'Sec-Fetch-Site': 'same-site' })).toBe(403);
    });

    test.each([['same-origin'], ['none']])('the event stream opens for Sec-Fetch-Site: %s', async (site) => {
        const status = await new Promise<number>((resolve, reject) => {
            const req = http.get(
                {
                    host: '127.0.0.1',
                    port,
                    path: `/api/events?t=${TOKEN}`,
                    headers: { Host: `localhost:${port}`, 'Sec-Fetch-Site': site },
                },
                (res) => {
                    resolve(res.statusCode ?? 0);
                    req.destroy();
                },
            );
            req.on('error', reject);
        });
        expect(status).toBe(200);
    });

    test('a token in the query does not authorize a POST', async () => {
        const reply = await request('POST', `/api/invoke/get-setting?t=${TOKEN}`, {
            headers: { 'Content-Type': 'application/json' },
            body,
        });
        expect(reply.status).toBe(403);
    });

    test('static files need no token: it never travels to the server', async () => {
        expect((await request('GET', '/')).status).toBe(200);
    });

    test('a server made without a token gets its own random one', async () => {
        const first = createWebServer({ distDir });
        const second = createWebServer({ distDir });
        expect(first.token).toMatch(/^[0-9a-f]{64}$/);
        expect(first.token).not.toBe(second.token);
        const open = await listen(first.server);
        try {
            const noToken = await new Promise<number>((resolve, reject) => {
                http.get(
                    { host: '127.0.0.1', port: open, path: '/api/events', headers: { Host: `localhost:${open}` } },
                    (res) => resolve(res.statusCode ?? 0),
                ).on('error', reject);
            });
            expect(noToken).toBe(403);
        } finally {
            await close(first.server);
        }
    });
});

describe('local-data wipe', () => {
    test('stops the server after the reply, ends the event streams and says to restart', async () => {
        const stream = await new Promise<http.IncomingMessage>((resolve) => {
            http.get(
                { host: '127.0.0.1', port, path: `/api/events?t=${TOKEN}`, headers: { Host: `localhost:${port}` } },
                resolve,
            );
        });
        const streamEnded = new Promise<void>((resolve) => stream.on('end', resolve).resume());

        const reply = await invoke('wipe-local-data', { args: [] });

        expect(parsed(reply)).toEqual({ result: { success: true } });
        await streamEnded;
        await new Promise<void>((resolve) => (server.listening ? server.once('close', () => resolve()) : resolve()));
        expect(server.listening).toBe(false);
        expect(onWiped).toHaveBeenCalledTimes(1);
    });

    test('two replies finishing after a wipe stop the server once', async () => {
        let release: () => void = () => undefined;
        mockSlowGate = new Promise<void>((resolve) => (release = resolve));
        const slow = invoke('slow-setting', { args: [] });
        // The slow request has reached its handler before the wipe is asked for.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        await invoke('wipe-local-data', { args: [] });
        release();
        await slow;
        mockSlowGate = null;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        expect(onWiped).toHaveBeenCalledTimes(1);
    });

    test('a refused wipe leaves the server running', async () => {
        mockWipeSucceeds = false;

        const reply = await invoke('wipe-local-data', { args: [] });

        expect(parsed(reply)).toEqual({ result: { success: false, error: 'busy' } });
        expect(server.listening).toBe(true);
        expect(onWiped).not.toHaveBeenCalled();
        expect((await invoke('get-setting', { args: ['theme'] })).status).toBe(200);
    });

    test('a server without a callback still stops', async () => {
        await close(server);
        ({ server } = createWebServer({ distDir, token: TOKEN }));
        port = await listen(server);

        await invoke('wipe-local-data', { args: [] });
        await new Promise<void>((resolve) => (server.listening ? server.once('close', () => resolve()) : resolve()));

        expect(server.listening).toBe(false);
    });
});

describe('invoke', () => {
    test('passes the arguments to the handler and returns its result', async () => {
        const reply = await invoke('get-setting', { args: ['theme', 'challenge-1'] });
        expect(reply.status).toBe(200);
        expect(reply.headers['cache-control']).toBe('no-store');
        expect(parsed(reply)).toEqual({ result: { key: 'theme', scope: 'challenge-1' } });
    });

    test('restores undefined arguments so default parameters apply; ignores bad positions', async () => {
        const reply = await invoke('get-setting', { args: ['theme', null], undefinedAt: [1, 5, -1, 'x', 0.5] });
        expect(parsed(reply)).toEqual({ result: { key: 'theme', scope: 'global' } });
        const plain = await invoke('get-setting', { args: ['theme', null], undefinedAt: 'nope' });
        expect(parsed(plain)).toEqual({ result: { key: 'theme', scope: null } });
    });

    test('an undefined result comes back as an empty envelope', async () => {
        expect(parsed(await invoke('get-log-backlog', { args: [] }))).toEqual({});
    });

    test('a body without an args array is a 400', async () => {
        expect((await invoke('get-setting', { nope: true })).status).toBe(400);
        expect((await invoke('get-setting', [1])).status).toBe(400);
        const empty = await request('POST', '/api/invoke/get-setting', { headers: JSON_HEADERS });
        expect(empty.status).toBe(400);
    });

    test('unknown channels, prototype names and other API paths are 404', async () => {
        expect(parsed(await invoke('no-such-channel', { args: [] }))).toEqual({
            success: false,
            error: 'Unknown channel: no-such-channel',
        });
        expect((await invoke('constructor', { args: [] })).status).toBe(404);
        const other = await request('POST', '/api/other', { headers: JSON_HEADERS, body: '{}' });
        expect(parsed(other)).toEqual({ success: false, error: 'Unknown channel: /api/other' });
    });

    test('a handler that throws, or returns what JSON cannot encode, is a 500', async () => {
        const thrown = await invoke('gui-vote', { args: [] });
        expect(thrown.status).toBe(500);
        expect(parsed(thrown)).toEqual({ success: false, error: 'vote exploded' });
        expect(parsed(await invoke('refresh-api', { args: [] }))).toEqual({ success: false, error: 'Handler failed' });
        expect((await invoke('get-active-challenges', { args: [] })).status).toBe(500);
    });

    test('update channels: no self-install, so downloads point at the releases page', async () => {
        expect(parsed(await invoke('can-auto-update', { args: [] }))).toEqual({
            result: { success: true, canAutoUpdate: false },
        });
        const failure = {
            success: false,
            error: 'The web UI does not install updates — download the new release instead',
            fallbackUrl: 'https://example.com/releases',
        };
        expect(parsed(await invoke('download-update', { args: [] }))).toEqual({ result: failure });
        expect(parsed(await invoke('install-update', { args: [] }))).toEqual({ result: failure });

        updateChecker.checkForUpdates.mockResolvedValue({
            updateAvailable: false,
            version: '1.0.0',
            downloadUrl: null,
            isPrerelease: false,
            releaseNotes: '',
            releaseDate: null,
        });
        await invoke('check-for-updates', { args: [] });
        expect(updateChecker.checkForUpdates).toHaveBeenCalledWith(expect.objectContaining({ assetSuffix: null }));
    });
});

describe('logout', () => {
    test('clears the token and resets mock to the environment default', async () => {
        const reply = await request('POST', '/api/logout', { headers: JSON_HEADERS, body: '{"args":[]}' });
        expect(parsed(reply)).toEqual({ result: { success: true } });
        expect(auth.clearAuthToken).toHaveBeenCalled();
        expect(settings.setSetting).toHaveBeenCalledWith('mock', false);
    });

    test('a logout the settings refused is answered as refused, and the mock flag is left alone', async () => {
        auth.clearAuthToken.mockRejectedValueOnce(new auth.LogoutNotSavedError());
        settings.setSetting.mockClear();

        const reply = await request('POST', '/api/logout', { headers: JSON_HEADERS, body: '' });

        expect(parsed(reply)).toEqual({ result: { success: false, error: 'logout-not-saved' } });
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test('a failed token flush is logged and the logout still completes', async () => {
        auth.clearAuthToken.mockRejectedValueOnce(new Error('disk full'));
        const reply = await request('POST', '/api/logout', { headers: JSON_HEADERS, body: '' });
        expect(reply.status).toBe(200);
        expect(mockLog.error).toHaveBeenCalledWith('Logout failed to clear token', expect.any(Error));
    });
});

describe('events', () => {
    /**
     * Open the event stream and collect what arrives until `count` frames are in.
     */
    const openStream = (token: string = TOKEN) =>
        new Promise<{ frames: string[]; req: http.ClientRequest; ready: Promise<void> }>((resolve) => {
            const frames: string[] = [];
            let markReady: () => void = () => {};
            const ready = new Promise<void>((r) => (markReady = r));
            const req = http.request(
                { host: '127.0.0.1', port, path: `/api/events?t=${token}`, headers: { Host: `localhost:${port}` } },
                (res) => {
                    res.setEncoding('utf8');
                    res.on('data', (chunk: string) => {
                        frames.push(chunk);
                        markReady();
                    });
                },
            );
            req.on('error', () => {});
            req.end();
            resolve({ frames, req, ready });
        });

    const waitFor = async (check: () => boolean) => {
        for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    };

    test('broadcasts events, settings changes included, to every open stream', async () => {
        const stream = await openStream();
        await stream.ready;
        expect(stream.frames[0]).toBe(': connected\n\n');

        emit('update-checking');
        mockSettingsDeps!.broadcastSettingsChange!({ theme: 'dark' });
        await waitFor(() => stream.frames.join('').includes('settings-changed'));
        const all = stream.frames.join('');
        expect(all).toContain('event: update-checking\ndata: null\n\n');
        expect(all).toContain('event: settings-changed\ndata: {"theme":"dark"}\n\n');
        stream.req.destroy();
    });

    test('a disconnected stream is dropped while the others keep receiving', async () => {
        const gone = await openStream();
        const kept = await openStream();
        await Promise.all([gone.ready, kept.ready]);
        gone.req.destroy();
        emit('update-checking', { at: 'right after the disconnect' });
        await new Promise((r) => setTimeout(r, 50));
        emit('update-error', { message: 'later' });
        await waitFor(() => kept.frames.join('').includes('update-error'));
        expect(kept.frames.join('')).toContain('event: update-checking');
        expect(kept.frames.join('')).toContain('event: update-error');
        expect(gone.frames.join('')).not.toContain('update-error');
        kept.req.destroy();
    });
});

describe('startWebServer', () => {
    const globals = globalThis as typeof globalThis & { sendLogToGUI?: GuiLogSink };

    afterEach(() => {
        delete globals.sendLogToGUI;
        holdWebServerLock.mockClear();
        mockReleaseMarker.mockClear();
    });

    test('holds the web-server marker while it listens, so a wipe from the app or the CLI waits for it', async () => {
        const started = await startWebServer({ port: 0, distDir });

        expect(holdWebServerLock).toHaveBeenCalledTimes(1);
        expect(started.server.listening).toBe(true);
        expect(mockReleaseMarker).not.toHaveBeenCalled();

        await close(started.server);
        expect(mockReleaseMarker).toHaveBeenCalledTimes(1);
    });

    test('holds no marker when it could not start listening', async () => {
        const started = await startWebServer({ port: 0, distDir });
        const taken = (started.server.address() as net.AddressInfo).port;
        holdWebServerLock.mockClear();
        try {
            await expect(startWebServer({ port: taken, distDir })).rejects.toThrow(/EADDRINUSE/);
            expect(holdWebServerLock).not.toHaveBeenCalled();
        } finally {
            await close(started.server);
        }
    });

    test('boots headers and intent presets, routes the logger fan-out, and listens on loopback', async () => {
        const started = await startWebServer({ port: 0, distDir });
        try {
            expect(randomizer.initializeHeaders).toHaveBeenCalled();
            expect(settings.seedIntentProfiles).toHaveBeenCalled();
            expect(started.url).toBe(
                `http://localhost:${(started.server.address() as net.AddressInfo).port}/#t=${started.token}`,
            );
            expect(started.token).toMatch(/^[0-9a-f]{64}$/);
            expect(started.server.address()).toEqual(expect.objectContaining({ address: '127.0.0.1' }));
            expect(typeof globals.sendLogToGUI).toBe('function');
            globals.sendLogToGUI!({
                seq: 1,
                level: 'INFO',
                context: 'CLI',
                category: 'ui',
                timestamp: 't',
                message: 'm',
            });
        } finally {
            await close(started.server);
        }
    });

    test('the token is in the returned URL only: never in a logger call, never in the logged URL', async () => {
        const started = await startWebServer({ port: 0, distDir });
        try {
            const { url, token } = started;
            const logged = JSON.stringify([
                mockLog.info.mock.calls,
                mockLog.warning.mock.calls,
                mockLog.error.mock.calls,
            ]);
            expect(logged).not.toContain(token);
            expect(mockLog.info).toHaveBeenCalledWith(
                `Web UI listening on ${url.split('#')[0]}`,
                expect.objectContaining({ userData: '/tmp/user-data' }),
            );
            const api = await fetch(`${url.split('#')[0]}api/invoke/get-setting`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-web-shell-token': token },
                body: JSON.stringify({ args: ['theme'] }),
            });
            expect(api.status).toBe(200);
            const refused = await fetch(`${url.split('#')[0]}api/invoke/get-setting`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ args: ['theme'] }),
            });
            expect(refused.status).toBe(403);
            expect(JSON.stringify(mockLog.error.mock.calls)).not.toContain(token);
        } finally {
            await close(started.server);
        }
    });

    test('after a wipe it says on the console that the web shell must be started again', async () => {
        const started = await startWebServer({ port: 0, distDir });
        const loggerModule = jest.mocked(require('../../src/ts/logger') as { printLine: jest.Mock<void, [string]> });
        const origin = started.url.split('#')[0];

        await fetch(`${origin}api/invoke/wipe-local-data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-web-shell-token': started.token },
            body: JSON.stringify({ args: [] }),
        });
        await new Promise<void>((resolve) =>
            started.server.listening ? started.server.once('close', () => resolve()) : resolve(),
        );

        expect(loggerModule.printLine).toHaveBeenCalledWith(
            'Local data was deleted. The web shell has stopped: start it again to continue.',
        );
        expect(started.server.listening).toBe(false);
    });

    test('a failed preset seed is non-fatal; a taken port rejects', async () => {
        settings.seedIntentProfiles.mockImplementationOnce(() => {
            throw new Error('seed failed');
        });
        await expect(startWebServer({ port, distDir })).rejects.toThrow(/EADDRINUSE/);
        expect(mockLog.warning).toHaveBeenCalledWith('Intent profile seeding failed (non-fatal):', expect.any(Error));
    });
});
