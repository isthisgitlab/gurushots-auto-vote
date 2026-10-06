/**
 * Tests for actions.handlers — direct user-triggered IPC actions.
 * Covers: get-active-challenges delegation, authenticate (mock + real
 * paths), play-auto-turbo (in-flight guard, manual-bypass cooldown,
 * mini-game result reshape), apply-turbo-to-entry (redacted-error
 * sanitisation), fill-challenge-now (mode normalisation), and
 * apply-boost-to-entry (auth guard + success/failure).
 *
 * Note: jest.mock() at module top works for both top-level and lazy
 * `require` calls inside handlers — Jest hoists the mock registration
 * before any `require` resolves.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/services/auth');
jest.mock('../../src/ts/services/VotingLogic');
jest.mock('../../src/ts/services/autoFill');
jest.mock('../../src/ts/windows/quitGuard', () => ({ rememberChallenges: jest.fn() }));

import type { IpcMain } from 'electron';
import { invalid } from '../helpers/invalid';
import { claimTurboRun, releaseTurboRun } from '../../src/ts/services/turboRunLock';
import { registerMissionNeeds } from '../../src/ts/services/missions';
import { clearOpenChallenges } from '../../src/ts/services/openChallengeCache';
import { isPlainObject } from '../../src/ts/plainObject';

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import authModule = require('../../src/ts/services/auth');
const auth = jest.mocked(authModule);
import votingLogicModule = require('../../src/ts/services/VotingLogic');
const votingLogic = jest.mocked(votingLogicModule);
import autoFillModule = require('../../src/ts/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import type * as quitGuardModule from '../../src/ts/windows/quitGuard';
import type * as logCategoriesModule from '../helpers/logCategories';
import type * as actions_handlersModule from '../../src/ts/ipc/actions.handlers';
import type * as autoClaimModule from '../../src/ts/services/autoClaim';
const { rememberChallenges } = jest.mocked(require('../../src/ts/windows/quitGuard') as typeof quitGuardModule);
const { logCategories } = require('../helpers/logCategories') as typeof logCategoriesModule;

// The handler routes auth through the factory surfaces + the shared
// extractAuthResult normalizer; exercise the real normalizer rather than a stub
// so these tests pin the actual token-key handling.
const { extractAuthResult: realExtractAuthResult } =
    jest.requireActual<typeof import('../../src/ts/services/auth')>('../../src/ts/services/auth');

const NOW = () => Math.floor(Date.now() / 1000);

const setToken = (token: string | null) => {
    settings.loadSettings = jest.fn().mockReturnValue({ token });
};

const stubStrategy = <O extends object = {}>(overrides: O = invalid<O>({})) => {
    const strategy = {
        getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [] }),
        applyTurbo: jest.fn(),
        applyBoostToEntry: jest.fn(),
        getEligiblePhotos: jest.fn(),
        submitToChallenge: jest.fn(),
        runTurboMiniGame: jest.fn(),
        getCurrentMemberProfile: jest.fn(),
        ...overrides,
    };
    apiFactory.getApiStrategy = jest.fn().mockReturnValue(strategy);
    return strategy;
};

const stubAuthGuardOk = () => {
    auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
};

const stubAuthGuardFail = () => {
    auth.requireAuthToken = jest
        .fn()
        .mockReturnValue({ ok: false, response: { success: false, error: 'No authentication token found' } });
};

// What the Chosen Photos settings resolve to, as the join resolves them: the challenge's own
// list first, then a matching rule, then the global default; plus who saved it and who is signed in.
const mockChosenSettings = ({
    own = {},
    inherited = [],
    rule = null,
    savedBy = '',
    current = 'member-1',
}: {
    own?: Record<string, string[]>;
    inherited?: string[];
    rule?: { value: string[] } | null;
    savedBy?: string;
    current?: string | null;
}) => {
    jest.mocked(settings.getChallengeOverride).mockImplementation(
        invalid((key: string, id: string) => (key === 'chosenPhotos' ? (own[id] ?? null) : null)),
    );
    jest.mocked(settings.resolveRuleSetting).mockReturnValue(invalid(rule));
    jest.mocked(settings.getEffectiveSetting).mockReturnValue(invalid(inherited));
    jest.mocked(settings.getSetting).mockReturnValue(invalid(savedBy));
    jest.mocked(autoFill.peekMemberId).mockReturnValue(current);
};

// Note on module-scoped state: turboRunLock keeps its set at module scope.
// The handler's try/finally always clears its slot, so as
// long as every test awaits the calls it makes, the Set stays empty between
// tests — no jest.resetModules() needed (and it would defeat module-top
// jest.mock() bindings anyway by giving the handler fresh mock instances).
const { buildHandlers } = require('../../src/ts/ipc/actions.handlers') as typeof actions_handlersModule;

type Handlers = ReturnType<typeof buildHandlers>;
// A zero-parameter handler invoked the way ipcMain does, with the event first.
type WithEvent<F> = F extends (...args: infer A) => infer R ? (event: object, ...args: A) => R : never;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('get-active-challenges', () => {
    test('delegates to strategy.getActiveChallenges with the stored token', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 1 }] }),
        });
        const handlers = buildHandlers();
        const result = await handlers['get-active-challenges']();
        expect(strategy.getActiveChallenges).toHaveBeenCalledWith('tok');
        expect(result).toEqual({ challenges: [{ id: 1 }] });
        // Feeds the quit-while-boost-window-open confirmation.
        expect(rememberChallenges).toHaveBeenCalledWith([{ id: 1 }], false);
    });

    test('records the mock setting the list was fetched under', async () => {
        settings.loadSettings = jest.fn().mockReturnValue({ token: 'tok', mock: true });
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 1 }] }) });
        await buildHandlers()['get-active-challenges']();
        expect(rememberChallenges).toHaveBeenCalledWith([{ id: 1 }], true);
    });

    test('a failed fetch keeps the quit guard on its previous list', async () => {
        setToken('tok');
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [], fetchFailed: true }) });
        const handlers = buildHandlers();
        await handlers['get-active-challenges']();
        expect(rememberChallenges).not.toHaveBeenCalled();
    });

    test('tolerates a strategy that resolves nothing', async () => {
        setToken('tok');
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue(undefined) });
        const handlers = buildHandlers();
        await expect(handlers['get-active-challenges']()).resolves.toBeUndefined();
        expect(rememberChallenges).toHaveBeenCalledWith(undefined, false);
    });

    test('never throws to the renderer — returns the fetchFailed list shape on error', async () => {
        // Architecture invariant: handlers return { success, error }-style
        // objects, never throw. get-active-challenges returns the same
        // { challenges, fetchFailed } shape the happy path uses so
        // useActiveChallenges' "always resolves a list shape" holds.
        setToken('tok');
        stubStrategy({ getActiveChallenges: jest.fn().mockRejectedValue(new Error('fetch fail')) });
        const handlers = buildHandlers();
        await expect(handlers['get-active-challenges']()).resolves.toEqual({
            challenges: [],
            fetchFailed: true,
        });
    });
});

describe('get-active-challenges without a stored token', () => {
    test.each([null, ''])(
        'answers the failed-fetch list shape for %p without a request or a warning',
        async (token) => {
            setToken(token);
            const strategy = stubStrategy();
            const handlers = buildHandlers();
            await expect(handlers['get-active-challenges']()).resolves.toEqual({ challenges: [], fetchFailed: true });
            expect(strategy.getActiveChallenges).not.toHaveBeenCalled();
            expect(rememberChallenges).not.toHaveBeenCalled();
        },
    );
});

describe('authenticate', () => {
    // The handler selects the surface via getApiStrategy({ mock }) — the
    // explicit-override seam — so the test injects both surfaces there
    // (the raw surfaces are not exported).
    type Surface = { authenticate: jest.MockedFunction<apiFactoryModule.ApiStrategy['authenticate']> };
    let mockSurface: Surface;
    let realSurface: Surface;

    beforeEach(() => {
        auth.extractAuthResult = invalid(realExtractAuthResult);
        auth.switchAccountToken.mockReset();
        settings.setSetting = jest.fn();
        mockSurface = { authenticate: jest.fn() };
        realSurface = { authenticate: jest.fn() };
        apiFactory.getApiStrategy = invalid(
            jest.fn(({ mock }: { mock?: boolean } = {}) => (mock ? mockSurface : realSurface)),
        );
    });

    test('mock path selects the mock surface, stores its token and does not return it', async () => {
        mockSurface.authenticate.mockResolvedValue({ token: 'mock-token-xyz' });
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'user@example.com', 'pw', true);
        expect(apiFactory.getApiStrategy).toHaveBeenCalledWith({ mock: true });
        expect(mockSurface.authenticate).toHaveBeenCalledWith('user@example.com', 'pw');
        expect(realSurface.authenticate).not.toHaveBeenCalled();
        expect(result).toEqual({ success: true });
        expect(result).not.toHaveProperty('token');
        // Stored through the account switch, so a login on top of another session drops the old one's memory.
        expect(auth.switchAccountToken).toHaveBeenCalledWith('mock-token-xyz');
    });

    test('real path selects the real surface and persists the token', async () => {
        realSurface.authenticate.mockResolvedValue(
            invalid({
                token: 'real-token',
                member_id: 42,
                user_name: 'realuser',
            }),
        );
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'user@example.com', 'pw', false);
        expect(apiFactory.getApiStrategy).toHaveBeenCalledWith({ mock: false });
        expect(realSurface.authenticate).toHaveBeenCalledWith('user@example.com', 'pw');
        expect(result).toEqual({ success: true });
        expect(result).not.toHaveProperty('token');
        expect(auth.switchAccountToken).toHaveBeenCalledWith('real-token');
    });

    test('real path accepts a token under access_token (the _login parity fix)', async () => {
        realSurface.authenticate.mockResolvedValue(invalid({ access_token: 'alt-token' }));
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'u', 'p', false);
        expect(result).toEqual({ success: true });
        expect(auth.switchAccountToken).toHaveBeenCalledWith('alt-token');
    });

    test('returns failure when API returns null', async () => {
        realSurface.authenticate.mockResolvedValue(null);
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'u', 'p', false);
        expect(result).toEqual({ success: false, error: 'Authentication failed - no response from server' });
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test('returns failure when API responds without a token', async () => {
        realSurface.authenticate.mockResolvedValue(invalid({ success: false, error: 'bad creds' }));
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'u', 'p', false);
        expect(result).toEqual({ success: false, error: 'bad creds' });
    });

    test('catches network errors and returns formatted failure', async () => {
        realSurface.authenticate.mockRejectedValue(new Error('ECONNREFUSED'));
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'u', 'p', false);
        expect(result).toEqual({ success: false, error: 'ECONNREFUSED' });
    });
});

describe('play-auto-turbo', () => {
    test('rejects when no token', async () => {
        setToken(null);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'Title');
        expect(result).toEqual({ success: false, error: 'No authentication token found' });
    });

    test('rejects when challenge no longer active', async () => {
        setToken('tok');
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 999 }] }) });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'Title');
        expect(result).toEqual({ success: false, error: 'Challenge no longer active' });
    });

    test('rejects with state-specific error when turbo not playable (manual bypass branch)', async () => {
        setToken('tok');
        const now = NOW();
        stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [
                    {
                        id: 123,
                        title: 'C',
                        close_time: now + 3600,
                        member: { turbo: { state: 'WON' } },
                    },
                ],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'Title');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/state=WON/);
    });

    test('manual bypass allows play when state is FREE and shouldPlayAutoTurbo returned false', async () => {
        // shouldPlayAutoTurbo can return false because the autoTurbo setting
        // is off. The manual button bypasses that gate as long as the turbo
        // is actually playable (FREE / IN_PROGRESS / cooldown passed).
        setToken('tok');
        const now = NOW();
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [
                    {
                        id: 123,
                        title: 'C',
                        close_time: now + 3600,
                        member: { turbo: { state: 'FREE' } },
                    },
                ],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        strategy.runTurboMiniGame.mockResolvedValue({ played: 5, correct: 5, won: true, flipped: 0, doubleFailed: 0 });
        const handlers = buildHandlers();
        const needs = { join: 0, fill: 0, turbo: 1, vote: 0 };
        const unregister = registerMissionNeeds('tok', needs);
        try {
            const result = await handlers['play-auto-turbo']({}, '123', 'C');
            expect(result.success).toBe(true);
            expect(strategy.runTurboMiniGame).toHaveBeenCalled();
            expect(needs.turbo).toBe(0);
        } finally {
            unregister?.();
        }
    });

    test('returns "no battles" when mini-game played 0', async () => {
        setToken('tok');
        const now = NOW();
        const strategy = stubStrategy({
            getActiveChallenges: jest
                .fn()
                .mockResolvedValue({ challenges: [{ id: 123, title: 'C', close_time: now + 3600 }] }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        strategy.runTurboMiniGame.mockResolvedValue({ played: 0, correct: 0, won: false });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toMatchObject({ success: false, error: 'No battles to play right now' });
    });

    test('returns "not earned" when mini-game played but not all correct', async () => {
        setToken('tok');
        const now = NOW();
        const strategy = stubStrategy({
            getActiveChallenges: jest
                .fn()
                .mockResolvedValue({ challenges: [{ id: 123, title: 'C', close_time: now + 3600 }] }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        strategy.runTurboMiniGame.mockResolvedValue({ played: 5, correct: 0, won: false, flipped: 5, doubleFailed: 1 });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not earned/i);
        // Whitelist check: only the documented fields are forwarded.
        expect(Object.keys((result as Extract<typeof result, { result: unknown }>).result || {}).sort()).toEqual(
            ['correct', 'doubleFailed', 'flipped', 'played', 'won'].sort(),
        );
    });

    test('in-flight guard: second simultaneous call for the same challenge is rejected', async () => {
        setToken('tok');
        // First call's getActiveChallenges hangs forever — keeps the
        // in-flight slot held so the second call sees it occupied.
        let releaseFirst: ((value: unknown) => void) | undefined;
        const firstHang = new Promise((resolve) => {
            releaseFirst = resolve;
        });
        const strategy = stubStrategy({ getActiveChallenges: jest.fn().mockReturnValue(firstHang) });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        strategy.runTurboMiniGame.mockResolvedValue({ played: 5, correct: 5, won: true });
        const handlers = buildHandlers();

        const firstPromise = handlers['play-auto-turbo']({}, '123', 'C');
        // Second call should see the in-flight slot held and bail early.
        const secondResult = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(secondResult).toEqual({
            success: false,
            error: 'A turbo run is already in progress for this challenge',
        });

        // Release the first call so the test doesn't leak a pending promise.
        releaseFirst!({ challenges: [{ id: 999 }] }); // no live challenge → first returns no-longer-active
        await firstPromise;
        // Sanity: strategy was not called twice for the second attempt.
        expect(strategy.getActiveChallenges).toHaveBeenCalledTimes(1);
    });

    test('a manual request cannot duplicate an autovote mini-game', async () => {
        setToken('tok');
        const strategy = stubStrategy();
        expect(claimTurboRun(123)).toBe(true);
        try {
            const result = await buildHandlers()['play-auto-turbo']({}, '123', 'C');
            expect(result).toEqual({
                success: false,
                error: 'A turbo run is already in progress for this challenge',
            });
            expect(strategy.getActiveChallenges).not.toHaveBeenCalled();
        } finally {
            releaseTurboRun(123, 'automatic');
        }
    });
});

describe('apply-turbo-to-entry', () => {
    test('rejects when auth guard fails', async () => {
        stubAuthGuardFail();
        const handlers = buildHandlers();
        const result = await handlers['apply-turbo-to-entry']({}, '123', 'i1');
        expect(result).toEqual({ success: false, error: 'No authentication token found' });
    });

    test('returns success when applyTurbo returns ok', async () => {
        stubAuthGuardOk();
        stubStrategy({ applyTurbo: jest.fn().mockResolvedValue({ ok: true }) });
        const handlers = buildHandlers();
        const result = await handlers['apply-turbo-to-entry']({}, '123', 'i1');
        expect(result).toEqual({ success: true, message: 'Turbo applied successfully' });
    });

    test('reshapes failure with sanitised message from raw response', async () => {
        stubAuthGuardOk();
        stubStrategy({
            applyTurbo: jest.fn().mockResolvedValue({
                ok: false,
                raw: { success: false, error_code: 42, message: 'turbo\nrejected\twith newlines' },
            }),
        });
        const handlers = buildHandlers();
        const result = await handlers['apply-turbo-to-entry']({}, '123', 'i1');
        expect(result.success).toBe(false);
        // Newlines and tabs collapsed to spaces by sanitizeForLog.
        expect((result as Extract<typeof result, { success: false }>).error).toBe('turbo rejected with newlines');
    });

    test('falls back to generic error string when raw has no message', async () => {
        stubAuthGuardOk();
        stubStrategy({ applyTurbo: jest.fn().mockResolvedValue({ ok: false, raw: null }) });
        const handlers = buildHandlers();
        const result = await handlers['apply-turbo-to-entry']({}, '123', 'i1');
        expect(result).toEqual({ success: false, error: 'Failed to apply turbo' });
    });

    test('catches strategy errors and returns formatted failure', async () => {
        stubAuthGuardOk();
        stubStrategy({ applyTurbo: jest.fn().mockRejectedValue(new Error('network')) });
        const handlers = buildHandlers();
        const result = await handlers['apply-turbo-to-entry']({}, '123', 'i1');
        expect(result).toEqual({ success: false, error: 'network' });
    });
});

describe('id-taking action handlers — invalid args', () => {
    const BAD_IDS: Array<[string, unknown]> = [
        ['an object', { id: 1 }],
        ['NaN', NaN],
        ['an empty string', ''],
        ['a blank string', '   '],
        ['a string over the id length cap', 'x'.repeat(65)],
    ];
    const VALID_IDS: Array<[string, string | number]> = [
        ['zero', 0],
        ['a numeric id', 123],
        ['a string at the id length cap', 'x'.repeat(64)],
    ];
    // [label, channel, log category, call with the id under test in its slot]
    const CHANNELS = [
        [
            'apply-turbo-to-entry',
            'apply-turbo-to-entry',
            'turbo',
            (h: Handlers, id: unknown) => h['apply-turbo-to-entry']({}, invalid<string>(id), 'i1'),
        ],
        [
            'apply-turbo-to-entry (image id)',
            'apply-turbo-to-entry',
            'turbo',
            (h: Handlers, id: unknown) => h['apply-turbo-to-entry']({}, '123', invalid<string>(id)),
        ],
        [
            'play-auto-turbo',
            'play-auto-turbo',
            'turbo',
            (h: Handlers, id: unknown) => h['play-auto-turbo']({}, invalid<string>(id), 'Title'),
        ],
        [
            'fill-challenge-now',
            'fill-challenge-now',
            'autoFill',
            (h: Handlers, id: unknown) => h['fill-challenge-now']({}, invalid<string>(id), 'one'),
        ],
        [
            'apply-boost-to-entry',
            'apply-boost-to-entry',
            'voting',
            (h: Handlers, id: unknown) => h['apply-boost-to-entry']({}, invalid<string>(id), 'i1'),
        ],
        [
            'apply-boost-to-entry (image id)',
            'apply-boost-to-entry',
            'voting',
            (h: Handlers, id: unknown) => h['apply-boost-to-entry']({}, '123', invalid<string>(id)),
        ],
        [
            'join-challenge',
            'join-challenge',
            'join',
            (h: Handlers, id: unknown) => h['join-challenge']({}, invalid<string>(id), false),
        ],
    ] as const;

    describe.each(CHANNELS)('%s', (_label, channel, category, call) => {
        test.each(BAD_IDS)(
            'refuses %s with the invalid-args code and one warning, before touching auth or the API',
            async (_idLabel, id) => {
                stubAuthGuardOk();
                const strategy = stubStrategy({ joinChallenge: jest.fn() });
                settings.loadSettings = jest.fn();
                const result = await call(buildHandlers(), id);
                expect(result).toEqual({ success: false, error: 'invalid-args' });
                expect(logCategories('warning', `Refused ${channel}: invalid id argument`, null)).toEqual([category]);
                expect(auth.requireAuthToken).not.toHaveBeenCalled();
                expect(settings.loadSettings).not.toHaveBeenCalled();
                expect(apiFactory.getApiStrategy).not.toHaveBeenCalled();
                for (const fn of [
                    strategy.applyTurbo,
                    strategy.applyBoostToEntry,
                    strategy.runTurboMiniGame,
                    strategy.joinChallenge,
                ]) {
                    expect(fn).not.toHaveBeenCalled();
                }
                expect(autoFill.fillChallengeNow).not.toHaveBeenCalled();
            },
        );
    });

    describe.each(VALID_IDS)('with %s as the challenge id', (_label, id) => {
        const liveChallenge = (): { id: string | number; title: string; close_time: number; member: object } => ({
            id,
            title: 'C',
            close_time: NOW() + 3600,
            member: { turbo: { state: 'FREE' } },
        });

        test('play-auto-turbo plays the mini-game', async () => {
            setToken('tok');
            const strategy = stubStrategy({
                getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge()] }),
            });
            votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
            strategy.runTurboMiniGame.mockResolvedValue({
                played: 1,
                correct: 1,
                won: false,
                flipped: 0,
                doubleFailed: 0,
            });
            await buildHandlers()['play-auto-turbo']({}, id, 'Title');
            expect(strategy.runTurboMiniGame).toHaveBeenCalledTimes(1);
        });

        test('fill-challenge-now fills the challenge', async () => {
            stubAuthGuardOk();
            stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge()] }) });
            autoFill.fillChallengeNow = jest.fn().mockResolvedValue({ success: true, submitted: 1, skipped: 0 });
            await buildHandlers()['fill-challenge-now']({}, id, 'one');
            expect(autoFill.fillChallengeNow).toHaveBeenCalledTimes(1);
        });

        test('apply-boost-to-entry applies the boost', async () => {
            stubAuthGuardOk();
            const strategy = stubStrategy({ applyBoostToEntry: jest.fn().mockResolvedValue(true) });
            await buildHandlers()['apply-boost-to-entry']({}, id, 'i1');
            expect(strategy.applyBoostToEntry).toHaveBeenCalledWith(id, 'i1', 'tok');
        });

        test('join-challenge joins the challenge', async () => {
            stubAuthGuardOk();
            const strategy = stubStrategy({ joinChallenge: jest.fn().mockResolvedValue({ status: 'joined' }) });
            await buildHandlers()['join-challenge']({}, id, false);
            expect(strategy.joinChallenge).toHaveBeenCalledWith(id, false, 'tok');
        });
    });

    test('apply-turbo-to-entry passes valid numeric ids through to applyTurbo', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({ applyTurbo: jest.fn().mockResolvedValue({ ok: true }) });
        const result = await buildHandlers()['apply-turbo-to-entry']({}, 123, invalid<string>(456));
        expect(result).toEqual({ success: true, message: 'Turbo applied successfully' });
        expect(strategy.applyTurbo).toHaveBeenCalledWith(123, 456, 'tok');
    });
});

describe('fill-challenge-now', () => {
    test('rejects when auth guard fails', async () => {
        stubAuthGuardFail();
        const handlers = buildHandlers();
        const result = await handlers['fill-challenge-now']({}, '123', 'one');
        expect(result.success).toBe(false);
    });

    test('rejects when challenge no longer active', async () => {
        stubAuthGuardOk();
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 999 }] }) });
        const handlers = buildHandlers();
        const result = await handlers['fill-challenge-now']({}, '123', 'one');
        expect(result).toEqual({ success: false, error: 'Challenge no longer active' });
    });

    test('passes normalised mode (anything other than "all" → "one") to autoFill', async () => {
        stubAuthGuardOk();
        const liveChallenge = { id: 123, title: 'C' };
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge] }) });
        autoFill.fillChallengeNow = jest.fn().mockResolvedValue({ success: true, submitted: 2, skipped: 0 });
        const handlers = buildHandlers();
        await handlers['fill-challenge-now']({}, '123', invalid('wat'));
        expect(autoFill.fillChallengeNow).toHaveBeenCalledWith(liveChallenge, 'tok', 'one', expect.any(Object));
    });

    test('passes "all" mode through unchanged', async () => {
        stubAuthGuardOk();
        const liveChallenge = { id: 123, title: 'C' };
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge] }) });
        autoFill.fillChallengeNow = jest.fn().mockResolvedValue({ success: true, submitted: 4, skipped: 0 });
        const handlers = buildHandlers();
        await handlers['fill-challenge-now']({}, '123', 'all');
        expect(autoFill.fillChallengeNow).toHaveBeenCalledWith(liveChallenge, 'tok', 'all', expect.any(Object));
    });

    test('returns success result with pluralised message', async () => {
        stubAuthGuardOk();
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 123 }] }) });
        autoFill.fillChallengeNow = jest.fn().mockResolvedValue({ success: true, submitted: 3, skipped: 1 });
        const handlers = buildHandlers();
        const result = await handlers['fill-challenge-now']({}, '123', 'all');
        expect(result).toMatchObject({ success: true, submitted: 3, skipped: 1, message: 'Submitted 3 entries' });
    });

    test('forwards the settings module in deps so tag rules apply', async () => {
        stubAuthGuardOk();
        const liveChallenge = { id: 123, title: 'C' };
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge] }) });
        autoFill.fillChallengeNow = jest.fn().mockResolvedValue({ success: true, submitted: 1, skipped: 0 });
        const handlers = buildHandlers();
        await handlers['fill-challenge-now']({}, '123', 'one');
        const depsArg = autoFill.fillChallengeNow.mock.calls[0][3];
        // Identity check, not just defined — a future refactor that passes
        // an empty stub instead of the real module would break tag-rule
        // resolution and silently degrade.
        expect(depsArg.settings).toBe(settings);
    });
});

describe('apply-boost-to-entry', () => {
    test('rejects when auth guard fails', async () => {
        stubAuthGuardFail();
        const handlers = buildHandlers();
        const result = await handlers['apply-boost-to-entry']({}, '123', 'i1');
        expect(result).toEqual({ success: false, error: 'No authentication token found' });
    });

    test('returns success when applyBoostToEntry returns truthy', async () => {
        stubAuthGuardOk();
        stubStrategy({ applyBoostToEntry: jest.fn().mockResolvedValue(true) });
        const handlers = buildHandlers();
        const result = await handlers['apply-boost-to-entry']({}, '123', 'i1');
        expect(result).toEqual({ success: true, message: 'Boost applied successfully' });
    });

    test('returns failure when applyBoostToEntry returns falsy', async () => {
        stubAuthGuardOk();
        stubStrategy({ applyBoostToEntry: jest.fn().mockResolvedValue(false) });
        const handlers = buildHandlers();
        const result = await handlers['apply-boost-to-entry']({}, '123', 'i1');
        expect(result).toEqual({ success: false, error: 'Failed to apply boost' });
    });
});

describe('get-bankroll', () => {
    test('whitelists the four currencies on success (no raw payload)', async () => {
        stubAuthGuardOk();
        stubStrategy({
            getBankroll: jest.fn().mockResolvedValue({ keys: 8, swaps: 41, fills: 818, coins: 17540, extra: 'x' }),
        });
        const handlers = buildHandlers();
        const result = await invalid<WithEvent<Handlers['get-bankroll']>>(handlers['get-bankroll'])({});
        expect(result).toEqual({ success: true, keys: 8, swaps: 41, fills: 818, coins: 17540 });
        expect(invalid<Record<string, unknown>>(result).extra).toBeUndefined();
    });

    test('reports failure (never 0s) when the balance cannot be read', async () => {
        stubAuthGuardOk();
        stubStrategy({ getBankroll: jest.fn().mockResolvedValue(null) });
        const handlers = buildHandlers();
        const result = await invalid<WithEvent<Handlers['get-bankroll']>>(handlers['get-bankroll'])({});
        expect(result.success).toBe(false);
    });

    test('returns the auth guard response when not authenticated', async () => {
        stubAuthGuardFail();
        const handlers = buildHandlers();
        const result = await invalid<WithEvent<Handlers['get-bankroll']>>(handlers['get-bankroll'])({});
        expect(result).toEqual({ success: false, error: 'No authentication token found' });
    });
});

describe('get-member-challenges', () => {
    test('defaults the filter to "open" and returns items', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue([{ id: 1 }]) });
        const handlers = buildHandlers();
        const result = await handlers['get-member-challenges']({});
        expect(strategy.getMemberChallenges).toHaveBeenCalledWith('tok', 'open');
        expect(result).toEqual({
            success: true,
            items: [{ id: 1, chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 }],
        });
    });

    describe('each open challenge says what is chosen for it', () => {
        const open = async () => {
            stubAuthGuardOk();
            stubStrategy({
                getMemberChallenges: jest.fn().mockResolvedValue([{ id: 7, title: 'Pink' }, {}, { id: 8 }]),
            });
            const result = await buildHandlers()['get-member-challenges']({});
            return result.success ? result.items : [];
        };

        beforeEach(() => {
            clearOpenChallenges();
            mockChosenSettings({});
            // As the real lookup does when it cannot tell: no member, never undefined.
            jest.mocked(autoFill.resolveMemberId).mockReset().mockResolvedValue(null);
        });

        test('its own list, and the count that applies when it is the one in force', async () => {
            mockChosenSettings({ own: { '7': ['a', 'b'] } });
            const items = await open();
            expect(items[0]).toEqual({
                id: 7,
                title: 'Pink',
                chosenOwn: ['a', 'b'],
                chosenOwnCount: 2,
                chosenEffectiveCount: 2,
            });
            // No list of its own and none inherited.
            expect(items[2]).toEqual({ id: 8, chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 });
        });

        test('a list inherited from a rule or the global default counts, with nothing of its own', async () => {
            mockChosenSettings({ inherited: ['g1', 'g2', 'g3'] });
            expect((await open())[0]).toEqual(
                expect.objectContaining({ chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 3 }),
            );
            mockChosenSettings({ rule: { value: ['r1'] } });
            expect((await open())[0]).toEqual(expect.objectContaining({ chosenOwn: [], chosenEffectiveCount: 1 }));
        });

        test('an item with no id is passed through with nothing chosen', async () => {
            mockChosenSettings({ inherited: ['g1'] });
            expect((await open())[1]).toEqual({ chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 });
        });

        test('a list saved under another account is counted but its ids are never sent, and nothing applies', async () => {
            mockChosenSettings({ own: { '7': ['secret-a', 'secret-b'] }, inherited: ['g1'], savedBy: 'member-0' });
            const [row] = await open();
            expect(row).toEqual(expect.objectContaining({ chosenOwn: [], chosenOwnCount: 2, chosenEffectiveCount: 0 }));
            expect(JSON.stringify(await open())).not.toContain('secret');
        });

        test('the same account, or no owner on record, gets its ids', async () => {
            mockChosenSettings({ own: { '7': ['secret-a'] }, savedBy: 'member-1' });
            expect((await open())[0]).toEqual(expect.objectContaining({ chosenOwn: ['secret-a'] }));
            mockChosenSettings({ own: { '7': ['secret-a'] }, savedBy: '' });
            expect((await open())[0]).toEqual(expect.objectContaining({ chosenOwn: ['secret-a'] }));
        });

        test('with an owner on record and the signed-in member not known yet, the ids are withheld but the list still applies', async () => {
            mockChosenSettings({ own: { '7': ['secret-a', 'secret-b'] }, savedBy: 'member-0', current: null });
            const [row] = await open();
            expect(row).toEqual(expect.objectContaining({ chosenOwn: [], chosenOwnCount: 2, chosenEffectiveCount: 2 }));
            expect(JSON.stringify(row)).not.toContain('secret');
        });

        describe('on a fresh launch the signed-in member is resolved before the ids are withheld', () => {
            afterEach(() => {
                jest.mocked(autoFill.resolveMemberId).mockReset();
                jest.mocked(autoFill.peekMemberId).mockReset();
            });

            test('a member a lookup already resolved costs no lookup of its own', async () => {
                mockChosenSettings({ own: { '7': ['a', 'b'] }, savedBy: 'member-0', current: 'member-0' });
                const [row] = await open();
                expect(row).toEqual(expect.objectContaining({ chosenOwn: ['a', 'b'] }));
                expect(autoFill.resolveMemberId).not.toHaveBeenCalled();
            });

            // peekMemberId knows nobody until the lookup has run, as in a fresh process.
            const unknownUntilResolved = (resolvesTo: string | null) => {
                jest.mocked(autoFill.peekMemberId).mockReturnValue(null);
                jest.mocked(autoFill.resolveMemberId).mockImplementation(async () => {
                    jest.mocked(autoFill.peekMemberId).mockReturnValue(resolvesTo);
                    return resolvesTo;
                });
            };

            test('the owner is the signed-in member: its own ids are sent', async () => {
                mockChosenSettings({ own: { '7': ['a', 'b'] }, savedBy: 'member-0' });
                unknownUntilResolved('member-0');
                const [row] = await open();
                expect(row).toEqual(expect.objectContaining({ chosenOwn: ['a', 'b'], chosenOwnCount: 2 }));
                expect(autoFill.resolveMemberId).toHaveBeenCalledTimes(1);
                expect(autoFill.resolveMemberId).toHaveBeenCalledWith(
                    'tok',
                    // The strategy's own lookup, as the fill path hands it over.
                    expect.any(Function),
                    expect.anything(),
                    'join',
                );
            });

            test('another account: the ids stay withheld and nothing applies', async () => {
                mockChosenSettings({ own: { '7': ['secret-a'] }, savedBy: 'member-0' });
                unknownUntilResolved('member-9');
                const [row] = await open();
                expect(row).toEqual(
                    expect.objectContaining({ chosenOwn: [], chosenOwnCount: 1, chosenEffectiveCount: 0 }),
                );
                expect(JSON.stringify(row)).not.toContain('secret');
            });

            test('a lookup that fails keeps withholding, and the list still applies', async () => {
                mockChosenSettings({ own: { '7': ['secret-a'] }, savedBy: 'member-0' });
                unknownUntilResolved(null);
                const [row] = await open();
                expect(row).toEqual(
                    expect.objectContaining({ chosenOwn: [], chosenOwnCount: 1, chosenEffectiveCount: 1 }),
                );
            });
        });

        test('the owner and the signed-in member are looked up once per request, not once per challenge', async () => {
            mockChosenSettings({ own: { '7': ['a'], '8': ['b'] } });
            await open();
            expect(settings.getSetting).toHaveBeenCalledTimes(1);
            expect(autoFill.peekMemberId).toHaveBeenCalledTimes(1);
        });
    });
});

describe('get-open-chosen-annotations — read from the settings, with one cached identity lookup', () => {
    const ask = (ids: unknown) =>
        invalid<(event: unknown, ids: unknown) => Promise<unknown>>(buildHandlers()['get-open-chosen-annotations'])(
            {},
            ids,
        );

    beforeEach(() => {
        clearOpenChallenges();
        jest.mocked(settings.loadSettings).mockReturnValue(invalid({ token: 'tok' }));
        mockChosenSettings({ own: { '7': ['a', 'b'] }, inherited: ['g'] });
        jest.mocked(autoFill.resolveMemberId).mockReset().mockResolvedValue(null);
    });

    describe("the signed-in member is resolved when no lookup has, so a fresh launch does not withhold the user's own list", () => {
        afterEach(() => {
            jest.mocked(autoFill.resolveMemberId).mockReset();
            jest.mocked(autoFill.peekMemberId).mockReset();
        });

        test('a member a lookup already resolved costs no lookup of its own', async () => {
            stubStrategy();
            mockChosenSettings({ own: { '7': ['a', 'b'] }, savedBy: 'member-0', current: 'member-0' });
            await expect(ask([7])).resolves.toEqual({
                success: true,
                annotations: { '7': { chosenOwn: ['a', 'b'], chosenOwnCount: 2, chosenEffectiveCount: 2 } },
            });
            expect(autoFill.resolveMemberId).not.toHaveBeenCalled();
        });

        const unknownUntilResolved = (resolvesTo: string | null) => {
            jest.mocked(autoFill.peekMemberId).mockReturnValue(null);
            jest.mocked(autoFill.resolveMemberId).mockImplementation(async () => {
                jest.mocked(autoFill.peekMemberId).mockReturnValue(resolvesTo);
                return resolvesTo;
            });
        };

        test('the member resolves to the owner: the ids are sent', async () => {
            stubStrategy();
            mockChosenSettings({ own: { '7': ['a', 'b'] }, savedBy: 'member-0' });
            unknownUntilResolved('member-0');
            await expect(ask([7])).resolves.toEqual({
                success: true,
                annotations: { '7': { chosenOwn: ['a', 'b'], chosenOwnCount: 2, chosenEffectiveCount: 2 } },
            });
            expect(autoFill.resolveMemberId).toHaveBeenCalledTimes(1);
        });

        test('the member resolves to another account: the ids stay withheld', async () => {
            stubStrategy();
            mockChosenSettings({ own: { '7': ['secret-a'] }, savedBy: 'member-0' });
            unknownUntilResolved('member-9');
            const result = await ask([7]);
            expect(result).toEqual({
                success: true,
                annotations: { '7': { chosenOwn: [], chosenOwnCount: 1, chosenEffectiveCount: 0 } },
            });
            expect(JSON.stringify(result)).not.toContain('secret');
        });

        test('a failed lookup keeps withholding; with no token there is no lookup at all', async () => {
            stubStrategy();
            mockChosenSettings({ own: { '7': ['secret-a'] }, savedBy: 'member-0' });
            unknownUntilResolved(null);
            expect(JSON.stringify(await ask([7]))).not.toContain('secret');
            jest.mocked(autoFill.resolveMemberId).mockClear();
            jest.mocked(settings.loadSettings).mockReturnValue(invalid({ token: '' }));
            await ask([7]);
            expect(autoFill.resolveMemberId).not.toHaveBeenCalled();
        });
    });

    test('answers from the settings, without fetching the challenge list or touching an entry', async () => {
        const strategy = stubStrategy();
        await expect(ask([7, '8'])).resolves.toEqual({
            success: true,
            annotations: {
                '7': { chosenOwn: ['a', 'b'], chosenOwnCount: 2, chosenEffectiveCount: 2 },
                '8': { chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 1 },
            },
        });
        expect(auth.requireAuthToken).not.toHaveBeenCalled();
        // None of the strategy's endpoints was reached.
        expect(strategy.getActiveChallenges).not.toHaveBeenCalled();
        expect(strategy.getEligiblePhotos).not.toHaveBeenCalled();
        expect(strategy.submitToChallenge).not.toHaveBeenCalled();
    });

    test('a rule keyed on the title resolves through the open list the last fetch returned', async () => {
        stubAuthGuardOk();
        stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue([{ id: 9, title: 'Rule Match' }]) });
        await buildHandlers()['get-member-challenges']({});
        mockChosenSettings({ rule: { value: ['r1'] } });
        await ask([9]);
        expect(settings.resolveRuleSetting).toHaveBeenCalledWith(
            'chosenPhotos',
            expect.objectContaining({ id: 9, title: 'Rule Match' }),
        );
    });

    test('logging out forgets the remembered open list: the same id resolves as a bare id again', async () => {
        stubAuthGuardOk();
        stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue([{ id: 9, title: 'Rule Match' }]) });
        await buildHandlers()['get-member-challenges']({});
        clearOpenChallenges();
        await ask([9]);
        expect(settings.resolveRuleSetting).toHaveBeenLastCalledWith('chosenPhotos', { id: 9 });
    });

    test("under another account's list the ids are never sent", async () => {
        mockChosenSettings({ own: { '7': ['a', 'b'] }, savedBy: 'member-0' });
        const result = await ask([7]);
        expect(result).toEqual({
            success: true,
            annotations: { '7': { chosenOwn: [], chosenOwnCount: 2, chosenEffectiveCount: 0 } },
        });
        expect(JSON.stringify(result)).not.toContain('"a"');
    });

    test('with an owner on record and the member not known yet, the ids are withheld but the list applies', async () => {
        mockChosenSettings({ own: { '7': ['a', 'b'] }, savedBy: 'member-0', current: null });
        await expect(ask([7])).resolves.toEqual({
            success: true,
            annotations: { '7': { chosenOwn: [], chosenOwnCount: 2, chosenEffectiveCount: 2 } },
        });
    });

    test.each([
        ['not an array', '7'],
        ['an item that is not an id', [7, {}]],
        ['a blank id', ['  ']],
        ['one id too many (201)', Array.from({ length: 201 }, (_, i) => i + 1)],
    ])('refuses %s', async (_name, ids) => {
        await expect(ask(ids)).resolves.toEqual({ success: false, error: 'invalid-args' });
    });

    test('exactly 200 ids is the most it answers', async () => {
        const ids = Array.from({ length: 200 }, (_, i) => i + 1);
        const result = await ask(ids);
        if (!isPlainObject(result) || result.success !== true || !isPlainObject(result.annotations)) {
            throw new Error('expected a successful answer');
        }
        expect(Object.keys(result.annotations)).toHaveLength(200);
    });

    test('an empty list is fine', async () => {
        await expect(ask([])).resolves.toEqual({ success: true, annotations: {} });
    });

    test('a failing settings read is an error result, never a throw', async () => {
        jest.mocked(settings.loadSettings).mockImplementation(() => {
            throw new Error('read failed');
        });
        await expect(ask([7])).resolves.toEqual({ success: false, error: 'read failed', annotations: {} });
        jest.mocked(settings.loadSettings).mockImplementation(() => {
            throw new Error('');
        });
        await expect(ask([7])).resolves.toEqual({
            success: false,
            error: 'Failed to read the chosen photos',
            annotations: {},
        });
    });
});

describe('join-challenge', () => {
    test('passes challengeId + spendCoins + token through, maps joined→success', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({
            joinChallenge: jest.fn().mockResolvedValue({ status: 'joined', cost: 100, challengeId: 5 }),
        });
        const handlers = buildHandlers();
        const result = await handlers['join-challenge']({}, 5, true);
        expect(strategy.joinChallenge).toHaveBeenCalledWith(5, true, 'tok');
        expect(result).toMatchObject({ success: true, status: 'joined', cost: 100 });
    });

    test('a paid challenge without spendCoins does not report success (needs-confirm)', async () => {
        stubAuthGuardOk();
        stubStrategy({ joinChallenge: jest.fn().mockResolvedValue({ status: 'needs-confirm', cost: 100 }) });
        const handlers = buildHandlers();
        const result = await handlers['join-challenge']({}, 5, false);
        expect(result.success).toBe(false);
        expect((result as Extract<typeof result, { status: unknown }>).status).toBe('needs-confirm');
    });
});

describe('get-auto-claim-status', () => {
    test('exposes the shared claim clock without running a claim', async () => {
        settings.getEffectiveSetting = invalid(jest.fn(() => true));
        const { resetClaimThrottle } = require('../../src/ts/services/autoClaim') as typeof autoClaimModule;
        resetClaimThrottle();
        await expect(
            invalid<WithEvent<Handlers['get-auto-claim-status']>>(buildHandlers()['get-auto-claim-status'])({}),
        ).resolves.toEqual({
            success: true,
            enabled: true,
            nextClaimAt: 0,
        });
    });

    test('returns an error envelope when settings cannot be read', async () => {
        settings.getEffectiveSetting = invalid(
            jest.fn(() => {
                throw new Error('unavailable');
            }),
        );
        await expect(
            invalid<WithEvent<Handlers['get-auto-claim-status']>>(buildHandlers()['get-auto-claim-status'])({}),
        ).resolves.toEqual({
            success: false,
            error: 'unavailable',
        });
    });

    test('falls back to a generic message when the error has none', async () => {
        settings.getEffectiveSetting = invalid(
            jest.fn(() => {
                throw new Error('');
            }),
        );
        await expect(
            invalid<WithEvent<Handlers['get-auto-claim-status']>>(buildHandlers()['get-auto-claim-status'])({}),
        ).resolves.toEqual({
            success: false,
            error: 'Could not read auto-claim status',
        });
    });
});

describe('get-auto-join-active', () => {
    test('reports active:true when the master autoJoin setting is on', async () => {
        settings.getEffectiveSetting = invalid(jest.fn((k: string) => (k === 'autoJoin' ? true : undefined)));
        settings.getTitleRules = invalid(jest.fn(() => []));
        const handlers = buildHandlers();
        const result = await invalid<WithEvent<Handlers['get-auto-join-active']>>(handlers['get-auto-join-active'])({});
        expect(result).toEqual({ success: true, active: true });
    });

    test('reports active:false when off and no profile enables it', async () => {
        settings.getEffectiveSetting = invalid(jest.fn(() => false));
        settings.getTitleRules = invalid(jest.fn(() => []));
        const handlers = buildHandlers();
        const result = await invalid<WithEvent<Handlers['get-auto-join-active']>>(handlers['get-auto-join-active'])({});
        expect(result).toEqual({ success: true, active: false });
    });

    test('fails closed to {success:false, active:false} when the check throws', async () => {
        settings.getEffectiveSetting = invalid(
            jest.fn(() => {
                throw new Error('boom');
            }),
        );
        const handlers = buildHandlers();
        const result = await invalid<WithEvent<Handlers['get-auto-join-active']>>(handlers['get-auto-join-active'])({});
        expect(result).toEqual({ success: false, active: false });
    });
});

describe('authenticate — error fallback', () => {
    test('uses the network-error fallback when the thrown error has no message', async () => {
        apiFactory.getApiStrategy = jest
            .fn()
            .mockReturnValue({ authenticate: jest.fn().mockRejectedValue(new Error('')) });
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'u', 'p', false);
        expect(result).toEqual({ success: false, error: 'Authentication failed due to network error' });
    });
});

describe('play-auto-turbo — manual bypass and result shaping', () => {
    const liveTurboChallenge = (overrides = {}) => ({
        id: 123,
        title: 'Live Title',
        close_time: NOW() + 3600,
        member: { turbo: { state: 'FREE' } },
        ...overrides,
    });

    test('allows play when a TIMER cooldown has already elapsed', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { state: 'TIMER', time_to_open: NOW() - 10 } } })],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        strategy.runTurboMiniGame.mockResolvedValue({ played: 3, correct: 3, won: true, flipped: 0, doubleFailed: 0 });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({
            success: true,
            result: { played: 3, correct: 3, won: true, flipped: 0, doubleFailed: 0 },
        });
    });

    test('refuses a TIMER whose cooldown has not elapsed yet', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { state: 'TIMER', time_to_open: NOW() + 600 } } })],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({ success: false, error: 'Turbo not playable (state=TIMER)' });
        expect(strategy.runTurboMiniGame).not.toHaveBeenCalled();
    });

    test('reports state=unknown when the challenge has no turbo state', async () => {
        setToken('tok');
        stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveTurboChallenge({ member: {} })] }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({ success: false, error: 'Turbo not playable (state=unknown)' });
    });

    test('refuses a playable turbo on a challenge that has already closed', async () => {
        setToken('tok');
        stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ close_time: NOW() - 1 })],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({ success: false, error: 'Turbo not playable (state=FREE)' });
    });

    test('falls back to the caller title, then a generic label, when the live challenge has none', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveTurboChallenge({ title: '' })] }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        strategy.runTurboMiniGame.mockResolvedValue({ played: 1, correct: 1 });
        const handlers = buildHandlers();

        await handlers['play-auto-turbo']({}, '123', 'Caller Title');
        expect(strategy.runTurboMiniGame).toHaveBeenLastCalledWith(
            expect.objectContaining({ id: 123, title: 'Caller Title' }),
            'tok',
        );

        await handlers['play-auto-turbo']({}, '123', invalid(undefined));
        expect(strategy.runTurboMiniGame).toHaveBeenLastCalledWith(
            expect.objectContaining({ id: 123, title: 'challenge 123' }),
            'tok',
        );
    });

    test('a null mini-game result is reported as not earned with a null result', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveTurboChallenge()] }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        strategy.runTurboMiniGame.mockResolvedValue(null);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({ success: false, error: 'Turbo not earned — try again later', result: null });
    });

    test('a throw inside the critical section releases the in-flight slot', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockRejectedValue(new Error('fetch failed')),
        });
        const handlers = buildHandlers();

        await expect(handlers['play-auto-turbo']({}, '123', 'C')).resolves.toEqual({
            success: false,
            error: 'fetch failed',
        });
        // Second call is not rejected as "already in progress".
        await expect(handlers['play-auto-turbo']({}, '123', 'C')).resolves.toEqual({
            success: false,
            error: 'fetch failed',
        });
        expect(strategy.getActiveChallenges).toHaveBeenCalledTimes(2);
    });

    test('uses the generic fallback when a pre-flight error has no message', async () => {
        settings.loadSettings = jest.fn(() => {
            throw new Error('');
        });
        const handlers = buildHandlers();
        await expect(handlers['play-auto-turbo']({}, '123', 'C')).resolves.toEqual({
            success: false,
            error: 'Failed to run turbo mini-game',
        });
    });
});

describe('apply-turbo-to-entry — error fallback', () => {
    test('uses the generic fallback when applyTurbo throws without a message', async () => {
        stubAuthGuardOk();
        stubStrategy({ applyTurbo: jest.fn().mockRejectedValue(new Error('')) });
        const handlers = buildHandlers();
        await expect(handlers['apply-turbo-to-entry']({}, '123', 'i1')).resolves.toEqual({
            success: false,
            error: 'Failed to apply turbo',
        });
    });
});

describe('fill-challenge-now — result shapes and errors', () => {
    const stubLive = () =>
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 123 }] }) });

    test('uses the singular form for exactly one submitted entry', async () => {
        stubAuthGuardOk();
        stubLive();
        autoFill.fillChallengeNow = jest.fn().mockResolvedValue({ success: true, submitted: 1, skipped: 0 });
        const result = await buildHandlers()['fill-challenge-now']({}, '123', 'one');
        expect((result as Extract<typeof result, { message: unknown }>).message).toBe('Submitted 1 entry');
    });

    test('forwards a failed fill without a success message', async () => {
        stubAuthGuardOk();
        stubLive();
        autoFill.fillChallengeNow = jest
            .fn()
            .mockResolvedValue({ success: false, submitted: 0, skipped: 2, error: 'No eligible photos' });
        const result = await buildHandlers()['fill-challenge-now']({}, '123', 'all');
        expect(result).toEqual({
            success: false,
            submitted: 0,
            skipped: 2,
            error: 'No eligible photos',
            message: undefined,
        });
    });

    test.each([
        ['its message', new Error('fill blew up'), 'fill blew up'],
        ['the generic fallback', new Error(''), 'Failed to submit photos'],
    ])('returns %s when the fill throws', async (_label, err, expected) => {
        stubAuthGuardOk();
        stubLive();
        autoFill.fillChallengeNow = jest.fn().mockRejectedValue(err);
        await expect(buildHandlers()['fill-challenge-now']({}, '123', 'one')).resolves.toEqual({
            success: false,
            error: expected,
        });
    });
});

describe('apply-boost-to-entry — errors', () => {
    test.each([
        ['its message', new Error('rate limited'), 'rate limited'],
        ['the generic fallback', new Error(''), 'Failed to apply boost'],
    ])('returns %s when applyBoostToEntry throws', async (_label, err, expected) => {
        stubAuthGuardOk();
        const strategy = stubStrategy({ applyBoostToEntry: jest.fn().mockRejectedValue(err) });
        await expect(buildHandlers()['apply-boost-to-entry']({}, '123', 'i1')).resolves.toEqual({
            success: false,
            error: expected,
        });
        expect(strategy.applyBoostToEntry).toHaveBeenCalledWith('123', 'i1', 'tok');
    });
});

describe('get-bankroll — errors', () => {
    test.each([
        ['its message', new Error('timeout'), 'timeout'],
        ['the generic fallback', new Error(''), 'Failed to read bankroll'],
        ['the generic fallback for a thrown null', null, 'Failed to read bankroll'],
    ])('returns %s when getBankroll throws', async (_label, err, expected) => {
        stubAuthGuardOk();
        stubStrategy({ getBankroll: jest.fn().mockRejectedValue(err) });
        await expect(
            invalid<WithEvent<Handlers['get-bankroll']>>(buildHandlers()['get-bankroll'])({}),
        ).resolves.toEqual({ success: false, error: expected });
    });
});

describe('get-member-challenges — filter, shape and errors', () => {
    test('returns the auth guard response when not authenticated', async () => {
        stubAuthGuardFail();
        await expect(buildHandlers()['get-member-challenges']({})).resolves.toEqual({
            success: false,
            error: 'No authentication token found',
        });
    });

    test('remembers the open list for the settings cleanup — open filter and readable lists only', async () => {
        stubAuthGuardOk();
        stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue([{ id: 1 }, { id: '2' }, {}, null]) });
        await buildHandlers()['get-member-challenges']({});
        expect(settings.rememberOpenChallengeIds).toHaveBeenLastCalledWith([1, '2']);
        settings.rememberOpenChallengeIds.mockClear();
        await buildHandlers()['get-member-challenges']({}, 'open');
        expect(settings.rememberOpenChallengeIds).toHaveBeenCalledTimes(1);
        settings.rememberOpenChallengeIds.mockClear();
        await buildHandlers()['get-member-challenges']({}, 'all');
        stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue(null) });
        await buildHandlers()['get-member-challenges']({}, 'open');
        expect(settings.rememberOpenChallengeIds).not.toHaveBeenCalled();
    });

    test('passes an explicit filter through and coerces a non-array result to []', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue(null) });
        const result = await buildHandlers()['get-member-challenges']({}, 'all');
        expect(strategy.getMemberChallenges).toHaveBeenCalledWith('tok', 'all');
        expect(result).toEqual({ success: true, items: [] });
    });

    test.each([
        ['its message', new Error('503'), '503'],
        ['the generic fallback', new Error(''), 'Failed to list challenges'],
        ['the generic fallback for a thrown null', null, 'Failed to list challenges'],
    ])('returns %s with an empty list when listing throws', async (_label, err, expected) => {
        stubAuthGuardOk();
        stubStrategy({ getMemberChallenges: jest.fn().mockRejectedValue(err) });
        await expect(buildHandlers()['get-member-challenges']({})).resolves.toEqual({
            success: false,
            items: [],
            error: expected,
        });
    });
});

describe('join-challenge — guard and errors', () => {
    test('returns the auth guard response when not authenticated', async () => {
        stubAuthGuardFail();
        const strategy = stubStrategy({ joinChallenge: jest.fn() });
        await expect(buildHandlers()['join-challenge']({}, 5, true)).resolves.toEqual({
            success: false,
            error: 'No authentication token found',
        });
        expect(strategy.joinChallenge).not.toHaveBeenCalled();
    });

    test('treats a truthy non-boolean spendCoins as false', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({ joinChallenge: jest.fn().mockResolvedValue(null) });
        const result = await buildHandlers()['join-challenge']({}, 5, invalid('yes'));
        expect(strategy.joinChallenge).toHaveBeenCalledWith(5, false, 'tok');
        expect(result.success).toBe(false);
    });

    test.each([
        ['its message', new Error('insufficient coins'), 'insufficient coins'],
        ['the generic fallback', new Error(''), 'Failed to join challenge'],
    ])('returns %s when joining throws', async (_label, err, expected) => {
        stubAuthGuardOk();
        stubStrategy({ joinChallenge: jest.fn().mockRejectedValue(err) });
        await expect(buildHandlers()['join-challenge']({}, 5, true)).resolves.toEqual({
            success: false,
            error: expected,
        });
    });
});

describe('log categories', () => {
    test('authenticate logs the request under authentication', async () => {
        auth.extractAuthResult = invalid(realExtractAuthResult);
        settings.setSetting = jest.fn();
        apiFactory.getApiStrategy = invalid(
            jest.fn(() => ({ authenticate: jest.fn().mockResolvedValue({ token: 't' }) })),
        );

        await buildHandlers().authenticate({}, 'user', 'pw', true);

        expect(logCategories('info', '🔐 Authentication request received - Mock: true', null)).toEqual([
            'authentication',
        ]);
    });

    test('apply-boost-to-entry logs both request lines under voting', async () => {
        stubAuthGuardOk();
        stubStrategy({ applyBoostToEntry: jest.fn().mockResolvedValue(true) });

        await buildHandlers()['apply-boost-to-entry']({}, '123', 'i1');

        expect(logCategories('info', '🚀 Apply boost to entry request: Challenge=123, Image=i1', null)).toEqual([
            'voting',
        ]);
        expect(logCategories('info', '🚀 Applying boost to entry: Challenge=123, Image=i1', null)).toEqual(['voting']);
    });
});

describe('register', () => {
    test('registers every action channel on ipcMain', async () => {
        const { register } = require('../../src/ts/ipc/actions.handlers') as typeof actions_handlersModule;
        const channels = new Map<string, Parameters<IpcMain['handle']>[1]>();
        register(
            invalid({
                handle: (channel: string, impl: Parameters<IpcMain['handle']>[1]) => channels.set(channel, impl),
            }),
        );
        expect([...channels.keys()].sort()).toEqual(Object.keys(buildHandlers()).sort());

        stubAuthGuardFail();
        await expect(channels.get('get-bankroll')!(invalid(undefined))).resolves.toEqual({
            success: false,
            error: 'No authentication token found',
        });
    });
});
