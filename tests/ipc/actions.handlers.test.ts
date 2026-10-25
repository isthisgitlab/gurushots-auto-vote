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
import {
    __resetSnapUnavailableForTests,
    claimTurboRun,
    markSnapUnavailable,
    releaseTurboRun,
} from '../../src/ts/services/turboRunLock';
import { registerMissionNeeds } from '../../src/ts/services/missions';
import { clearOpenChallenges } from '../../src/ts/services/openChallengeCache';
import { isPlainObject } from '../../src/ts/plainObject';
import { MAX_SUGGEST_EXCLUDE } from '../../src/ts/settings/limits';
import type { TurboGameResult } from '../../src/ts/types/gurushots';
import type { JoinSingleResult } from '../../src/ts/services/joinChallenges/shared';
import type { ForgetOutcome } from '../../src/ts/services/joinChallenges/forgetPayment';

import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(loggerModule);
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
import type { CategoryLogger } from '../../src/ts/logger';
import type * as quitGuardModule from '../../src/ts/windows/quitGuard';
import type * as logCategoriesModule from '../helpers/logCategories';
import type * as actions_handlersModule from '../../src/ts/ipc/actions.handlers';
import type * as libraryCacheModule from '../../src/ts/services/libraryCache';
import type * as discoverChallengesModule from '../../src/ts/services/discoverChallenges';
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
    settings.loadSettings = jest.fn().mockReturnValue({ auth: { token }, app: { mock: false } });
};

const stubStrategy = <O extends object = {}>(overrides: O = invalid<O>({})) => {
    const strategy = {
        getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [] }),
        // The suggest handler's discover fallback reads this on every active-list miss; a default
        // null keeps that miss answering challenge-ended instead of crashing into the catch.
        getMemberChallenges: jest.fn().mockResolvedValue(null),
        applyTurbo: jest.fn(),
        applyBoostToEntry: jest.fn(),
        getEligiblePhotos: jest.fn(),
        submitToChallenge: jest.fn(),
        runTurboGame: jest.fn(),
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
// list first, then a matching rule, then the global default.
const mockChosenSettings = ({
    own = {},
    inherited = [],
    rule = null,
}: {
    own?: Record<string, string[]>;
    inherited?: string[];
    rule?: { value: string[] } | null;
}) => {
    jest.mocked(settings.getChallengeOverride).mockImplementation(
        invalid((key: string, id: string) => (key === 'chosenPhotos' ? (own[id] ?? null) : null)),
    );
    jest.mocked(settings.resolveRuleSetting).mockReturnValue(invalid(rule));
    jest.mocked(settings.getEffectiveSetting).mockReturnValue(invalid(inherited));
};

// Note on module-scoped state: turboRunLock keeps its set at module scope.
// The handler's try/finally always clears its slot, so as
// long as every test awaits the calls it makes, the Set stays empty between
// tests — no jest.resetModules() needed (and it would defeat module-top
// jest.mock() bindings anyway by giving the handler fresh mock instances).
const { buildHandlers } = require('../../src/ts/ipc/actions.handlers') as typeof actions_handlersModule;
const { clearUpcomingCache } = require('../../src/ts/services/discoverChallenges') as typeof discoverChallengesModule;
const { writeListing, readFresh, clearLibraryCache } =
    require('../../src/ts/services/libraryCache') as typeof libraryCacheModule;

type Handlers = ReturnType<typeof buildHandlers>;
// A zero-parameter handler invoked the way ipcMain does, with the event first.
type WithEvent<F> = F extends (...args: infer A) => infer R ? (event: object, ...args: A) => R : never;

// The Discover handler takes no argument from the renderer, and is invoked with the event first.
const listChallenges = () =>
    invalid<WithEvent<Handlers['get-member-challenges']>>(buildHandlers()['get-member-challenges'])({});

beforeEach(() => {
    jest.clearAllMocks();
    // Implementations and property replacements some tests make must not leak into the next one.
    jest.mocked(settings.getEffectiveSetting).mockReset();
    jest.mocked(settings.getChallengeOverride).mockReset();
    jest.mocked(settings.resolveRuleSetting).mockReset();
    // The upcoming list is cached for a minute; every test starts without it.
    clearUpcomingCache();
    clearLibraryCache();
    // What the member-challenges writes compare against: the token a request was read under.
    jest.mocked(settings.getSetting).mockReset();
    jest.mocked(settings.getSetting).mockReturnValue('tok');
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
        settings.loadSettings = jest.fn().mockReturnValue({ auth: { token: 'tok' }, app: { mock: true } });
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

    // Every argument every logger call received, collected from the withCategory results (each call
    // returns a fresh category logger of jest.fn methods).
    const loggedArgs = (): string =>
        JSON.stringify(
            logger.withCategory.mock.results.flatMap((call) =>
                Object.values(invalid<CategoryLogger>(call.value)).flatMap(
                    (fn) => invalid<jest.MockedFunction<(...args: unknown[]) => void>>(fn).mock.calls,
                ),
            ),
        );

    test.each([
        ['username', invalid<string>(12345), 'pw'],
        ['password', 'user@example.com', invalid<string>({ user: 'h4x' })],
    ])(
        'refuses a non-string %s locally: no strategy, no save, no value in any log',
        async (_bad, username, password) => {
            const handlers = buildHandlers();
            const result = await handlers.authenticate({}, username, password, false);

            expect(result).toEqual({ success: false, error: 'Invalid credentials' });
            expect(apiFactory.getApiStrategy).not.toHaveBeenCalled();
            expect(mockSurface.authenticate).not.toHaveBeenCalled();
            expect(realSurface.authenticate).not.toHaveBeenCalled();
            expect(settings.setSetting).not.toHaveBeenCalled();
            expect(loggedArgs()).not.toContain('12345');
            expect(loggedArgs()).not.toContain('h4x');
            // One fixed warning on the authentication category, telling a local refusal from a GuruShots one.
            expect(logger.withCategory).toHaveBeenCalledTimes(1);
            expect(logger.withCategory).toHaveBeenCalledWith('authentication');
            const warning = invalid<jest.MockedFunction<(message: string, data?: unknown) => void>>(
                invalid<CategoryLogger>(logger.withCategory.mock.results[0].value).warning,
            );
            expect(warning).toHaveBeenCalledTimes(1);
            expect(warning.mock.calls[0][0]).toContain('non-string credentials');
        },
    );
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
                        member: { turbo: { state: 'WON', mode: 'classic' } },
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
                        member: { turbo: { state: 'FREE', mode: 'classic' } },
                    },
                ],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        strategy.runTurboGame.mockResolvedValue({
            kind: 'classic',
            played: 5,
            correct: 5,
            won: true,
            flipped: 0,
            doubleFailed: 0,
        });
        const handlers = buildHandlers();
        const needs = { join: 0, fill: 0, turbo: 1, boost: 0, vote: 0 };
        const unregister = registerMissionNeeds('tok', needs);
        try {
            const result = await handlers['play-auto-turbo']({}, '123', 'C');
            expect(result.success).toBe(true);
            expect(strategy.runTurboGame).toHaveBeenCalled();
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
        strategy.runTurboGame.mockResolvedValue({ kind: 'classic', played: 0, correct: 0, won: false });
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
        strategy.runTurboGame.mockResolvedValue({
            kind: 'classic',
            played: 5,
            correct: 0,
            won: false,
            flipped: 5,
            doubleFailed: 1,
        });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not earned/i);
        // Whitelist check: only the documented fields are forwarded.
        expect(Object.keys((result as Extract<typeof result, { result: unknown }>).result || {}).sort()).toEqual(
            ['correct', 'doubleFailed', 'flipped', 'kind', 'played', 'won'].sort(),
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
        strategy.runTurboGame.mockResolvedValue({ kind: 'classic', played: 5, correct: 5, won: true });
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
            'autoSubmit',
            (h: Handlers, id: unknown) => h['fill-challenge-now']({}, invalid<string>(id), 'one'),
        ],
        [
            'submit-picked-photos',
            'submit-picked-photos',
            'autoSubmit',
            (h: Handlers, id: unknown) => h['submit-picked-photos']({}, invalid<string>(id), ['abc']),
        ],
        [
            'suggest-photos',
            'suggest-photos',
            'autoSubmit',
            (h: Handlers, id: unknown) => h['suggest-photos']({}, invalid<string>(id)),
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
                    strategy.runTurboGame,
                    strategy.joinChallenge,
                ]) {
                    expect(fn).not.toHaveBeenCalled();
                }
                expect(autoFill.fillChallengeNow).not.toHaveBeenCalled();
                expect(autoFill.submitPickedPhotos).not.toHaveBeenCalled();
                expect(autoFill.suggestFillPhotos).not.toHaveBeenCalled();
            },
        );
    });

    describe.each(VALID_IDS)('with %s as the challenge id', (_label, id) => {
        const liveChallenge = (): { id: string | number; title: string; close_time: number; member: object } => ({
            id,
            title: 'C',
            close_time: NOW() + 3600,
            member: { turbo: { state: 'FREE', mode: 'classic' } },
        });

        test('play-auto-turbo plays the mini-game', async () => {
            setToken('tok');
            const strategy = stubStrategy({
                getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge()] }),
            });
            votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
            strategy.runTurboGame.mockResolvedValue({
                played: 1,
                correct: 1,
                won: false,
                flipped: 0,
                doubleFailed: 0,
            });
            await buildHandlers()['play-auto-turbo']({}, id, 'Title');
            expect(strategy.runTurboGame).toHaveBeenCalledTimes(1);
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

    test('passes normalised mode (anything other than "all" → "one") to autoSubmit', async () => {
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

describe('submit-picked-photos', () => {
    const liveChallenge = { id: 123, title: 'C' };
    // The module is auto-mocked (typed by jest.mocked): start each use from a bare mock.
    const stubSubmitPicked = () => autoFill.submitPickedPhotos.mockReset();

    test.each([
        ['a non-array', 'abc'],
        ['an empty list', []],
        ['more than the chosen-photos cap', Array.from({ length: 21 }, (_, i) => `p${i}`)],
        ['duplicates', ['a', 'a']],
        ['a non-string element', ['a', 7]],
        // eslint-disable-next-line no-sparse-arrays -- the hole is the case
        ['a sparse array', ['a', , 'c']],
        ['an id failing the id pattern', ['ok', 'not ok!']],
    ])('refuses %s with the invalid-args code, before touching auth or the API', async (_label, imageIds) => {
        stubAuthGuardOk();
        stubStrategy();
        const result = await buildHandlers()['submit-picked-photos']({}, '123', invalid<string[]>(imageIds));
        expect(result).toEqual({ success: false, error: 'invalid-args' });
        expect(logCategories('warning', 'Refused submit-picked-photos: invalid id argument', null)).toEqual([
            'autoSubmit',
        ]);
        expect(auth.requireAuthToken).not.toHaveBeenCalled();
        expect(apiFactory.getApiStrategy).not.toHaveBeenCalled();
        expect(autoFill.submitPickedPhotos).not.toHaveBeenCalled();
    });

    test('rejects when auth guard fails', async () => {
        stubAuthGuardFail();
        const result = await buildHandlers()['submit-picked-photos']({}, '123', ['a']);
        expect(result).toEqual({ success: false, error: 'No authentication token found' });
    });

    test('rejects when the challenge is no longer active', async () => {
        stubAuthGuardOk();
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 999 }] }) });
        const result = await buildHandlers()['submit-picked-photos']({}, '123', ['a']);
        expect(result).toEqual({ success: false, error: 'Challenge no longer active' });
        expect(autoFill.submitPickedPhotos).not.toHaveBeenCalled();
    });

    test('submits the ids to the live challenge through the strategy and returns the service result', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge] }),
        });
        stubSubmitPicked().mockResolvedValue({ success: true, submitted: 2 });
        const result = await buildHandlers()['submit-picked-photos']({}, '123', ['a', 'b']);
        expect(result).toEqual({ success: true, submitted: 2 });
        expect(autoFill.submitPickedPhotos).toHaveBeenCalledWith(liveChallenge, 'tok', ['a', 'b'], {
            logger: expect.any(Object),
            submitToChallenge: strategy.submitToChallenge,
        });
        expect(autoFill.submitPickedPhotos.mock.calls[0][3].logger.withCategory).toBe(logger.withCategory);
    });

    test('logs the challenge and the number of photos, never the ids', async () => {
        stubAuthGuardOk();
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge] }) });
        stubSubmitPicked().mockResolvedValue({ success: true, submitted: 1 });
        await buildHandlers()['submit-picked-photos']({}, '123', ['secretphoto']);
        const logged = logger.withCategory.mock.results.flatMap((result) =>
            Object.values(result.value as Record<string, jest.Mock<unknown, unknown[]>>).flatMap(
                (fn): unknown[][] => fn.mock.calls,
            ),
        );
        expect(JSON.stringify(logged)).not.toContain('secretphoto');
        expect(logCategories('info', '📝 Manual pick request: Challenge=123, Photos=1', null)).toEqual(['autoSubmit']);
    });

    test.each([
        ['its message', new Error('network down'), 'network down'],
        ['the generic fallback', new Error(''), 'Failed to submit photos'],
    ])('answers %s instead of throwing, and logs the error under autoSubmit', async (_label, err, expected) => {
        stubAuthGuardOk();
        stubStrategy({ getActiveChallenges: jest.fn().mockRejectedValue(err) });
        await expect(buildHandlers()['submit-picked-photos']({}, '123', ['a'])).resolves.toEqual({
            success: false,
            error: expected,
        });
        expect(logCategories('error', 'Error handling submit-picked-photos request:', err)).toEqual(['autoSubmit']);
    });

    describe('a second submit for the same challenge', () => {
        const stubLive = () =>
            stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge] }) });

        test('is turned away as submit-busy while the first runs, without sending, and goes through after it ends', async () => {
            stubAuthGuardOk();
            stubLive();
            let finish: (value: { success: true; submitted: number }) => void = () => undefined;
            const submitPicked = stubSubmitPicked().mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
            const handlers = buildHandlers();
            const first = handlers['submit-picked-photos']({}, '123', ['a']);
            // The numeric and string forms of an id are the same challenge.
            await expect(handlers['submit-picked-photos']({}, 123, ['b'])).resolves.toEqual({
                success: false,
                error: 'submit-busy',
            });
            await expect(handlers['submit-picked-photos']({}, '123', ['a'])).resolves.toEqual({
                success: false,
                error: 'submit-busy',
            });
            // Each refusal says so in the log, naming the challenge and never the photos.
            expect(
                logCategories(
                    'info',
                    '📝 Manual pick request refused: a submit for Challenge=123 is already running',
                    null,
                ),
            ).toEqual(['autoSubmit', 'autoSubmit']);
            finish({ success: true, submitted: 1 });
            await expect(first).resolves.toEqual({ success: true, submitted: 1 });
            expect(submitPicked).toHaveBeenCalledTimes(1);

            submitPicked.mockResolvedValue({ success: true, submitted: 1 });
            await expect(handlers['submit-picked-photos']({}, '123', ['a'])).resolves.toEqual({
                success: true,
                submitted: 1,
            });
            expect(submitPicked).toHaveBeenCalledTimes(2);
        });

        test.each([
            [
                'the auth guard fails',
                () => {
                    stubAuthGuardFail();
                    stubStrategy();
                },
            ],
            [
                'the challenge is no longer active',
                () => {
                    stubAuthGuardOk();
                    stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 999 }] }) });
                },
            ],
        ])('is not refused as busy after a submit that returned early because %s', async (_label, stubEarlyReturn) => {
            const handlers = buildHandlers();
            stubEarlyReturn();
            const first = await handlers['submit-picked-photos']({}, '123', ['a']);
            expect(first.success).toBe(false);
            expect(first).not.toEqual({ success: false, error: 'submit-busy' });
            const second = await handlers['submit-picked-photos']({}, '123', ['a']);
            expect(second).toEqual(first);
            expect(autoFill.submitPickedPhotos).not.toHaveBeenCalled();
        });

        test('does not hold another challenge, and a submit that throws releases its own', async () => {
            stubAuthGuardOk();
            stubLive();
            let finish: (value: { success: true; submitted: number }) => void = () => undefined;
            const submitPicked = stubSubmitPicked().mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
            const handlers = buildHandlers();
            const first = handlers['submit-picked-photos']({}, '123', ['a']);
            await expect(handlers['submit-picked-photos']({}, '124', ['a'])).resolves.toEqual({
                success: false,
                error: 'Challenge no longer active',
            });
            finish({ success: true, submitted: 1 });
            await first;
            stubAuthGuardOk();
            stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 125 }] }) });
            submitPicked.mockRejectedValueOnce(new Error('boom'));
            await expect(handlers['submit-picked-photos']({}, '125', ['a'])).resolves.toEqual({
                success: false,
                error: 'boom',
            });
            submitPicked.mockResolvedValueOnce({ success: true, submitted: 1 });
            await expect(handlers['submit-picked-photos']({}, '125', ['a'])).resolves.toEqual({
                success: true,
                submitted: 1,
            });
        });
    });
});

describe('suggest-photos', () => {
    const liveChallenge = { id: 123, title: 'C' };
    const photo = (id: string, extra: object = {}) => ({
        id,
        labels: ['Pink'],
        permission: { allowed: true },
        ...extra,
    });
    const suggested = (ids: string[] = ['a1', 'b2'], statsLimited = false) => ({
        status: 'suggested' as const,
        photos: ids.map((id) => photo(id)),
        statsLimited,
    });
    const mapped = (id: string) => ({
        id,
        labels: ['Pink'],
        allowed: true,
        message: null,
        uploadDate: null,
    });
    const stubLive = (challenges: object[] = [liveChallenge]) =>
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges }) });
    const suggest = (id: string | number = '123') => buildHandlers()['suggest-photos']({}, id);

    beforeEach(() => {
        autoFill.suggestFillPhotos.mockReset().mockResolvedValue(suggested());
        autoFill.resolveMemberId.mockReset().mockResolvedValue('member-9');
        stubAuthGuardOk();
        stubLive();
    });

    test('rejects when the auth guard fails, without ranking', async () => {
        stubAuthGuardFail();
        await expect(suggest()).resolves.toEqual({ success: false, error: 'No authentication token found' });
        expect(autoFill.suggestFillPhotos).not.toHaveBeenCalled();
    });

    test('answers challenge-ended when the live challenge is gone or could not be read', async () => {
        stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 999 }] }),
            getMemberChallenges: jest.fn().mockResolvedValue(null),
        });
        await expect(suggest()).resolves.toEqual({ success: false, error: 'challenge-ended' });
        expect(autoFill.suggestFillPhotos).not.toHaveBeenCalled();
    });

    test('a joined challenge ranks from the active list without ignoreOnly, reading no discover list', async () => {
        await expect(suggest()).resolves.toEqual({
            success: true,
            memberId: 'member-9',
            photos: [mapped('a1'), mapped('b2')],
            statsLimited: false,
        });
        const [, , , , opts] = autoFill.suggestFillPhotos.mock.calls[0];
        expect(opts).toEqual({ usage: undefined, exclude: new Set(), ignoreOnly: false });
    });

    test('an open-list hit ranks the Discover-row challenge with ignoreOnly', async () => {
        const openChallenge = { id: 555, title: 'O' };
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [] }),
            getMemberChallenges: jest.fn().mockResolvedValue([openChallenge]),
        });
        await expect(suggest('555')).resolves.toMatchObject({ success: true });
        expect(strategy.getMemberChallenges).toHaveBeenCalledTimes(1);
        expect(strategy.getMemberChallenges).toHaveBeenCalledWith('tok', 'open');
        const [challenge, , , , opts] = autoFill.suggestFillPhotos.mock.calls[0];
        expect(challenge).toBe(openChallenge);
        expect(opts).toEqual({ usage: undefined, exclude: new Set(), ignoreOnly: true });
    });

    test('an upcoming-list hit ranks the Discover-row challenge with ignoreOnly after the open list misses', async () => {
        const upcomingChallenge = { id: 777, title: 'U' };
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [] }),
            getMemberChallenges: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([upcomingChallenge]),
        });
        await expect(suggest('777')).resolves.toMatchObject({ success: true });
        expect(strategy.getMemberChallenges).toHaveBeenNthCalledWith(1, 'tok', 'open');
        expect(strategy.getMemberChallenges).toHaveBeenNthCalledWith(2, 'tok', 'upcoming');
        const [challenge, , , , opts] = autoFill.suggestFillPhotos.mock.calls[0];
        expect(challenge).toBe(upcomingChallenge);
        expect(opts).toEqual({ usage: undefined, exclude: new Set(), ignoreOnly: true });
    });

    test('answers challenge-ended when the active list and both discover lists miss (a failed read is a miss)', async () => {
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue(null),
            getMemberChallenges: jest.fn().mockResolvedValue(null),
        });
        await expect(suggest('999')).resolves.toEqual({ success: false, error: 'challenge-ended' });
        expect(autoFill.suggestFillPhotos).not.toHaveBeenCalled();
        expect(strategy.getMemberChallenges).toHaveBeenCalledTimes(2);
    });

    test('ranks the live challenge with settings and the strategy, no submitter, and answers the mapped photos with the member id', async () => {
        const strategy = stubLive();
        const result = await suggest();
        expect(result).toEqual({
            success: true,
            memberId: 'member-9',
            photos: [mapped('a1'), mapped('b2')],
            statsLimited: false,
        });
        expect(autoFill.suggestFillPhotos).toHaveBeenCalledTimes(1);
        const [challenge, token, deps] = autoFill.suggestFillPhotos.mock.calls[0];
        expect(challenge).toBe(liveChallenge);
        expect(token).toBe('tok');
        expect(deps.settings).toBe(settings);
        expect(deps.getEligiblePhotos).toBe(strategy.getEligiblePhotos);
        expect(deps).not.toHaveProperty('submitToChallenge');
        expect(autoFill.resolveMemberId).toHaveBeenCalledWith(
            'tok',
            strategy.getCurrentMemberProfile,
            expect.anything(),
            'suggest',
        );
    });

    test.each([['submit' as const], ['swap' as const], [undefined]])(
        'forwards the usage %s to the ranking, which reads submit eligibility when it is not given',
        async (usage) => {
            await buildHandlers()['suggest-photos']({}, '123', usage);
            const [, , , count, opts] = autoFill.suggestFillPhotos.mock.calls[0];
            expect(count).toBeUndefined();
            expect(opts).toEqual({ usage, exclude: new Set(), ignoreOnly: false });
        },
    );

    test.each([['everyone'], [null], [7], [{}]])('refuses the usage %j before looking up the token', async (usage) => {
        const handlers = buildHandlers();
        await expect(handlers['suggest-photos']({}, '123', invalid<'swap'>(usage))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        expect(autoFill.suggestFillPhotos).not.toHaveBeenCalled();
    });

    test('passes the exclude ids on to the ranking as a set, and logs their count, not the ids', async () => {
        await buildHandlers()['suggest-photos']({}, '123', 'submit', ['a1', 'b2', 'a1']);
        const [, , , , opts] = autoFill.suggestFillPhotos.mock.calls[0];
        expect(opts).toEqual({ usage: 'submit', exclude: new Set(['a1', 'b2']), ignoreOnly: false });
        expect(logCategories('info', '📝 Photo suggestions request: Challenge=123, Excluded=3', null)).toEqual([
            'autoSubmit',
        ]);
    });

    test('accepts an exclude list of exactly the cap and an empty one', async () => {
        const full = Array.from({ length: MAX_SUGGEST_EXCLUDE }, (_, i) => `p${i}`);
        await expect(buildHandlers()['suggest-photos']({}, '123', 'submit', full)).resolves.toMatchObject({
            success: true,
        });
        await expect(buildHandlers()['suggest-photos']({}, '123', 'submit', [])).resolves.toMatchObject({
            success: true,
        });
    });

    test.each([
        ['not an array', 'a1'],
        ['a non-string', ['a1', 7]],
        ['a bad id', ['a1', 'not ok!']],
        ['more than the cap', Array.from({ length: MAX_SUGGEST_EXCLUDE + 1 }, (_, i) => `p${i}`)],
    ])('refuses an exclude list that is %s, without ranking', async (_name, exclude) => {
        await expect(
            buildHandlers()['suggest-photos']({}, '123', 'submit', invalid<string[]>(exclude)),
        ).resolves.toEqual({ success: false, error: 'invalid-args' });
        expect(autoFill.suggestFillPhotos).not.toHaveBeenCalled();
    });

    test('answers no-more-suggestions, not no-eligible, when an exclude list was sent and no suggested photo has a safe id', async () => {
        autoFill.suggestFillPhotos.mockResolvedValue(suggested(['not ok!']));
        await expect(buildHandlers()['suggest-photos']({}, '123', 'submit', ['a1'])).resolves.toEqual({
            success: false,
            error: 'no-more-suggestions',
        });
        // An empty list is a first press: the plain code.
        await expect(buildHandlers()['suggest-photos']({}, '123', 'submit', [])).resolves.toEqual({
            success: false,
            error: 'no-eligible',
        });
    });

    test('reports statsLimited', async () => {
        autoFill.suggestFillPhotos.mockResolvedValue(suggested(['a1'], true));
        await expect(suggest()).resolves.toMatchObject({ success: true, statsLimited: true });
    });

    test('offers only photos whose id is a safe token, best first', async () => {
        autoFill.suggestFillPhotos.mockResolvedValue(suggested(['b2', 'not ok!', 'a1']));
        const result = await suggest();
        expect(result).toMatchObject({ success: true, photos: [mapped('b2'), mapped('a1')] });
    });

    test('answers no-eligible when no suggested photo has a safe id', async () => {
        autoFill.suggestFillPhotos.mockResolvedValue(suggested(['not ok!']));
        await expect(suggest()).resolves.toEqual({ success: false, error: 'no-eligible' });
        expect(autoFill.resolveMemberId).not.toHaveBeenCalled();
    });

    test.each([
        [{ status: 'fetch-error' as const, error: new Error('secret network text') }, 'fetch-failed'],
        [{ status: 'no-chosen-entered' as const }, 'no-chosen-entered'],
        [{ status: 'no-chosen-unusable' as const }, 'no-chosen-unusable'],
        [{ status: 'no-match' as const }, 'no-match'],
        [{ status: 'no-eligible' as const }, 'no-eligible'],
        [{ status: 'no-more-suggestions' as const }, 'no-more-suggestions'],
    ])('maps the service answer %j to the code %s', async (answer, code) => {
        autoFill.suggestFillPhotos.mockResolvedValue(answer);
        await expect(suggest()).resolves.toEqual({ success: false, error: code });
    });

    test('a failed ranking leaves nothing behind: the next call ranks again', async () => {
        autoFill.suggestFillPhotos.mockResolvedValueOnce({ status: 'no-match' });
        await suggest();
        await expect(suggest()).resolves.toMatchObject({ success: true });
        expect(autoFill.suggestFillPhotos).toHaveBeenCalledTimes(2);
    });

    test('answers suggest-busy while a ranking runs (for any challenge), and again after it ends', async () => {
        let finish: (value: ReturnType<typeof suggested>) => void = () => undefined;
        autoFill.suggestFillPhotos.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
        const first = suggest('123');
        await expect(suggest('124')).resolves.toEqual({ success: false, error: 'suggest-busy' });
        expect(logCategories('info', '📝 Photo suggestions refused: a ranking is already running', null)).toEqual([
            'autoSubmit',
        ]);
        finish(suggested());
        await expect(first).resolves.toMatchObject({ success: true });
        expect(autoFill.suggestFillPhotos).toHaveBeenCalledTimes(1);
        // The flag was released: this one reaches the challenge resolution, which no longer has 124
        // (the discover lists miss too).
        stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [liveChallenge] }),
            getMemberChallenges: jest.fn().mockResolvedValue(null),
        });
        await expect(suggest('124')).resolves.toEqual({ success: false, error: 'challenge-ended' });
    });

    test('a ranking that throws answers suggest-failed with no raw text, logs it, and releases the flag', async () => {
        const err = new Error('secret token abc');
        autoFill.suggestFillPhotos.mockRejectedValueOnce(err);
        const result = await suggest();
        expect(result).toEqual({ success: false, error: 'suggest-failed' });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(logCategories('error', 'Error handling suggest-photos request:', err)).toEqual(['autoSubmit']);
        await expect(suggest()).resolves.toMatchObject({ success: true });
    });

    test('logs the challenge, never a photo id', async () => {
        await suggest();
        const logged = logger.withCategory.mock.results.flatMap((result) =>
            Object.values(result.value as Record<string, jest.Mock<unknown, unknown[]>>).flatMap(
                (fn): unknown[][] => fn.mock.calls,
            ),
        );
        expect(JSON.stringify(logged)).not.toContain('a1');
        expect(logCategories('info', '📝 Photo suggestions request: Challenge=123, Excluded=0', null)).toEqual([
            'autoSubmit',
        ]);
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
    test('asks for the open list and the upcoming one itself, and returns the open items', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue([{ id: 1 }]) });
        const result = await listChallenges();
        expect(strategy.getMemberChallenges).toHaveBeenCalledWith('tok', 'open');
        expect(strategy.getMemberChallenges).toHaveBeenCalledWith('tok', 'upcoming');
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
            const result = await listChallenges();
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

        test('the saved list is answered with its ids, as saved', async () => {
            mockChosenSettings({ own: { '7': ['secret-a'] } });
            expect((await open())[0]).toEqual(expect.objectContaining({ chosenOwn: ['secret-a'] }));
        });

        test('the annotations read the settings only: no identity lookup, no extra challenge fetch', async () => {
            const getMemberChallenges = jest
                .fn<Promise<unknown[]>, [string, string]>()
                .mockResolvedValue([{ id: 7, title: 'Pink' }, {}, { id: 8 }]);
            const strategy = stubStrategy({ getMemberChallenges });
            mockChosenSettings({ own: { '7': ['a'], '8': ['b'] } });
            const result = await listChallenges();
            expect(result.success).toBe(true);
            expect(autoFill.resolveMemberId).not.toHaveBeenCalled();
            expect(strategy.getCurrentMemberProfile).not.toHaveBeenCalled();
            expect(getMemberChallenges.mock.calls.map((call) => String(call.at(1)))).toEqual(['open', 'upcoming']);
        });
    });
});

describe('get-open-chosen-annotations — read from the settings', () => {
    const ask = (ids: unknown) =>
        invalid<(event: unknown, ids: unknown) => Promise<unknown>>(buildHandlers()['get-open-chosen-annotations'])(
            {},
            ids,
        );

    beforeEach(() => {
        clearOpenChallenges();
        jest.mocked(settings.loadSettings).mockReturnValue(invalid({ auth: { token: 'tok' } }));
        mockChosenSettings({ own: { '7': ['a', 'b'] }, inherited: ['g'] });
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
        await listChallenges();
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
        await listChallenges();
        clearOpenChallenges();
        await ask([9]);
        expect(settings.resolveRuleSetting).toHaveBeenLastCalledWith('chosenPhotos', { id: 9 });
    });

    test.each([
        ['not an array', '7'],
        ['an item that is not an id', [7, {}]],
        ['a blank id', ['  ']],
        ['one id too many (301)', Array.from({ length: 301 }, (_, i) => i + 1)],
    ])('refuses %s', async (_name, ids) => {
        await expect(ask(ids)).resolves.toEqual({ success: false, error: 'invalid-args' });
    });

    // Up to 300: the open list and the 100 upcoming rows Discover shows.
    test.each([[200], [250], [300]])('%p ids are answered, and 300 is the most', async (count) => {
        const ids = Array.from({ length: count }, (_, i) => i + 1);
        const result = await ask(ids);
        if (!isPlainObject(result) || result.success !== true || !isPlainObject(result.annotations)) {
            throw new Error('expected a successful answer');
        }
        expect(Object.keys(result.annotations)).toHaveLength(count);
    });

    test('an empty list is fine', async () => {
        await expect(ask([])).resolves.toEqual({ success: true, annotations: {} });
    });

    test('a failing settings read is an error result, never a throw', async () => {
        jest.mocked(settings.getChallengeOverride).mockImplementation(() => {
            throw new Error('read failed');
        });
        await expect(ask([7])).resolves.toEqual({ success: false, error: 'read failed', annotations: {} });
        jest.mocked(settings.getChallengeOverride).mockImplementation(() => {
            throw new Error('');
        });
        await expect(ask([7])).resolves.toEqual({
            success: false,
            error: 'Failed to read the chosen photos',
            annotations: {},
        });
    });
});

describe('forget-unconfirmed-payment', () => {
    test('forgets through the strategy and answers success', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({
            forgetUnconfirmedPayment: jest
                .fn<Promise<ForgetOutcome>, [string | number, string]>()
                .mockResolvedValue({ status: 'forgotten', challengeId: 5 }),
        });
        const result = await buildHandlers()['forget-unconfirmed-payment']({}, 5);
        expect(strategy.forgetUnconfirmedPayment).toHaveBeenCalledWith(5, 'tok');
        expect(result).toEqual({ success: true, status: 'forgotten' });
    });

    test.each(['nothing-to-forget', 'busy', 'unreadable', 'locks-unavailable', 'not-authenticated'] as const)(
        'a %s answer is a failure that names it, and never throws',
        async (status) => {
            stubAuthGuardOk();
            stubStrategy({
                forgetUnconfirmedPayment: jest
                    .fn<Promise<ForgetOutcome>, [string | number, string]>()
                    .mockResolvedValue({ status, challengeId: 5 }),
            });
            expect(await buildHandlers()['forget-unconfirmed-payment']({}, 5)).toEqual({
                success: false,
                error: status,
                status,
            });
        },
    );

    // A claim is keyed by its challenge id: an id with a colon in it is not one.
    test.each([['555:123'], ['abc'], ['1.5'], ['-1'], [' 5'], ['5\n'], ['0x10'], [1.5], [-1]])(
        'the id %p is not a plain challenge id: refused, and nothing is forgotten',
        async (id) => {
            stubAuthGuardOk();
            const strategy = stubStrategy({ forgetUnconfirmedPayment: jest.fn() });
            expect(await buildHandlers()['forget-unconfirmed-payment']({}, invalid(id))).toMatchObject({
                success: false,
                error: 'invalid-args',
            });
            expect(strategy.forgetUnconfirmedPayment).not.toHaveBeenCalled();
        },
    );

    test.each([['123'], [123]])('a plain id (%p) goes through', async (id) => {
        stubAuthGuardOk();
        const strategy = stubStrategy({
            forgetUnconfirmedPayment: jest
                .fn<Promise<ForgetOutcome>, [string | number, string]>()
                .mockResolvedValue({ status: 'forgotten', challengeId: id }),
        });
        expect(await buildHandlers()['forget-unconfirmed-payment']({}, id)).toEqual({
            success: true,
            status: 'forgotten',
        });
        expect(strategy.forgetUnconfirmedPayment).toHaveBeenCalledWith(id, 'tok');
    });

    test.each([[undefined], [null], [{}], [''], [[]]])(
        'an invalid id %p is refused, and nothing is forgotten',
        async (id) => {
            stubAuthGuardOk();
            const strategy = stubStrategy({ forgetUnconfirmedPayment: jest.fn() });
            const result = await buildHandlers()['forget-unconfirmed-payment']({}, invalid(id));
            expect(result).toMatchObject({ success: false, error: 'invalid-args' });
            expect(strategy.forgetUnconfirmedPayment).not.toHaveBeenCalled();
        },
    );

    test('without a login it forgets nothing', async () => {
        stubAuthGuardFail();
        const strategy = stubStrategy({ forgetUnconfirmedPayment: jest.fn() });
        // The status is what the dialog words as "log in again": the guard's reply alone would read as "try again".
        expect(await buildHandlers()['forget-unconfirmed-payment']({}, 5)).toEqual({
            success: false,
            error: 'No authentication token found',
            status: 'not-authenticated',
        });
        expect(strategy.forgetUnconfirmedPayment).not.toHaveBeenCalled();
    });

    test('a strategy that throws becomes a {success,error} reply', async () => {
        stubAuthGuardOk();
        stubStrategy({ forgetUnconfirmedPayment: jest.fn().mockRejectedValue(new Error('boom')) });
        expect(await buildHandlers()['forget-unconfirmed-payment']({}, 5)).toMatchObject({ success: false });
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

    test('the balance the join recorded before a payment travels with the answer as it is', async () => {
        stubAuthGuardOk();
        stubStrategy({
            joinChallenge: jest
                .fn<Promise<JoinSingleResult>, [string | number, boolean, string, number?]>()
                .mockResolvedValueOnce({
                    status: 'charged-pending-submit',
                    challengeId: 5,
                    cost: 100,
                    reason: 'unconfirmed',
                    coinsBefore: 500,
                })
                .mockResolvedValueOnce({ status: 'joined', challengeId: 5, cost: 100 }),
        });
        expect(await buildHandlers()['join-challenge']({}, 5, true)).toMatchObject({
            reason: 'unconfirmed',
            coinsBefore: 500,
        });
        // Which answers carry one is decided where the join is made (performJoin), not here.
        expect(await buildHandlers()['join-challenge']({}, 5, true)).toMatchObject({ coinsBefore: undefined });
    });

    test('an upcoming challenge is not joined: not-started is a failure that carries its status', async () => {
        stubAuthGuardOk();
        stubStrategy({
            joinChallenge: jest.fn().mockResolvedValue({ status: 'not-started', cost: 0, challengeId: 5 }),
        });
        const result = await buildHandlers()['join-challenge']({}, 5, true);
        expect(result).toMatchObject({ success: false, status: 'not-started', challengeId: 5 });
    });

    test('the cost the confirmation named is passed on, and only when there is one', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({ joinChallenge: jest.fn().mockResolvedValue({ status: 'joined' }) });
        await buildHandlers()['join-challenge']({}, 5, true, 100);
        expect(strategy.joinChallenge).toHaveBeenLastCalledWith(5, true, 'tok', 100);
        await buildHandlers()['join-challenge']({}, 5, true, 0);
        expect(strategy.joinChallenge).toHaveBeenLastCalledWith(5, true, 'tok', 0);
        await buildHandlers()['join-challenge']({}, 5, true);
        expect(strategy.joinChallenge).toHaveBeenLastCalledWith(5, true, 'tok');
    });

    test.each([
        ['-1', -1],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['a string', '5'],
        ['null', null],
        ['an object', {}],
    ])('a cost that is %s is refused, and joins nothing', async (_name, expectedCost) => {
        stubAuthGuardOk();
        const strategy = stubStrategy({ joinChallenge: jest.fn() });
        await expect(buildHandlers()['join-challenge']({}, 5, true, invalid(expectedCost))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        expect(strategy.joinChallenge).not.toHaveBeenCalled();
    });

    test('the reason a paid retry could not finish travels with the answer, and is absent otherwise', async () => {
        stubAuthGuardOk();
        const strategy = stubStrategy({
            joinChallenge: jest
                .fn<Promise<JoinSingleResult>, [string | number, boolean, string, number?]>()
                .mockResolvedValueOnce({
                    status: 'charged-pending-submit',
                    challengeId: 5,
                    cost: 100,
                    reason: 'no-photo',
                })
                .mockResolvedValueOnce({ status: 'charged-pending-submit', challengeId: 5, cost: 100 }),
        });
        const withReason = await buildHandlers()['join-challenge']({}, 5, false);
        const without = await buildHandlers()['join-challenge']({}, 5, false);
        expect(withReason).toMatchObject({ success: false, status: 'charged-pending-submit', reason: 'no-photo' });
        expect(without).toMatchObject({ status: 'charged-pending-submit', reason: undefined });
        expect(strategy.joinChallenge).toHaveBeenCalledTimes(2);
    });

    test('the log names the cap that is enforced, a number or "none"', async () => {
        stubAuthGuardOk();
        stubStrategy({ joinChallenge: jest.fn().mockResolvedValue({ status: 'joined' }) });
        await buildHandlers()['join-challenge']({}, 5, true, 100);
        await buildHandlers()['join-challenge']({}, 5, true, 0);
        await buildHandlers()['join-challenge']({}, 5, false);
        const line = (cap: string) =>
            `▶️ Join request: Challenge=5, spendCoins=${cap === 'none' ? 'false' : 'true'}, expectedCost=${cap}`;
        expect(logCategories('info', line('100'), null)).toEqual(['join']);
        expect(logCategories('info', line('0'), null)).toEqual(['join']);
        expect(logCategories('info', line('none'), null)).toEqual(['join']);
    });

    test('a price that rose answers needs-confirm with the live cost', async () => {
        stubAuthGuardOk();
        stubStrategy({ joinChallenge: jest.fn().mockResolvedValue({ status: 'needs-confirm', cost: 150 }) });
        expect(await buildHandlers()['join-challenge']({}, 5, true, 100)).toMatchObject({
            success: false,
            status: 'needs-confirm',
            cost: 150,
        });
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
    beforeEach(() => __resetSnapUnavailableForTests());

    const snapResult = (overrides: Partial<Extract<TurboGameResult, { kind: 'snap' }>> = {}) => ({
        kind: 'snap' as const,
        answered: 10,
        total: 10,
        meanAgreement: 72,
        won: true,
        stopReason: 'completed' as const,
        ...overrides,
    });

    const liveTurboChallenge = (overrides = {}) => ({
        id: 123,
        title: 'Live Title',
        close_time: NOW() + 3600,
        member: { turbo: { state: 'FREE', mode: 'classic' } },
        ...overrides,
    });

    test('allows play when a TIMER cooldown has already elapsed', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [
                    liveTurboChallenge({
                        member: { turbo: { state: 'TIMER', mode: 'classic', time_to_open: NOW() - 10 } },
                    }),
                ],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        strategy.runTurboGame.mockResolvedValue({
            kind: 'classic',
            played: 3,
            correct: 3,
            won: true,
            flipped: 0,
            doubleFailed: 0,
        });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({
            success: true,
            result: { kind: 'classic', played: 3, correct: 3, won: true, flipped: 0, doubleFailed: 0 },
        });
    });

    test('refuses a TIMER whose cooldown has not elapsed yet', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [
                    liveTurboChallenge({
                        member: { turbo: { state: 'TIMER', mode: 'classic', time_to_open: NOW() + 600 } },
                    }),
                ],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({ success: false, error: 'Turbo not playable (state=TIMER)' });
        expect(strategy.runTurboGame).not.toHaveBeenCalled();
    });

    test.each([
        ['FREE', 'FREE'],
        ['IN_PROGRESS', 'IN_PROGRESS'],
        ['TIMER', 'TIMER'],
    ])('plays a Snap-mode %s turbo through the manual bypass', async (state) => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [
                    liveTurboChallenge({ member: { turbo: { state, mode: 'snap', time_to_open: NOW() - 10 } } }),
                ],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        strategy.runTurboGame.mockResolvedValue(snapResult());
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({ success: true, result: snapResult() });
        expect(strategy.runTurboGame).toHaveBeenCalledTimes(1);
    });

    test('a Snap turbo that is not playable is refused with its state', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { mode: 'snap' } } })],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({ success: false, error: 'Turbo not playable (state=unknown)' });
        expect(strategy.runTurboGame).not.toHaveBeenCalled();
    });

    test('a manual run ignores the unavailable marker, so the user can retry a Snap', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { state: 'FREE', mode: 'snap' } } })],
            }),
        });
        markSnapUnavailable(123);
        // The real decision (autoTurbo off in the stubbed settings) declines; the manual path still plays.
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        strategy.runTurboGame.mockResolvedValue(snapResult());
        const handlers = buildHandlers();
        await expect(handlers['play-auto-turbo']({}, '123', 'C')).resolves.toMatchObject({ success: true });
        expect(strategy.runTurboGame).toHaveBeenCalledTimes(1);
    });

    test('a manual run passes no cancellation, so a stopped autovote does not stop it', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { state: 'FREE', mode: 'snap' } } })],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        strategy.runTurboGame.mockResolvedValue(snapResult());
        await buildHandlers()['play-auto-turbo']({}, '123', 'C');
        expect(strategy.runTurboGame.mock.calls[0]).toHaveLength(2);
    });

    test.each([
        [
            'no-model',
            'Snap needs the vision model, which this build does not include; turn on snapYesWithoutModel to play it',
        ],
        ['withdrawn', 'Snap is no longer offered for this challenge'],
        ['unavailable', 'Snap is no longer offered for this challenge'],
        ['unparsed-caption', 'Snap question could not be answered'],
        ['judge-failed', 'Snap question could not be answered'],
        ['request-failed', 'Snap was interrupted; try again later'],
        ['vote-unclear', 'Snap was interrupted; try again later'],
        ['cancelled', 'Snap was interrupted; try again later'],
    ] as const)('a Snap game that stopped on %s answers with a fixed error', async (stopReason, error) => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { state: 'FREE', mode: 'snap' } } })],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        const stopped = snapResult({ answered: 4, meanAgreement: 61, won: false, stopReason });
        strategy.runTurboGame.mockResolvedValue(stopped);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({ success: false, error, result: stopped });
    });

    test('a Snap result is whitelisted field by field', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { state: 'FREE', mode: 'snap' } } })],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        strategy.runTurboGame.mockResolvedValue({ ...snapResult(), secret: 'leak' } as ReturnType<typeof snapResult>);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(Object.keys((result as Extract<typeof result, { result: unknown }>).result || {}).sort()).toEqual(
            ['answered', 'kind', 'meanAgreement', 'stopReason', 'total', 'won'].sort(),
        );
    });

    test('a classic-mode FREE turbo still plays through the manual bypass', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { state: 'FREE', mode: 'classic' } } })],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        strategy.runTurboGame.mockResolvedValue({
            kind: 'classic',
            played: 3,
            correct: 3,
            won: true,
            flipped: 0,
            doubleFailed: 0,
        });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toMatchObject({ success: true });
        expect(strategy.runTurboGame).toHaveBeenCalledTimes(1);
    });

    test('refuses a turbo with no mode without playing it', async () => {
        setToken('tok');
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { state: 'FREE' } } })],
            }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(false);
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toEqual({ success: false, error: 'Turbo mode unknown; try again later' });
        expect(strategy.runTurboGame).not.toHaveBeenCalled();
    });

    test('reports state=unknown when the challenge has no turbo state', async () => {
        setToken('tok');
        stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({
                challenges: [liveTurboChallenge({ member: { turbo: { mode: 'classic' } } })],
            }),
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
        strategy.runTurboGame.mockResolvedValue({ kind: 'classic', played: 1, correct: 1 });
        const handlers = buildHandlers();

        await handlers['play-auto-turbo']({}, '123', 'Caller Title');
        expect(strategy.runTurboGame).toHaveBeenLastCalledWith(
            expect.objectContaining({ id: 123, title: 'Caller Title' }),
            'tok',
        );

        await handlers['play-auto-turbo']({}, '123', invalid(undefined));
        expect(strategy.runTurboGame).toHaveBeenLastCalledWith(
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
        strategy.runTurboGame.mockResolvedValue(null);
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
        await expect(listChallenges()).resolves.toEqual({
            success: false,
            error: 'No authentication token found',
        });
    });

    test('remembers the open list for the settings cleanup — readable ids only, and only when the fetch succeeded', async () => {
        stubAuthGuardOk();
        stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue([{ id: 1 }, { id: '2' }, {}, null]) });
        await listChallenges();
        expect(settings.rememberOpenChallengeIds).toHaveBeenLastCalledWith([1, '2']);
        settings.rememberOpenChallengeIds.mockClear();
        settings.rememberUpcomingChallenges.mockClear();
        stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue(null) });
        await listChallenges();
        expect(settings.rememberOpenChallengeIds).not.toHaveBeenCalled();
        expect(settings.rememberUpcomingChallenges).not.toHaveBeenCalled();
    });

    test('a failed open list is a failure, not an empty list, and nothing is remembered', async () => {
        stubAuthGuardOk();
        clearOpenChallenges();
        const strategy = stubStrategy({ getMemberChallenges: jest.fn().mockResolvedValue(null) });
        expect(await listChallenges()).toEqual({ success: false, error: 'Could not list challenges', items: [] });
        // Both lists were asked for, and neither is kept: not the ids, not the challenges.
        expect(strategy.getMemberChallenges).toHaveBeenCalledWith('tok', 'open');
        expect(strategy.getMemberChallenges).toHaveBeenCalledWith('tok', 'upcoming');
        expect(settings.rememberOpenChallengeIds).not.toHaveBeenCalled();
        expect(settings.rememberUpcomingChallenges).not.toHaveBeenCalled();
        mockChosenSettings({ rule: { value: ['r1'] } });
        setToken('tok');
        await invalid<(event: object, ids: unknown) => Promise<unknown>>(
            buildHandlers()['get-open-chosen-annotations'],
        )({}, [1]);
        expect(settings.resolveRuleSetting).toHaveBeenLastCalledWith('chosenPhotos', { id: 1 });
    });

    test('a failed open list is a failure even when the upcoming list came', async () => {
        stubAuthGuardOk();
        stubStrategy({
            getMemberChallenges: jest.fn(async (_token: string, filter: string) =>
                filter === 'upcoming' ? [{ id: 2, start_time: 9_999_999_999 }] : null,
            ),
        });
        expect(await listChallenges()).toEqual({ success: false, error: 'Could not list challenges', items: [] });
    });

    test.each([
        ['its message', new Error('503'), '503'],
        ['the generic fallback', new Error(''), 'Failed to list challenges'],
        ['the generic fallback for a thrown null', null, 'Failed to list challenges'],
    ])('returns %s with an empty list when listing throws', async (_label, err, expected) => {
        stubAuthGuardOk();
        stubStrategy({ getMemberChallenges: jest.fn().mockRejectedValue(err) });
        await expect(listChallenges()).resolves.toEqual({
            success: false,
            items: [],
            error: expected,
        });
    });
});

describe('get-member-challenges — upcoming challenges', () => {
    const T0 = 1_800_000_000;
    const HOUR = 3600;
    const up = (id: number, startsIn: number, over: object = {}) => ({
        id,
        title: `Up ${id}`,
        status: 'upcoming',
        start_time: T0 + startsIn,
        ...over,
    });
    // The server answers each filter apart; a function as `upcoming` is called, and may throw.
    const lists = (open: unknown, upcoming: unknown) =>
        jest.fn(async (_token: string, filter: string) => {
            if (filter === 'upcoming' && typeof upcoming === 'function') (upcoming as () => void)();
            return filter === 'upcoming' ? upcoming : open;
        });
    const throwing = (value: unknown) => () => {
        throw value;
    };
    const withWindow = (hours: unknown) =>
        jest
            .mocked(settings.getEffectiveSetting)
            .mockImplementation(invalid((key: string) => (key === 'discoverUpcomingHours' ? hours : [])));
    const shown = async () => {
        const result = await listChallenges();
        return result.success ? result.items.map((c) => [c.id, c.status]) : [];
    };

    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(T0 * 1000);
        clearOpenChallenges();
        mockChosenSettings({});
        stubAuthGuardOk();
        withWindow(24);
        settings.getUpcomingChallengeIds.mockReset();
    });
    afterEach(() => jest.mocked(Date.now).mockRestore());

    test('merges them behind the open ones: the open copy wins, started and non-finite items drop, soonest first', async () => {
        stubStrategy({
            getMemberChallenges: lists(
                [{ id: 1, status: 'started' }, { id: 5 }],
                [
                    up(30, 3 * HOUR),
                    up(5, 2 * HOUR), // also open: the open copy
                    up(20, 1 * HOUR),
                    up(21, 1 * HOUR), // same start: by id
                    up(40, -60), // already started (server lag)
                    up(41, 0), // starts this very second: not after now
                    up(42, Number.NaN),
                    up(43, 25 * HOUR), // outside the window
                    { id: 44, status: 'upcoming' }, // no start_time
                    null,
                ],
            ),
        });
        expect(await shown()).toEqual([
            [1, undefined], // an open row carries no status, whatever the server said
            [5, undefined],
            [20, 'upcoming'],
            [21, 'upcoming'],
            [30, 'upcoming'],
        ]);
    });

    test('the window: 24 h by default, the far end inclusive, a custom value, and 0 = off', async () => {
        stubStrategy({ getMemberChallenges: lists([], [up(1, 24 * HOUR), up(2, 24 * HOUR + 1), up(3, 100 * HOUR)]) });
        expect(await shown()).toEqual([[1, 'upcoming']]);
        clearUpcomingCache();
        withWindow(100);
        expect(await shown()).toEqual([
            [1, 'upcoming'],
            [2, 'upcoming'],
            [3, 'upcoming'],
        ]);
        clearUpcomingCache();
        withWindow(0);
        expect(await shown()).toEqual([]);
    });

    test('shows at most the 100 soonest upcoming rows', async () => {
        const many = Array.from({ length: 150 }, (_, i) => up(1000 + i, 60 + i));
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], many) });
        const result = await listChallenges();
        expect(result.success && result.items).toHaveLength(101);
        expect(result.success && result.items.at(-1)?.id).toBe(1099);
    });

    test('records EVERY upcoming id for the cleanup, whatever the window shows, even with the window at 0', async () => {
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], [up(2, HOUR), up(3, 100 * HOUR), up(4, -5)]) });
        withWindow(0);
        expect(await shown()).toEqual([[1, undefined]]);
        expect(settings.rememberUpcomingChallenges).toHaveBeenLastCalledWith([
            expect.objectContaining({ id: 2 }),
            expect.objectContaining({ id: 3 }),
            expect.objectContaining({ id: 4 }),
        ]);
        expect(settings.rememberOpenChallengeIds).toHaveBeenLastCalledWith([1]);
    });

    test('a failed upcoming fetch keeps the open list and the previous upcoming ids, and logs the filter and the kind only', async () => {
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], null) });
        expect(await shown()).toEqual([[1, undefined]]);
        expect(settings.rememberUpcomingChallenges).not.toHaveBeenCalled();
        expect(settings.rememberOpenChallengeIds).toHaveBeenCalledWith([1]);
        expect(logCategories('warning', 'Could not list challenges (filter=upcoming: failed)')).toEqual(['api']);

        // Thrown, with the account's token and a member id in the message: neither reaches the log.
        const secret = new TypeError('401 for tok member-77');
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], throwing(secret)) });
        expect(await shown()).toEqual([[1, undefined]]);
        expect(settings.rememberUpcomingChallenges).not.toHaveBeenCalled();
        expect(logCategories('warning', 'Could not list challenges (filter=upcoming: TypeError)')).toEqual(['api']);
        expect(logCategories('warning', 'Could not list challenges (filter=upcoming: failed)')).toEqual(['api']);
        const logged = JSON.stringify(
            jest
                .mocked(logger.withCategory)
                .mock.results.flatMap(
                    (r) =>
                        jest.mocked((r.value as { warning: jest.MockedFunction<(m: string) => void> }).warning).mock
                            .calls,
                ),
        );
        expect(logged).not.toContain('tok');
        expect(logged).not.toContain('member-77');
        // A thrown value that is no Error is named by its type.
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], throwing('boom')) });
        clearUpcomingCache();
        await shown();
        expect(logCategories('warning', 'Could not list challenges (filter=upcoming: string)')).toEqual(['api']);
    });

    test('an empty upcoming answer is a real one: the recorded ids become empty', async () => {
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], []) });
        await shown();
        expect(settings.rememberUpcomingChallenges).toHaveBeenLastCalledWith([]);
    });

    test('the upcoming list is fetched once for a burst of calls, again after a minute or a logout, and a failure is not kept', async () => {
        const strategy = stubStrategy({ getMemberChallenges: lists([{ id: 1 }], [up(2, HOUR)]) });
        const upcomingCalls = () =>
            strategy.getMemberChallenges.mock.calls.filter(([, filter]) => filter === 'upcoming').length;
        await Promise.all([shown(), shown(), shown()]);
        await shown();
        expect(upcomingCalls()).toBe(1);
        // The open list is never cached.
        expect(strategy.getMemberChallenges.mock.calls.filter(([, filter]) => filter === 'open')).toHaveLength(4);
        jest.mocked(Date.now).mockReturnValue((T0 + 59) * 1000);
        await shown();
        expect(upcomingCalls()).toBe(1);
        jest.mocked(Date.now).mockReturnValue((T0 + 61) * 1000);
        await shown();
        expect(upcomingCalls()).toBe(2);
        clearUpcomingCache();
        await shown();
        expect(upcomingCalls()).toBe(3);

        // A failed fetch is asked again on the next call.
        const flaky = stubStrategy({ getMemberChallenges: lists([{ id: 1 }], null) });
        clearUpcomingCache();
        await shown();
        await shown();
        expect(flaky.getMemberChallenges.mock.calls.filter(([, filter]) => filter === 'upcoming')).toHaveLength(2);
    });

    test('a login that replaced the token empties the upcoming cache', async () => {
        const strategy = stubStrategy({ getMemberChallenges: lists([], [up(2, HOUR)]) });
        await shown();
        // What a login that replaces the token does (forgetAccountMemory).
        clearUpcomingCache();
        auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'other', settings: {} });
        await shown();
        expect(strategy.getMemberChallenges.mock.calls.filter(([, filter]) => filter === 'upcoming')).toEqual([
            ['tok', 'upcoming'],
            ['other', 'upcoming'],
        ]);
    });

    test('a challenge the upcoming feed has dropped but the open one does not list yet keeps resolving its rules', async () => {
        // First load: 2 is upcoming. The settings facade (mocked here) has recorded it.
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], [up(2, 60, { title: 'Rule Match' })]) });
        await listChallenges();
        // Its start passes: the feed drops it, the open list lacks it, and the facade still holds its id.
        clearUpcomingCache();
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], []) });
        settings.getUpcomingChallengeIds.mockReturnValue(new Set(['2']));
        await listChallenges();
        mockChosenSettings({ rule: { value: ['r1'] } });
        setToken('tok');
        const annotations = invalid<(event: object, ids: unknown) => Promise<unknown>>(
            buildHandlers()['get-open-chosen-annotations'],
        );
        await expect(annotations({}, [2])).resolves.toEqual({
            success: true,
            annotations: { '2': { chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 1 } },
        });
        // Resolved by its remembered title, not as a bare id.
        expect(settings.resolveRuleSetting).toHaveBeenCalledWith(
            'chosenPhotos',
            expect.objectContaining({ id: 2, title: 'Rule Match' }),
        );
    });

    test('an id the facade no longer holds is forgotten with the rest of the old list', async () => {
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], [up(2, 60, { title: 'Rule Match' })]) });
        await listChallenges();
        clearUpcomingCache();
        stubStrategy({ getMemberChallenges: lists([{ id: 1 }], []) });
        settings.getUpcomingChallengeIds.mockReturnValue(new Set());
        await listChallenges();
        mockChosenSettings({ rule: { value: ['r1'] } });
        setToken('tok');
        const annotations = invalid<(event: object, ids: unknown) => Promise<unknown>>(
            buildHandlers()['get-open-chosen-annotations'],
        );
        await annotations({}, [2]);
        expect(settings.resolveRuleSetting).toHaveBeenLastCalledWith('chosenPhotos', { id: 2 });
    });

    describe('a request still in flight when a login replaced the token', () => {
        const inFlight = () => {
            let release: (value: unknown) => void = () => undefined;
            const gate = new Promise((resolve) => (release = resolve));
            const getMemberChallenges = jest.fn(async (_token: string, filter: string) => {
                await gate;
                return filter === 'upcoming' ? [up(2, HOUR)] : [{ id: 1 }];
            });
            stubStrategy({ getMemberChallenges });
            return { release: () => release(undefined) };
        };

        test('the lists are answered but nothing is remembered for the account they were not read under', async () => {
            stubAuthGuardOk();
            const { release } = inFlight();
            const pending = listChallenges();
            // What a login that replaces the token does (switchAccountToken, forgetAccountMemory):
            // the stored token the next write compares against is no longer the request's.
            jest.mocked(settings.getSetting).mockReturnValueOnce('tok-2');
            release();
            const answer = await pending;
            expect(answer).toMatchObject({ success: true });
            expect(settings.rememberOpenChallengeIds).not.toHaveBeenCalled();
            expect(settings.rememberUpcomingChallenges).not.toHaveBeenCalled();
        });

        test('the token being unchanged, the same request writes as usual', async () => {
            stubAuthGuardOk();
            jest.mocked(settings.getSetting).mockReturnValue('tok');
            const { release } = inFlight();
            const pending = listChallenges();
            release();
            expect((await pending).success).toBe(true);
            expect(settings.rememberOpenChallengeIds).toHaveBeenCalledWith([1]);
        });
    });

    test('annotations resolve through the merged list: a rule keyed on an upcoming title gives its list', async () => {
        stubStrategy({
            getMemberChallenges: lists([{ id: 1, title: 'Open' }], [up(2, HOUR, { title: 'Rule Match' })]),
        });
        await listChallenges();
        mockChosenSettings({ rule: { value: ['r1'] } });
        setToken('tok');
        await expect(
            invalid<(event: object, ids: unknown) => Promise<unknown>>(buildHandlers()['get-open-chosen-annotations'])(
                {},
                [2],
            ),
        ).resolves.toEqual({
            success: true,
            annotations: { '2': { chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 1 } },
        });
        expect(settings.resolveRuleSetting).toHaveBeenCalledWith(
            'chosenPhotos',
            expect.objectContaining({ id: 2, title: 'Rule Match' }),
        );
    });

    test('keeps the upcoming rows annotated like open ones, with their own saved list', async () => {
        stubStrategy({ getMemberChallenges: lists([], [up(2, HOUR)]) });
        mockChosenSettings({ own: { '2': ['early'] } });
        withWindow(24);
        const result = await listChallenges();
        expect(result.success && result.items[0]).toEqual(
            expect.objectContaining({ id: 2, status: 'upcoming', chosenOwn: ['early'], chosenOwnCount: 1 }),
        );
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

describe('the library listing an action of this window outdates', () => {
    const live = { id: 123, title: 'C' };
    // A listing kept for the challenge (and one for another), as the chooser's walk leaves them.
    const keepListings = () => {
        const listing = {
            photos: [],
            memberId: 'm',
            wonIds: [],
            wonCount: 0,
            truncated: false,
            nextStart: 0,
            allowedKnown: true,
            readAtMs: Date.now(),
        };
        writeListing('123', listing);
        writeListing('124', listing);
        writeListing(null, listing);
    };
    const kept = (id: string | null) => readFresh(id) !== null;
    const expectDropped = () => {
        expect(kept('123')).toBe(false);
        // Only that challenge's: another's, and the no-challenge one, stay.
        expect(kept('124')).toBe(true);
        expect(kept(null)).toBe(true);
    };
    const expectKept = () => expect([kept('123'), kept('124'), kept(null)]).toEqual([true, true, true]);
    const liveStrategy = () =>
        stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [live] }) });

    describe('submit-picked-photos', () => {
        test.each([
            ['is done', () => Promise.resolve({ success: true, submitted: 1 })],
            ['is refused', () => Promise.resolve({ success: false, error: 'submit-rejected' })],
            ['is unclear', () => Promise.resolve({ success: false, error: 'submit-unclear' })],
            ['throws after the challenge was read', () => Promise.reject(new Error('boom'))],
        ])('drops the challenge’s listing when the submit %s', async (_name, outcome) => {
            stubAuthGuardOk();
            liveStrategy();
            keepListings();
            autoFill.submitPickedPhotos.mockReset().mockImplementation(invalid(outcome));
            await buildHandlers()['submit-picked-photos']({}, '123', ['a']);
            expectDropped();
        });

        test.each([
            ['invalid arguments', () => buildHandlers()['submit-picked-photos']({}, '123', invalid<string[]>('x'))],
            [
                'no token',
                () => {
                    stubAuthGuardFail();
                    return buildHandlers()['submit-picked-photos']({}, '123', ['a']);
                },
            ],
            [
                'a challenge that is no longer active',
                () => {
                    stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [] }) });
                    return buildHandlers()['submit-picked-photos']({}, '123', ['a']);
                },
            ],
        ])('keeps it with %s: nothing was sent', async (_name, act) => {
            stubAuthGuardOk();
            keepListings();
            await act();
            expectKept();
        });

        test('keeps it when a second submit is turned away as busy, and drops it once the first one ends', async () => {
            stubAuthGuardOk();
            liveStrategy();
            keepListings();
            let finish: (value: { success: true; submitted: number }) => void = () => undefined;
            autoFill.submitPickedPhotos.mockReset().mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
            const first = buildHandlers()['submit-picked-photos']({}, '123', ['a']);
            await expect(buildHandlers()['submit-picked-photos']({}, '123', ['b'])).resolves.toEqual({
                success: false,
                error: 'submit-busy',
            });
            expectKept();
            finish({ success: true, submitted: 1 });
            await first;
            expectDropped();
        });
    });

    describe('fill-challenge-now', () => {
        test.each([
            ['is done', () => Promise.resolve({ success: true, submitted: 1, skipped: 0 })],
            [
                'finds nothing to submit',
                () => Promise.resolve({ success: false, submitted: 0, skipped: 2, error: 'x' }),
            ],
            ['throws', () => Promise.reject(new Error('boom'))],
        ])('drops the challenge’s listing when the fill %s', async (_name, outcome) => {
            stubAuthGuardOk();
            liveStrategy();
            keepListings();
            autoFill.fillChallengeNow = jest.fn().mockImplementation(outcome);
            await buildHandlers()['fill-challenge-now']({}, '123', 'one');
            expectDropped();
        });

        test.each([
            ['invalid arguments', () => buildHandlers()['fill-challenge-now']({}, invalid<string>({}), 'one')],
            [
                'no token',
                () => {
                    stubAuthGuardFail();
                    return buildHandlers()['fill-challenge-now']({}, '123', 'one');
                },
            ],
            [
                'a challenge that is no longer active',
                () => {
                    stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [] }) });
                    return buildHandlers()['fill-challenge-now']({}, '123', 'one');
                },
            ],
        ])('keeps it with %s: nothing was filled', async (_name, act) => {
            stubAuthGuardOk();
            keepListings();
            await act();
            expectKept();
        });
    });

    describe('join-challenge', () => {
        test('drops the challenge’s listing when it joined', async () => {
            stubAuthGuardOk();
            stubStrategy({ joinChallenge: jest.fn().mockResolvedValue({ status: 'joined', challengeId: 123 }) });
            keepListings();
            await buildHandlers()['join-challenge']({}, 123, true);
            expectDropped();
        });

        test.each([
            ['needs-confirm', { status: 'needs-confirm', challengeId: 123, cost: 50 }],
            ['not-started', { status: 'not-started', challengeId: 123 }],
            ['no answer', null],
        ])('keeps it when the join comes to %s', async (_name, outcome) => {
            stubAuthGuardOk();
            stubStrategy({ joinChallenge: jest.fn().mockResolvedValue(outcome) });
            keepListings();
            await buildHandlers()['join-challenge']({}, 123, true);
            expectKept();
        });

        test('keeps it with invalid arguments, no token or a throw', async () => {
            keepListings();
            stubAuthGuardOk();
            await buildHandlers()['join-challenge']({}, invalid<string>({}), true);
            stubAuthGuardFail();
            await buildHandlers()['join-challenge']({}, 123, true);
            stubAuthGuardOk();
            stubStrategy({ joinChallenge: jest.fn().mockRejectedValue(new Error('boom')) });
            await buildHandlers()['join-challenge']({}, 123, true);
            expectKept();
        });
    });
});
