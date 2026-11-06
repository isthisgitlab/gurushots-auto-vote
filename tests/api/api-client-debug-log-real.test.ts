/**
 * api-client with the REAL logger on a dirty build: every response body reaches debug.log exactly once, on a source
 * run (the log entry itself is mirrored) and on a packaged dirty build (the normal sinks drop the api channel and the
 * logger copies the call directly); a clean build writes no file. This file never loads the globally mocked logger
 * in the outer registry, so the isolated load below can take the real one.
 */

import type { AxiosRequestConfig } from 'axios';
import { invalid } from '../helpers/invalid';
import { installTestPlatform } from '../helpers/platform';
import type * as api_clientModule from '../../src/ts/core/api/api-client';
import type * as constantsModule from '../../src/ts/core/api/constants';
import type * as loggerModule from '../../src/ts/core/logger';

type AxiosMock = jest.Mock<Promise<unknown>, [config: AxiosRequestConfig]>;

jest.mock('../../src/ts/core/settings', () => ({
    getSetting: (key: string) => ({ apiTimeout: 30, apiMaxRetries: 0, apiRetryBaseDelayMs: 0 })[key],
}));
jest.mock('../../src/ts/core/timing', () => ({ sleep: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/ts/core/api/randomizer', () => ({
    generateRandomHeaders: jest.fn((token: string) => ({ 'x-token': token })),
}));

const { ENDPOINTS } = require('../../src/ts/core/api/constants') as typeof constantsModule;

const URL = 'https://api.gurushots.com/edge';
// An endpoint whose body the normal log leaves out (api-client's BODY_UNLOGGED_URLS).
const PROFILE_URL = ENDPOINTS.currentMemberProfile;
const g = globalThis as typeof globalThis & { __GS_DIRTY__?: boolean };

describe('with the real logger', () => {
    const MARKER = 'BODY-MARKER-4242';
    const LOGS_DIR = '/ud/logs';

    const makeFs = () => ({
        existsSync: jest.fn(() => true),
        mkdirSync: jest.fn(),
        readdirSync: jest.fn(() => []),
        statSync: jest.fn(() => ({ size: 0, mtime: new Date() })),
        unlinkSync: jest.fn(),
        appendFileSync: jest.fn<void, [string, string, { mode: number }]>(),
        chmodSync: jest.fn(),
    });

    /** Loads the real logger and api-client together, on a node platform whose source-code answer is `sourceCode`. */
    const load = (sourceCode: boolean) => {
        const fs = makeFs();
        let client!: typeof api_clientModule;
        let isolatedAxios!: AxiosMock;
        jest.isolateModules(() => {
            jest.doMock('fs', () => fs);
            const family = jest.requireActual<typeof import('../../src/ts/platforms/node/paths')>(
                '../../src/ts/platforms/node/paths',
            );
            const paths = family.createNodePaths();
            paths.userData = () => '/ud';
            paths.isSourceCode = () => sourceCode;
            installTestPlatform({
                paths,
                capabilities: {
                    refreshMissionNeeds: false,
                    snapAllowed: true,
                    backgroundServiceOwnsScenarios: () => false,
                    recoveryWording: 'file',
                    logContext: () => 'CLI',
                    logCleanup: false,
                },
            });
            // The real logger, loaded once into this isolated registry and handed to api-client in place of the mock.
            const realLogger = jest.requireActual<typeof loggerModule>('../../src/ts/core/logger');
            jest.doMock('../../src/ts/core/logger', () => realLogger);
            client = require('../../src/ts/core/api/api-client') as typeof api_clientModule;
            isolatedAxios = invalid<AxiosMock>(require('axios'));
        });
        const debugText = () =>
            fs.appendFileSync.mock.calls
                .filter(([file]) => file.startsWith(`${LOGS_DIR}/debug-`))
                .map(([, text]) => text)
                .join('');
        return { client, axios: isolatedAxios, fs, debugText };
    };

    const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

    let logSpy: jest.SpiedFunction<typeof console.log>;
    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        Object.assign(g, { __GS_DIRTY__: true });
    });
    afterEach(() => {
        logSpy.mockRestore();
        Reflect.deleteProperty(g, '__GS_DIRTY__');
        jest.dontMock('fs');
        jest.dontMock('../../src/ts/core/logger');
    });

    test.each([
        ['a source run', true],
        ['a packaged dirty build, where the normal sinks drop the api channel', false],
    ])('on %s each response body is in debug.log exactly once', async (_name, sourceCode) => {
        const { client, axios: isolatedAxios, debugText } = load(sourceCode);
        isolatedAxios.mockResolvedValue({ status: 200, headers: {}, data: { marker: MARKER } });
        await client.makePostRequest(URL, { 'x-token': 'tok-123' }, 'a=1');
        expect(occurrences(debugText(), MARKER)).toBe(1);
        // The request is there whole, token included.
        expect(debugText()).toContain('"x-token":"tok-123"');

        // An unlogged endpoint's body reaches the file through api-in alone.
        isolatedAxios.mockResolvedValue({ status: 200, headers: {}, data: { name: MARKER } });
        await client.makePostRequest(PROFILE_URL, {}, '');
        expect(occurrences(debugText(), MARKER)).toBe(2);
    });

    test('a clean build writes no debug file', async () => {
        Object.assign(g, { __GS_DIRTY__: false });
        const { client, axios: isolatedAxios, fs } = load(true);
        isolatedAxios.mockResolvedValue({ status: 200, headers: {}, data: { marker: MARKER } });
        await client.makePostRequest(URL, {}, '');
        expect(fs.appendFileSync.mock.calls.filter(([file]) => file.includes('/debug-'))).toEqual([]);
    });
});
