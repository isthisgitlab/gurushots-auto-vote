/**
 * Unit tests for the CLI parity commands: the one-shot actions
 * (boost / turbo / fill), single-challenge manual vote, logout, and
 * check-updates. These commands are thin wrappers that reuse the GUI's
 * code paths — the middleware's applyBoost (which honors the mock/real
 * API swap) and the IPC handlers — so the tests assert the wiring: auth
 * guard, challenge resolution, correct dispatch + args, and success/error
 * reporting. The handlers, the middleware, the update checker, and the
 * logger are all mocked; the real-strategy applyBoost is mocked purely to prove the CLI
 * never bypasses the factory to reach the real API surface.
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
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        progress: jest.fn(),
    };
    return { __calls: calls, withCategory: jest.fn(() => cat), CATEGORIES: {} };
});

jest.mock('../../src/ts/settings', () => ({
    getSetting: jest.fn(() => 'tok'),
    setSetting: jest.fn(() => true),
    loadSettings: jest.fn(() => ({ app: { mock: true }, auth: { token: 'tok' } })),
    getEffectiveSetting: jest.fn(),
    flushPendingWrites: jest.fn(async () => {}),
    forgetOpenChallengeIds: jest.fn(),
    getEnvironmentInfo: jest.fn(() => ({ defaultMock: true })),
}));

jest.mock('../../src/ts/apiFactory', () => {
    const getActiveChallenges = jest.fn();
    const isAuthenticated = jest.fn(() => true);
    const applyBoost = jest.fn();
    const cliVote = jest.fn();
    const cliVoteManual = jest.fn();
    return {
        __getActiveChallenges: getActiveChallenges,
        __isAuthenticated: isAuthenticated,
        __applyBoost: applyBoost,
        __cliVote: cliVote,
        __cliVoteManual: cliVoteManual,
        getMiddleware: jest.fn(() => ({ isAuthenticated, getActiveChallenges, applyBoost, cliVote, cliVoteManual })),
        getApiStrategy: jest.fn(),
        refreshApi: jest.fn(),
    };
});

// Mocked ONLY to prove the CLI never reaches the real API module directly —
// in mock mode a direct import would fire a real boost request (the bug this
// guards against). Every boost must flow through the middleware above.
jest.mock('../../src/ts/strategies/real/applyBoost', () => ({ applyBoost: jest.fn() }));

jest.mock('../../src/ts/ipc/actions.handlers', () => {
    const handlers = {
        'apply-boost-to-entry': jest.fn(),
        'apply-turbo-to-entry': jest.fn(),
        'play-auto-turbo': jest.fn(),
        'fill-challenge-now': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

jest.mock('../../src/ts/ipc/currency.handlers', () => {
    const handlers = {
        'get-swap-backs': jest.fn(),
        'swap-back-entry-photo': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

jest.mock('../../src/ts/ipc/voting.handlers', () => {
    const handlers = { 'vote-on-challenge-manual': jest.fn() };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

jest.mock('../../src/ts/scheduling/runScheduler', () => ({ createScheduler: jest.fn() }));

jest.mock('../../src/ts/services/UpdateChecker', () => ({
    checkForUpdates: jest.fn(),
    getReleasesUrl: jest.fn(() => 'https://github.com/owner/repo/releases/latest'),
}));

import { invalid } from '../helpers/invalid';
import type * as actionHandlersModule from '../../src/ts/cli/actionHandlers';
// The rows↔handlers cycle initialises only rows-first (commandRows reads the handlers'
// exports at module scope), so load the rows before reaching for their handlers.
require('../../src/ts/cli/commandRows');
const { runTurbo, runSwapBack } = require('../../src/ts/cli/actionHandlers') as typeof actionHandlersModule;
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(
    invalid<typeof loggerModule & { __calls: { level: string; msg: unknown; data?: unknown }[] }>(loggerModule),
);
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
// The middleware whose methods the factory mock exposes as __-prefixed jest.fns.
type Middleware = ReturnType<typeof apiFactoryModule.getMiddleware>;
const apiFactory = jest.mocked(
    invalid<
        typeof apiFactoryModule & {
            __getActiveChallenges: jest.MockedFunction<Middleware['getActiveChallenges']>;
            __isAuthenticated: jest.MockedFunction<Middleware['isAuthenticated']>;
            __applyBoost: jest.MockedFunction<Middleware['applyBoost']>;
            __cliVote: jest.MockedFunction<Middleware['cliVote']>;
            __cliVoteManual: jest.MockedFunction<Middleware['cliVoteManual']>;
        }
    >(apiFactoryModule),
);
import boostApiModule = require('../../src/ts/strategies/real/applyBoost');
const boostApi = jest.mocked(boostApiModule);
// The handler-module mocks expose their jest.fn table for the assertions.
type HandlersMock<M extends { buildHandlers: (...args: never[]) => object }> = {
    __handlers: jest.Mocked<ReturnType<M['buildHandlers']>>;
};
const actionsHandlers = invalid<HandlersMock<typeof actionsHandlersModule>>(
    require('../../src/ts/ipc/actions.handlers'),
).__handlers;
const currencyHandlers = invalid<HandlersMock<typeof currencyHandlersModule>>(
    require('../../src/ts/ipc/currency.handlers'),
).__handlers;
const votingHandlers = invalid<HandlersMock<typeof votingHandlersModule>>(
    require('../../src/ts/ipc/voting.handlers'),
).__handlers;
import updateCheckerModule = require('../../src/ts/services/UpdateChecker');
const updateChecker = jest.mocked(updateCheckerModule);
import type * as actionsModule from '../../src/ts/cli/commands/actions';
import type * as submitModule from '../../src/ts/cli/commands/submit';
import type * as actionsHandlersModule from '../../src/ts/ipc/actions.handlers';
import type * as currencyHandlersModule from '../../src/ts/ipc/currency.handlers';
import type * as votingHandlersModule from '../../src/ts/ipc/voting.handlers';
import type * as votingModule from '../../src/ts/cli/commands/voting';
import type * as authModule from '../../src/ts/cli/commands/auth';
import type * as updateModule from '../../src/ts/cli/commands/update';

const { boostChallenge, turboChallenge, SWAP_BACK_USAGE } =
    require('../../src/ts/cli/commands/actions') as typeof actionsModule;
const { fillChallenge } = require('../../src/ts/cli/commands/submit') as typeof submitModule;
const { voteChallengeManual, runVotingCycle } = require('../../src/ts/cli/commands/voting') as typeof votingModule;
const { handleLogout } = require('../../src/ts/cli/commands/auth') as typeof authModule;
const { checkUpdates } = require('../../src/ts/cli/commands/update') as typeof updateModule;

const msgsAt = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const allMsgs = () => logger.__calls.map((c) => String(c.msg));
const contains = (arr: string[], sub: string) => arr.some((s) => s.includes(sub));

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
    apiFactory.__isAuthenticated.mockReturnValue(true);
    apiFactory.__getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'Sunset' }] }));
    settings.getSetting.mockReturnValue('tok');
});

describe('CLI boost command', () => {
    test('no --image: routes through the middleware applyBoost (resolves boostImageIndex) and reports success', async () => {
        apiFactory.__applyBoost.mockResolvedValue(invalid({ ok: true }));

        await boostChallenge('111', {});

        // Middleware injects the token itself — the CLI passes only the challenge.
        expect(apiFactory.__applyBoost).toHaveBeenCalledWith({ id: 111, title: 'Sunset' });
        expect(actionsHandlers['apply-boost-to-entry']).not.toHaveBeenCalled();
        expect(contains(msgsAt('success'), 'Sunset')).toBe(true);
    });

    test('never bypasses the factory to reach the real-strategy applyBoost (mock-mode safety)', async () => {
        apiFactory.__applyBoost.mockResolvedValue(invalid({ ok: true }));

        await boostChallenge('111', {});

        expect(boostApi.applyBoost).not.toHaveBeenCalled();
        expect(apiFactory.__applyBoost).toHaveBeenCalledTimes(1);
    });

    test('--image routes to the apply-boost-to-entry handler with the explicit id', async () => {
        actionsHandlers['apply-boost-to-entry'].mockResolvedValue(invalid({ success: true }));

        await boostChallenge('111', { imageId: 'img9' });

        expect(actionsHandlers['apply-boost-to-entry']).toHaveBeenCalledWith(null, '111', 'img9');
        expect(apiFactory.__applyBoost).not.toHaveBeenCalled();
        expect(contains(msgsAt('success'), 'img9')).toBe(true);
    });

    test('a challenge-data-incomplete handler error reads as words, never the raw code', async () => {
        // The handlers re-read the challenge themselves; the CLI words their refusal.
        actionsHandlers['apply-boost-to-entry'].mockResolvedValue({
            success: false,
            error: 'challenge-data-incomplete',
        });

        await boostChallenge('111', { imageId: 'img9' });

        expect(contains(msgsAt('error'), "challenge's data cannot be read")).toBe(true);
        expect(contains(allMsgs(), 'challenge-data-incomplete')).toBe(false);
    });

    test('a null/failed boost is reported as an error', async () => {
        apiFactory.__applyBoost.mockResolvedValue(null);

        await boostChallenge('111', {});

        expect(contains(msgsAt('error'), 'Failed to apply boost')).toBe(true);
        // The CLI is where the flag exists.
        expect(contains(msgsAt('error'), 'pass --image=<id>')).toBe(true);
    });

    test('not authenticated: does not boost, prompts to login', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);

        await boostChallenge('111', {});

        expect(apiFactory.__applyBoost).not.toHaveBeenCalled();
        expect(apiFactory.__getActiveChallenges).not.toHaveBeenCalled();
        expect(contains(allMsgs(), 'Run: login')).toBe(true);
    });

    test('unknown challenge: errors without dispatching', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [] });

        await boostChallenge('999', {});

        expect(apiFactory.__applyBoost).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'not found')).toBe(true);
    });

    test('a marked challenge: worded refusal, never the raw code, without dispatching', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({ challenges: [{ id: 111, title: 'Sunset', dataIssues: ['close_time'] }] }),
        );

        await boostChallenge('111', {});

        expect(apiFactory.__applyBoost).not.toHaveBeenCalled();
        expect(actionsHandlers['apply-boost-to-entry']).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'challenge data cannot be read')).toBe(true);
        expect(contains(allMsgs(), 'dataIssues')).toBe(false);
    });

    test('a challenge lost by a prune-unsafe read refuses as unreadable, like every channel', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [], pruneUnsafe: true });

        await boostChallenge('999', {});

        expect(apiFactory.__applyBoost).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'challenge data cannot be read')).toBe(true);
    });

    test('finds the challenge when the API returns string ids', async () => {
        // Regression companion to findActiveChallenge: the live list may
        // carry ids as strings; the lookup must still match.
        apiFactory.__getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: '111', title: 'Sunset' }] }));
        apiFactory.__applyBoost.mockResolvedValue(invalid({ ok: true }));

        await boostChallenge(invalid(111), {});

        expect(apiFactory.__applyBoost).toHaveBeenCalledWith({ id: '111', title: 'Sunset' });
        expect(contains(msgsAt('success'), 'Sunset')).toBe(true);
    });
});

describe('CLI turbo command', () => {
    test('delegates to play-auto-turbo with the resolved title and reports success', async () => {
        actionsHandlers['play-auto-turbo'].mockResolvedValue(invalid({ success: true }));

        await expect(turboChallenge('111')).resolves.toBe(true);

        expect(actionsHandlers['play-auto-turbo']).toHaveBeenCalledWith(null, '111', 'Sunset');
        expect(contains(msgsAt('success'), 'Sunset')).toBe(true);
    });

    test('a won Turbo is not replayed: the apply command is named, exit 1, nothing played', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({ challenges: [{ id: 111, title: 'Sunset', member: { turbo: { state: 'WON' } } }] }),
        );

        await expect(runTurbo(['--challenge=111'])).resolves.toBe(1);

        expect(
            contains(
                msgsAt('error'),
                'The Turbo on "Sunset" is already won. Apply it to a photo: turbo --challenge=111 --image=<photo id> (challenges --challenge=<id> lists the photo ids).',
            ),
        ).toBe(true);
        expect(actionsHandlers['play-auto-turbo']).not.toHaveBeenCalled();
        expect(actionsHandlers['apply-turbo-to-entry']).not.toHaveBeenCalled();
    });

    test('a won Turbo with --image still applies to the named photo', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue(
            invalid({ challenges: [{ id: 111, title: 'Sunset', member: { turbo: { state: 'WON' } } }] }),
        );
        actionsHandlers['apply-turbo-to-entry'].mockResolvedValue(invalid({ success: true }));

        await expect(runTurbo(['--challenge=111', '--image=img9'])).resolves.toBe(0);

        expect(actionsHandlers['apply-turbo-to-entry']).toHaveBeenCalledWith(null, '111', 'img9');
        expect(actionsHandlers['play-auto-turbo']).not.toHaveBeenCalled();
    });

    test('surfaces the handler error message and exits 1', async () => {
        actionsHandlers['play-auto-turbo'].mockResolvedValue({
            success: false,
            error: 'Turbo not playable (state=TIMER)',
        });

        await expect(turboChallenge('111')).resolves.toBe(false);

        expect(contains(msgsAt('error'), 'Turbo not playable')).toBe(true);
    });

    test('--image applies a won Turbo through apply-turbo-to-entry and exits 0', async () => {
        actionsHandlers['apply-turbo-to-entry'].mockResolvedValue(invalid({ success: true }));

        await expect(turboChallenge('111', { imageId: 'img9' })).resolves.toBe(true);

        expect(actionsHandlers['apply-turbo-to-entry']).toHaveBeenCalledWith(null, '111', 'img9');
        expect(actionsHandlers['play-auto-turbo']).not.toHaveBeenCalled();
        expect(contains(msgsAt('success'), 'img9')).toBe(true);
    });

    test('--image on a failed result surfaces the error and exits 1', async () => {
        actionsHandlers['apply-turbo-to-entry'].mockResolvedValue({
            success: false,
            error: 'Failed to apply turbo',
        });

        await expect(turboChallenge('111', { imageId: 'img9' })).resolves.toBe(false);

        expect(contains(msgsAt('error'), 'Failed to apply turbo')).toBe(true);
    });

    test('an error string carrying terminal control codes is stripped before printing', async () => {
        const esc = String.fromCharCode(27);
        actionsHandlers['apply-turbo-to-entry'].mockResolvedValue({
            success: false,
            error: `Turbo ${esc}[31mrejected${esc}[0m by the server`,
        });

        await expect(turboChallenge('111', { imageId: 'img9' })).resolves.toBe(false);

        const errors = msgsAt('error');
        expect(contains(errors, 'Turbo rejected by the server')).toBe(true);
        expect(errors.some((s) => s.includes(esc))).toBe(false);
    });

    test('an unknown id exits 1', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [] });

        await expect(turboChallenge('999')).resolves.toBe(false);

        expect(actionsHandlers['play-auto-turbo']).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'not found')).toBe(true);
    });

    test('a thrown handler exits 1', async () => {
        actionsHandlers['play-auto-turbo'].mockRejectedValue(new Error('boom'));

        await expect(turboChallenge('111')).resolves.toBe(false);
        expect(contains(msgsAt('error'), 'Failed to play turbo')).toBe(true);
    });

    test('not authenticated exits 1', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);

        await expect(turboChallenge('111')).resolves.toBe(false);
        expect(contains(allMsgs(), 'Run: login')).toBe(true);
    });
});

describe('CLI turbo command — strict --image flag', () => {
    test.each([
        ['a typo flag', ['--images=img9']],
        ['a repeated flag', ['--image=img9', '--image=img8']],
        ['a space-form flag', ['--image', 'img9']],
        ['a bare --yes', ['--yes']],
    ])('%s prints the usage and exits 1', async (_label, rest) => {
        await expect(runTurbo(['--challenge=111', ...rest])).resolves.toBe(1);
        expect(contains(msgsAt('error'), 'Wrong arguments')).toBe(true);
        expect(contains(msgsAt('info'), 'Usage: turbo --challenge=<id> [--image=<id>]')).toBe(true);
        expect(actionsHandlers['apply-turbo-to-entry']).not.toHaveBeenCalled();
        expect(actionsHandlers['play-auto-turbo']).not.toHaveBeenCalled();
    });

    test('an empty --image= names what is missing and exits 1', async () => {
        await expect(runTurbo(['--challenge=111', '--image='])).resolves.toBe(1);
        expect(contains(msgsAt('error'), '--image needs a photo id')).toBe(true);
        expect(actionsHandlers['play-auto-turbo']).not.toHaveBeenCalled();
    });

    test('runTurbo passes --image through and exits 0 on success, 1 on failure', async () => {
        actionsHandlers['apply-turbo-to-entry'].mockResolvedValue(invalid({ success: true }));
        await expect(runTurbo(['--challenge=111', '--image=img9'])).resolves.toBe(0);

        actionsHandlers['apply-turbo-to-entry'].mockResolvedValue({ success: false, error: 'nope' });
        await expect(runTurbo(['--challenge=111', '--image=img9'])).resolves.toBe(1);

        expect(actionsHandlers['apply-turbo-to-entry']).toHaveBeenCalledTimes(2);
        expect(actionsHandlers['apply-turbo-to-entry']).toHaveBeenNthCalledWith(1, null, '111', 'img9');
    });

    test.each([
        ['both in the = form', ['--challenge=111', '--challenge=222']],
        ['both in the space form', ['--challenge', '111', '--challenge', '222']],
        ['the forms mixed', ['--challenge=111', '--challenge', '222']],
    ])('a repeated --challenge (%s) is a usage error before anything runs', async (_label, argv) => {
        await expect(runTurbo(argv)).resolves.toBe(1);
        expect(contains(msgsAt('error'), 'Wrong arguments')).toBe(true);
        expect(contains(msgsAt('info'), 'Usage: turbo --challenge=<id> [--image=<id>]')).toBe(true);
        expect(actionsHandlers['play-auto-turbo']).not.toHaveBeenCalled();
        expect(actionsHandlers['apply-turbo-to-entry']).not.toHaveBeenCalled();
    });
});

describe('CLI swap-back command — strict --challenge flag', () => {
    test.each([
        ['both in the = form', ['--challenge=111', '--challenge=222']],
        ['both in the space form', ['--challenge', '111', '--challenge', '222']],
        ['the forms mixed', ['--challenge=111', '--challenge', '222']],
    ])('a repeated --challenge (%s) is a usage error before anything runs', async (_label, argv) => {
        await expect(runSwapBack(argv)).resolves.toBe(1);
        expect(contains(msgsAt('error'), 'Wrong arguments')).toBe(true);
        expect(contains(msgsAt('info'), SWAP_BACK_USAGE)).toBe(true);
        expect(currencyHandlers['get-swap-backs']).not.toHaveBeenCalled();
        expect(currencyHandlers['swap-back-entry-photo']).not.toHaveBeenCalled();
    });
});

describe('CLI fill command', () => {
    test('default mode "one"', async () => {
        actionsHandlers['fill-challenge-now'].mockResolvedValue(invalid({ success: true, submitted: 1, skipped: 0 }));

        await fillChallenge('111', {});

        expect(actionsHandlers['fill-challenge-now']).toHaveBeenCalledWith(null, '111', 'one');
        expect(contains(msgsAt('success'), 'submitted 1')).toBe(true);
    });

    test('--all maps to mode "all"', async () => {
        actionsHandlers['fill-challenge-now'].mockResolvedValue(invalid({ success: true, submitted: 2, skipped: 1 }));

        await fillChallenge('111', { all: true });

        expect(actionsHandlers['fill-challenge-now']).toHaveBeenCalledWith(null, '111', 'all');
    });

    test('failure surfaces the handler error', async () => {
        actionsHandlers['fill-challenge-now'].mockResolvedValue({
            success: false,
            error: 'Challenge no longer active',
        });

        await fillChallenge('111', {});

        expect(contains(msgsAt('error'), 'Challenge no longer active')).toBe(true);
    });
});

describe('CLI vote --challenge (single-challenge manual)', () => {
    test('resolves the title then calls vote-on-challenge-manual', async () => {
        votingHandlers['vote-on-challenge-manual'].mockResolvedValue({
            success: true,
            message: 'Successfully voted on challenge "Sunset" manually',
        });

        const result = await voteChallengeManual('111');

        expect(votingHandlers['vote-on-challenge-manual']).toHaveBeenCalledWith(null, '111', 'Sunset');
        expect(result.success).toBe(true);
        expect(contains(msgsAt('success'), 'Sunset')).toBe(true);
    });

    test('unknown challenge: does not call the handler', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [] });

        const result = await voteChallengeManual('999');

        expect(votingHandlers['vote-on-challenge-manual']).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(contains(msgsAt('error'), 'not found')).toBe(true);
    });

    test('not authenticated: prompts to login, no handler call', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);

        const result = await voteChallengeManual('111');

        expect(votingHandlers['vote-on-challenge-manual']).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(contains(allMsgs(), 'Run: login')).toBe(true);
    });
});

describe('CLI runVotingCycle — challenges gated on success', () => {
    // The scheduler reuses the returned `challenges` as the next cycle's
    // prefetched list. On an outage the orchestrator resolves to
    // `{ success: false, challenges: [] }`; that empty list must NOT be handed
    // back as prefetched — it would look like "nothing to vote on" and arm a
    // full normal-cadence wait instead of the short offline-retry cap. Gating
    // on success (mirroring the GUI's AutovoteContext wrapper) returns null so
    // the scheduler re-fetches and detects fetchFailed. This is the CLI half of
    // the network-outage badge/recovery path.
    test('a failed strategy cycle returns challenges: null even when the list is []', async () => {
        apiFactory.__cliVote.mockResolvedValue({ success: false, error: 'offline', challenges: [] });

        const result = await runVotingCycle(1);

        expect(result).toEqual({ success: false, challenges: null });
    });

    test('a failed strategy cycle returns challenges: null even with a non-empty list', async () => {
        apiFactory.__cliVote.mockResolvedValue(invalid({ success: false, challenges: [{ id: 1 }] }));

        const result = await runVotingCycle(1);

        expect(result).toEqual({ success: false, challenges: null });
    });

    test('a successful strategy cycle hands its fetched list back as prefetched', async () => {
        const challenges = [{ id: 111, title: 'Sunset' }];
        apiFactory.__cliVote.mockResolvedValue(invalid({ success: true, challenges }));

        const result = await runVotingCycle(1);

        expect(result).toEqual({ success: true, challenges });
    });

    test('a successful cycle with a non-array list still yields null (nothing to reuse)', async () => {
        apiFactory.__cliVote.mockResolvedValue({ success: true });

        const result = await runVotingCycle(1);

        expect(result).toEqual({ success: true, challenges: null });
    });

    test('not authenticated: returns failure with a null list, never calls the strategy', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);

        const result = await runVotingCycle(1);

        expect(apiFactory.__cliVote).not.toHaveBeenCalled();
        expect(result).toEqual({ success: false, challenges: null });
    });
});

describe('CLI logout command', () => {
    test('clears the stored token when one is present, and returns the mode to the environment default', async () => {
        settings.getSetting.mockReturnValue('tok');

        await handleLogout();

        expect(settings.setSetting).toHaveBeenCalledWith('token', '');
        expect(settings.setSetting).toHaveBeenCalledWith('mock', true);
        expect(contains(msgsAt('success'), 'Logged out')).toBe(true);
    });

    test('reports already-logged-out when no token was set', async () => {
        settings.getSetting.mockReturnValue('');

        await handleLogout();

        expect(settings.setSetting).toHaveBeenCalledWith('token', '');
        expect(contains(allMsgs(), 'Already logged out')).toBe(true);
    });
});

describe('CLI check-updates command', () => {
    test('reports up to date when no newer release', async () => {
        updateChecker.checkForUpdates.mockResolvedValue(invalid({ updateAvailable: false }));

        await checkUpdates();

        expect(contains(msgsAt('success'), 'up to date')).toBe(true);
    });

    test('prints the version and download URL when an update is available', async () => {
        updateChecker.checkForUpdates.mockResolvedValue(
            invalid({
                updateAvailable: true,
                version: '2.0.0',
                downloadUrl: 'https://example.com/app.dmg',
                releaseDate: '2026-01-01T00:00:00Z',
                isPrerelease: false,
            }),
        );

        await checkUpdates();

        expect(contains(allMsgs(), '2.0.0')).toBe(true);
        expect(contains(allMsgs(), 'https://example.com/app.dmg')).toBe(true);
    });

    test('on error, prints the failure and the releases URL', async () => {
        updateChecker.checkForUpdates.mockResolvedValue(invalid({ error: 'rate limited' }));

        await checkUpdates();

        expect(contains(msgsAt('error'), 'rate limited')).toBe(true);
        expect(contains(allMsgs(), 'releases/latest')).toBe(true);
    });

    test('tells the user it does not self-update when an update is available', async () => {
        updateChecker.checkForUpdates.mockResolvedValue(
            invalid({
                updateAvailable: true,
                version: '2.0.0',
                downloadUrl: 'https://example.com/app.dmg',
            }),
        );

        await checkUpdates();

        expect(contains(allMsgs(), 'does not self-update')).toBe(true);
    });

    test('a thrown checkForUpdates is caught and reported (not a crash)', async () => {
        updateChecker.checkForUpdates.mockRejectedValue(new Error('socket hang up'));

        await expect(checkUpdates()).resolves.toBeUndefined();
        expect(contains(msgsAt('error'), 'socket hang up')).toBe(true);
        expect(contains(allMsgs(), 'releases/latest')).toBe(true);
    });
});

// Error/edge paths added when hardening the commands: fetch failures, the
// explicit-image failure branch, and the defensive try/catch around each
// dispatch (a thrown handler must degrade to a clean per-command message,
// never an unhandled rejection).
describe('CLI actions — error paths', () => {
    test('boost: a failed challenge fetch is reported, nothing dispatched', async () => {
        apiFactory.__getActiveChallenges.mockRejectedValue(new Error('network down'));

        await boostChallenge('111', {});

        expect(apiFactory.__applyBoost).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'Failed to fetch challenges')).toBe(true);
    });

    test('boost --image: handler failure surfaces the error', async () => {
        actionsHandlers['apply-boost-to-entry'].mockResolvedValue({ success: false, error: 'entry not found' });

        await boostChallenge('111', { imageId: 'imgX' });

        expect(contains(msgsAt('error'), 'entry not found')).toBe(true);
    });

    test('boost: a thrown applyBoost is caught', async () => {
        apiFactory.__applyBoost.mockRejectedValue(new Error('boom'));

        await expect(boostChallenge('111', {})).resolves.toBeUndefined();
        expect(contains(msgsAt('error'), 'Failed to apply boost')).toBe(true);
    });

    test('turbo: a thrown handler is caught', async () => {
        actionsHandlers['play-auto-turbo'].mockRejectedValue(new Error('boom'));

        await expect(turboChallenge('111')).resolves.toBe(false);
        expect(contains(msgsAt('error'), 'Failed to play turbo')).toBe(true);
    });

    test('fill: a thrown handler is caught', async () => {
        actionsHandlers['fill-challenge-now'].mockRejectedValue(new Error('boom'));

        await expect(fillChallenge('111', {})).resolves.toBe(1);
        expect(contains(msgsAt('error'), 'Failed to submit photos')).toBe(true);
    });

    test('vote: handler failure is surfaced and returned', async () => {
        votingHandlers['vote-on-challenge-manual'].mockResolvedValue({ success: false, error: 'no vote images' });

        const result = await voteChallengeManual('111');

        expect(result.success).toBe(false);
        expect(contains(msgsAt('error'), 'no vote images')).toBe(true);
    });

    test('vote: a thrown handler is caught and returns a failure result', async () => {
        votingHandlers['vote-on-challenge-manual'].mockRejectedValue(new Error('boom'));

        const result = await voteChallengeManual('111');

        expect(result.success).toBe(false);
        expect(contains(msgsAt('error'), 'Failed to vote')).toBe(true);
    });

    test('vote: a failed challenge fetch reports an error without dispatching', async () => {
        apiFactory.__getActiveChallenges.mockRejectedValue(new Error('network down'));

        const result = await voteChallengeManual('111');

        expect(votingHandlers['vote-on-challenge-manual']).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(contains(msgsAt('error'), 'Failed to fetch challenges')).toBe(true);
    });
});
