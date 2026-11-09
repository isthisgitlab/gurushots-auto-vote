/**
 * What api-client hands the debug log of a dirty build: one record per event (`api-out`, `api-in`, `api-error`), the
 * request whole (every header, the body), the response body for the endpoints whose bodies the normal log leaves
 * out, and the failed body whole for every endpoint. They are pinned here against the mocked logger;
 * api-client-debug-log-real.test.ts runs the real logger to prove no response body is written twice, or dropped.
 */

import axiosModule = require('axios');
import type { AxiosRequestConfig } from 'axios';
import { invalid } from '../helpers/invalid';
import { isPlainObject } from '../../src/ts/core/plainObject';
import type * as api_clientModule from '../../src/ts/core/api/api-client';
import type * as constantsModule from '../../src/ts/core/api/constants';
import type * as loggerModule from '../../src/ts/core/logger';
import type { CategoryLogger } from '../../src/ts/core/logger';

type AxiosMock = jest.Mock<Promise<unknown>, [config: AxiosRequestConfig]>;
const axios: AxiosMock = invalid(axiosModule);

jest.mock('../../src/ts/core/settings', () => ({ getSetting: jest.fn() }));
jest.mock('../../src/ts/core/timing', () => ({ sleep: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/ts/core/api/randomizer', () => ({
    generateRandomHeaders: jest.fn((token: string) => ({ 'x-token': token })),
}));

import settingsModule = require('../../src/ts/core/settings');
const settings = jest.mocked(settingsModule);
const logger = jest.mocked(require('../../src/ts/core/logger') as typeof loggerModule);
const { makePostRequest, postOnce } = require('../../src/ts/core/api/api-client') as typeof api_clientModule;
const { ENDPOINTS } = require('../../src/ts/core/api/constants') as typeof constantsModule;

const URL = 'https://api.gurushots.com/edge';
// An endpoint whose body the normal log leaves out (api-client's BODY_UNLOGGED_URLS).
const PROFILE_URL = ENDPOINTS.currentMemberProfile;

const useSettings = (overrides = {}) => {
    const values: Record<string, unknown> = { apiTimeout: 30, apiMaxRetries: 0, apiRetryBaseDelayMs: 0, ...overrides };
    settings.getSetting.mockImplementation((key) => values[key]);
};

const httpError = (status: number, data: unknown) => {
    const error: Error & { response?: unknown } = new Error(`Request failed with status code ${status}`);
    error.response = { status, data, headers: {} };
    return error;
};

const debugRecords = (kind: string) =>
    logger.writeDebug.mock.calls
        .filter(([recordKind]) => recordKind === kind)
        .map(([, message, data]) => ({
            message,
            data,
        }));

const loggedApiRecord = (message: string) =>
    jest
        .mocked(logger.withCategory)
        .mock.results.flatMap((result) => jest.mocked(result.value as CategoryLogger).api.mock.calls)
        .filter((call) => call[0] === message)
        .map((call) => call[1]);

beforeEach(() => {
    axios.mockReset();
    useSettings();
});

describe('the records of one POST', () => {
    test('api-out keeps every header, the token included, and the request body', async () => {
        axios.mockResolvedValue({ status: 200, headers: {}, data: { ok: true } });
        await makePostRequest(URL, { 'x-token': 'tok-123', 'x-env': 'ios' }, 'a=1&b=2');
        expect(debugRecords('api-out')).toEqual([
            {
                message: `POST ${URL}`,
                data: { url: URL, headers: { 'x-token': 'tok-123', 'x-env': 'ios' }, body: 'a=1&b=2' },
            },
        ]);
    });

    test('api-in has the status, headers and duration, and no body for an ordinary endpoint', async () => {
        axios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true } });
        await makePostRequest(URL, {}, '');
        const [record] = debugRecords('api-in');
        expect(record.data).toEqual({
            url: URL,
            status: 200,
            headers: { 'content-type': 'application/json' },
            durationMs: expect.any(Number),
        });
        expect(record.data).not.toHaveProperty('responseData');
        if (!isPlainObject(record.data)) {
            throw new Error('Expected api-in data to be an object');
        }
        expect(record.message).toBe(`POST ${URL} → 200 (${record.data.durationMs}ms)`);
    });

    test('api-in carries the body of an endpoint whose body the normal log leaves out', async () => {
        axios.mockResolvedValue({ status: 200, headers: {}, data: { member_id: 'm1', name: 'Jane' } });
        await makePostRequest(PROFILE_URL, {}, '');
        expect(debugRecords('api-in')[0].data).toMatchObject({ responseData: { member_id: 'm1', name: 'Jane' } });
        expect(loggedApiRecord('API Response')[0]).not.toHaveProperty('responseData');
    });

    test('api-error keeps a 4xx JSON body whole, with the fields the normal log filters out', async () => {
        const body = { error: 'denied', message: 'no', retry_after: 5, token: 'leak', nested: { a: 1 } };
        axios.mockRejectedValue(httpError(403, body));
        expect(await makePostRequest(URL, {}, '')).toBeNull();
        expect(debugRecords('api-error')).toEqual([
            {
                message: `POST ${URL} failed (403)`,
                data: {
                    url: URL,
                    status: 403,
                    error: 'Request failed with status code 403',
                    decision: 'refused',
                    delayMs: null,
                    responseData: body,
                },
            },
        ]);
        // The normal record holds the filtered subset only.
        expect(loggedApiRecord('API Error Response')[0]).toMatchObject({
            responseData: { error: 'denied', message: 'no', retry_after: 5 },
        });
    });

    test('api-error keeps an HTML 5xx body whole, once per attempt: retry, then the terminal outcome', async () => {
        useSettings({ apiMaxRetries: 1 });
        const html = '<html><body>Bad gateway</body></html>';
        axios.mockRejectedValue(httpError(502, html));
        expect(await makePostRequest(URL, {}, '')).toBeNull();
        expect(debugRecords('api-error').map(({ data }) => data)).toEqual([
            expect.objectContaining({ status: 502, decision: 'retry', delayMs: 0, responseData: html }),
            expect.objectContaining({ status: 502, decision: 'unclear', delayMs: null, responseData: html }),
        ]);
    });

    test('api-error keeps the failed body of an endpoint whose success body is unlogged, and a failure with no response', async () => {
        axios.mockRejectedValueOnce(httpError(401, { error: 'bad token', member: { id: 7 } }));
        await makePostRequest(PROFILE_URL, {}, '');
        expect(debugRecords('api-error')[0].data).toMatchObject({
            responseData: { error: 'bad token', member: { id: 7 } },
        });
        expect(loggedApiRecord('API Error Response')[0]).not.toHaveProperty('responseData');

        logger.writeDebug.mockClear();
        axios.mockRejectedValueOnce(new Error('socket hang up'));
        await makePostRequest(URL, {}, '');
        expect(debugRecords('api-error')[0].data).toMatchObject({
            status: 'NO_RESPONSE',
            decision: 'unclear',
            responseData: undefined,
        });
    });

    test('a spend sent once records its single attempt and the verdict', async () => {
        useSettings({ apiMaxRetries: 3 });
        axios.mockRejectedValue(httpError(500, 'oops'));
        expect(await postOnce(URL, {}, '')).toEqual({ kind: 'unclear' });
        expect(debugRecords('api-error').map(({ data }) => data)).toEqual([
            expect.objectContaining({ decision: 'unclear', responseData: 'oops' }),
        ]);
    });

    test('a retried 429 records the wait', async () => {
        useSettings({ apiMaxRetries: 1 });
        axios.mockRejectedValueOnce(httpError(429, { retry_after: 2 }));
        axios.mockResolvedValueOnce({ status: 200, headers: {}, data: {} });
        await makePostRequest(URL, {}, '');
        expect(debugRecords('api-error')[0].data).toMatchObject({ decision: 'retry', delayMs: 2000 });
        expect(debugRecords('api-out')).toHaveLength(2);
        expect(debugRecords('api-in')).toHaveLength(1);
    });
});
