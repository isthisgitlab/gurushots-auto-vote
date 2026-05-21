/**
 * Tests for api-client.js
 *
 * Tests the core HTTP client functionality and common headers for API requests.
 */

const axios = require('axios');
const { makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE } = require('../../src/js/api/api-client');

// Mock the randomizer module
jest.mock('../../src/js/api/randomizer', () => ({
    generateRandomHeaders: jest.fn((token) => ({
        'x-token': token || 'mock-token',
        'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
        accept: 'application/json',
        'accept-language': 'en-US',
        connection: 'keep-alive',
    })),
}));

// Mock the runtime module so we can flip isCapacitor() per-test.
jest.mock('../../src/js/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
    isElectron: jest.fn(() => false),
    isCli: jest.fn(() => true),
    getPlatform: jest.fn(() => 'cli'),
    isPackaged: jest.fn(() => false),
    getOs: jest.fn(() => 'darwin'),
    isDevelopment: jest.fn(() => false),
    isProduction: jest.fn(() => true),
    isTest: jest.fn(() => true),
    getEnvSnapshot: jest.fn(() => ({})),
    getUserDataDir: jest.fn((appName) => `/tmp/${appName}`),
}));

// Mock @capacitor/core for the CapacitorHttp adapter test.
jest.mock(
    '@capacitor/core',
    () => ({
        CapacitorHttp: { request: jest.fn() },
    }),
    { virtual: true },
);

// Mock settings so the request timeout and retry/backoff knobs are
// deterministic. The default impl is installed in beforeEach;
// apiRetryBaseDelayMs is 0 there so backoff sleeps are instant.
jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(),
}));

// Mock the logger module
jest.mock('../../src/js/logger', () => {
    const mockApiFn = jest.fn();
    const mockApiRequestFn = jest.fn();

    return {
        api: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        apiRequest: jest.fn(),
        apiResponse: jest.fn(),
        isDevMode: jest.fn(() => false),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        withCategory: jest.fn(() => ({
            info: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            api: mockApiFn,
            apiRequest: mockApiRequestFn,
            startOperation: jest.fn(),
            endOperation: jest.fn(),
            progress: jest.fn(),
        })),
        // Export the mock functions for testing
        __mockApiFn: mockApiFn,
        __mockApiRequestFn: mockApiRequestFn,
    };
});

describe('api-client', () => {
    const mockToken = 'test-token-123';
    const mockUrl = 'https://api.gurushots.com/test';
    const mockData = 'test=data';
    const logger = require('../../src/js/logger');
    const settings = require('../../src/js/settings');

    beforeEach(() => {
        jest.clearAllMocks();
        // mockReset (not mockClear) so any unconsumed *Once queue from a
        // prior test can't leak into the next one.
        axios.mockReset();
        // Deterministic settings: real timeout, retries on, zero base delay
        // so exponential-backoff sleeps don't slow the suite.
        settings.getSetting.mockImplementation((key) => {
            switch (key) {
                case 'apiTimeout':
                    return 30;
                case 'apiMaxRetries':
                    return 3;
                case 'apiRetryBaseDelayMs':
                    return 0;
                default:
                    return undefined;
            }
        });
    });

    describe('FORM_CONTENT_TYPE', () => {
        test('should export correct content type', () => {
            expect(FORM_CONTENT_TYPE).toBe('application/x-www-form-urlencoded; charset=utf-8');
        });
    });

    describe('createCommonHeaders', () => {
        test('should create headers with token', () => {
            const headers = createCommonHeaders(mockToken);

            expect(headers).toEqual(
                expect.objectContaining({
                    'x-token': mockToken,
                    'user-agent': expect.stringContaining('GuruShots'),
                    accept: 'application/json',
                    'accept-language': 'en-US',
                    connection: 'keep-alive',
                }),
            );
        });

        test('should create headers without token', () => {
            const headers = createCommonHeaders();

            expect(headers).toEqual(
                expect.objectContaining({
                    'x-token': 'mock-token',
                    'user-agent': expect.stringContaining('GuruShots'),
                    accept: 'application/json',
                    'accept-language': 'en-US',
                    connection: 'keep-alive',
                }),
            );
        });
    });

    describe('makePostRequest', () => {
        test('should make successful POST request', async () => {
            const mockResponse = {
                status: 200,
                headers: { 'content-type': 'application/json' },
                data: { success: true, message: 'Request successful' },
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(axios).toHaveBeenCalledWith({
                method: 'post',
                url: mockUrl,
                headers: headers,
                data: mockData,
                timeout: 30000,
            });

            expect(result).toEqual(mockResponse.data);
        });

        test('should handle request with empty data', async () => {
            const mockResponse = {
                status: 200,
                headers: { 'content-type': 'application/json' },
                data: { success: true },
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            const result = await makePostRequest(mockUrl, headers);

            expect(axios).toHaveBeenCalledWith({
                method: 'post',
                url: mockUrl,
                headers: headers,
                data: '',
                timeout: 30000,
            });

            expect(result).toEqual(mockResponse.data);
        });

        test('should return null on request error', async () => {
            const mockError = new Error('Network error');
            mockError.response = {
                status: 500,
                data: { error: 'Internal server error' },
                headers: { 'content-type': 'application/json' },
            };

            axios.mockRejectedValueOnce(mockError);

            const headers = createCommonHeaders(mockToken);
            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
        });

        test('should return null on request error without response', async () => {
            const mockError = new Error('Network timeout');

            axios.mockRejectedValueOnce(mockError);

            const headers = createCommonHeaders(mockToken);
            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
        });

        test('should use 30 second timeout', async () => {
            const mockResponse = {
                status: 200,
                headers: {},
                data: { success: true },
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(axios).toHaveBeenCalledWith(
                expect.objectContaining({
                    timeout: 30000,
                }),
            );
        });

        test('should log API requests and responses', async () => {
            const logger = require('../../src/js/logger');
            const mockResponse = {
                status: 200,
                headers: { 'content-type': 'application/json' },
                data: { success: true },
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockApiRequestFn).toHaveBeenCalledWith('POST', mockUrl);
            expect(logger.__mockApiFn).toHaveBeenCalledWith('API Response', {
                method: 'POST',
                url: mockUrl,
                status: mockResponse.status,
                duration: expect.any(Number),
                responseData: mockResponse.data,
            });
        });

        test('should log API errors', async () => {
            const logger = require('../../src/js/logger');
            const mockError = new Error('API error');
            mockError.response = {
                status: 400,
                data: { error: 'Bad request' },
                headers: { 'content-type': 'application/json' },
            };

            axios.mockRejectedValueOnce(mockError);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockApiFn).toHaveBeenCalledWith('API Error Response', {
                method: 'POST',
                url: mockUrl,
                status: 400,
                duration: expect.any(Number),
                error: mockError.message,
                responseData: { error: 'Bad request' },
                timeout: false,
            });
        });

        test('should log API errors without response', async () => {
            const logger = require('../../src/js/logger');
            const mockError = new Error('Network timeout');

            axios.mockRejectedValueOnce(mockError);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockApiFn).toHaveBeenCalledWith('API Error Response', {
                method: 'POST',
                url: mockUrl,
                status: 'NO_RESPONSE',
                duration: expect.any(Number),
                error: mockError.message,
                responseData: null,
                timeout: false,
            });
        });

        test('should attach CapacitorHttp adapter when running on Capacitor', async () => {
            const runtime = require('../../src/js/runtime');
            runtime.isCapacitor.mockReturnValue(true);

            const mockResponse = {
                status: 200,
                headers: {},
                data: { ok: true },
            };
            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            const result = await makePostRequest(mockUrl, headers, mockData);

            // Verify axios was called with an adapter function (the CapacitorHttp wrapper).
            const callArgs = axios.mock.calls[axios.mock.calls.length - 1][0];
            expect(typeof callArgs.adapter).toBe('function');
            expect(result).toEqual(mockResponse.data);

            runtime.isCapacitor.mockReturnValue(false);
        });

        test('CapacitorHttp adapter forwards the request to native and reshapes the response', async () => {
            const runtime = require('../../src/js/runtime');
            runtime.isCapacitor.mockReturnValue(true);

            // Capture the adapter axios receives, then invoke it directly to
            // exercise the wrapping logic (method-uppercase, timeout fan-out,
            // axios-shaped response build).
            let capturedAdapter;
            axios.mockImplementationOnce(async (config) => {
                capturedAdapter = config.adapter;
                return { status: 200, headers: {}, data: { triggered: true } };
            });
            await makePostRequest(mockUrl, createCommonHeaders(mockToken), mockData);

            expect(capturedAdapter).toBeDefined();

            const { CapacitorHttp } = require('@capacitor/core');
            CapacitorHttp.request.mockResolvedValueOnce({
                data: { hello: 'native' },
                status: 201,
                headers: { 'x-from-native': '1' },
            });

            const adapterResult = await capturedAdapter({
                method: 'post',
                url: 'https://api.gurushots.com/native-test',
                headers: { foo: 'bar' },
                data: 'payload',
                timeout: 12345,
            });

            expect(CapacitorHttp.request).toHaveBeenCalledWith({
                method: 'POST',
                url: 'https://api.gurushots.com/native-test',
                headers: { foo: 'bar' },
                data: 'payload',
                connectTimeout: 12345,
                readTimeout: 12345,
            });
            expect(adapterResult.data).toEqual({ hello: 'native' });
            expect(adapterResult.status).toBe(201);
            expect(adapterResult.headers).toEqual({ 'x-from-native': '1' });

            runtime.isCapacitor.mockReturnValue(false);
        });

        test('CapacitorHttp adapter defaults method to GET when config.method is missing', async () => {
            const runtime = require('../../src/js/runtime');
            runtime.isCapacitor.mockReturnValue(true);

            let capturedAdapter;
            axios.mockImplementationOnce(async (config) => {
                capturedAdapter = config.adapter;
                return { status: 200, headers: {}, data: {} };
            });
            await makePostRequest(mockUrl, createCommonHeaders(mockToken), mockData);

            const { CapacitorHttp } = require('@capacitor/core');
            CapacitorHttp.request.mockResolvedValueOnce({ data: null, status: 204, headers: undefined });

            const adapterResult = await capturedAdapter({ url: '/x' });

            // GET method when config.method is not provided.
            expect(CapacitorHttp.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }));
            // headers default to {} when CapacitorHttp returns undefined.
            expect(adapterResult.headers).toEqual({});

            runtime.isCapacitor.mockReturnValue(false);
        });

        test('should log API response with full data', async () => {
            const logger = require('../../src/js/logger');

            const mockResponse = {
                status: 200,
                headers: { 'content-type': 'application/json' },
                data: { success: true, message: 'Request successful' },
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockApiFn).toHaveBeenCalledWith('API Response', {
                method: 'POST',
                url: mockUrl,
                status: mockResponse.status,
                duration: expect.any(Number),
                responseData: mockResponse.data,
            });
        });
    });

    describe('makePostRequest retry/backoff', () => {
        const headers = createCommonHeaders(mockToken);

        const timeoutError = () => {
            const e = new Error('timeout of 30000ms exceeded');
            e.code = 'ECONNABORTED';
            return e;
        };
        const httpError = (status, data = {}) => {
            const e = new Error(`Request failed with status code ${status}`);
            e.response = { status, data, headers: {} };
            return e;
        };

        test('retries a timed-out request and returns data once it succeeds', async () => {
            axios
                .mockRejectedValueOnce(timeoutError())
                .mockRejectedValueOnce(timeoutError())
                .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } });

            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toEqual({ ok: true });
            expect(axios).toHaveBeenCalledTimes(3);
        });

        test('retries network errors (no response) before giving up', async () => {
            axios.mockRejectedValue(new Error('Network Error'));

            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
            // 1 initial attempt + apiMaxRetries (3) retries.
            expect(axios).toHaveBeenCalledTimes(4);
        });

        test('retries 5xx responses up to apiMaxRetries then returns null', async () => {
            axios.mockRejectedValue(httpError(503));

            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
            expect(axios).toHaveBeenCalledTimes(4);
        });

        test('does not retry a non-retryable 4xx response', async () => {
            axios.mockRejectedValue(httpError(400, { error: 'Bad request' }));

            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test('apiMaxRetries of 0 makes a single attempt (escape hatch)', async () => {
            settings.getSetting.mockImplementation((key) => {
                switch (key) {
                    case 'apiTimeout':
                        return 30;
                    case 'apiMaxRetries':
                        return 0;
                    default:
                        return 0;
                }
            });
            axios.mockRejectedValue(httpError(503));

            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test('a negative apiMaxRetries falls back to the default instead of disabling retries', async () => {
            settings.getSetting.mockImplementation((key) => {
                switch (key) {
                    case 'apiTimeout':
                        return 30;
                    case 'apiMaxRetries':
                        return -1;
                    default:
                        return 0;
                }
            });
            axios.mockRejectedValue(httpError(503));

            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
            // -1 is invalid → falls back to default 3 retries → 1 + 3 attempts.
            expect(axios).toHaveBeenCalledTimes(4);
        });

        test('gives up immediately when a 429 retry_after exceeds the in-call cap', async () => {
            // retry_after is in seconds; 60s is far longer than a voting cycle,
            // so the request defers to the scheduler instead of blocking.
            axios.mockRejectedValue(httpError(429, { retry_after: 60 }));

            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test('uses the headless native HTTP adapter when running in the background service', async () => {
            const runtime = require('../../src/js/runtime');
            runtime.isHeadlessService.mockReturnValue(true);

            let capturedAdapter;
            axios.mockImplementationOnce(async (config) => {
                capturedAdapter = config.adapter;
                return { status: 200, headers: {}, data: { ok: true } };
            });
            await makePostRequest(mockUrl, headers, mockData);

            // The headless adapter (not the CapacitorHttp one) should be attached.
            expect(typeof capturedAdapter).toBe('function');

            // Drive the adapter directly. The native interface is async: it
            // returns immediately and posts the result back by invoking the
            // global resolver, which the adapter wired up.
            globalThis.AndroidHeadlessHttp = {
                request: jest.fn((id) => {
                    globalThis.__gsResolveHeadlessHttp(
                        id,
                        JSON.stringify({ status: 201, body: JSON.stringify({ hello: 'native' }), headers: { x: '1' } }),
                    );
                }),
            };
            const adapterResult = await capturedAdapter({
                method: 'post',
                url: 'https://api.gurushots.com/headless-test',
                headers: { foo: 'bar' },
                data: 'payload',
            });

            expect(globalThis.AndroidHeadlessHttp.request).toHaveBeenCalledWith(
                expect.any(Number),
                'POST',
                'https://api.gurushots.com/headless-test',
                JSON.stringify({ foo: 'bar' }),
                'payload',
            );
            expect(adapterResult.status).toBe(201);
            expect(adapterResult.data).toEqual({ hello: 'native' });
            expect(adapterResult.headers).toEqual({ x: '1' });

            runtime.isHeadlessService.mockReturnValue(false);
            delete globalThis.AndroidHeadlessHttp;
        });

        test('the headless adapter rejects non-2xx so retry/backoff can classify it', async () => {
            const runtime = require('../../src/js/runtime');
            runtime.isHeadlessService.mockReturnValue(true);

            let capturedAdapter;
            axios.mockImplementationOnce(async (config) => {
                capturedAdapter = config.adapter;
                return { status: 200, headers: {}, data: {} };
            });
            await makePostRequest(mockUrl, headers, mockData);

            globalThis.AndroidHeadlessHttp = {
                request: jest.fn((id) => {
                    globalThis.__gsResolveHeadlessHttp(
                        id,
                        JSON.stringify({ status: 503, body: JSON.stringify({ retry_after: 1 }), headers: {} }),
                    );
                }),
            };
            await expect(capturedAdapter({ method: 'post', url: mockUrl, headers: {}, data: '' })).rejects.toMatchObject({
                response: { status: 503, data: { retry_after: 1 } },
            });

            runtime.isHeadlessService.mockReturnValue(false);
            delete globalThis.AndroidHeadlessHttp;
        });

        test('honors a short 429 retry_after then retries', async () => {
            jest.useFakeTimers();
            axios
                .mockRejectedValueOnce(httpError(429, { retry_after: 5 }))
                .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } });

            const promise = makePostRequest(mockUrl, headers, mockData);
            await jest.advanceTimersByTimeAsync(6000);
            const result = await promise;

            expect(result).toEqual({ ok: true });
            expect(axios).toHaveBeenCalledTimes(2);
            jest.useRealTimers();
        });

        test('honors a 429 retry_after at exactly the 30s cap (boundary, inclusive)', async () => {
            jest.useFakeTimers();
            axios
                .mockRejectedValueOnce(httpError(429, { retry_after: 30 }))
                .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } });

            const promise = makePostRequest(mockUrl, headers, mockData);
            await jest.advanceTimersByTimeAsync(31000);
            const result = await promise;

            expect(result).toEqual({ ok: true });
            expect(axios).toHaveBeenCalledTimes(2);
            jest.useRealTimers();
        });

        test('honors a Retry-After header when no retry_after body field is present', async () => {
            jest.useFakeTimers();
            const err = httpError(429);
            err.response.headers = { 'retry-after': '2' };
            axios
                .mockRejectedValueOnce(err)
                .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } });

            const promise = makePostRequest(mockUrl, headers, mockData);
            await jest.advanceTimersByTimeAsync(3000);
            const result = await promise;

            expect(result).toEqual({ ok: true });
            expect(axios).toHaveBeenCalledTimes(2);
            jest.useRealTimers();
        });
    });
});
