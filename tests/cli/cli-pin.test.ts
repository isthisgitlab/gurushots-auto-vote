/**
 * Unit tests for the CLI `pin` command: it reads or writes a challenge's pinned
 * Boost/Turbo photos through the same `get-entry-pins` / `set-entry-pin`
 * handlers the GUI uses; listing and clearing never look the challenge up, and
 * pinning warns (but still saves) for a photo that is not one of its current
 * entries, and says when a save displaced the other feature's pin.
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

jest.mock('../../src/ts/settings', () => ({
    getSetting: jest.fn(() => 'tok'),
    loadSettings: jest.fn(() => ({ mock: true, token: 'tok' })),
}));

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

jest.mock('../../src/ts/ipc/settings.handlers', () => {
    const handlers = { 'get-entry-pins': jest.fn(), 'set-entry-pin': jest.fn() };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

import { invalid } from '../helpers/invalid';
import { sentenceCaseLogMessage } from '../../src/ts/format/logSafe';
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
import type * as pinModule from '../../src/ts/cli/commands/pin';
type HandlerTable = Record<string, jest.Mock<Promise<unknown>, unknown[]>>;
const handlers = invalid<{ __handlers: HandlerTable }>(require('../../src/ts/ipc/settings.handlers')).__handlers;
const { pinCmd, printableChallengeId, PIN_USAGE } = require('../../src/ts/cli/commands/pin') as typeof pinModule;

const msgsAt = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
    apiFactory.__isAuthenticated.mockReturnValue(true);
    apiFactory.__getActiveChallenges.mockResolvedValue(
        invalid({
            challenges: [
                { id: 111, title: 'Sunset', member: { ranking: { entries: [{ id: 'imgA' }, { id: 'imgB' }] } } },
            ],
        }),
    );
    handlers['set-entry-pin'].mockResolvedValue({ success: true });
    handlers['get-entry-pins'].mockResolvedValue({ boost: 'imgA', turbo: null });
});

describe('pin', () => {
    test('exports the usage line', () => {
        expect(PIN_USAGE).toBe('Usage: pin --challenge=<id> [--boost=<imageId|none>] [--turbo=<imageId|none>]');
    });

    test('with no flags lists the current pins and saves nothing, naming the challenge by its id', async () => {
        expect(await pinCmd('111')).toBe(true);
        expect(handlers['get-entry-pins']).toHaveBeenCalledWith(null, '111');
        expect(handlers['set-entry-pin']).not.toHaveBeenCalled();
        expect(msgsAt('info')).toEqual(['Pins on challenge 111:', '  Boost: imgA', '  Turbo: none']);
    });

    test('lists none for a feature without a pin and the id for one with', async () => {
        handlers['get-entry-pins'].mockResolvedValue({ boost: null, turbo: 'imgB' });
        expect(await pinCmd('111')).toBe(true);
        expect(msgsAt('info')).toEqual(['Pins on challenge 111:', '  Boost: none', '  Turbo: imgB']);
    });

    test('listing works offline: no authentication, no challenge lookup', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);
        expect(await pinCmd('111')).toBe(true);
        expect(apiFactory.__isAuthenticated).not.toHaveBeenCalled();
        expect(apiFactory.__getActiveChallenges).not.toHaveBeenCalled();
    });

    test('the challenge id is printed as plain text', async () => {
        expect(await pinCmd('7\nforged\u001b[2J')).toBe(true);
        expect(msgsAt('info')[0]).toBe('Pins on challenge 7 forged:');
    });

    test('a failed read of the pins is an error, not an empty list', async () => {
        handlers['get-entry-pins'].mockResolvedValue(null);
        expect(await pinCmd('111')).toBe(false);
        expect(msgsAt('info')).toEqual([]);
        expect(msgsAt('error')).toEqual(['The pins on challenge 111 could not be read. Try again.']);
    });

    test('a challenge id of exactly 64 characters is accepted and printed whole', async () => {
        expect(await pinCmd('7'.repeat(64))).toBe(true);
        expect(msgsAt('info')[0]).toBe(`Pins on challenge ${'7'.repeat(64)}:`);
    });

    test.each([
        ['an over-long', '7'.repeat(65)],
        ['a blank', '   '],
    ])('%s challenge id is refused up front, before any handler or lookup', async (_name, id) => {
        expect(await pinCmd(id)).toBe(false);
        expect(await pinCmd(id, { boost: 'imgA' })).toBe(false);
        expect(handlers['get-entry-pins']).not.toHaveBeenCalled();
        expect(handlers['set-entry-pin']).not.toHaveBeenCalled();
        expect(apiFactory.__getActiveChallenges).not.toHaveBeenCalled();
        expect(msgsAt('error')).toEqual([
            `--challenge takes a non-blank challenge id of at most 64 characters. ${PIN_USAGE}`,
            `--challenge takes a non-blank challenge id of at most 64 characters. ${PIN_USAGE}`,
        ]);
    });

    describe('printableChallengeId', () => {
        test('cuts by code points, so a character straddling the limit is not split', () => {
            const id = `${'7'.repeat(63)}😀${'7'.repeat(5)}`;
            expect(printableChallengeId(id)).toBe(`${'7'.repeat(63)}😀`);
            expect(Array.from(printableChallengeId(`${'😀'.repeat(70)}`))).toHaveLength(64);
        });

        test('strips terminal control characters', () => {
            expect(printableChallengeId('7\u0007\u001b[2J')).toBe('7');
        });
    });

    test('clearing works offline: no lookup, named by id', async () => {
        handlers['get-entry-pins'].mockResolvedValue({ boost: null, turbo: 'imgA' });
        apiFactory.__isAuthenticated.mockReturnValue(false);
        expect(await pinCmd('111', { turbo: null })).toBe(true);
        expect(apiFactory.__getActiveChallenges).not.toHaveBeenCalled();
        expect(handlers['set-entry-pin']).toHaveBeenCalledWith(null, 'turbo', '111', null);
        expect(msgsAt('success')).toEqual(['Cleared the turbo pin on challenge 111']);
    });

    test('clearing a feature that had no pin says so, saves nothing and still succeeds', async () => {
        expect(await pinCmd('111', { turbo: null })).toBe(true);
        expect(handlers['set-entry-pin']).not.toHaveBeenCalled();
        expect(msgsAt('success')).toEqual([]);
        expect(msgsAt('error')).toEqual([]);
        expect(msgsAt('info')).toEqual(['challenge 111 had no turbo pin']);
    });

    test('clearing with unreadable pins still clears', async () => {
        handlers['get-entry-pins'].mockResolvedValue(null);
        expect(await pinCmd('111', { turbo: null })).toBe(true);
        expect(handlers['set-entry-pin']).toHaveBeenCalledWith(null, 'turbo', '111', null);
        expect(msgsAt('success')).toEqual(['Cleared the turbo pin on challenge 111']);
    });

    test.each([
        ['an id', 'd41d8cd98f00b204e9800998ecf8427e'],
        ['an id with a letter first', 'abcdef0123'],
    ])('the warnings print %s unchanged through the logger’s sentence-casing', async (_name, imageId) => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({
                challenges: [
                    {
                        id: 111,
                        title: 'Sunset',
                        member: {
                            ranking: { entries: [{ id: 'imgA' }, { id: 'imgB' }, { id: imageId, turbo: true }] },
                        },
                    },
                ],
            }),
        );
        expect(await pinCmd('111', { boost: imageId })).toBe(true);
        expect(await pinCmd('111', { boost: 'ff00' })).toBe(true);
        const warnings = msgsAt('warning').map(sentenceCaseLogMessage);
        expect(warnings).toEqual([
            `Photo ${imageId} already carries turbo on "Sunset", so it cannot take boost — pinning it anyway.`,
            `Photo ff00 is not one of the entries in "Sunset" (imgA, imgB, ${imageId}) — pinning it anyway.`,
        ]);
    });

    test('pins one entry for one feature through the shared handler', async () => {
        expect(await pinCmd('111', { boost: 'imgB' })).toBe(true);
        expect(handlers['set-entry-pin']).toHaveBeenCalledTimes(1);
        expect(handlers['set-entry-pin']).toHaveBeenCalledWith(null, 'boost', '111', 'imgB');
        expect(msgsAt('success')).toEqual(['Pinned imgB for boost on "Sunset"']);
        expect(msgsAt('warning')).toEqual([]);
        expect(msgsAt('info')).toEqual([]);
    });

    test('pins one feature and clears the other, looking the challenge up once', async () => {
        handlers['get-entry-pins'].mockResolvedValue({ boost: null, turbo: 'imgA' });
        expect(await pinCmd('111', { boost: 'imgB', turbo: null })).toBe(true);
        expect(apiFactory.__getActiveChallenges).toHaveBeenCalledTimes(1);
        expect(handlers['set-entry-pin']).toHaveBeenNthCalledWith(1, null, 'boost', '111', 'imgB');
        expect(handlers['set-entry-pin']).toHaveBeenNthCalledWith(2, null, 'turbo', '111', null);
        expect(msgsAt('success')).toEqual(['Pinned imgB for boost on "Sunset"', 'Cleared the turbo pin on "Sunset"']);
    });

    test('a challenge without a title is named by its id', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111 }] }));
        expect(await pinCmd('111', { boost: 'zzz' })).toBe(true);
        expect(msgsAt('success')).toEqual(['Pinned zzz for boost on challenge 111']);
        expect(msgsAt('warning')).toEqual([
            'Photo zzz is not one of the entries in challenge 111 (none) — pinning it anyway.',
        ]);
    });

    test('an id that is not a current entry is saved with a warning that lists the real ones', async () => {
        expect(await pinCmd('111', { turbo: 'zzz' })).toBe(true);
        expect(handlers['set-entry-pin']).toHaveBeenCalledWith(null, 'turbo', '111', 'zzz');
        expect(msgsAt('warning')).toEqual([
            'Photo zzz is not one of the entries in "Sunset" (imgA, imgB) — pinning it anyway.',
        ]);
    });

    test('a challenge without entries lists none in the warning', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'Sunset' }] }));
        expect(await pinCmd('111', { boost: 'zzz' })).toBe(true);
        expect(msgsAt('warning')).toEqual([
            'Photo zzz is not one of the entries in "Sunset" (none) — pinning it anyway.',
        ]);
    });

    describe('a pin that cannot take effect is saved with a warning', () => {
        const withChallenge = (
            overrides: Record<string, unknown>,
            extraEntries: Record<string, unknown>[] = [],
            member: Record<string, unknown> = {},
        ) =>
            apiFactory.__getActiveChallenges.mockResolvedValue(
                invalid({
                    challenges: [
                        {
                            id: 111,
                            title: 'Sunset',
                            ...overrides,
                            member: {
                                ...member,
                                ranking: { entries: [{ id: 'imgA' }, { id: 'imgB' }, ...extraEntries] },
                            },
                        },
                    ],
                }),
            );

        test.each([
            ['boost', { type: 'flash' }, 'boost never fires on "Sunset": it is a flash challenge — pinning it anyway.'],
            ['turbo', { type: 'flash' }, 'turbo never fires on "Sunset": it is a flash challenge — pinning it anyway.'],
            [
                'boost',
                { max_photo_submits: 1 },
                'boost never fires on "Sunset": it is a single-photo challenge, so Boost never unlocks — pinning it anyway.',
            ],
            [
                'turbo',
                { type: 'exhibition' },
                'turbo never fires on "Sunset": it is an exhibition challenge — pinning it anyway.',
            ],
        ] as const)('%s on %j: names why the feature never fires', async (kind, overrides, line) => {
            withChallenge(overrides);
            expect(await pinCmd('111', { [kind]: 'imgB' })).toBe(true);
            expect(msgsAt('warning')).toEqual([line]);
            expect(handlers['set-entry-pin']).toHaveBeenCalledWith(null, kind, '111', 'imgB');
            expect(msgsAt('success')).toEqual([`Pinned imgB for ${kind} on "Sunset"`]);
        });

        test('a feature that is already used, spent or unavailable cannot fire any more', async () => {
            withChallenge({}, [], { boost: { state: 'USED' } });
            expect(await pinCmd('111', { boost: 'imgB' })).toBe(true);
            withChallenge({}, [{ id: 'imgC', turbo: true }]);
            expect(await pinCmd('111', { turbo: 'imgB' })).toBe(true);
            expect(msgsAt('warning')).toEqual([
                'boost can no longer fire on "Sunset": it is already used, spent or unavailable — pinning it anyway.',
                'turbo can no longer fire on "Sunset": it is already used, spent or unavailable — pinning it anyway.',
            ]);
            expect(handlers['set-entry-pin']).toHaveBeenCalledTimes(2);
        });

        test.each([
            ['boost', { turbo: true }, 'turbo'],
            ['turbo', { boosted: true }, 'boost'],
        ] as const)('a photo that already carries the other feature cannot take %s', async (kind, flag, other) => {
            withChallenge({}, [{ id: 'imgC', ...flag }]);
            expect(await pinCmd('111', { [kind]: 'imgC' })).toBe(true);
            expect(msgsAt('warning')).toEqual([
                `Photo imgC already carries ${other} on "Sunset", so it cannot take ${kind} — pinning it anyway.`,
            ]);
        });

        test('a clear adds no warning; a pin in the same command still warns', async () => {
            withChallenge({ type: 'flash' });
            expect(await pinCmd('111', { boost: null, turbo: 'imgB' })).toBe(true);
            expect(msgsAt('warning')).toEqual([
                'turbo never fires on "Sunset": it is a flash challenge — pinning it anyway.',
            ]);
        });
    });

    describe('a save that displaces the other feature’s pin on that photo', () => {
        test('says so in one line, after the save', async () => {
            // Boost holds imgA: pinning imgA for turbo drops the boost pin.
            expect(await pinCmd('111', { turbo: 'imgA' })).toBe(true);
            expect(msgsAt('success')).toEqual(['Pinned imgA for turbo on "Sunset"']);
            expect(msgsAt('info')).toEqual([
                'Cleared the boost pin on "Sunset": a photo is pinned for one feature only.',
            ]);
        });

        test('says nothing when the other feature pins a different photo, or the pins cannot be read', async () => {
            expect(await pinCmd('111', { turbo: 'imgB' })).toBe(true);
            handlers['get-entry-pins'].mockResolvedValue(null);
            expect(await pinCmd('111', { turbo: 'imgA' })).toBe(true);
            expect(msgsAt('info')).toEqual([]);
        });

        test('swapping the two photos in one command says nothing about a displaced pin, in this order', async () => {
            // Turbo holds imgA; `--boost=imgA --turbo=imgB` ends with boost imgA, turbo imgB.
            handlers['get-entry-pins'].mockResolvedValue({ boost: null, turbo: 'imgA' });
            expect(await pinCmd('111', { boost: 'imgA', turbo: 'imgB' })).toBe(true);
            expect(handlers['set-entry-pin'].mock.calls).toEqual([
                [null, 'boost', '111', 'imgA'],
                [null, 'turbo', '111', 'imgB'],
            ]);
            expect(logger.__calls.map((c) => `${c.level}: ${String(c.msg)}`)).toEqual([
                'success: Pinned imgA for boost on "Sunset"',
                'success: Pinned imgB for turbo on "Sunset"',
            ]);
        });

        test('setting one feature and clearing the one it displaced reports the clear once, from what was held', async () => {
            handlers['get-entry-pins'].mockResolvedValue({ boost: null, turbo: 'imgA' });
            expect(await pinCmd('111', { boost: 'imgA', turbo: null })).toBe(true);
            expect(logger.__calls.map((c) => `${c.level}: ${String(c.msg)}`)).toEqual([
                'success: Pinned imgA for boost on "Sunset"',
                'success: Cleared the turbo pin on "Sunset"',
            ]);
        });

        test('clearing the displaced feature first, then pinning its photo for the other, reports each save once', async () => {
            // Boost holds imgA; `--turbo=imgA --boost=none` clears boost (saved first), then pins turbo.
            const stored: Record<string, string | null> = { boost: 'imgA', turbo: null };
            handlers['get-entry-pins'].mockImplementation(async () => ({ ...stored }));
            handlers['set-entry-pin'].mockImplementation(async (...args: unknown[]) => {
                const [, kind, , imageId] = args as [null, 'boost' | 'turbo', string, string | null];
                const other = kind === 'boost' ? 'turbo' : 'boost';
                stored[kind] = imageId;
                if (imageId !== null && stored[other] === imageId) stored[other] = null;
                return { success: true };
            });
            expect(await pinCmd('111', { turbo: 'imgA', boost: null })).toBe(true);
            expect(handlers['set-entry-pin'].mock.calls).toEqual([
                [null, 'boost', '111', null],
                [null, 'turbo', '111', 'imgA'],
            ]);
            expect(logger.__calls.map((c) => `${c.level}: ${String(c.msg)}`)).toEqual([
                'success: Cleared the boost pin on "Sunset"',
                'success: Pinned imgA for turbo on "Sunset"',
            ]);
            expect(stored).toEqual({ boost: null, turbo: 'imgA' });
        });

        test('says nothing when the save failed', async () => {
            handlers['set-entry-pin'].mockResolvedValue({ success: false, error: 'pin-write-failed' });
            expect(await pinCmd('111', { turbo: 'imgA' })).toBe(false);
            expect(msgsAt('info')).toEqual([]);
        });
    });

    test.each([
        [{ success: false, error: 'pin-cap-reached' }, /^Too many challenges already have pins\..*clear a pin/],
        [{ success: false, error: 'pin-write-failed' }, /^The settings file could not be written\. Try again\.$/],
        [{ success: false, error: 'invalid-args' }, /^Invalid challenge or image id\.$/],
        [{ success: false, error: 'something else' }, /^something else$/],
        [{ success: false }, /^Failed to pin for boost$/],
        [null, /^Failed to pin for boost$/],
    ])('a refused save %p is reported with its own reason and fails the command', async (result, text) => {
        handlers['set-entry-pin'].mockResolvedValue(result);
        expect(await pinCmd('111', { boost: 'imgA' })).toBe(false);
        expect(msgsAt('error')).toHaveLength(1);
        expect(msgsAt('error')[0]).toMatch(text);
        expect(msgsAt('success')).toEqual([]);
    });

    test('keeps going after one feature fails, and still fails overall', async () => {
        handlers['set-entry-pin'].mockResolvedValueOnce({ success: false, error: 'nope' });
        expect(await pinCmd('111', { boost: 'imgA', turbo: 'imgB' })).toBe(false);
        expect(handlers['set-entry-pin']).toHaveBeenCalledTimes(2);
        expect(msgsAt('success')).toEqual(['Pinned imgB for turbo on "Sunset"']);
    });

    test('a thrown handler is reported, never raised', async () => {
        handlers['set-entry-pin'].mockRejectedValue(new Error('boom'));
        expect(await pinCmd('111', { boost: 'imgA' })).toBe(false);
        expect(msgsAt('error')).toEqual(['Failed to pin: boom']);
        handlers['set-entry-pin'].mockRejectedValue('plain');
        expect(await pinCmd('111', { boost: 'imgA' })).toBe(false);
        expect(msgsAt('error').pop()).toBe('Failed to pin: plain');
    });

    test('pinning on an unknown challenge or while logged out changes nothing and fails', async () => {
        expect(await pinCmd('999', { boost: 'imgA' })).toBe(false);
        apiFactory.__isAuthenticated.mockReturnValue(false);
        expect(await pinCmd('111', { boost: 'imgA' })).toBe(false);
        expect(handlers['set-entry-pin']).not.toHaveBeenCalled();
    });
});
