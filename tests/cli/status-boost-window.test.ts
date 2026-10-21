/**
 * Unit tests for the CLI `status` command's authenticated sections, both fed by
 * ONE best-effort fetch of the active challenges: the "Boost Window Open" list
 * (the CLI parity of the GUI BoostWindowBanner — informational, no anchors) and
 * the "Standing" section (per-challenge rank with its benchmark gap, and the
 * team-match standing). A failed fetch prints a note under each section and
 * never crashes status. logger, settings, the middleware, and the scheduler
 * are mocked.
 */

jest.mock('../../src/ts/logger', () => {
    const infoMock = jest.fn();
    return {
        __infoMock: infoMock,
        withCategory: jest.fn(() => ({
            info: infoMock,
            error: infoMock,
            success: infoMock,
            warning: infoMock,
            startOperation: jest.fn(),
            endOperation: jest.fn(),
        })),
    };
});

jest.mock('../../src/ts/settings', () => ({
    loadSettings: jest.fn(() => ({
        app: {
            mock: true,
            theme: 'latvian',
            language: 'english',
            timezone: 'Europe/Riga',
            apiTimeout: 30,
            checkFrequencyMin: 1,
            checkFrequencyMax: 1,
        },
        auth: { token: 'tok' },
        challenges: {},
    })),
    getEffectiveSetting: jest.fn(() => 1),
}));

jest.mock('../../src/ts/scheduling/runScheduler', () => ({ createScheduler: jest.fn() }));

jest.mock('../../src/ts/apiFactory', () => {
    const mockGetActiveChallenges = jest.fn();
    const mockIsAuthenticated = jest.fn(() => true);
    return {
        __getActiveChallenges: mockGetActiveChallenges,
        __isAuthenticated: mockIsAuthenticated,
        getMiddleware: jest.fn(() => ({
            isAuthenticated: mockIsAuthenticated,
            getActiveChallenges: mockGetActiveChallenges,
        })),
    };
});

import { invalid } from '../helpers/invalid';
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(invalid<typeof loggerModule & { __infoMock: jest.Mock<void, [unknown]> }>(loggerModule));
import apiFactoryModule = require('../../src/ts/apiFactory');
type Middleware = ReturnType<typeof apiFactoryModule.getMiddleware>;
const apiFactory = jest.mocked(
    invalid<
        typeof apiFactoryModule & {
            __getActiveChallenges: jest.MockedFunction<Middleware['getActiveChallenges']>;
            __isAuthenticated: jest.MockedFunction<Middleware['isAuthenticated']>;
        }
    >(apiFactoryModule),
);
import type * as votingModule from '../../src/ts/cli/commands/voting';
import type { Challenge } from '../../src/ts/types/gurushots';
const { showStatus } = require('../../src/ts/cli/commands/voting') as typeof votingModule;

const challenge = (title: string, boost: { state: string; timeout?: number }) =>
    invalid<Challenge>({
        id: title,
        title,
        member: { boost },
    });

const printedLines = () =>
    logger.__infoMock.mock.calls.map((c) => c[0]).filter((s): s is string => typeof s === 'string');
const bulletLines = () => printedLines().filter((s) => s.startsWith('  • '));

describe('CLI status — Boost Window Open section', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        apiFactory.__isAuthenticated.mockReturnValue(true);
    });

    test('lists open windows soonest-first, key-unlocked last, with formatted remaining', async () => {
        const now = Math.floor(Date.now() / 1000);
        apiFactory.__getActiveChallenges.mockResolvedValue({
            challenges: [
                challenge('TenMin', { state: 'AVAILABLE', timeout: now + 630 }),
                challenge('KeyOne', { state: 'AVAILABLE_KEY' }),
                challenge('TwoMin', { state: 'AVAILABLE', timeout: now + 150 }),
                challenge('HourPlus', { state: 'AVAILABLE', timeout: now + 3700 }),
                challenge('Closed', { state: 'USED' }),
            ],
        });

        await showStatus();

        expect(printedLines()).toContain('\nBoost Window Open:');
        expect(bulletLines()).toEqual([
            '  • TwoMin — 2m',
            '  • TenMin — 10m',
            '  • HourPlus — 1h 1m',
            '  • KeyOne — no expiry',
        ]);
    });

    test('multi-day window uses d/h units (not raw hours/minutes)', async () => {
        const now = Math.floor(Date.now() / 1000);
        apiFactory.__getActiveChallenges.mockResolvedValue({
            challenges: [challenge('LongOne', { state: 'AVAILABLE', timeout: now + 2 * 86400 + 3 * 3600 + 1800 })],
        });

        await showStatus();

        expect(bulletLines()).toEqual(['  • LongOne — 2d 3h']);
    });

    test('sub-minute window prints "<1m", not "0m"', async () => {
        const now = Math.floor(Date.now() / 1000);
        apiFactory.__getActiveChallenges.mockResolvedValue({
            challenges: [challenge('AlmostGone', { state: 'AVAILABLE', timeout: now + 30 })],
        });

        await showStatus();

        expect(bulletLines()).toEqual(['  • AlmostGone — <1m']);
    });

    test('a non-array challenges payload is treated as empty (prints "None")', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: invalid(null) });

        await showStatus();

        expect(printedLines()).toContain('  None');
        expect(bulletLines()).toEqual([]);
    });

    test('prints "None" when no boost window is open', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({
            challenges: [challenge('Closed', { state: 'USED' })],
        });

        await showStatus();

        expect(printedLines()).toContain('  None');
        expect(bulletLines()).toEqual([]);
    });

    test('best-effort: a failed fetch prints a note instead of throwing', async () => {
        apiFactory.__getActiveChallenges.mockRejectedValue(new Error('network down'));

        await expect(showStatus()).resolves.toBeUndefined();
        expect(printedLines().some((s) => s.includes('unavailable') && s.includes('network down'))).toBe(true);
    });

    test('skips the section entirely when not authenticated', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);

        await showStatus();

        expect(printedLines()).not.toContain('\nBoost Window Open:');
        expect(apiFactory.__getActiveChallenges).not.toHaveBeenCalled();
    });
});

describe('CLI status — Standing section', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        apiFactory.__isAuthenticated.mockReturnValue(true);
    });

    const withChallenges = async (...challenges: unknown[]) => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: invalid<Challenge[]>(challenges) });
        await showStatus();
        return printedLines();
    };

    test('prints the rank and the benchmark gap, from one shared read', async () => {
        const lines = await withChallenges({
            id: 1,
            title: 'Sunset',
            member: {
                ranking: {
                    total: {
                        rank: 214,
                        votes: 99,
                        benchmark: [
                            { benchmark: '1', score: '50' },
                            { benchmark: '10', score: '120' },
                            { benchmark: '100', score: '312' },
                        ],
                    },
                },
            },
        });
        // One fetch feeds both the Boost Window and Standing sections.
        expect(apiFactory.__getActiveChallenges).toHaveBeenCalledTimes(1);
        expect(lines).toContain('  • Sunset — rank 214 — top 100 needs 214 votes');
    });

    test('inside the top 100 the gap runs toward the next smaller benchmark', async () => {
        const lines = await withChallenges(
            {
                id: 1,
                title: 'Mid',
                member: {
                    ranking: { total: { rank: 42, votes: 108, benchmark: [{ benchmark: '10', score: '120' }] } },
                },
            },
            {
                id: 2,
                title: 'High',
                member: { ranking: { total: { rank: 5, votes: 48, benchmark: [{ benchmark: '1', score: '50' }] } } },
            },
        );
        expect(lines).toContain('  • Mid — rank 42 — top 10 needs 13 votes');
        expect(lines).toContain('  • High — rank 5 — top 1 needs 3 votes');
    });

    test.each([
        [
            'rank 1 has nothing left to reach',
            { rank: 1, votes: 500, benchmark: [{ benchmark: '1', score: '50' }] },
            'rank 1',
        ],
        [
            'a benchmark already reached shows no gap',
            { rank: 42, votes: 200, benchmark: [{ benchmark: '10', score: '120' }] },
            'rank 42',
        ],
        [
            'a garbage score is omitted',
            { rank: 214, votes: 99, benchmark: [{ benchmark: '100', score: 'abc' }] },
            'rank 214',
        ],
        [
            'an empty score is omitted',
            { rank: 214, votes: 99, benchmark: [{ benchmark: '100', score: '' }] },
            'rank 214',
        ],
        [
            'the benchmark the rank calls for is not listed',
            { rank: 214, votes: 99, benchmark: [{ benchmark: '10', score: '120' }] },
            'rank 214',
        ],
        ['no benchmark rows at all', { rank: 214, votes: 99 }, 'rank 214'],
    ])('%s', async (_name, total, line) => {
        expect(await withChallenges({ id: 1, title: 'C', member: { ranking: { total } } })).toContain(
            `  • C — ${line}`,
        );
    });

    test('with the votes unreadable, the benchmark score is shown without a gap', async () => {
        const lines = await withChallenges(
            {
                id: 1,
                title: 'NoVotes',
                member: { ranking: { total: { rank: 214, benchmark: [{ benchmark: '100', score: '312' }] } } },
            },
            {
                id: 2,
                title: 'ZeroVotes',
                member: { ranking: { total: { rank: 30, votes: 0, benchmark: [{ benchmark: '10', score: '120' }] } } },
            },
        );
        expect(lines).toContain('  • NoVotes — rank 214 — top 100 at 312 votes');
        expect(lines).toContain('  • ZeroVotes — rank 30 — top 10 at 120 votes');
    });

    test('a challenge with no readable rank, and one with no ranking at all, print no line', async () => {
        const lines = await withChallenges(
            {
                id: 1,
                title: 'NoRank',
                member: { ranking: { total: { votes: 99, benchmark: [{ benchmark: '100', score: '312' }] } } },
            },
            { id: 2, title: 'NoRanking', member: {} },
            { id: 3, title: 'Plain' },
        );
        expect(bulletLines()).toEqual([]);
        expect(lines).toContain('  None');
    });

    test('a challenge with both a ranking and a team match prints both lines', async () => {
        const lines = await withChallenges({
            id: 1,
            title: 'Both',
            member: { ranking: { total: { rank: 214, votes: 99, benchmark: [{ benchmark: '100', score: '312' }] } } },
            teamMatch: {
                us: { name: 'Ours', votes: 1200 },
                them: { name: 'Theirs', votes: 1100 },
                me: { kind: 'active', position: 2, votes: 300, activeSlots: 5, cushion: 1 },
            },
        });
        expect(lines).toContain('  • Both — rank 214 — top 100 needs 214 votes');
        expect(lines).toContain('  • Both — us 1200, them 1100 — #2 of 5 active (+1 over standby)');
    });

    test('a title carrying terminal control prints stripped, on the rank and the team-match lines', async () => {
        const lines = await withChallenges({
            id: 1,
            title: 'Evil\u001b[31m\nShaw',
            member: { ranking: { total: { rank: 214, votes: 99, benchmark: [{ benchmark: '100', score: '312' }] } } },
            teamMatch: { us: { name: 'Ours', votes: 1 }, them: { name: 'Theirs', votes: 2 } },
        });
        expect(lines).toContain('  • Evil Shaw — rank 214 — top 100 needs 214 votes');
        expect(lines).toContain('  • Evil Shaw — us 1, them 2');
    });

    test.each([
        [
            'active with a cushion over standby',
            {
                us: { name: 'O', votes: 1200 },
                them: { name: 'T', votes: 1100 },
                me: { kind: 'active', position: 2, votes: 300, activeSlots: 5, cushion: 1 },
            },
            '  • Tm — us 1200, them 1100 — #2 of 5 active (+1 over standby)',
        ],
        [
            'active with no cushion',
            {
                us: { name: 'O', votes: 1200 },
                them: { name: 'T', votes: 1100 },
                me: { kind: 'active', position: 3, votes: 300, activeSlots: 5, cushion: null },
            },
            '  • Tm — us 1200, them 1100 — #3 of 5 active',
        ],
        [
            'standby counts the votes to active',
            {
                us: { name: 'O', votes: 900 },
                them: { name: 'T', votes: 1300 },
                me: { kind: 'standby', position: 6, votes: 100, activeSlots: 5, votesToActive: 3 },
            },
            '  • Tm — us 900, them 1300 — standby, 3 votes to active',
        ],
        [
            'an unreadable standing prints the totals alone',
            { us: { name: 'O', votes: 1200 }, them: { name: 'T', votes: 1100 }, me: null },
            '  • Tm — us 1200, them 1100',
        ],
        [
            'a match that is over says so instead of the standing',
            {
                us: { name: 'O', votes: 1200 },
                them: { name: 'T', votes: 1100 },
                running: false,
                me: { kind: 'active', position: 1, votes: 300, activeSlots: 5, cushion: null },
            },
            '  • Tm — us 1200, them 1100 — not running',
        ],
    ])('team-match standing: %s', async (_name, teamMatch, line) => {
        expect(await withChallenges({ id: 1, title: 'Tm', teamMatch })).toContain(line);
    });

    test('a failed fetch prints a note under both sections instead of crashing', async () => {
        apiFactory.__getActiveChallenges.mockRejectedValue(new Error('network down'));

        await expect(showStatus()).resolves.toBeUndefined();

        expect(printedLines().filter((s) => s.includes('unavailable') && s.includes('network down'))).toHaveLength(2);
    });
});
