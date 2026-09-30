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

import type * as serverModule from '../../src/js/web/server';
import type * as settingsHandlersModule from '../../src/js/ipc/settings.handlers';
import type * as authModule from '../../src/js/services/auth';
import type * as settingsModule from '../../src/js/settings';
import type * as randomizerModule from '../../src/js/api/randomizer';
import type * as updateCheckerModule from '../../src/js/services/UpdateChecker';
import type { CategoryLogger, GuiLogSink } from '../../src/js/logger';

let mockSettingsDeps: Parameters<typeof settingsHandlersModule.buildHandlers>[0] | null = null;
jest.mock('../../src/js/ipc/settings.handlers', () => ({
    buildHandlers: (deps: Parameters<typeof settingsHandlersModule.buildHandlers>[0]) => {
        mockSettingsDeps = deps;
        return {
            'get-setting': async (_event: unknown, key: string, scope = 'global') => ({ key, scope }),
        };
    },
}));
jest.mock('../../src/js/ipc/voting.handlers', () => ({
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
jest.mock('../../src/js/ipc/log.handlers', () => ({
    buildHandlers: () => ({ 'get-log-backlog': async () => undefined }),
}));
jest.mock('../../src/js/ipc/actions.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/computations.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/currency.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/scenarios.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/services/visionVerifier', () => ({ hasBundledModel: async () => true }));
jest.mock('../../src/js/services/UpdateChecker', () => ({
    checkForUpdates: jest.fn(),
    getReleasesUrl: jest.fn(() => 'https://example.com/releases'),
}));
jest.mock('../../src/js/services/auth', () => ({ clearAuthToken: jest.fn(async () => true) }));
jest.mock('../../src/js/api/randomizer', () => ({ initializeHeaders: jest.fn() }));
jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(() => ''),
    setSetting: jest.fn(() => true),
    seedIntentProfiles: jest.fn(),
    getEnvironmentInfo: jest.fn(() => ({ defaultMock: false })),
    getUserDataPath: jest.fn(() => '/tmp/user-data'),
}));
const mockLog = { error: jest.fn(), warning: jest.fn(), info: jest.fn() };
jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn((): Pick<CategoryLogger, 'error' | 'warning' | 'info'> => mockLog),
}));

const { createWebServer, startWebServer } = require('../../src/js/web/server') as typeof serverModule;
const auth = jest.mocked(require('../../src/js/services/auth') as typeof authModule);
const settings = jest.mocked(require('../../src/js/settings') as typeof settingsModule);
const randomizer = jest.mocked(require('../../src/js/api/randomizer') as typeof randomizerModule);
const updateChecker = jest.mocked(require('../../src/js/services/UpdateChecker') as typeof updateCheckerModule);

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

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
    ({ server, emit } = createWebServer({ distDir }));
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
            (await request('POST', '/api/invoke/get-setting', { headers: { 'Content-Type': 'text/plain' }, body }))
                .status,
        ).toBe(403);
        expect((await request('POST', '/api/invoke/get-setting', { body })).status).toBe(403);
    });

    test('API paths only take POST', async () => {
        expect((await request('GET', '/api/invoke/get-setting')).status).toBe(405);
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
    const openStream = () =>
        new Promise<{ frames: string[]; req: http.ClientRequest; ready: Promise<void> }>((resolve) => {
            const frames: string[] = [];
            let markReady: () => void = () => {};
            const ready = new Promise<void>((r) => (markReady = r));
            const req = http.request(
                { host: '127.0.0.1', port, path: '/api/events', headers: { Host: `localhost:${port}` } },
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

    test('a closed stream stops receiving', async () => {
        const gone = await openStream();
        await gone.ready;
        gone.req.destroy();
        await new Promise((r) => setTimeout(r, 50));
        emit('update-checking');
    });
});

describe('startWebServer', () => {
    const globals = globalThis as typeof globalThis & { sendLogToGUI?: GuiLogSink };

    afterEach(() => {
        delete globals.sendLogToGUI;
    });

    test('boots headers and intent presets, routes the logger fan-out, and listens on loopback', async () => {
        const started = await startWebServer({ port: 0, distDir });
        try {
            expect(randomizer.initializeHeaders).toHaveBeenCalled();
            expect(settings.seedIntentProfiles).toHaveBeenCalled();
            expect(started.url).toMatch(/^http:\/\/localhost:\d+\/$/);
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

    test('a failed preset seed is non-fatal; a taken port rejects', async () => {
        settings.seedIntentProfiles.mockImplementationOnce(() => {
            throw new Error('seed failed');
        });
        await expect(startWebServer({ port, distDir })).rejects.toThrow(/EADDRINUSE/);
        expect(mockLog.warning).toHaveBeenCalledWith('Intent profile seeding failed (non-fatal):', expect.any(Error));
    });
});
