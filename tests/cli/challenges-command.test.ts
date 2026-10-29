/**
 * Unit tests for the CLI `challenges` command (alias `list`): one block per
 * active challenge with the id first — the id every `--challenge=<id>` command
 * needs — the per-state turbo line naming the command that can run now, the
 * detail view with the photo ids an `--image=<id>` aims at, and the failure
 * paths (unknown flag forms, unknown id, failed fetch, not authenticated).
 * The middleware is mocked; the row handler is driven the way the dispatcher
 * drives it (argv → exit code).
 */

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: unknown }[] = [];
    const rec = (level: string) => (msg: unknown) => calls.push({ level, msg });
    const cat = {
        info: rec('info'),
        error: rec('error'),
        success: rec('success'),
        warning: rec('warning'),
        debug: rec('debug'),
    };
    return { __calls: calls, withCategory: jest.fn(() => cat), CATEGORIES: {} };
});

jest.mock('../../src/ts/apiFactory', () => {
    const getActiveChallenges = jest.fn();
    const isAuthenticated = jest.fn(() => true);
    return {
        __getActiveChallenges: getActiveChallenges,
        __isAuthenticated: isAuthenticated,
        getMiddleware: jest.fn(() => ({ isAuthenticated, getActiveChallenges })),
        getApiStrategy: jest.fn(),
    };
});

import { invalid } from '../helpers/invalid';
import { buildChallenge } from '../helpers/challengeFixtures';
import type { Challenge } from '../../src/ts/types/gurushots';
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(invalid<typeof loggerModule & { __calls: { level: string; msg: unknown }[] }>(loggerModule));
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
import type * as commandTableModule from '../../src/ts/cli/commandTable';
const { COMMANDS } = require('../../src/ts/cli/commandTable') as typeof commandTableModule;
const challenges = COMMANDS.challenges;

const msgsAt = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const contains = (arr: string[], sub: string) => arr.some((s) => s.includes(sub));

// The command reads the wall clock itself, so the fixture's close time is
// relative to the same second it computes.
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
    apiFactory.__isAuthenticated.mockReturnValue(true);
    apiFactory.__getActiveChallenges.mockResolvedValue(
        invalid({
            challenges: [
                buildChallenge({
                    id: 'c1',
                    title: 'Sunset',
                    max_photo_submits: 5,
                    close_time: now() + 7200,
                    member: {
                        boost: { state: 'AVAILABLE', timeout: 0 },
                        turbo: { state: 'FREE', mode: 'classic' },
                        ranking: { entries: [{ id: 'imgA' }, { id: 'imgB' }], exposure: { exposure_factor: 40 } },
                    },
                }),
            ],
        }),
    );
});

describe('challenges — the list', () => {
    test('one block per challenge, id first, with the readable fields', async () => {
        await expect(challenges([])).resolves.toBe(0);

        const lines = msgsAt('info');
        expect(lines).toEqual([
            '• c1 — Sunset',
            expect.stringContaining('Closes in 2h'),
            '  Entries: 2 / 5',
            '  Exposure: 40%',
            '  Boost: AVAILABLE',
            '  Turbo: FREE (mode classic) — can play now: turbo --challenge=c1',
        ]);
    });

    test('an empty list says so and exits 0', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(invalid({ challenges: [] }));

        await expect(challenges([])).resolves.toBe(0);
        expect(msgsAt('info')).toEqual(['No active challenges.']);
    });

    test('an unreadable fetch is a failure, not an empty list', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(invalid(null));

        await expect(challenges([])).resolves.toBe(1);

        const errors = msgsAt('error');
        expect(contains(errors, 'Failed to fetch the active challenges: the request did not succeed')).toBe(true);
        expect(contains(errors, 'Nothing was read — check the connection and try again')).toBe(true);
        expect(msgsAt('info')).toEqual([]);
    });

    test('a marked challenge names itself and stops at (data cannot be read)', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({
                challenges: [buildChallenge({ id: 2, title: 'Broken', dataIssues: ['close_time'] })],
            }),
        );

        await expect(challenges([])).resolves.toBe(0);
        expect(msgsAt('info')).toEqual(['• 2 — Broken — (data cannot be read)']);
    });

    test('fields that cannot be read are skipped or read as none', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({
                challenges: [
                    buildChallenge({
                        id: 'c2',
                        title: 'Sparse',
                        close_time: undefined,
                        member: {
                            boost: null,
                            turbo: null,
                            ranking: { entries: [], exposure: { exposure_factor: null } },
                        },
                    }),
                ],
            }),
        );

        await expect(challenges([])).resolves.toBe(0);
        expect(msgsAt('info')).toEqual([
            '• c2 — Sparse',
            '  Entries: 0 / 0',
            '  Exposure: —',
            '  Boost: none',
            '  Turbo: none (mode unknown)',
        ]);
    });

    test('a challenge with no member standing at all still lists', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({ challenges: [invalid<Challenge>({ id: 'c3', title: 'Bare', close_time: now() + 60 })] }),
        );

        await expect(challenges([])).resolves.toBe(0);
        expect(msgsAt('info')).toEqual([
            '• c3 — Bare',
            expect.stringContaining('Closes in'),
            '  Entries: 0 / 0',
            '  Exposure: —',
            '  Boost: none',
            '  Turbo: none (mode unknown)',
        ]);
    });
});

describe('challenges — the turbo line per state', () => {
    test.each([
        ['FREE', { state: 'FREE', mode: 'classic' }, 'Turbo: FREE (mode classic) — can play now: turbo --challenge=c1'],
        [
            'an elapsed TIMER',
            { state: 'TIMER', mode: 'classic', time_to_open: now() - 1 },
            'Turbo: TIMER (mode classic) — can play now: turbo --challenge=c1',
        ],
        [
            'IN_PROGRESS',
            { state: 'IN_PROGRESS', mode: 'snap' },
            'Turbo: IN_PROGRESS (mode snap) — in progress (another session may be playing it): turbo --challenge=c1 resumes it',
        ],
        [
            'a TIMER still counting down',
            { state: 'TIMER', mode: 'classic', time_to_open: now() + 60 },
            'Turbo: TIMER (mode classic)',
        ],
        [
            'WON',
            { state: 'WON', mode: 'classic' },
            'Turbo: WON (mode classic) — apply it to a photo: turbo --challenge=c1 --image=<photo id>',
        ],
        ['an unknown mode', { state: 'FREE', mode: 'NEW_MODE' }, 'Turbo: FREE (mode unknown)'],
        [
            'an unknown mode, in progress',
            { state: 'IN_PROGRESS', mode: 'NEW_MODE' },
            'Turbo: IN_PROGRESS (mode unknown)',
        ],
    ])('%s', (_label, turbo, line) => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({
                challenges: [
                    buildChallenge({ id: 'c1', title: 'Sunset', close_time: now() + 7200, member: { turbo } }),
                ],
            }),
        );
        return challenges([]).then((code) => {
            expect(code).toBe(0);
            expect(contains(msgsAt('info'), line)).toBe(true);
        });
    });
});

describe('challenges — the detail view', () => {
    test('one challenge, with its entries as the --image targets', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({
                challenges: [
                    buildChallenge({
                        id: 'c1',
                        title: 'Sunset',
                        max_photo_submits: 5,
                        close_time: now() + 7200,
                        member: {
                            boost: null,
                            turbo: { state: 'WON', mode: 'classic' },
                            ranking: {
                                entries: [
                                    { id: 'imgA', votes: 120, rank: 9, turbo: true },
                                    { id: 'imgB', votes: 5, boosted: true },
                                    { id: 'imgC', rank: -1 },
                                    { id: 'imgD' },
                                ],
                                exposure: { exposure_factor: 40 },
                                total: { rank: 12 },
                            },
                        },
                    }),
                ],
            }),
        );

        await expect(challenges(['--challenge=c1'])).resolves.toBe(0);

        const lines = msgsAt('info');
        expect(lines).toEqual([
            '• c1 — Sunset',
            expect.stringContaining('Closes in 2h'),
            '  Entries: 4 / 5',
            '  Exposure: 40%',
            '  Boost: none',
            '  Turbo: WON (mode classic) — apply it to a photo: turbo --challenge=c1 --image=<photo id>',
            '  Rank: rank 12',
            '  Entries:',
            '    • imgA — 120 votes, rank 9 (turboed)',
            '    • imgB — 5 votes (boosted)',
            '    • imgC',
            '    • imgD',
        ]);
    });

    test('an unknown id exits 1', async () => {
        await expect(challenges(['--challenge=999'])).resolves.toBe(1);
        expect(contains(msgsAt('error'), 'Challenge 999 not found among active challenges')).toBe(true);
    });

    test('a failed fetch exits 1 and never reads as an unknown id', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(invalid({ challenges: [], fetchFailed: true }));

        await expect(challenges(['--challenge=c1'])).resolves.toBe(1);

        const errors = msgsAt('error');
        expect(contains(errors, 'Failed to fetch the active challenges: the request did not succeed')).toBe(true);
        expect(contains(errors, 'Nothing was read — check the connection and try again')).toBe(true);
        expect(contains(errors, 'not found among active challenges')).toBe(false);
    });

    test('a detail challenge with no readable entries prints the block alone', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({ challenges: [invalid<Challenge>({ id: 'c3', title: 'Bare', close_time: now() + 7200 })] }),
        );

        await expect(challenges(['--challenge=c3'])).resolves.toBe(0);

        const lines = msgsAt('info');
        expect(lines).toEqual([
            '• c3 — Bare',
            expect.stringContaining('Closes in 2h'),
            '  Entries: 0 / 0',
            '  Exposure: —',
            '  Boost: none',
            '  Turbo: none (mode unknown)',
        ]);
    });
});

describe('challenges — failures', () => {
    test('a failed fetch exits 1 with what happened, why, and what to do next', async () => {
        apiFactory.__getActiveChallenges.mockRejectedValue(new Error('network down'));

        await expect(challenges([])).resolves.toBe(1);

        const errors = msgsAt('error');
        expect(contains(errors, 'Failed to fetch the active challenges: network down')).toBe(true);
        expect(contains(errors, 'check the connection and try again')).toBe(true);
    });

    test('a rejection with no message prints the thrown value itself', async () => {
        apiFactory.__getActiveChallenges.mockRejectedValue(undefined);

        await expect(challenges([])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'Failed to fetch the active challenges: undefined')).toBe(true);
    });

    test('not authenticated exits 1 with the login guidance', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);

        await expect(challenges([])).resolves.toBe(1);

        expect(contains(msgsAt('error'), 'No authentication token found. Please login first')).toBe(true);
        expect(contains(msgsAt('info'), 'Run: login')).toBe(true);
        expect(apiFactory.__getActiveChallenges).not.toHaveBeenCalled();
    });
});

describe('challenges — strict flags', () => {
    test.each([
        ['an unknown flag', ['--json']],
        ['a repeated flag', ['--challenge=c1', '--challenge=c2']],
        ['a space-form flag', ['--challenge', 'c1']],
        ['an empty value', ['--challenge=']],
        ['a positional argument', ['c1']],
    ])('%s prints the usage and exits 1', async (_label, argv) => {
        await expect(challenges(argv)).resolves.toBe(1);
        expect(contains(msgsAt('error'), 'Wrong arguments')).toBe(true);
        expect(contains(msgsAt('info'), 'Usage: challenges [--challenge=<id>]')).toBe(true);
        expect(apiFactory.__getActiveChallenges).not.toHaveBeenCalled();
    });

    test('the alias `list` dispatches to the same handler', () => {
        expect(COMMANDS.list).toBe(COMMANDS.challenges);
    });
});
