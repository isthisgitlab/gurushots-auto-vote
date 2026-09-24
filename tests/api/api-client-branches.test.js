/**
 * Edge-case tests for api/api-client.js that complement api-client.test.js:
 *   - the headless (Android background service) adapter's error / non-JSON /
 *     missing-field handling, its request-body encoding, and adapter caching;
 *   - retry classification (TypeError and odd statuses are terminal);
 *   - Retry-After parsing fallbacks and the minimum retry delay;
 *   - coercion of the retry settings.
 *
 * makePostRequest's contract is "body or null, never throws" — every failure
 * path below asserts a null result, never a rejection.
 */

const axios = require('axios');

jest.mock('../../src/js/api/randomizer', () => ({
    generateRandomHeaders: jest.fn((token) => ({ 'x-token': token })),
}));

jest.mock('../../src/js/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
}));

jest.mock(
    '@capacitor/core',
    () => ({
        CapacitorHttp: { request: jest.fn() },
    }),
    { virtual: true },
);

jest.mock('../../src/js/settings', () => ({ getSetting: jest.fn() }));

jest.mock('../../src/js/timing', () => ({ sleep: jest.fn(() => Promise.resolve()) }));

const settings = require('../../src/js/settings');
const runtime = require('../../src/js/runtime');
const timing = require('../../src/js/timing');
const logger = require('../../src/js/logger');
const { makePostRequest } = require('../../src/js/api/api-client');

const URL = 'https://api.gurushots.com/edge';

const defaultSettings = (overrides = {}) => {
    const values = { apiTimeout: 30, apiMaxRetries: 3, apiRetryBaseDelayMs: 0, ...overrides };
    settings.getSetting.mockImplementation((key) => values[key]);
};

const httpError = (status, data, headers = {}) => {
    const e = new Error(`Request failed with status code ${status}`);
    e.response = { status, data, headers };
    return e;
};

const apiLogEntries = (message) =>
    logger.withCategory.mock.results
        .flatMap((r) => r.value.api.mock.calls)
        .filter((call) => call[0] === message)
        .map((call) => call[1]);

/** Capture the adapter makePostRequest attaches on the headless path. */
const captureHeadlessAdapter = async () => {
    runtime.isHeadlessService.mockReturnValue(true);
    let adapter;
    axios.mockImplementationOnce(async (config) => {
        adapter = config.adapter;
        return { status: 200, headers: {}, data: {} };
    });
    await makePostRequest(URL, {}, '');
    runtime.isHeadlessService.mockReturnValue(false);
    return adapter;
};

/** Install a native bridge that answers every request with `result`. */
const installNativeBridge = (result) => {
    globalThis.AndroidHeadlessHttp = {
        request: jest.fn((id) => {
            globalThis.__gsResolveHeadlessHttp(id, JSON.stringify(result));
        }),
    };
    return globalThis.AndroidHeadlessHttp.request;
};

beforeEach(() => {
    jest.clearAllMocks();
    axios.mockReset();
    defaultSettings();
});

afterEach(() => {
    delete globalThis.AndroidHeadlessHttp;
});

describe('headless adapter', () => {
    test('rejects with the native transport error message', async () => {
        const adapter = await captureHeadlessAdapter();
        installNativeBridge({ error: 'socket closed' });

        await expect(adapter({ method: 'post', url: URL, headers: {}, data: '' })).rejects.toThrow('socket closed');
    });

    test('returns a non-JSON body as the raw string and defaults missing headers to {}', async () => {
        const adapter = await captureHeadlessAdapter();
        installNativeBridge({ status: 200, body: '<html>ok</html>' });

        const response = await adapter({ method: 'post', url: URL, headers: {}, data: '' });

        expect(response.data).toBe('<html>ok</html>');
        expect(response.headers).toEqual({});
        expect(response.status).toBe(200);
    });

    test('rejects when the native result itself is not valid JSON', async () => {
        const adapter = await captureHeadlessAdapter();
        globalThis.AndroidHeadlessHttp = {
            request: jest.fn((id) => globalThis.__gsResolveHeadlessHttp(id, 'not json')),
        };

        await expect(adapter({ method: 'post', url: URL, headers: {}, data: '' })).rejects.toThrow(SyntaxError);
    });

    test('JSON-encodes an object body, sends "" for no body, and defaults method/headers', async () => {
        const adapter = await captureHeadlessAdapter();
        const request = installNativeBridge({ status: 200, body: '{}' });

        await adapter({ method: 'post', url: URL, headers: { a: '1' }, data: { x: 1 } });
        await adapter({ url: URL });

        expect(request.mock.calls[0].slice(1)).toEqual(['POST', URL, JSON.stringify({ a: '1' }), '{"x":1}']);
        expect(request.mock.calls[1].slice(1)).toEqual(['GET', URL, '{}', '']);
        // Each request gets its own correlation id.
        expect(request.mock.calls[0][0]).not.toBe(request.mock.calls[1][0]);
    });

    test('the resolver ignores ids it does not know (late or duplicate callbacks)', async () => {
        const adapter = await captureHeadlessAdapter();
        let resolveLater;
        globalThis.AndroidHeadlessHttp = {
            request: jest.fn((id) => {
                resolveLater = () => globalThis.__gsResolveHeadlessHttp(id, JSON.stringify({ status: 200, body: '1' }));
            }),
        };

        const pending = adapter({ method: 'post', url: URL, headers: {}, data: '' });
        expect(() => globalThis.__gsResolveHeadlessHttp(-1, '{}')).not.toThrow();
        resolveLater();
        // A second delivery for an already-settled id is a no-op.
        expect(() => resolveLater()).not.toThrow();

        await expect(pending).resolves.toMatchObject({ status: 200, data: 1 });
    });

    test('the same adapter instance is reused across requests', async () => {
        const first = await captureHeadlessAdapter();
        const second = await captureHeadlessAdapter();

        expect(second).toBe(first);
    });

    test('an already-installed global resolver is not replaced', () => {
        jest.isolateModules(() => {
            const existing = jest.fn();
            globalThis.__gsResolveHeadlessHttp = existing;
            try {
                const isolatedRuntime = require('../../src/js/runtime');
                const isolatedAxios = require('axios');
                isolatedRuntime.isHeadlessService.mockReturnValue(true);
                isolatedAxios.mockResolvedValueOnce({ status: 200, headers: {}, data: {} });
                require('../../src/js/api/api-client').makePostRequest(URL, {}, '');
                expect(globalThis.__gsResolveHeadlessHttp).toBe(existing);
                isolatedRuntime.isHeadlessService.mockReturnValue(false);
            } finally {
                delete globalThis.__gsResolveHeadlessHttp;
            }
        });
    });
});

describe('capacitor adapter caching', () => {
    test('the same CapacitorHttp adapter instance is reused across requests', async () => {
        runtime.isCapacitor.mockReturnValue(true);
        const adapters = [];
        axios.mockImplementation(async (config) => {
            adapters.push(config.adapter);
            return { status: 200, headers: {}, data: {} };
        });

        await makePostRequest(URL, {}, '');
        await makePostRequest(URL, {}, '');
        runtime.isCapacitor.mockReturnValue(false);

        expect(adapters).toHaveLength(2);
        expect(typeof adapters[0]).toBe('function');
        expect(adapters[1]).toBe(adapters[0]);
    });
});

describe('retry classification', () => {
    test('a TypeError (adapter/programmer bug) is not retried', async () => {
        axios.mockRejectedValue(new TypeError('cannot read properties of undefined'));

        await expect(makePostRequest(URL, {}, '')).resolves.toBeNull();
        expect(axios).toHaveBeenCalledTimes(1);
        expect(timing.sleep).not.toHaveBeenCalled();
    });

    test('a rejection with no error object is terminal and still resolves null', async () => {
        axios.mockRejectedValue(null);

        await expect(makePostRequest(URL, {}, '')).resolves.toBeNull();
        expect(axios).toHaveBeenCalledTimes(1);
        expect(timing.sleep).not.toHaveBeenCalled();
    });

    test('a response with a non-numeric status is terminal', async () => {
        axios.mockRejectedValue(httpError('weird', null));

        await expect(makePostRequest(URL, {}, '')).resolves.toBeNull();
        expect(axios).toHaveBeenCalledTimes(1);
    });

    test('a timeout that carries a 4xx response is still retried (ECONNABORTED wins)', async () => {
        const err = httpError(400, null);
        err.code = 'ECONNABORTED';
        axios.mockRejectedValueOnce(err).mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: 1 } });

        await expect(makePostRequest(URL, {}, '')).resolves.toEqual({ ok: 1 });
        expect(axios).toHaveBeenCalledTimes(2);
    });

    test('logs NO_RESPONSE and a null body for a network error', async () => {
        defaultSettings({ apiMaxRetries: 0 });
        axios.mockRejectedValue(new Error('Network Error'));

        await makePostRequest(URL, {}, '');

        expect(apiLogEntries('API Error Response')).toEqual([
            expect.objectContaining({ status: 'NO_RESPONSE', responseData: null, timeout: false }),
        ]);
    });
});

describe('retry delay selection', () => {
    test('a zero retry_after is clamped up to the 100ms minimum', async () => {
        axios
            .mockRejectedValueOnce(httpError(429, { retry_after: 0 }))
            .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });

        await expect(makePostRequest(URL, {}, '')).resolves.toBe('ok');
        expect(timing.sleep).toHaveBeenCalledWith(100);
    });

    test('a negative body retry_after is ignored in favour of the Retry-After header', async () => {
        axios
            .mockRejectedValueOnce(httpError(429, { retry_after: -3 }, { 'retry-after': '4' }))
            .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });

        await makePostRequest(URL, {}, '');

        expect(timing.sleep).toHaveBeenCalledWith(4000);
    });

    test('an unparseable Retry-After header falls back to exponential backoff', async () => {
        defaultSettings({ apiRetryBaseDelayMs: 200 });
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
        try {
            axios
                .mockRejectedValueOnce(httpError(503, null, { 'retry-after': 'soon' }))
                .mockRejectedValueOnce(httpError(503, null))
                .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });

            await expect(makePostRequest(URL, {}, '')).resolves.toBe('ok');

            // attempt 0: 200*1 + 0.5*200 = 300; attempt 1: 200*2 + 100 = 500
            expect(timing.sleep.mock.calls).toEqual([[300], [500]]);
        } finally {
            Math.random.mockRestore();
        }
    });

    test('exponential backoff is capped at 30s', async () => {
        defaultSettings({ apiRetryBaseDelayMs: 60_000, apiMaxRetries: 1 });
        axios.mockRejectedValue(httpError(500, null));

        await expect(makePostRequest(URL, {}, '')).resolves.toBeNull();
        expect(timing.sleep).toHaveBeenCalledWith(30_000);
    });
});

describe('retry settings coercion', () => {
    test.each([
        ['null', null, 4],
        ['a non-numeric string', 'lots', 4],
        ['a numeric string', '1', 2],
        ['a fractional value (floored)', 2.9, 3],
    ])('apiMaxRetries of %s gives the expected attempt count', async (_label, value, attempts) => {
        defaultSettings({ apiMaxRetries: value });
        axios.mockRejectedValue(httpError(502, null));

        await expect(makePostRequest(URL, {}, '')).resolves.toBeNull();
        expect(axios).toHaveBeenCalledTimes(attempts);
    });
});
