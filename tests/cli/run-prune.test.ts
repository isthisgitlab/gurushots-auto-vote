/**
 * Unit tests for `run`'s stale-settings prune (commandHandlers.runRun): after
 * its cycle it makes its own active-list read and prunes through the same IPC
 * handler the renderer drives (cleanup-stale-challenge-setting — which holds
 * the mock-mode gate; in mock mode it prunes nothing and in real mode it
 * prunes the stale ids, covered at handler level in
 * tests/ipc/settings.handlers.test.ts). The gates mirror the renderer's: an
 * empty list, a prune-unsafe read and a failed read prune nothing; `start`
 * never prunes. The handler and middleware are mocked; the facade is asserted
 * to stay untouched (runRun never bypasses the handler).
 */

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: unknown; data?: unknown }[] = [];
    const rec = (level: string) => (msg: unknown, data?: unknown) => calls.push({ level, msg, data });
    const cat = {
        info: rec('info'),
        error: rec('error'),
        success: rec('success'),
        warning: rec('warning'),
        debug: rec('debug'),
        startOperation: rec('startOperation'),
        endOperation: rec('endOperation'),
    };
    return { __calls: calls, withCategory: jest.fn(() => cat) };
});

jest.mock('../../src/ts/settings', () => ({
    loadSettings: jest.fn(() => ({ app: { mock: true }, auth: { token: '' }, challenges: {} })),
    cleanupStaleChallengeSetting: jest.fn(() => true),
}));

jest.mock('../../src/ts/apiFactory', () => {
    const mw = {
        isAuthenticated: jest.fn(() => true),
        getActiveChallenges: jest.fn(),
        cliVote: jest.fn(),
        cliVoteManual: jest.fn(),
    };
    return { __mw: mw, getMiddleware: jest.fn(() => mw) };
});

jest.mock('../../src/ts/ipc/settings.handlers', () => {
    const cleanup = jest.fn(async () => ({ success: true as const }));
    const buildHandlers = jest.fn(() => ({ 'cleanup-stale-challenge-setting': cleanup }));
    return { __cleanup: cleanup, __buildHandlers: buildHandlers, buildHandlers, register: jest.fn() };
});

jest.mock('../../src/ts/scheduling/runScheduler', () => ({ createScheduler: jest.fn() }));
jest.mock('../../src/ts/dateFormat', () => ({ formatDateTime: jest.fn(() => 'NOW') }));
jest.mock('../../src/ts/services/auth', () => ({ clearTokenUnlessStayingLoggedIn: jest.fn() }));

import { invalid } from '../helpers/invalid';
import type { ConfigV2 } from '../../src/ts/types/config';
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(invalid<typeof loggerModule & { __calls: { level: string; msg: unknown }[] }>(loggerModule));
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as apiFactoryModule from '../../src/ts/apiFactory';
import type * as runSchedulerModule from '../../src/ts/scheduling/runScheduler';
import type * as commandHandlersModule from '../../src/ts/cli/commandHandlers';
import type * as votingModule from '../../src/ts/cli/commands/voting';
import type * as settingsHandlersModule from '../../src/ts/ipc/settings.handlers';
const { __mw: mw } = jest.mocked(
    require('../../src/ts/apiFactory') as typeof apiFactoryModule & {
        __mw: jest.Mocked<
            Pick<
                ReturnType<typeof apiFactoryModule.getMiddleware>,
                'isAuthenticated' | 'getActiveChallenges' | 'cliVote' | 'cliVoteManual'
            >
        >;
    },
);
const { createScheduler } = jest.mocked(require('../../src/ts/scheduling/runScheduler') as typeof runSchedulerModule);
// The settings-handler mock exposes both its built handler table and the
// builder itself, so `start` can be asserted to never even construct them.
type SettingsHandlersMock = {
    __cleanup: jest.MockedFunction<
        (
            event: unknown,
            activeChallengeIds: Array<string | number>,
        ) => Promise<{ success: true } | { success: false; error: string }>
    >;
    __buildHandlers: jest.MockedFunction<typeof settingsHandlersModule.buildHandlers>;
};
const settingsHandlers = invalid<SettingsHandlersMock>(require('../../src/ts/ipc/settings.handlers'));

// The rows↔handlers cycle initialises only rows-first, so load the rows first.
require('../../src/ts/cli/commandRows');
const { runRun } = require('../../src/ts/cli/commandHandlers') as typeof commandHandlersModule;
const { startContinuousVoting } = require('../../src/ts/cli/commands/voting') as typeof votingModule;

const config = (): ConfigV2 => invalid<ConfigV2>({ app: { mock: true }, auth: { token: '' }, challenges: {} });

beforeEach(() => {
    logger.__calls.length = 0;
    settingsHandlers.__buildHandlers.mockClear();
    settingsHandlers.__cleanup.mockClear();
    mw.isAuthenticated.mockReturnValue(true);
    mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'Sunset' }, { id: '222' }] }));
    mw.cliVote.mockResolvedValue({ success: true, challenges: [] });
    settings.loadSettings.mockReturnValue(config());
});

describe('runRun — the stale-settings prune', () => {
    test('a normal read prunes the active ids through the handler, never the facade', async () => {
        await expect(runRun([])).resolves.toBe(0);
        expect(mw.cliVote).toHaveBeenCalledWith(null);
        expect(settingsHandlers.__cleanup).toHaveBeenCalledWith(null, ['111', '222']);
        expect(settings.cleanupStaleChallengeSetting).not.toHaveBeenCalled();
    });

    test('an empty list prunes nothing', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [] }));
        await runRun([]);
        expect(settingsHandlers.__cleanup).not.toHaveBeenCalled();
    });

    test('a prune-unsafe read prunes nothing: absence from such a list is not "gone"', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111 }], pruneUnsafe: true }));
        await runRun([]);
        expect(settingsHandlers.__cleanup).not.toHaveBeenCalled();
    });

    test('a failed read (fetchFailed) prunes nothing', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [], fetchFailed: true }));
        await runRun([]);
        expect(settingsHandlers.__cleanup).not.toHaveBeenCalled();
        expect(
            logger.__calls.some((c) => c.level === 'debug' && String(c.msg).includes('Skipped stale-settings cleanup')),
        ).toBe(true);
    });

    test('a thrown read prunes nothing and `run` still exits 0', async () => {
        mw.getActiveChallenges.mockRejectedValue(new Error('offline'));
        await expect(runRun([])).resolves.toBe(0);
        expect(settingsHandlers.__cleanup).not.toHaveBeenCalled();
        expect(
            logger.__calls.some((c) => c.level === 'debug' && String(c.msg).includes('Skipped stale-settings cleanup')),
        ).toBe(true);
    });

    test('a thrown prune is best effort: the cycle already ran, and `run` exits 0', async () => {
        settingsHandlers.__cleanup.mockRejectedValueOnce(new Error('busy'));
        await expect(runRun([])).resolves.toBe(0);
        expect(settingsHandlers.__cleanup).toHaveBeenCalledTimes(1);
    });
});

describe('startContinuousVoting — never prunes', () => {
    beforeEach(() => {
        const scheduler = { start: jest.fn().mockResolvedValue(undefined), stop: jest.fn() };
        createScheduler.mockReturnValue(invalid(scheduler));
        jest.spyOn(process, 'on').mockImplementation((_sig, fn) => {
            void fn;
            return process;
        });
        jest.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('continuous mode never constructs the settings handlers, so it never prunes', async () => {
        await startContinuousVoting();
        expect(settingsHandlers.__buildHandlers).not.toHaveBeenCalled();
        expect(mw.getActiveChallenges).not.toHaveBeenCalled();
    });
});
