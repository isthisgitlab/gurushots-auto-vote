/**
 * Tests for api-client.ts
 *
 * Tests the core HTTP client functionality and common headers for API requests.
 */

import axiosModule = require('axios');
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { invalid } from '../helpers/invalid';
// tests/setup.ts replaces axios with a bare jest.fn(), called with one config.
const axios: jest.Mock<Promise<unknown>, [config: AxiosRequestConfig]> = invalid(axiosModule);
import type * as api_clientModule from '../../src/ts/api/api-client';
import type * as constantsModule from '../../src/ts/api/constants';
import type * as settingsModule from '../../src/ts/settings';
import type * as loggerModule from '../../src/ts/logger';
import type * as runtimeModule from '../../src/ts/runtime';
import type * as coreModule from '@capacitor/core';
const { makePostRequest, postOnce, createCommonHeaders, FORM_CONTENT_TYPE } =
    require('../../src/ts/api/api-client') as typeof api_clientModule;
const { ENDPOINTS } = require('../../src/ts/api/constants') as typeof constantsModule;

// The logger factory below also exports its shared api/apiRequest mocks.
type LoggerMock = typeof loggerModule & {
    __mockApiFn: jest.MockedFunction<loggerModule.CategoryLogger['api']>;
    __mockApiRequestFn: jest.MockedFunction<loggerModule.CategoryLogger['apiRequest']>;
};
// The captured adapter, called with the partial configs the tests hand it.
type TestAdapter = (config: AxiosRequestConfig) => Promise<AxiosResponse>;
// The Android headless-service bridge globals api-client reads.
const g = globalThis as typeof globalThis & {
    AndroidHeadlessHttp?: { request: (id: number, ...rest: string[]) => void };
    __gsResolveHeadlessHttp?: (id: number, resultJson: string) => void;
};

// Mock the randomizer module
jest.mock('../../src/ts/api/randomizer', () => ({
    generateRandomHeaders: jest.fn((token: string | undefined) => ({
        'x-token': token || 'mock-token',
        'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
        accept: 'application/json',
        'accept-language': 'en-US',
        connection: 'keep-alive',
    })),
}));

// Mock the runtime module so we can flip isCapacitor() per-test.
jest.mock('../../src/ts/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
    isElectron: jest.fn(() => false),
    isCli: jest.fn(() => true),
    getPlatform: jest.fn(() => 'cli'),
    isPackaged: jest.fn(() => false),
    isDevelopment: jest.fn(() => false),
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
jest.mock('../../src/ts/settings', () => ({
    getSetting: jest.fn(),
}));

// Mock the logger module
jest.mock('../../src/ts/logger', () => {
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
    const settings = jest.mocked(require('../../src/ts/settings') as typeof settingsModule);

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
            const headers = createCommonHeaders(undefined);

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
                maxRedirects: 0,
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
                maxRedirects: 0,
            });

            expect(result).toEqual(mockResponse.data);
        });

        test('should return null on request error', async () => {
            const mockError: Error & { response?: unknown } = new Error('Network error');
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
            const logger: LoggerMock = invalid(require('../../src/ts/logger'));
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

        test.each([['getTeams'], ['getMatch']] as const)(
            "logs the status of %s but never its body (it carries other members' rosters)",
            async (endpoint) => {
                const logger: LoggerMock = invalid(require('../../src/ts/logger'));
                const url = ENDPOINTS[endpoint];
                axios.mockResolvedValueOnce({
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                    data: { data: { teams: [{ id: 1, name: 'Roster' }] } },
                });

                await makePostRequest(url, createCommonHeaders(mockToken), mockData);

                expect(logger.__mockApiFn).toHaveBeenCalledWith('API Response', {
                    method: 'POST',
                    url,
                    status: 200,
                    duration: expect.any(Number),
                });
            },
        );

        test('should log API errors', async () => {
            const logger: LoggerMock = invalid(require('../../src/ts/logger'));
            const mockError: Error & { response?: unknown } = new Error('API error');
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
            const logger: LoggerMock = invalid(require('../../src/ts/logger'));
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
            const runtime = jest.mocked(require('../../src/ts/runtime') as typeof runtimeModule);
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
            const runtime = jest.mocked(require('../../src/ts/runtime') as typeof runtimeModule);
            runtime.isCapacitor.mockReturnValue(true);

            // Capture the adapter axios receives, then invoke it directly to
            // exercise the wrapping logic (method-uppercase, timeout fan-out,
            // axios-shaped response build).
            let capturedAdapter: TestAdapter | undefined;
            axios.mockImplementationOnce(async (config) => {
                capturedAdapter = invalid(config.adapter);
                return { status: 200, headers: {}, data: { triggered: true } };
            });
            await makePostRequest(mockUrl, createCommonHeaders(mockToken), mockData);

            expect(capturedAdapter).toBeDefined();

            const { CapacitorHttp } = jest.mocked(require('@capacitor/core') as typeof coreModule);
            CapacitorHttp.request.mockResolvedValueOnce(
                invalid({
                    data: { hello: 'native' },
                    status: 201,
                    headers: { 'x-from-native': '1' },
                }),
            );

            const adapterResult = await capturedAdapter!({
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
                disableRedirects: true,
            });
            expect(adapterResult.data).toEqual({ hello: 'native' });
            expect(adapterResult.status).toBe(201);
            expect(adapterResult.headers).toEqual({ 'x-from-native': '1' });

            runtime.isCapacitor.mockReturnValue(false);
        });

        test('CapacitorHttp adapter defaults method to GET when config.method is missing', async () => {
            const runtime = jest.mocked(require('../../src/ts/runtime') as typeof runtimeModule);
            runtime.isCapacitor.mockReturnValue(true);

            let capturedAdapter: TestAdapter | undefined;
            axios.mockImplementationOnce(async (config) => {
                capturedAdapter = invalid(config.adapter);
                return { status: 200, headers: {}, data: {} };
            });
            await makePostRequest(mockUrl, createCommonHeaders(mockToken), mockData);

            const { CapacitorHttp } = jest.mocked(require('@capacitor/core') as typeof coreModule);
            CapacitorHttp.request.mockResolvedValueOnce(invalid({ data: null, status: 204, headers: undefined }));

            const adapterResult = await capturedAdapter!({ url: '/x' });

            // GET method when config.method is not provided.
            expect(CapacitorHttp.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }));
            // headers default to {} when CapacitorHttp returns undefined.
            expect(adapterResult.headers).toEqual({});

            runtime.isCapacitor.mockReturnValue(false);
        });

        test('CapacitorHttp adapter rejects non-2xx so retry/backoff can classify it', async () => {
            // CapacitorHttp.request resolves for ALL statuses, so without
            // finalizeAdapterResponse the foreground path would treat a 429/5xx
            // error body as a success and the retry layer would never fire.
            const runtime = jest.mocked(require('../../src/ts/runtime') as typeof runtimeModule);
            runtime.isCapacitor.mockReturnValue(true);

            let capturedAdapter: TestAdapter | undefined;
            axios.mockImplementationOnce(async (config) => {
                capturedAdapter = invalid(config.adapter);
                return { status: 200, headers: {}, data: {} };
            });
            await makePostRequest(mockUrl, createCommonHeaders(mockToken), mockData);

            const { CapacitorHttp } = jest.mocked(require('@capacitor/core') as typeof coreModule);
            CapacitorHttp.request.mockResolvedValueOnce(
                invalid({
                    data: { retry_after: 1 },
                    status: 503,
                    headers: {},
                }),
            );

            await expect(
                capturedAdapter!({ method: 'post', url: mockUrl, headers: {}, data: '' }),
            ).rejects.toMatchObject({
                response: { status: 503, data: { retry_after: 1 } },
            });

            runtime.isCapacitor.mockReturnValue(false);
        });

        test('should log API response with full data', async () => {
            const logger: LoggerMock = invalid(require('../../src/ts/logger'));

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

    describe('postOnce: a request that spends is told apart as answered, refused or unclear', () => {
        const headers = createCommonHeaders(mockToken);
        const once = () => postOnce(mockUrl, headers, mockData);

        const timeoutError = () => {
            const e: Error & { code?: string } = new Error('timeout of 30000ms exceeded');
            e.code = 'ECONNABORTED';
            return e;
        };
        const httpError = (status: number, data: unknown = {}) => {
            const e: Error & { response?: { status: number; data: unknown; headers: Record<string, string> } } =
                new Error(`Request failed with status code ${status}`);
            e.response = { status, data, headers: {} };
            return e;
        };
        const codeError = (code: string) => {
            const e: Error & { code?: string } = new Error(code);
            e.code = code;
            return e;
        };

        afterEach(() => {
            jest.useRealTimers();
        });

        test('a JSON object body is the answer, whatever it says', async () => {
            axios.mockResolvedValueOnce({ status: 200, headers: {}, data: { success: false } });
            expect(await once()).toEqual({ kind: 'body', body: { success: false } });
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test('the body defaults to empty', async () => {
            axios.mockResolvedValueOnce({ status: 200, headers: {}, data: { success: true } });
            await postOnce(mockUrl, headers);
            expect(axios.mock.calls[0][0].data).toBe('');
        });

        test('a 429 is retried after its Retry-After, and the answer that follows is the answer', async () => {
            jest.useFakeTimers();
            axios
                .mockRejectedValueOnce(httpError(429, { retry_after: 5 }))
                .mockResolvedValueOnce({ status: 200, headers: {}, data: { success: true } });
            const promise = once();
            await jest.advanceTimersByTimeAsync(6000);
            expect(await promise).toEqual({ kind: 'body', body: { success: true } });
            expect(axios).toHaveBeenCalledTimes(2);
        });

        test('a 429 that outlasts the retries is refused: the server never processed it', async () => {
            axios.mockRejectedValue(httpError(429));
            expect(await once()).toEqual({ kind: 'refused' });
            expect(axios).toHaveBeenCalledTimes(4);
        });

        test('a Retry-After header past the in-call cap is refused without waiting, as the body field is', async () => {
            const error = httpError(429);
            error.response!.headers = { 'retry-after': '120' };
            axios.mockRejectedValue(error);
            expect(await once()).toEqual({ kind: 'refused' });
            expect(axios).toHaveBeenCalledTimes(1);
        });

        describe('through the native adapters, whose failures are plain errors', () => {
            const runtime = () => jest.mocked(require('../../src/ts/runtime') as typeof runtimeModule);
            // axios hands the request to the adapter it was given, as the real one does.
            const throughAdapter = () =>
                axios.mockImplementation(async (config) => invalid<TestAdapter>(config.adapter)(config));

            afterEach(() => {
                runtime().isCapacitor.mockReturnValue(false);
                runtime().isHeadlessService.mockReturnValue(false);
                delete g.AndroidHeadlessHttp;
            });

            test('a CapacitorHttp request that rejects with a plain Error is unclear, and sent once', async () => {
                runtime().isCapacitor.mockReturnValue(true);
                throughAdapter();
                const { CapacitorHttp } = jest.mocked(require('@capacitor/core') as typeof coreModule);
                CapacitorHttp.request.mockRejectedValue(new Error('native transport failed'));
                expect(await once()).toEqual({ kind: 'unclear' });
                expect(CapacitorHttp.request).toHaveBeenCalledTimes(1);
            });

            test.each([
                ['an error the native side reports', JSON.stringify({ error: 'socket closed' })],
                ['a result that is not JSON (a SyntaxError)', 'not json{'],
            ])('the headless adapter with %s is unclear, and sent once', async (_name, result) => {
                runtime().isHeadlessService.mockReturnValue(true);
                throughAdapter();
                g.AndroidHeadlessHttp = {
                    request: jest.fn((id) => g.__gsResolveHeadlessHttp!(id, result)),
                };
                expect(await once()).toEqual({ kind: 'unclear' });
                expect(g.AndroidHeadlessHttp.request).toHaveBeenCalledTimes(1);
            });
        });

        test('a 429 whose cooldown is past the in-call cap is refused without waiting', async () => {
            axios.mockRejectedValue(httpError(429, { retry_after: 60 }));
            expect(await once()).toEqual({ kind: 'refused' });
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test.each([400, 401, 403, 404, 422])('a %i is refused, and not repeated', async (status) => {
            axios.mockRejectedValue(httpError(status));
            expect(await once()).toEqual({ kind: 'refused' });
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test('a redirect (3xx, never followed) is unclear: a redirected POST may have been processed', async () => {
            axios.mockRejectedValue(httpError(302));
            expect(await once()).toEqual({ kind: 'unclear' });
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test('a timeout is unclear, and sent once', async () => {
            axios.mockRejectedValue(timeoutError());
            expect(await once()).toEqual({ kind: 'unclear' });
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test.each(['ECONNRESET', 'ETIMEDOUT', 'ERR_NETWORK'])('%s is unclear, and sent once', async (code) => {
            axios.mockRejectedValue(codeError(code));
            expect(await once()).toEqual({ kind: 'unclear' });
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test.each([500, 502, 503, 504])('a %i is unclear, and sent once', async (status) => {
            axios.mockRejectedValue(httpError(status));
            expect(await once()).toEqual({ kind: 'unclear' });
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test('a 2xx whose body is not a JSON object is unclear', async () => {
            axios.mockResolvedValueOnce({ status: 200, headers: {}, data: '<html>oops</html>' });
            expect(await once()).toEqual({ kind: 'unclear' });
            axios.mockResolvedValueOnce({ status: 200, headers: {}, data: [1] });
            expect(await once()).toEqual({ kind: 'unclear' });
        });

        test('an error with no error object, or an adapter bug, is unclear', async () => {
            axios.mockRejectedValueOnce(undefined);
            expect(await once()).toEqual({ kind: 'unclear' });
            axios.mockRejectedValueOnce(new TypeError('adapter bug'));
            expect(await once()).toEqual({ kind: 'unclear' });
        });

        test.each(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'])(
            '%s never left this machine: retried like any request, refused when it runs out',
            async (code) => {
                axios.mockRejectedValueOnce(codeError(code)).mockResolvedValueOnce({
                    status: 200,
                    headers: {},
                    data: { success: true },
                });
                expect(await once()).toEqual({ kind: 'body', body: { success: true } });
                expect(axios).toHaveBeenCalledTimes(2);

                axios.mockReset();
                axios.mockRejectedValue(codeError(code));
                expect(await once()).toEqual({ kind: 'refused' });
                expect(axios).toHaveBeenCalledTimes(4);
            },
        );

        test('an error with no code and no response is unclear', async () => {
            axios.mockRejectedValue(new Error('Network Error'));
            expect(await once()).toEqual({ kind: 'unclear' });
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test('a read through makePostRequest still retries a timeout and a 5xx, as before', async () => {
            axios
                .mockRejectedValueOnce(timeoutError())
                .mockRejectedValueOnce(httpError(503))
                .mockResolvedValueOnce({
                    status: 200,
                    headers: {},
                    data: { ok: true },
                });
            expect(await makePostRequest(mockUrl, headers, mockData)).toEqual({ ok: true });
            expect(axios).toHaveBeenCalledTimes(3);
        });
    });

    describe('makePostRequest retry/backoff', () => {
        const headers = createCommonHeaders(mockToken);

        const timeoutError = () => {
            const e: Error & { code?: string } = new Error('timeout of 30000ms exceeded');
            e.code = 'ECONNABORTED';
            return e;
        };
        const httpError = (status: number, data: unknown = {}) => {
            const e: Error & { response?: { status: number; data: unknown; headers: Record<string, string> } } =
                new Error(`Request failed with status code ${status}`);
            e.response = { status, data, headers: {} };
            return e;
        };

        // Some tests below switch to fake timers; restore real timers even if
        // one throws before its inline useRealTimers() so it can't bleed over.
        afterEach(() => {
            jest.useRealTimers();
        });

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

        test('gives up immediately when a 429 retry_after exceeds the in-call cap', async () => {
            // retry_after is in seconds; 60s is far longer than a voting cycle,
            // so the request defers to the scheduler instead of blocking.
            axios.mockRejectedValue(httpError(429, { retry_after: 60 }));

            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
            expect(axios).toHaveBeenCalledTimes(1);
        });

        test('uses the headless native HTTP adapter when running in the background service', async () => {
            const runtime = jest.mocked(require('../../src/ts/runtime') as typeof runtimeModule);
            runtime.isHeadlessService.mockReturnValue(true);

            let capturedAdapter: TestAdapter | undefined;
            axios.mockImplementationOnce(async (config) => {
                capturedAdapter = invalid(config.adapter);
                return { status: 200, headers: {}, data: { ok: true } };
            });
            await makePostRequest(mockUrl, headers, mockData);

            // The headless adapter (not the CapacitorHttp one) should be attached.
            expect(typeof capturedAdapter).toBe('function');

            // Drive the adapter directly. The native interface is async: it
            // returns immediately and posts the result back by invoking the
            // global resolver, which the adapter wired up.
            g.AndroidHeadlessHttp = {
                request: jest.fn((id) => {
                    g.__gsResolveHeadlessHttp!(
                        id,
                        JSON.stringify({ status: 201, body: JSON.stringify({ hello: 'native' }), headers: { x: '1' } }),
                    );
                }),
            };
            const adapterResult = await capturedAdapter!({
                method: 'post',
                url: 'https://api.gurushots.com/headless-test',
                headers: { foo: 'bar' },
                data: 'payload',
            });

            expect(g.AndroidHeadlessHttp.request).toHaveBeenCalledWith(
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
            delete g.AndroidHeadlessHttp;
        });

        test('the headless adapter rejects non-2xx so retry/backoff can classify it', async () => {
            const runtime = jest.mocked(require('../../src/ts/runtime') as typeof runtimeModule);
            runtime.isHeadlessService.mockReturnValue(true);

            let capturedAdapter: TestAdapter | undefined;
            axios.mockImplementationOnce(async (config) => {
                capturedAdapter = invalid(config.adapter);
                return { status: 200, headers: {}, data: {} };
            });
            await makePostRequest(mockUrl, headers, mockData);

            g.AndroidHeadlessHttp = {
                request: jest.fn((id) => {
                    g.__gsResolveHeadlessHttp!(
                        id,
                        JSON.stringify({ status: 503, body: JSON.stringify({ retry_after: 1 }), headers: {} }),
                    );
                }),
            };
            await expect(
                capturedAdapter!({ method: 'post', url: mockUrl, headers: {}, data: '' }),
            ).rejects.toMatchObject({
                response: { status: 503, data: { retry_after: 1 } },
            });

            runtime.isHeadlessService.mockReturnValue(false);
            delete g.AndroidHeadlessHttp;
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
            err.response!.headers = { 'retry-after': '2' };
            axios.mockRejectedValueOnce(err).mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } });

            const promise = makePostRequest(mockUrl, headers, mockData);
            await jest.advanceTimersByTimeAsync(3000);
            const result = await promise;

            expect(result).toEqual({ ok: true });
            expect(axios).toHaveBeenCalledTimes(2);
            jest.useRealTimers();
        });
    });
});
