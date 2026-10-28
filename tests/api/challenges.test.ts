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
import type * as suggestedPhotosModule from '../../src/ts/strategies/real/suggestedPhotos';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type { CategoryLogger } from '../../src/ts/logger';
import { APP_SET_CHALLENGE_FIELDS } from '../../src/ts/challengeIntegrity';
import { invalid } from '../helpers/invalid';

// The logger factory below also exports its shared debug/endOperation mocks.
type LoggerMock = typeof loggerModule & {
    __mockDebugFn: jest.MockedFunction<CategoryLogger['debug']>;
    __mockEndOperationFn: jest.MockedFunction<CategoryLogger['endOperation']>;
    __mockWarningFn: jest.MockedFunction<CategoryLogger['warning']>;
};

const { getActiveChallenges } =
    require('../../src/ts/strategies/real/activeChallenges') as typeof activeChallengesModule;
const { fetchWebActiveOverlay } = require('../../src/ts/api/challenges') as typeof challengesModule;
const { beginSuggestedPhotos, getSuggestedPhotoIds } =
    require('../../src/ts/strategies/real/suggestedPhotos') as typeof suggestedPhotosModule;

// A 32-character lowercase-hex library photo id ('…01', '…02', …).
const photoId = (n: number): string => n.toString(16).padStart(32, '0');

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
    refreshTeamMatch: jest.fn(),
    settledTeamMatch: jest.fn(),
}));

// Mock the logger module
jest.mock('../../src/ts/logger', () => {
    const mockDebugFn = jest.fn();
    const mockEndOperationFn = jest.fn();
    const mockWarningFn = jest.fn();
    const mockWarningTFn = jest.fn();

    return {
        challengeTag: jest.fn(
            (c: { id?: string | number; title?: string } | string | number | null | undefined, t?: string | null) =>
                c && typeof c === 'object'
                    ? `[Challenge ${c.id ?? 'unknown'}: ${c.title ?? 'unknown'}]`
                    : `[Challenge ${c ?? 'unknown'}: ${t ?? 'unknown'}]`,
        ),
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
            warningT: mockWarningTFn,
            infoT: jest.fn(),
            errorT: jest.fn(),
        })),
        // Export the mock functions for testing
        __mockDebugFn: mockDebugFn,
        __mockEndOperationFn: mockEndOperationFn,
        __mockWarningFn: mockWarningFn,
        __mockWarningTFn: mockWarningTFn,
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
    const { refreshTeamMatch, settledTeamMatch } = jest.mocked(
        require('../../src/ts/strategies/real/teamMatch') as typeof teamMatchModule,
    );

    beforeEach(() => {
        jest.clearAllMocks();
        refreshTeamMatch.mockReset();
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
                        start_time: 1_800_000_000,
                        close_time: 1_800_086_400,
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
                        start_time: 1_800_000_000,
                        close_time: 1_800_086_400,
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

            // The boundary ran with app-set stripping on: a clean read carries
            // both flags as real booleans and leaves the challenges whole.
            expect(result.challenges).toEqual(mockResponse.challenges);
            expect(result.fetchFailed).toBe(false);
            expect(result.pruneUnsafe).toBe(false);
            // Positive wiring: the fetched list must pass through the pin hook
            // (the identity mock would hide a dropped or mis-arged call).
            expect(pinChallengeTitles).toHaveBeenCalledWith(mockResponse.challenges, false);
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
                    {
                        id: '12345',
                        title: 'T',
                        // Well-formed timestamps: a boundary-marked challenge is
                        // neither observed nor annotated (services/entryTimes).
                        start_time: 1_799_900_000,
                        close_time: 1_800_100_000,
                        member: { ranking: { entries: [{ id: 'e1' }, { id: 'e2' }] } },
                    },
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

            resolveRequest!({ challenges: [{ id: '1', start_time: 1, close_time: 2 }] });
            const [r1, r2] = await Promise.all([first, second]);

            // One mobile read plus its web turbo read, shared by both callers.
            expect(makePostRequest).toHaveBeenCalledTimes(2);
            expect(r1).toEqual({
                challenges: [{ id: '1', start_time: 1, close_time: 2 }],
                fetchFailed: false,
                pruneUnsafe: false,
            });
            expect(r2).toBe(r1);
        });

        test('does not coalesce sequential calls (no stale caching)', async () => {
            makePostRequest
                .mockResolvedValueOnce({ challenges: [] })
                .mockResolvedValueOnce({ challenges: [] })
                .mockResolvedValueOnce({ challenges: [{ id: '2', start_time: 1, close_time: 2 }] })
                .mockResolvedValueOnce({ challenges: [] });

            await getActiveChallenges(mockToken);
            const second = await getActiveChallenges(mockToken);

            expect(makePostRequest).toHaveBeenCalledTimes(4);
            expect(second).toEqual({
                challenges: [{ id: '2', start_time: 1, close_time: 2 }],
                fetchFailed: false,
                pruneUnsafe: false,
            });
        });

        describe('the boundary check on the real read', () => {
            const valid = { start_time: 1_800_000_000, close_time: 1_800_086_400 };

            test('strips every app-set field the server may have pre-seeded, iterating the constant', async () => {
                for (const field of APP_SET_CHALLENGE_FIELDS) {
                    makePostRequest.mockResolvedValueOnce({
                        challenges: [
                            {
                                id: 7,
                                title: 'S',
                                ...valid,
                                [field]: field === 'boostHoldUntil' ? 1_800_000_000 : { us: {}, them: {} },
                            },
                        ],
                    });
                    makePostRequest.mockResolvedValueOnce({ challenges: [] });

                    const result = await getActiveChallenges(mockToken);

                    expect(result.challenges[0]).not.toHaveProperty(field);
                }
            });

            test('a server-sent fetchFailed cannot fake a failed read', async () => {
                makePostRequest.mockResolvedValueOnce({
                    challenges: [{ id: 7, title: 'S', ...valid }],
                    fetchFailed: true,
                });
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const result = await getActiveChallenges(mockToken);

                expect(result.fetchFailed).toBe(false);
                // A successful read runs the pin/prune and overlay logic — it is not an outage.
                expect(pinChallengeTitles).toHaveBeenCalledWith(result.challenges, false);
            });

            test('id-less elements are dropped and the read is flagged prune-unsafe', async () => {
                const kept = { id: 7, title: 'S', ...valid };
                makePostRequest.mockResolvedValueOnce({
                    challenges: [kept, null, 'text', { title: 'no id' }],
                });
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const result = await getActiveChallenges(mockToken);

                expect(result.challenges).toEqual([kept]);
                expect(result.pruneUnsafe).toBe(true);
                // Only the kept rows reach the pin/prune logic, flagged so the
                // pruning knows the read is prune-unsafe.
                expect(pinChallengeTitles).toHaveBeenCalledWith([kept], true);
            });

            test('the read flag reaches the pin hook: true when prune-unsafe, false on a clean read', async () => {
                const kept = { id: 8, title: 'K', ...valid };
                makePostRequest.mockResolvedValueOnce({ challenges: [{ title: 'no id' }, kept] });
                makePostRequest.mockResolvedValueOnce({ challenges: [] });
                await getActiveChallenges(mockToken);
                expect(pinChallengeTitles).toHaveBeenLastCalledWith([kept], true);

                const list = [{ id: 9, title: 'C', ...valid }];
                makePostRequest.mockResolvedValueOnce({ challenges: list });
                makePostRequest.mockResolvedValueOnce({ challenges: [] });
                await getActiveChallenges(mockToken);
                expect(pinChallengeTitles).toHaveBeenLastCalledWith(list, false);
            });

            test('a malformed challenge is marked and the merge skips it', async () => {
                const marked: {
                    id: number;
                    title: string;
                    member: { turbo: { state: string } };
                    dataIssues?: string[];
                } = { id: 1, title: 'Broken', member: { turbo: { state: 'WON' } } };
                const healthy = { id: 2, title: 'Ok', ...valid, member: { turbo: { state: 'WON' } } };
                makePostRequest.mockResolvedValueOnce({ challenges: [marked, healthy] });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        { id: 1, member: { turbo: { state: 'FREE', mode: 'classic' } } },
                        { id: 2, member: { turbo: { state: 'FREE', mode: 'classic' } } },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                expect(marked.dataIssues).toEqual(['start_time', 'close_time']);
                // The marked challenge keeps its mobile data; the healthy one takes the overlay.
                expect(result.challenges[0].member?.turbo).toEqual({ state: 'WON' });
                expect(result.challenges[1].member?.turbo).toEqual({ state: 'FREE', mode: 'classic' });
            });

            test('the merge skips a string member without throwing', async () => {
                const badMember: {
                    id: number;
                    title: string;
                    start_time: number;
                    close_time: number;
                    member: string;
                    dataIssues?: string[];
                } = { id: 1, title: 'Primitive member', ...valid, member: 'none' };
                makePostRequest.mockResolvedValueOnce({ challenges: [badMember] });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            member: {
                                turbo: { state: 'FREE' },
                                ranking: { total: { benchmark: [{ benchmark: '1', score: '1' }] } },
                            },
                        },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                // Marked by the boundary, and the overlay left the row exactly as it arrived.
                expect(badMember.dataIssues).toEqual(['member']);
                expect(result.challenges[0]).toEqual(badMember);
            });

            test('a null member carries no mark, and the merge still skips it without making one up', async () => {
                const nullMember: {
                    id: number;
                    title: string;
                    start_time: number;
                    close_time: number;
                    member: null;
                    dataIssues?: string[];
                } = { id: 1, title: 'Null member', ...valid, member: null };
                makePostRequest.mockResolvedValueOnce({ challenges: [nullMember] });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            member: {
                                turbo: { state: 'FREE' },
                                ranking: { total: { benchmark: [{ benchmark: '1', score: '1' }] } },
                            },
                        },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                // §1: null never marks — and the merge's own guard still skips
                // the row, so the overlay never creates a member for it. The
                // member is asserted on the fixture itself: the merge mutates
                // that same object in place, so a dropped guard would replace
                // the null with {} right here and fail this assertion.
                expect(nullMember.dataIssues).toBeUndefined();
                expect(nullMember.member).toBeNull();
                expect(result.challenges[0]).toEqual(nullMember);
            });
        });

        describe('the web overlay on the merged list', () => {
            const WEB_URL = 'https://api.gurushots.com/rest/get_my_active_challenges';
            const mobileTurbo = { state: 'WON', time_to_open: null };
            const mobileResponse = () => ({
                challenges: [
                    {
                        id: 1,
                        title: 'A',
                        start_time: 1_800_000_000,
                        close_time: 1_800_086_400,
                        member: { turbo: { ...mobileTurbo }, boost: { state: 'USED' } },
                    },
                    {
                        id: '2',
                        title: 'B',
                        start_time: 1_800_000_000,
                        close_time: 1_800_086_400,
                        member: { turbo: { ...mobileTurbo } },
                    },
                    { id: 3, title: 'C', start_time: 1_800_000_000, close_time: 1_800_086_400 },
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

                expect(result.fetchFailed).toBe(false);
                expect(result.challenges[0].member?.turbo).toEqual(mobileTurbo);
                expect(result.challenges[1].member?.turbo).toEqual(mobileTurbo);
                expect(pinChallengeTitles).toHaveBeenCalledWith(result.challenges, false);
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

            test('overlay fields land even when the web turbo is null; the mobile total fields are never overwritten', async () => {
                const benchmark = [{ benchmark: '10', score: '1411' }];
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            title: 'A',
                            start_time: 1_800_000_000,
                            close_time: 1_800_086_400,
                            member: { ranking: { total: { votes: 5, rank: 2 } } },
                        },
                    ],
                });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            member: { turbo: null, ranking: { total: { benchmark } } },
                            guru_pick_enable: false,
                            top_photographer_enable: true,
                            levels_rank_enable: false,
                            new_ranking_enable: true,
                            first_prizes: [{ type: 'KEY', amount: 1 }],
                            achievements_and_prizes: [
                                {
                                    title: 'Top 10',
                                    rank: { min_rank: 1, max_rank: 10, type: 'MEMBER' },
                                    prizes: [{ type: 'COINS', amount: 5 }],
                                },
                            ],
                        },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                const challenge = result.challenges[0];
                expect(challenge.guru_pick_enable).toBe(false);
                expect(challenge.top_photographer_enable).toBe(true);
                expect(challenge.levels_rank_enable).toBe(false);
                expect(challenge.new_ranking_enable).toBe(true);
                expect(challenge.first_prizes).toEqual([{ type: 'KEY', amount: 1 }]);
                expect(challenge.achievements_and_prizes).toEqual([
                    {
                        title: 'Top 10',
                        rank: { min_rank: 1, max_rank: 10, type: 'MEMBER' },
                        prizes: [{ type: 'COINS', amount: 5 }],
                    },
                ]);
                // Only `benchmark` is set on the mobile read's own total; votes and rank stay.
                expect(challenge.member?.ranking?.total).toEqual({ votes: 5, rank: 2, benchmark });
                // A null web turbo never replaces what the mobile read had.
                expect(challenge.member?.turbo).toBeUndefined();
            });

            test('a tier whose prizes are not an array of plain objects loses the field; so does a non-array first_prizes', async () => {
                makePostRequest.mockResolvedValueOnce({
                    challenges: [{ id: 1, title: 'A', start_time: 1_800_000_000, close_time: 1_800_086_400 }],
                });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            first_prizes: {},
                            achievements_and_prizes: [
                                { title: 'NoPrizes', rank: null, prizes: {} },
                                { title: 'JunkPrize', prizes: ['bad'] },
                                { title: 'Ok', prizes: [{ type: 'COINS', amount: 5 }] },
                            ],
                        },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                const challenge = result.challenges[0];
                expect(challenge.first_prizes).toBeUndefined();
                expect(challenge.achievements_and_prizes).toEqual([
                    { title: 'NoPrizes', rank: null },
                    { title: 'JunkPrize' },
                    { title: 'Ok', prizes: [{ type: 'COINS', amount: 5 }] },
                ]);
                expect(challenge.achievements_and_prizes?.[0]).not.toHaveProperty('prizes');
                expect(challenge.achievements_and_prizes?.[1]).not.toHaveProperty('prizes');
            });

            test('the benchmark merge creates member / ranking / total when the mobile read lacks them', async () => {
                const benchmark = [{ benchmark: '1', score: '' }];
                const webBenchmark = { id: 0, member: { ranking: { total: { benchmark } } } };
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        { id: 1, title: 'No member', start_time: 1_800_000_000, close_time: 1_800_086_400 },
                        {
                            id: 2,
                            title: 'No ranking',
                            start_time: 1_800_000_000,
                            close_time: 1_800_086_400,
                            member: { boost: { state: 'USED' } },
                        },
                        {
                            id: 3,
                            title: 'No total',
                            start_time: 1_800_000_000,
                            close_time: 1_800_086_400,
                            member: { ranking: { exposure: { exposure_factor: 9 } } },
                        },
                    ],
                });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        { ...webBenchmark, id: 1 },
                        { ...webBenchmark, id: 2 },
                        { ...webBenchmark, id: 3 },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                expect(result.challenges[0].member?.ranking?.total?.benchmark).toEqual(benchmark);
                expect(result.challenges[1].member?.ranking?.total?.benchmark).toEqual(benchmark);
                // Whatever the mobile read already carried next to the created chain stays.
                expect(result.challenges[1].member?.boost).toEqual({ state: 'USED' });
                expect(result.challenges[2].member?.ranking?.total?.benchmark).toEqual(benchmark);
                expect(result.challenges[2].member?.ranking?.exposure).toEqual({ exposure_factor: 9 });
            });

            test('a challenge the web read does not cover is untouched', async () => {
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            title: 'A',
                            start_time: 1_800_000_000,
                            close_time: 1_800_086_400,
                            member: { ranking: { total: { votes: 1 } } },
                        },
                    ],
                });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [{ id: 999, member: { turbo: { state: 'FREE' } } }],
                });

                const result = await getActiveChallenges(mockToken);

                expect(result.challenges).toEqual([
                    {
                        id: 1,
                        title: 'A',
                        start_time: 1_800_000_000,
                        close_time: 1_800_086_400,
                        member: { ranking: { total: { votes: 1 } } },
                    },
                ]);
            });

            test("the web read's Guru's picks raise guru_pick on the mobile entries whose ids match", async () => {
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            title: 'A',
                            start_time: 1_800_000_000,
                            close_time: 1_800_086_400,
                            member: {
                                ranking: {
                                    entries: [
                                        { id: 'e1', guru_pick: false },
                                        { id: 'e2', guru_pick: true },
                                    ],
                                },
                            },
                        },
                        {
                            id: 2,
                            title: 'B',
                            start_time: 1_800_000_000,
                            close_time: 1_800_086_400,
                            member: { ranking: { entries: [{ id: '3' }] } },
                        },
                    ],
                });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            member: {
                                ranking: {
                                    entries: [
                                        { id: 'e1', guru_pick: true },
                                        { id: 'nope', guru_pick: true },
                                    ],
                                },
                            },
                        },
                        { id: 2, member: { ranking: { entries: [{ id: 3, guru_pick: true }] } } },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                // Raised from the web read; an unknown web id touches nothing.
                expect(result.challenges[0].member?.ranking?.entries?.[0]?.guru_pick).toBe(true);
                // A mobile true is kept (and counted as matched), never cleared.
                expect(result.challenges[0].member?.ranking?.entries?.[1]?.guru_pick).toBe(true);
                // A numeric web id matches a string mobile id.
                expect(result.challenges[1].member?.ranking?.entries?.[0]?.guru_pick).toBe(true);
                expect(result.challenges[1].member?.ranking?.entries?.[0]?.id).toBe('3');
            });

            test('a mobile challenge without member or ranking entries takes the overlay without throwing', async () => {
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        { id: 1, title: 'A', start_time: 1_800_000_000, close_time: 1_800_086_400 },
                        {
                            id: 2,
                            title: 'B',
                            start_time: 1_800_000_000,
                            close_time: 1_800_086_400,
                            member: { turbo: { state: 'WON' } },
                        },
                    ],
                });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        { id: 1, member: { ranking: { entries: [{ id: 'e1', guru_pick: true }] } } },
                        { id: 2, member: { ranking: { entries: [{ id: 'e2', guru_pick: true }] } } },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                expect(result.challenges[0].member).toBeUndefined();
                expect(result.challenges[1].member?.turbo).toEqual({ state: 'WON' });
                expect(result.challenges[1].member?.ranking).toBeUndefined();
            });

            test('a web read that fails leaves the mobile guru_pick flags as they are', async () => {
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            title: 'A',
                            start_time: 1_800_000_000,
                            close_time: 1_800_086_400,
                            member: { ranking: { entries: [{ id: 'e1', guru_pick: true }] } },
                        },
                    ],
                });
                makePostRequest.mockResolvedValueOnce(null);

                const result = await getActiveChallenges(mockToken);

                expect(result.challenges[0].member?.ranking?.entries?.[0]?.guru_pick).toBe(true);
            });

            test('a shape-check failure inside one challenge is omitted for that challenge only', async () => {
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        { id: 1, title: 'A', start_time: 1_800_000_000, close_time: 1_800_086_400 },
                        { id: 2, title: 'B', start_time: 1_800_000_000, close_time: 1_800_086_400 },
                    ],
                });
                makePostRequest.mockResolvedValueOnce({
                    challenges: [
                        {
                            id: 1,
                            member: 'none',
                            guru_pick_enable: 'yes',
                            first_prizes: ['bad'],
                            achievements_and_prizes: 'nope',
                            benchmark: [{ benchmark: '1', score: '1' }, 'bad'],
                        },
                        {
                            id: 2,
                            member: { ranking: { total: { benchmark: [{ benchmark: '100', score: '3' }] } } },
                            guru_pick_enable: true,
                            first_prizes: [{ type: 'EXPOSURE_AUTOFILL', amount: 2 }],
                        },
                    ],
                });

                const result = await getActiveChallenges(mockToken);

                // Every malformed field is left off challenge 1 — the mobile shape stands.
                expect(result.challenges[0]).toEqual({
                    id: 1,
                    title: 'A',
                    start_time: 1_800_000_000,
                    close_time: 1_800_086_400,
                });
                // Challenge 2 keeps the fields its web element carried valid.
                expect(result.challenges[1].guru_pick_enable).toBe(true);
                expect(result.challenges[1].first_prizes).toEqual([{ type: 'EXPOSURE_AUTOFILL', amount: 2 }]);
                expect(result.challenges[1].member?.ranking?.total?.benchmark).toEqual([
                    { benchmark: '100', score: '3' },
                ]);
            });
        });

        describe('team match from the cache', () => {
            const teamMatch = { us: { name: 'Home Team', votes: 7514 }, them: { name: 'Poland Gurus', votes: 8258 } };
            const list = () => ({
                challenges: [
                    { id: 1, title: 'A', start_time: 1_800_000_000, close_time: 1_800_086_400 },
                    { id: '135938', title: 'B', start_time: 1_800_000_000, close_time: 1_800_086_400 },
                ],
            });

            test('the cached team match lands on the matching challenge only', async () => {
                refreshTeamMatch.mockReturnValue(true);
                settledTeamMatch.mockResolvedValue({ challengeId: '135938', teamMatch });
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const result = await getActiveChallenges(mockToken);

                expect(result.challenges[0].teamMatch).toBeUndefined();
                expect(result.challenges[1].teamMatch).toEqual(teamMatch);
                expect(refreshTeamMatch).toHaveBeenCalledWith(mockToken);
                // The read that started the refresh waits for it, bounded at 2 s.
                expect(settledTeamMatch).toHaveBeenCalledWith(mockToken, 2000);
            });

            test('a read that did not start the refresh takes the cache as it is: no wait', async () => {
                refreshTeamMatch.mockReturnValue(false);
                settledTeamMatch.mockResolvedValue({ challengeId: '135938', teamMatch });
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const result = await getActiveChallenges(mockToken);

                expect(settledTeamMatch).toHaveBeenCalledWith(mockToken, 0);
                expect(result.challenges[1].teamMatch).toEqual(teamMatch);
            });

            test('during one refresh that never settles, only the first of two sequential reads waits', async () => {
                jest.useFakeTimers();
                try {
                    refreshTeamMatch.mockReturnValueOnce(true).mockReturnValue(false);
                    // Stands in for the real cache: a wait above 0 runs out the cap, a wait of 0 returns at once.
                    settledTeamMatch.mockImplementation(
                        (_token, waitMs) =>
                            new Promise((resolve) =>
                                waitMs > 0 ? setTimeout(() => resolve(undefined), waitMs) : resolve(undefined),
                            ),
                    );
                    // Two reads, each a mobile list and a web list.
                    makePostRequest
                        .mockResolvedValueOnce(list())
                        .mockResolvedValueOnce({ challenges: [] })
                        .mockResolvedValueOnce(list())
                        .mockResolvedValueOnce({ challenges: [] });

                    const first = getActiveChallenges(mockToken);
                    await jest.advanceTimersByTimeAsync(2000);
                    const firstResult = await first;
                    expect(firstResult.challenges).toEqual(list().challenges);

                    // No timer advance: the second read must not wait at all.
                    const second = await getActiveChallenges(mockToken);
                    expect(second.challenges).toEqual(list().challenges);
                    expect(settledTeamMatch.mock.calls).toEqual([
                        [mockToken, 2000],
                        [mockToken, 0],
                    ]);
                } finally {
                    jest.useRealTimers();
                }
            });

            test('fetchAndPin awaits settledTeamMatch and still returns the list', async () => {
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

                    expect(result.challenges).toEqual(list().challenges);
                } finally {
                    jest.useRealTimers();
                }
            });

            test('the refresh starts with the reads, before the mobile read settles', async () => {
                let resolveMobile: (value: { challenges: [] }) => void;
                makePostRequest.mockReturnValueOnce(new Promise((resolve) => (resolveMobile = resolve)));
                makePostRequest.mockResolvedValueOnce({ challenges: [] });

                const pending = getActiveChallenges(mockToken);

                expect(refreshTeamMatch).toHaveBeenCalledTimes(1);
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

                expect(result.challenges).toEqual(list().challenges);
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

        describe('the suggested-photos cache', () => {
            // One challenge on both reads, so the assertions stay on the cache.
            const list = () => ({ challenges: [{ id: 10, title: 'S' }] });
            const webRead = (suggestedChallenges: unknown) => ({
                challenges: [],
                suggested_challenges: suggestedChallenges,
            });
            const images = (ids: string[]) => ids.map((id) => ({ id }));

            beforeEach(() => {
                // The cache is module state shared with the merge tests above.
                beginSuggestedPhotos('');
            });

            test('a good read replaces the cache', async () => {
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce(
                    webRead([{ id: 10, member: { suggested_images: images([photoId(1), photoId(2)]) } }]),
                );
                await getActiveChallenges(mockToken);
                await expect(getSuggestedPhotoIds(mockToken, 10)).resolves.toEqual([photoId(1), photoId(2)]);

                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce(
                    webRead([{ id: 10, member: { suggested_images: images([photoId(3)]) } }]),
                );
                await getActiveChallenges(mockToken);
                await expect(getSuggestedPhotoIds(mockToken, 10)).resolves.toEqual([photoId(3)]);
            });

            test.each([
                ['missing', undefined],
                ['malformed', 'nope'],
            ])('a %s suggested_challenges clears the cache', async (_label, suggestedChallenges) => {
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce(
                    webRead([{ id: 10, member: { suggested_images: images([photoId(1)]) } }]),
                );
                await getActiveChallenges(mockToken);
                await expect(getSuggestedPhotoIds(mockToken, 10)).resolves.toEqual([photoId(1)]);

                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce(webRead(suggestedChallenges));
                await getActiveChallenges(mockToken);
                await expect(getSuggestedPhotoIds(mockToken, 10)).resolves.toEqual([]);
            });

            test('a failed web read leaves the cache alone', async () => {
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce(
                    webRead([{ id: 10, member: { suggested_images: images([photoId(1)]) } }]),
                );
                await getActiveChallenges(mockToken);

                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce(null);
                await getActiveChallenges(mockToken);

                await expect(getSuggestedPhotoIds(mockToken, 10)).resolves.toEqual([photoId(1)]);
            });

            test('a failed mobile read leaves the cache alone', async () => {
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce(
                    webRead([{ id: 10, member: { suggested_images: images([photoId(1)]) } }]),
                );
                await getActiveChallenges(mockToken);

                makePostRequest.mockResolvedValueOnce(null);
                makePostRequest.mockResolvedValueOnce(
                    webRead([{ id: 10, member: { suggested_images: images([photoId(2)]) } }]),
                );
                await getActiveChallenges(mockToken);

                await expect(getSuggestedPhotoIds(mockToken, 10)).resolves.toEqual([photoId(1)]);
            });

            test('another token never sees the cache', async () => {
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce(
                    webRead([{ id: 10, member: { suggested_images: images([photoId(1)]) } }]),
                );
                await getActiveChallenges(mockToken);

                await expect(getSuggestedPhotoIds('other-token', 10)).resolves.toEqual([]);
                await expect(getSuggestedPhotoIds('', 10)).resolves.toEqual([]);
            });

            test('the cache keeps only 32-hex ids, twenty per challenge at most', async () => {
                const ids = [
                    photoId(1),
                    'NOTHEX',
                    photoId(0xab).toUpperCase(),
                    ...Array.from({ length: 25 }, (_v, i) => photoId(i + 3)),
                ];
                makePostRequest.mockResolvedValueOnce(list());
                makePostRequest.mockResolvedValueOnce(webRead([{ id: 10, member: { suggested_images: images(ids) } }]));
                await getActiveChallenges(mockToken);

                await expect(getSuggestedPhotoIds(mockToken, 10)).resolves.toEqual([
                    photoId(1),
                    ...Array.from({ length: 19 }, (_v, i) => photoId(i + 3)),
                ]);
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

    describe('fetchWebActiveOverlay', () => {
        test('maps each challenge id to its overlay and each suggested id to its raw photo ids', async () => {
            const snap = { state: 'IN_PROGRESS', mode: 'snap' };
            const benchmark = [{ benchmark: '10', score: '1411' }];
            makePostRequest.mockResolvedValueOnce({
                challenges: [
                    {
                        id: 11,
                        member: { turbo: snap, ranking: { total: { benchmark } } },
                        guru_pick_enable: true,
                        top_photographer_enable: false,
                        levels_rank_enable: true,
                        new_ranking_enable: false,
                        first_prizes: [{ type: 'KEY', amount: 1 }],
                        achievements_and_prizes: [{ title: 'T', rank: null, prizes: [] }],
                    },
                    { id: '12', member: { turbo: null } },
                    { id: 13 },
                ],
                suggested_challenges: [
                    {
                        id: 500,
                        member: {
                            suggested_images: [{ id: photoId(1), member_id: 'someone-else' }, { id: photoId(2) }],
                        },
                    },
                    { id: '501', member: { suggested_images: [] } },
                ],
            });

            const overlay = await fetchWebActiveOverlay(mockToken);

            expect(overlay?.byId.get('11')).toEqual({
                turbo: snap,
                guru_pick_enable: true,
                top_photographer_enable: false,
                levels_rank_enable: true,
                new_ranking_enable: false,
                first_prizes: [{ type: 'KEY', amount: 1 }],
                achievements_and_prizes: [{ title: 'T', rank: null, prizes: [] }],
                benchmark,
            });
            expect(overlay?.byId.get('12')).toEqual({ turbo: null });
            expect(overlay?.byId.get('13')).toEqual({ turbo: null });
            // Raw ids as the body carries them — the owner is not this cache's concern.
            expect(overlay?.suggestions).toEqual(
                new Map([
                    ['500', [photoId(1), photoId(2)]],
                    ['501', []],
                ]),
            );
            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest/get_my_active_challenges',
                expect.objectContaining({ 'x-env': 'WEB', 'x-token': mockToken }),
                '',
            );
        });

        test('skips unusable elements and omits a challenge’s malformed fields, keeping the rest', async () => {
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
                        { id: 23, member: { turbo: snap, ranking: 'none' } },
                        { id: 24, member: { turbo: snap, ranking: { total: 'none' } } },
                        {
                            id: 25,
                            member: {
                                turbo: snap,
                                ranking: { total: { benchmark: [{ benchmark: '1', score: '1' }, 'bad'] } },
                            },
                            guru_pick_enable: 'yes',
                            first_prizes: ['bad'],
                            achievements_and_prizes: 'nope',
                        },
                        {
                            id: 26,
                            member: {
                                turbo: snap,
                                ranking: { total: { benchmark: [{ benchmark: '100', score: '' }] } },
                            },
                            new_ranking_enable: true,
                        },
                    ],
                }),
            );

            const overlay = await fetchWebActiveOverlay(mockToken);

            expect(overlay?.byId).toEqual(
                new Map([
                    ['21', { turbo: null }],
                    ['22', { turbo: null }],
                    ['23', { turbo: snap }],
                    ['24', { turbo: snap }],
                    // 25's malformed fields are all omitted; the turbo survives.
                    ['25', { turbo: snap }],
                    ['26', { turbo: snap, new_ranking_enable: true, benchmark: [{ benchmark: '100', score: '' }] }],
                ]),
            );
        });

        test('a missing or malformed suggested_challenges reads as an empty map, and bad entries are skipped', async () => {
            makePostRequest.mockResolvedValueOnce(
                invalid({
                    challenges: [{ id: 1 }],
                    suggested_challenges: [
                        'text',
                        { member: { suggested_images: [{ id: photoId(1) }] } },
                        { id: null, member: { suggested_images: [{ id: photoId(1) }] } },
                        { id: 600 },
                        { id: 601, member: 'none' },
                        { id: 602, member: { suggested_images: 'nope' } },
                        { id: 603, member: { suggested_images: ['bad', { id: null }, { id: photoId(9) }] } },
                    ],
                }),
            );

            const overlay = await fetchWebActiveOverlay(mockToken);

            expect(overlay?.suggestions).toEqual(new Map([['603', [photoId(9)]]]));
        });

        test('collects the String ids of the web entries whose guru_pick is true, and nothing else', async () => {
            makePostRequest.mockResolvedValueOnce(
                invalid({
                    challenges: [
                        {
                            id: 31,
                            member: {
                                ranking: {
                                    entries: [
                                        // The shape the live web body carries: string ids, boolean guru_pick.
                                        { id: '429487321', guru_pick: true, member: {}, image: { id: 'x' } },
                                        { id: 84512, guru_pick: true },
                                        { id: '429487322', guru_pick: false },
                                        { id: '429487323' },
                                        'bad',
                                        { guru_pick: true },
                                        { id: null, guru_pick: true },
                                    ],
                                },
                            },
                        },
                        { id: '32', member: { ranking: {} } },
                        { id: 33 },
                    ],
                }),
            );

            const overlay = await fetchWebActiveOverlay(mockToken);

            expect(overlay?.byId.get('31')?.guruPickIds).toEqual(['429487321', '84512']);
            expect(overlay?.byId.get('31')?.turbo).toBeNull();
            // No entries array → the field stays off.
            expect(overlay?.byId.get('32')?.guruPickIds).toBeUndefined();
            expect(overlay?.byId.get('33')?.guruPickIds).toBeUndefined();
        });

        test.each([
            ['a failed request', null, true],
            ['a body without a challenge list', { success: true }, false],
            ['a challenge list that is not an array', { challenges: 'none' }, false],
        ])('is null on %s, with a warning that carries no token', async (_label, body, requestFailed) => {
            makePostRequest.mockResolvedValueOnce(invalid(body));

            await expect(fetchWebActiveOverlay(mockToken)).resolves.toBeNull();

            expect(logger.__mockWarningFn).toHaveBeenCalledWith(
                "Web active challenges unavailable; turbo mode and Guru's picks unknown",
                {
                    requestFailed,
                },
            );
            expect(JSON.stringify(logger.__mockWarningFn.mock.calls)).not.toContain(mockToken);
        });
    });
});
