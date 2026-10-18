/**
 * Tests for the active-challenges read: the api/challenges.ts transport
 * driven through the real-strategy wrapper (strategies/real/activeChallenges.ts)
 * that adds title pinning and in-flight coalescing.
 */

import type * as activeChallengesModule from '../../src/ts/strategies/real/activeChallenges';
import type * as challengesModule from '../../src/ts/api/challenges';
import type * as api_clientModule from '../../src/ts/api/api-client';
import type * as challengeTitlePinModule from '../../src/ts/services/challengeTitlePin';
import type * as loggerModule from '../../src/ts/logger';
import type * as teamMatchModule from '../../src/ts/strategies/real/teamMatch';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';

// The logger factory below also exports its shared debug/endOperation mocks.
type LoggerMock = typeof loggerModule & {
    __mockDebugFn: jest.MockedFunction<CategoryLogger['debug']>;
    __mockEndOperationFn: jest.MockedFunction<CategoryLogger['endOperation']>;
    __mockWarningFn: jest.MockedFunction<CategoryLogger['warning']>;
};

const { getActiveChallenges } =
    require('../../src/ts/strategies/real/activeChallenges') as typeof activeChallengesModule;
const { fetchWebActiveTurbos } = require('../../src/ts/api/challenges') as typeof challengesModule;

// Mock the api-client module
jest.mock('../../src/ts/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn((token: string | undefined) => ({
        'x-token': token || 'mock-token',
        'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
        accept: 'application/json',
    })),
}));

// Mock the title-pin module as an identity pass-through so this file keeps
// testing fetch/coalescing behavior in isolation (pin behavior is unit-tested
// in tests/services/challengeTitlePin.test.ts). Wiring is still asserted:
// success responses must reach the pin hook, failed fetches must not.
jest.mock('../../src/ts/services/challengeTitlePin', () => ({
    pinChallengeTitles: jest.fn((challenges: unknown) => challenges),
}));

// The team-match cache is unit-tested in tests/strategies/real-team-match.test.ts; here it is a stub, so
// the ordered makePostRequest queues below never see a team request.
jest.mock('../../src/ts/strategies/real/teamMatch', () => ({
    latestTeamMatch: jest.fn(),
    settledTeamMatch: jest.fn(),
}));

// Mock the logger module
jest.mock('../../src/ts/logger', () => {
    const mockDebugFn = jest.fn();
    const mockEndOperationFn = jest.fn();
    const mockWarningFn = jest.fn();

    return {
        debug: jest.fn(),
        error: jest.fn(),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        withCategory: jest.fn(() => ({
            info: jest.fn(),
            error: jest.fn(),
            debug: mockDebugFn,
            success: jest.fn(),
            warning: mockWarningFn,
            api: jest.fn(),
            apiRequest: jest.fn(),
            startOperation: jest.fn(),
            endOperation: mockEndOperationFn,
            progress: jest.fn(),
        })),
        // Export the mock functions for testing
        __mockDebugFn: mockDebugFn,
        __mockEndOperationFn: mockEndOperationFn,
        __mockWarningFn: mockWarningFn,
    };
});

describe('challenges', () => {
    const mockToken = 'test-token-123';
    const { makePostRequest, createCommonHeaders } = jest.mocked(
        require('../../src/ts/api/api-client') as typeof api_clientModule,
    );
    const { pinChallengeTitles } = jest.mocked(
        require('../../src/ts/services/challengeTitlePin') as typeof challengeTitlePinModule,
    );
    const logger: LoggerMock = invalid(require('../../src/ts/logger'));
    const { latestTeamMatch, settledTeamMatch } = jest.mocked(
        require('../../src/ts/strategies/real/teamMatch') as typeof teamMatchModule,
    );

    beforeEach(() => {
        jest.clearAllMocks();
        latestTeamMatch.mockReset();
        settledTeamMatch.mockReset();
    });

    describe('getActiveChallenges', () => {
        test('should fetch active challenges successfully', async () => {
            const mockResponse = {
                challenges: [
                    {
                        id: '12345',
                        title: 'Test Challenge 1',
                        url: 'challenge-1-url',
                        member: {
                            ranking: {
                                exposure: { exposure_factor: 75 },
                            },
                            boost: { state: 'AVAILABLE' },
                        },
                    },
                    {
                        id: '67890',
                        title: 'Test Challenge 2',
                        url: 'challenge-2-url',
                        member: {
                            ranking: {
                                exposure: { exposure_factor: 100 },
                            },
                            boost: { state: 'USED' },
                        },
                    },
                ],
            };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await getActiveChallenges(mockToken);

            expect(createCommonHeaders).toHaveBeenCalledWith(mockToken);
            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/get_my_active_challenges',
                expect.objectContaining({
                    'x-token': mockToken,
                    'user-agent': expect.stringContaining('GuruShots'),
                    accept: 'application/json',
                }),
            );

            expect(result).toEqual(mockResponse);
            // Positive wiring: the fetched list must pass through the pin hook
            // (the identity mock would hide a dropped or mis-arged call).
            expect(pinChallengeTitles).toHaveBeenCalledWith(mockResponse.challenges);
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            // Presence only — never a slice of the token itself (a tokenPrefix
            // field would bypass the logger's key-based redaction).
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Requesting active challenges from API', {
                hasToken: true,
            });
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Active challenges response received', {
                challengeCount: 2,
                hasValidStructure: true,
                responseKeys: ['challenges'],
            });
        });

        test('logs only token presence, never any slice of the token', async () => {
            const shortToken = 'short';
            const mockResponse = { challenges: [] };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(shortToken);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            // Exact-object match: proves no tokenPrefix (or any other token
            // material) is added to the debug payload.
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Requesting active challenges from API', {
                hasToken: true,
            });
        });

        test('should handle missing token', async () => {
            const mockResponse = { challenges: [] };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(invalid(undefined));

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Requesting active challenges from API', {
                hasToken: false,
            });
            expect(createCommonHeaders).toHaveBeenCalledWith(undefined);
        });

        test('should return empty challenges array when request fails', async () => {
            makePostRequest.mockResolvedValueOnce(null);

            const result = await getActiveChallenges(mockToken);

            expect(result).toEqual({ challenges: [], fetchFailed: true });
            // The logger module handles the error message, not console.error
        });

        test('should log response structure details', async () => {
            const mockResponse = {
                challenges: [
                    { id: '1', title: 'Challenge 1' },
                    { id: '2', title: 'Challenge 2' },
                ],
                other_field: 'test',
            };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(mockToken);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Active challenges response received', {
                challengeCount: 2,
                hasValidStructure: true,
                responseKeys: ['challenges', 'other_field'],
            });
        });

        test('should handle response without challenges array', async () => {
            const mockResponse = {
                other_field: 'test',
            };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(mockToken);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Active challenges response received', {
                challengeCount: 0,
                hasValidStructure: false,
                responseKeys: ['other_field'],
            });
        });

        test('should handle null response gracefully', async () => {
            makePostRequest.mockResolvedValueOnce(null);

            const result = await getActiveChallenges(mockToken);

            expect(result).toEqual({ challenges: [], fetchFailed: true });
            // The logger module handles the error message, not console.error
        });

        test('a successful fetch carries the time each entry went in, from the entry-age ledger', async () => {
            const { entryAgeLedger } = require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;
            const observeAll = jest.spyOn(entryAgeLedger, 'observeAll').mockReturnValue({
                '12345': { e1: { at: 1_800_000_000, exact: true } },
            });
            const refresh = jest.spyOn(entryAgeLedger, 'refresh').mockResolvedValue(undefined);
            makePostRequest.mockResolvedValueOnce({
                challenges: [
                    { id: '12345', title: 'T', member: { ranking: { entries: [{ id: 'e1' }, { id: 'e2' }] } } },
                ],
            });

            const result = await getActiveChallenges(mockToken);

            const entries = result.challenges[0].member?.ranking?.entries ?? [];
            expect(entries[0].appEntered).toEqual({ at: 1_800_000_000, exact: true });
            expect(entries[1].appEntered).toBeUndefined();
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(observeAll).toHaveBeenCalledWith(result.challenges, expect.any(Number));
            observeAll.mockRestore();
            refresh.mockRestore();
        });

        test('failed fetch never reaches the entry-age ledger', async () => {
            const { entryAgeLedger } = require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;
            const observeAll = jest.spyOn(entryAgeLedger, 'observeAll');
            makePostRequest.mockResolvedValueOnce(null);

            await getActiveChallenges(mockToken);

            expect(observeAll).not.toHaveBeenCalled();
            observeAll.mockRestore();
        });

        test('failed fetch never reaches the title-pin hook', async () => {
            makePostRequest.mockResolvedValueOnce(null);

            const result = await getActiveChallenges(mockToken);

            expect(result).toEqual({ challenges: [], fetchFailed: true });
            // The early return on a failed request must keep the pin/prune
            // logic from ever seeing the synthetic empty payload.
            expect(pinChallengeTitles).not.toHaveBeenCalled();
        });

        test('should handle falsy response object', async () => {
            // Test with false (which is falsy but not null/undefined)
            makePostRequest.mockResolvedValueOnce(invalid(false));

            const result = await getActiveChallenges(mockToken);

            expect(result).toEqual({ challenges: [], fetchFailed: true });
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockEndOperationFn).toHaveBeenCalledWith(expect.any(String), null, 'API request failed');
        });

        test('coalesces concurrent calls for the same token into a single request', async () => {
            let resolveRequest: ((value: object | null) => void) | undefined;
            makePostRequest.mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveRequest = resolve;
                }),
            );

            // Two callers fire while the request is still in flight (the
            // post-cycle UI refresh + the scheduler's window re-check).
            const first = getActiveChallenges(mockToken);
            const second = getActiveChallenges(mockToken);

            expect(first).toBe(second); // same in-flight promise shared

            resolveRequest!({ challenges: [{ id: '1' }] });
            const [r1, r2] = await Promise.all([first, second]);

            // One mobile read plus its web turbo read, shared by both callers.
            expect(makePostRequest).toHaveBeenCalledTimes(2);
            expect(r1).toEqual({ challenges: [{ id: '1' }] });
            expect(r2).toBe(r1);
        });

        test('does not coalesce sequential calls (no stale caching)', async () => {
            makePostRequest
                .mockResolvedValueOnce({ challenges: [] })
                .mockResolvedValueOnce({ challenges: [] })
                .mockResolvedValueOnce({ challenges: [{ id: '2' }] })
                .mockResolvedValueOnce({ challenges: [] });

            await getActiveChallenges(mockToken);
            const second = await getActiveChallenges(mockToken);

            expect(makePostRequest).toHaveBeenCalledTimes(4);
            expect(second).toEqual({ challenges: [{ id: '2' }] });
        });

        describe('turbo from the web read', () => {
            const WEB_URL = 'https://api.gurushots.com/rest/get_my_active_challenges';
            const mobileTurbo = { state: 'WON', time_to_open: null };
            const mobileResponse = () => ({
                challenges: [
                    { id: 1, title: 'A', member: { turbo: { ...mobileTurbo }, boost: { state: 'USED' } } },
                    { id: '2', title: 'B', member: { turbo: { ...mobileTurbo } } },
                    { id: 3, title: 'C' },
                ],
            });

            test('the web turbo replaces the mobile turbo; every other field stays from mobile', async () => {
                const snapTurbo = { state: 'IN_PROGRESS', mode: 'snap' };
                makePostRequest.mockResolvedValueOnce(mobileResponse());
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        { id: 1, member: { turbo: snapTurbo, boost: { state: 'AVAILABLE' } } },
                        { id: 3, member: { turbo: { state: 'FREE', mode: 'classic' } } },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                expect(result.challenges[0].member).toEqual({ turbo: snapTurbo, boost: { state: 'USED' } });
                expect(result.challenges[0].title).toBe('A');
                // Absent from the web read: the mobile turbo (no mode) is left as it was.
                expect(result.challenges[1].member?.turbo).toEqual(mobileTurbo);
                // A challenge with no member gets none made up for it.
                expect(result.challenges[2].member).toBeUndefined();
                expect(makePostRequest).toHaveBeenNthCalledWith(
                    2,
                    WEB_URL,
                    expect.objectContaining({ 'x-env': 'WEB', 'x-token': mockToken }),
                    '',
                );
            });

            test('a challenge the web read reports without a turbo keeps the mobile turbo', async () => {
                makePostRequest.mockResolvedValueOnce(mobileResponse());
                makePostRequest.mockResolvedValueOnce({ challenges: [{ id: 1, member: { turbo: null } }, { id: 2 }] });

                const result = await getActiveChallenges(mockToken);

                expect(result.challenges[0].member?.turbo).toEqual(mobileTurbo);
                expect(result.challenges[1].member?.turbo).toEqual(mobileTurbo);
            });

            test.each([
                ['fails', null],
                ['has no challenge list', { success: true }],
            ])('leaves the mobile turbos untouched when the web read %s', async (_label, webBody) => {
                makePostRequest.mockResolvedValueOnce(mobileResponse());
                makePostRequest.mockResolvedValueOnce(webBody);

                const result = await getActiveChallenges(mockToken);

                expect(result.fetchFailed).toBeUndefined();
                expect(result.challenges[0].member?.turbo).toEqual(mobileTurbo);
                expect(result.challenges[1].member?.turbo).toEqual(mobileTurbo);
                expect(pinChallengeTitles).toHaveBeenCalledWith(result.challenges);
            });

            test('a failed mobile fetch is returned as it is; the web result is not applied', async () => {
                makePostRequest.mockResolvedValueOnce(null);
                makePostRequest.mockResolvedValueOnce({
                    challenges: [{ id: 1, member: { turbo: { state: 'FREE' } } }],
                });

                const result = await getActiveChallenges(mockToken);

                expect(result).toEqual({ challenges: [], fetchFailed: true });
                expect(pinChallengeTitles).not.toHaveBeenCalled();
            });

            test('the web read starts before the mobile read settles', async () => {
                let resolveMobile: (value: { challenges: [] }) => void;
                makePostRequest.mockReturnValueOnce(new Promise((resolve) => (resolveMobile = resolve)));
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const pending = getActiveChallenges(mockToken);

                expect(makePostRequest).toHaveBeenCalledTimes(2);
                expect(makePostRequest).toHaveBeenNthCalledWith(2, WEB_URL, expect.anything(), '');
                resolveMobile!({ challenges: [] });
                await pending;
            });
        });

        describe('team match from the cache', () => {
            const teamMatch = { us: { name: 'Home Team', votes: 7514 }, them: { name: 'Poland Gurus', votes: 8258 } };
            const list = () => ({
                challenges: [
                    { id: 1, title: 'A' },
                    { id: '135938', title: 'B' },
                ],
            });

            test('the cached team match lands on the matching challenge only', async () => {
                settledTeamMatch.mockResolvedValue({ challengeId: '135938', teamMatch });
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const result = await getActiveChallenges(mockToken);

                expect(result.challenges[0].teamMatch).toBeUndefined();
                expect(result.challenges[1].teamMatch).toEqual(teamMatch);
                expect(latestTeamMatch).toHaveBeenCalledWith(mockToken);
                // The wait is bounded at 2 s.
                expect(settledTeamMatch).toHaveBeenCalledWith(mockToken, 2000);
            });

            test('a team read that only settles at the cap still yields the list', async () => {
                jest.useFakeTimers();
                try {
                    settledTeamMatch.mockReturnValue(
                        new Promise((resolve) => setTimeout(() => resolve(undefined), 2000)),
                    );
                    makePostRequest.mockResolvedValueOnce(list());
                    makePostRequest.mockResolvedValueOnce({ challenges: [] });

                    const pending = getActiveChallenges(mockToken);
                    await jest.advanceTimersByTimeAsync(2000);
                    const result = await pending;

                    expect(result).toEqual(list());
                } finally {
                    jest.useRealTimers();
                }
            });

            test('the refresh starts with the reads, before the mobile read settles', async () => {
                let resolveMobile: (value: { challenges: [] }) => void;
                makePostRequest.mockReturnValueOnce(new Promise((resolve) => (resolveMobile = resolve)));
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const pending = getActiveChallenges(mockToken);

                expect(latestTeamMatch).toHaveBeenCalledTimes(1);
                resolveMobile!({ challenges: [] });
                await pending;
            });

            test.each([
                ['no team match is cached', undefined],
                ['the cached match runs on a challenge the member has not joined', { challengeId: '999', teamMatch }],
            ])('the list is untouched when %s', async (_label, cached) => {
                settledTeamMatch.mockResolvedValue(cached);
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const result = await getActiveChallenges(mockToken);

                expect(result).toEqual(list());
                expect(result.challenges.some((challenge) => 'teamMatch' in challenge)).toBe(false);
            });

            test('a failed mobile read is returned as it is, with no team match', async () => {
                settledTeamMatch.mockResolvedValue({ challengeId: '135938', teamMatch });
                makePostRequest.mockResolvedValueOnce(null);
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const result = await getActiveChallenges(mockToken);

                expect(result).toEqual({ challenges: [], fetchFailed: true });
            });
        });

        test('never writes any part of the token into the debug log payload', async () => {
            // Security guard: a `tokenPrefix` slice of the real bearer token would
            // bypass the logger's key-based redaction and land in api-*.log in
            // cleartext. No fragment of the token may appear in any logged argument.
            const longToken = 'very-long-token-that-should-be-truncated-for-security';
            const mockResponse = { challenges: [] };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(longToken);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Requesting active challenges from API', {
                hasToken: true,
            });
            // Belt-and-suspenders: no debug call may carry even a prefix of it.
            for (const call of logger.__mockDebugFn.mock.calls) {
                const serialised = JSON.stringify(call);
                expect(serialised).not.toContain(longToken.slice(0, 10));
            }
        });
    });

    describe('fetchWebActiveTurbos', () => {
        test('maps each challenge id (as a string) to its turbo, null when it has none', async () => {
            const snap = { state: 'IN_PROGRESS', mode: 'snap' };
            makePostRequest.mockResolvedValueOnce({
                challenges: [{ id: 11, member: { turbo: snap } }, { id: '12', member: { turbo: null } }, { id: 13 }],
            });

            const turbos = await fetchWebActiveTurbos(mockToken);

            expect(turbos).toEqual(
                new Map([
                    ['11', snap],
                    ['12', null],
                    ['13', null],
                ]),
            );
            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest/get_my_active_challenges',
                expect.objectContaining({ 'x-env': 'WEB', 'x-token': mockToken }),
                '',
            );
        });

        test('skips elements that are not objects or have no usable id, and a turbo that is not an object', async () => {
            const snap = { state: 'IN_PROGRESS', mode: 'snap' };
            makePostRequest.mockResolvedValueOnce(
                invalid({
                    challenges: [
                        null,
                        'text',
                        { member: { turbo: snap } },
                        { id: null, member: { turbo: snap } },
                        { id: 21, member: 'none' },
                        { id: 22, member: { turbo: 'WON' } },
                        { id: 23, member: { turbo: snap } },
                    ],
                }),
            );

            const turbos = await fetchWebActiveTurbos(mockToken);

            expect(turbos).toEqual(
                new Map([
                    ['21', null],
                    ['22', null],
                    ['23', snap],
                ]),
            );
        });

        test.each([
            ['a failed request', null, true],
            ['a body without a challenge list', { success: true }, false],
            ['a challenge list that is not an array', { challenges: 'none' }, false],
        ])('is null on %s, with a warning that carries no token', async (_label, body, requestFailed) => {
            makePostRequest.mockResolvedValueOnce(invalid(body));

            await expect(fetchWebActiveTurbos(mockToken)).resolves.toBeNull();

            expect(logger.__mockWarningFn).toHaveBeenCalledWith(
                'Web active challenges unavailable; turbo mode unknown',
                {
                    requestFailed,
                },
            );
            expect(JSON.stringify(logger.__mockWarningFn.mock.calls)).not.toContain(mockToken);
        });
    });
});
