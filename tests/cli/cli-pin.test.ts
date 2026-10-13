/**
 * Unit tests for the CLI `pin` command: it reads or writes a challenge's pinned
 * Boost/Turbo photos through the same `get-entry-pins` / `set-entry-pin`
 * handlers the GUI uses, and warns (but still saves) for a photo that is not one
 * of the challenge's current entries.
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
import type * as actionsModule from '../../src/ts/cli/commands/actions';
type HandlerTable = Record<string, jest.Mock<Promise<unknown>, unknown[]>>;
const handlers = invalid<{ __handlers: HandlerTable }>(require('../../src/ts/ipc/settings.handlers')).__handlers;
const { pinCmd } = require('../../src/ts/cli/commands/actions') as typeof actionsModule;

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
    test('with no flags lists the current pins and saves nothing', async () => {
        expect(await pinCmd('111')).toBe(true);
        expect(handlers['get-entry-pins']).toHaveBeenCalledWith(null, '111');
        expect(handlers['set-entry-pin']).not.toHaveBeenCalled();
        expect(msgsAt('info')).toEqual(['Pins on "Sunset":', '  Boost: imgA', '  Turbo: none']);
    });

    test('a failed read of the pins lists none', async () => {
        handlers['get-entry-pins'].mockResolvedValue(null);
        expect(await pinCmd('111')).toBe(true);
        expect(msgsAt('info')).toEqual(['Pins on "Sunset":', '  Boost: none', '  Turbo: none']);
    });

    test('pins one entry for one feature through the shared handler', async () => {
        expect(await pinCmd('111', { boost: 'imgB' })).toBe(true);
        expect(handlers['set-entry-pin']).toHaveBeenCalledTimes(1);
        expect(handlers['set-entry-pin']).toHaveBeenCalledWith(null, 'boost', '111', 'imgB');
        expect(msgsAt('success')).toEqual(['Pinned imgB for boost on "Sunset"']);
        expect(msgsAt('warning')).toEqual([]);
    });

    test('pins both features, and null clears a pin', async () => {
        expect(await pinCmd('111', { boost: 'imgA', turbo: null })).toBe(true);
        expect(handlers['set-entry-pin']).toHaveBeenNthCalledWith(1, null, 'boost', '111', 'imgA');
        expect(handlers['set-entry-pin']).toHaveBeenNthCalledWith(2, null, 'turbo', '111', null);
        expect(msgsAt('success')).toEqual(['Pinned imgA for boost on "Sunset"', 'Cleared the turbo pin on "Sunset"']);
    });

    test('an id that is not a current entry is saved with a warning that lists the real ones', async () => {
        expect(await pinCmd('111', { turbo: 'zzz' })).toBe(true);
        expect(handlers['set-entry-pin']).toHaveBeenCalledWith(null, 'turbo', '111', 'zzz');
        expect(msgsAt('warning')).toEqual([
            'zzz is not one of the entries in "Sunset" (imgA, imgB) — pinning it anyway.',
        ]);
    });

    test('a challenge without entries lists none in the warning', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'Sunset' }] }));
        expect(await pinCmd('111', { boost: 'zzz' })).toBe(true);
        expect(msgsAt('warning')).toEqual(['zzz is not one of the entries in "Sunset" (none) — pinning it anyway.']);
    });

    test.each([
        [{ success: false, error: 'The pin could not be saved' }, 'The pin could not be saved'],
        [{ success: false, error: 'invalid-args' }, undefined],
        [{ success: false }, 'Failed to pin for boost'],
        [null, 'Failed to pin for boost'],
    ])('a refused save %p is reported and fails the command', async (result, text) => {
        handlers['set-entry-pin'].mockResolvedValue(result);
        expect(await pinCmd('111', { boost: 'imgA' })).toBe(false);
        expect(msgsAt('error')).toHaveLength(1);
        if (text) expect(msgsAt('error')).toEqual([text]);
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

    test('an unknown challenge or a logged-out user changes nothing and fails', async () => {
        expect(await pinCmd('999', { boost: 'imgA' })).toBe(false);
        apiFactory.__isAuthenticated.mockReturnValue(false);
        expect(await pinCmd('111', { boost: 'imgA' })).toBe(false);
        expect(handlers['set-entry-pin']).not.toHaveBeenCalled();
    });
});
