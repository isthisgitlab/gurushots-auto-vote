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

jest.mock('../../src/js/settings');
jest.mock('../../src/js/apiFactory');
jest.mock('../../src/js/services/auth');
jest.mock('../../src/js/services/VotingLogic');
jest.mock('../../src/js/services/autoFill');
jest.mock('../../src/js/api/main', () => ({ runTurboMiniGame: jest.fn() }));
jest.mock('../../src/js/mock/auth', () => ({
    mockLoginSuccess: {
        token: 'mock-token-xyz',
        user: { id: 1, username: 'mockuser', display_name: 'Mock User' },
    },
    mockLoginFailure: { message: 'Mock auth failed' },
}));
jest.mock('../../src/js/api/login', () => ({ authenticate: jest.fn() }));

const settings = require('../../src/js/settings');
const apiFactory = require('../../src/js/apiFactory');
const auth = require('../../src/js/services/auth');
const votingLogic = require('../../src/js/services/VotingLogic');
const autoFill = require('../../src/js/services/autoFill');
const apiMain = require('../../src/js/api/main');
const realLogin = require('../../src/js/api/login');

const NOW = () => Math.floor(Date.now() / 1000);

const setToken = (token) => {
    settings.loadSettings = jest.fn().mockReturnValue({ token });
};

const stubStrategy = (overrides = {}) => {
    const strategy = {
        getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [] }),
        applyTurbo: jest.fn(),
        applyBoostToEntry: jest.fn(),
        getEligiblePhotos: jest.fn(),
        submitToChallenge: jest.fn(),
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

// Note on module-scoped state: actions.handlers keeps `turboMiniGameInFlight`
// at module scope. The handler's try/finally always clears its slot, so as
// long as every test awaits the calls it makes, the Set stays empty between
// tests — no jest.resetModules() needed (and it would defeat module-top
// jest.mock() bindings anyway by giving the handler fresh mock instances).
const { buildHandlers } = require('../../src/js/ipc/actions.handlers');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('get-active-challenges', () => {
    test('delegates to strategy.getActiveChallenges with the token', async () => {
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: 1 }] }),
        });
        const handlers = buildHandlers();
        const result = await handlers['get-active-challenges']({}, 'tok');
        expect(strategy.getActiveChallenges).toHaveBeenCalledWith('tok');
        expect(result).toEqual({ challenges: [{ id: 1 }] });
    });

    test('rethrows strategy errors', async () => {
        stubStrategy({ getActiveChallenges: jest.fn().mockRejectedValue(new Error('fetch fail')) });
        const handlers = buildHandlers();
        await expect(handlers['get-active-challenges']({}, 'tok')).rejects.toThrow('fetch fail');
    });
});

describe('authenticate', () => {
    test('mock path returns success with mock token', async () => {
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'user@example.com', 'pw', true);
        expect(result.success).toBe(true);
        expect(result.token).toBe('mock-token-xyz');
        expect(result.user.email).toBe('user@example.com');
    });

    test('real path returns success when API responds with token', async () => {
        realLogin.authenticate.mockResolvedValue({
            token: 'real-token',
            member_id: 42,
            user_name: 'realuser',
        });
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'user@example.com', 'pw', false);
        expect(result.success).toBe(true);
        expect(result.token).toBe('real-token');
        expect(result.user).toMatchObject({ id: 42, email: 'user@example.com', username: 'realuser' });
    });

    test('real path returns failure when API returns null', async () => {
        realLogin.authenticate.mockResolvedValue(null);
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'u', 'p', false);
        expect(result).toEqual({ success: false, message: 'Authentication failed - no response from server' });
    });

    test('real path returns failure when API responds without a token', async () => {
        realLogin.authenticate.mockResolvedValue({ success: false, error: 'bad creds' });
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'u', 'p', false);
        expect(result.success).toBe(false);
        expect(result.message).toBe('bad creds');
    });

    test('real path catches network errors and returns formatted failure', async () => {
        realLogin.authenticate.mockRejectedValue(new Error('ECONNREFUSED'));
        const handlers = buildHandlers();
        const result = await handlers.authenticate({}, 'u', 'p', false);
        expect(result).toEqual({ success: false, message: 'ECONNREFUSED' });
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
        stubStrategy({
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
        apiMain.runTurboMiniGame.mockResolvedValue({ played: 5, correct: 5, won: true, flipped: 0, doubleFailed: 0 });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result.success).toBe(true);
        expect(apiMain.runTurboMiniGame).toHaveBeenCalled();
    });

    test('returns "no battles" when mini-game played 0', async () => {
        setToken('tok');
        const now = NOW();
        stubStrategy({
            getActiveChallenges: jest
                .fn()
                .mockResolvedValue({ challenges: [{ id: 123, title: 'C', close_time: now + 3600 }] }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        apiMain.runTurboMiniGame.mockResolvedValue({ played: 0, correct: 0, won: false });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result).toMatchObject({ success: false, error: 'No battles to play right now' });
    });

    test('returns "not earned" when mini-game played but not all correct', async () => {
        setToken('tok');
        const now = NOW();
        stubStrategy({
            getActiveChallenges: jest
                .fn()
                .mockResolvedValue({ challenges: [{ id: 123, title: 'C', close_time: now + 3600 }] }),
        });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        apiMain.runTurboMiniGame.mockResolvedValue({ played: 5, correct: 0, won: false, flipped: 5, doubleFailed: 1 });
        const handlers = buildHandlers();
        const result = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not earned/i);
        // Whitelist check: only the documented fields are forwarded.
        expect(Object.keys(result.result || {}).sort()).toEqual(
            ['correct', 'doubleFailed', 'flipped', 'played', 'won'].sort(),
        );
    });

    test('in-flight guard: second simultaneous call for the same challenge is rejected', async () => {
        setToken('tok');
        const now = NOW();
        // First call's getActiveChallenges hangs forever — keeps the
        // in-flight slot held so the second call sees it occupied.
        let releaseFirst;
        const firstHang = new Promise((resolve) => {
            releaseFirst = resolve;
        });
        const strategy = stubStrategy({ getActiveChallenges: jest.fn().mockReturnValue(firstHang) });
        votingLogic.shouldPlayAutoTurbo = jest.fn().mockReturnValue(true);
        apiMain.runTurboMiniGame.mockResolvedValue({ played: 5, correct: 5, won: true });
        const handlers = buildHandlers();

        const firstPromise = handlers['play-auto-turbo']({}, '123', 'C');
        // Second call should see the in-flight slot held and bail early.
        const secondResult = await handlers['play-auto-turbo']({}, '123', 'C');
        expect(secondResult).toEqual({
            success: false,
            error: 'A turbo run is already in progress for this challenge',
        });

        // Release the first call so the test doesn't leak a pending promise.
        releaseFirst({ challenges: [{ id: 999 }] }); // no live challenge → first returns no-longer-active
        await firstPromise;
        // Sanity: strategy was not called twice for the second attempt.
        expect(strategy.getActiveChallenges).toHaveBeenCalledTimes(1);
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
        expect(result.error).toBe('turbo rejected with newlines');
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
        await handlers['fill-challenge-now']({}, '123', 'wat');
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
