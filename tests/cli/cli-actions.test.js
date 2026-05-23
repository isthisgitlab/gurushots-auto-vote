/**
 * Unit tests for the CLI parity commands: the one-shot actions
 * (boost / turbo / fill), single-challenge manual vote, logout, and
 * check-updates. These commands are thin wrappers that reuse the GUI's
 * code paths — the boost picker in api/boost and the IPC handlers — so the
 * tests assert the wiring: auth guard, challenge resolution, correct
 * dispatch + args, and success/error reporting. The handlers, api/boost,
 * the middleware, the update checker, and the logger are all mocked.
 */

jest.mock('../../src/js/logger.js', () => {
    const calls = [];
    const rec = (level) => (msg, data) => calls.push({ level, msg, data });
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

jest.mock('../../src/js/settings.js', () => ({
    getSetting: jest.fn(() => 'tok'),
    setSetting: jest.fn(() => true),
    loadSettings: jest.fn(() => ({ mock: true, token: 'tok' })),
    getEffectiveSetting: jest.fn(),
}));

jest.mock('../../src/js/apiFactory', () => {
    const getActiveChallenges = jest.fn();
    const isAuthenticated = jest.fn(() => true);
    return {
        __getActiveChallenges: getActiveChallenges,
        __isAuthenticated: isAuthenticated,
        getMiddleware: jest.fn(() => ({ isAuthenticated, getActiveChallenges })),
        getApiStrategy: jest.fn(),
        refreshApi: jest.fn(),
    };
});

jest.mock('../../src/js/api/boost', () => ({ applyBoost: jest.fn() }));

jest.mock('../../src/js/ipc/actions.handlers', () => {
    const handlers = {
        'apply-boost-to-entry': jest.fn(),
        'play-auto-turbo': jest.fn(),
        'fill-challenge-now': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

jest.mock('../../src/js/ipc/voting.handlers', () => {
    const handlers = { 'vote-on-challenge-manual': jest.fn() };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

jest.mock('../../src/js/scheduling/runScheduler', () => ({ createScheduler: jest.fn() }));

jest.mock('../../src/js/services/UpdateChecker', () => ({
    checkForUpdates: jest.fn(),
    getReleasesUrl: jest.fn(() => 'https://github.com/owner/repo/releases/latest'),
}));

const logger = require('../../src/js/logger.js');
const settings = require('../../src/js/settings.js');
const apiFactory = require('../../src/js/apiFactory');
const boostApi = require('../../src/js/api/boost');
const actionsHandlers = require('../../src/js/ipc/actions.handlers').__handlers;
const votingHandlers = require('../../src/js/ipc/voting.handlers').__handlers;
const updateChecker = require('../../src/js/services/UpdateChecker');

const { boostChallenge, turboChallenge, fillChallenge } = require('../../src/js/cli/commands/actions');
const { voteChallengeManual } = require('../../src/js/cli/commands/voting');
const { handleLogout } = require('../../src/js/cli/commands/auth');
const { checkUpdates } = require('../../src/js/cli/commands/update');

const msgsAt = (level) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const allMsgs = () => logger.__calls.map((c) => String(c.msg));
const contains = (arr, sub) => arr.some((s) => s.includes(sub));

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
    apiFactory.__isAuthenticated.mockReturnValue(true);
    apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [{ id: 111, title: 'Sunset' }] });
    settings.getSetting.mockReturnValue('tok');
});

describe('CLI boost command', () => {
    test('no --image: reuses api/boost.applyBoost (resolves boostImageIndex) and reports success', async () => {
        boostApi.applyBoost.mockResolvedValue({ ok: true });

        await boostChallenge('111', {});

        expect(boostApi.applyBoost).toHaveBeenCalledWith({ id: 111, title: 'Sunset' }, 'tok');
        expect(actionsHandlers['apply-boost-to-entry']).not.toHaveBeenCalled();
        expect(contains(msgsAt('success'), 'Sunset')).toBe(true);
    });

    test('--image routes to the apply-boost-to-entry handler with the explicit id', async () => {
        actionsHandlers['apply-boost-to-entry'].mockResolvedValue({ success: true });

        await boostChallenge('111', { imageId: 'img9' });

        expect(actionsHandlers['apply-boost-to-entry']).toHaveBeenCalledWith(null, '111', 'img9');
        expect(boostApi.applyBoost).not.toHaveBeenCalled();
        expect(contains(msgsAt('success'), 'img9')).toBe(true);
    });

    test('a null/failed boost is reported as an error', async () => {
        boostApi.applyBoost.mockResolvedValue(null);

        await boostChallenge('111', {});

        expect(contains(msgsAt('error'), 'Failed to apply boost')).toBe(true);
    });

    test('not authenticated: does not boost, prompts to login', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);

        await boostChallenge('111', {});

        expect(boostApi.applyBoost).not.toHaveBeenCalled();
        expect(apiFactory.__getActiveChallenges).not.toHaveBeenCalled();
        expect(contains(allMsgs(), 'Run: login')).toBe(true);
    });

    test('unknown challenge: errors without dispatching', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [] });

        await boostChallenge('999', {});

        expect(boostApi.applyBoost).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'not found')).toBe(true);
    });
});

describe('CLI turbo command', () => {
    test('delegates to play-auto-turbo with the resolved title and reports success', async () => {
        actionsHandlers['play-auto-turbo'].mockResolvedValue({ success: true });

        await turboChallenge('111');

        expect(actionsHandlers['play-auto-turbo']).toHaveBeenCalledWith(null, '111', 'Sunset');
        expect(contains(msgsAt('success'), 'Sunset')).toBe(true);
    });

    test('surfaces the handler error message', async () => {
        actionsHandlers['play-auto-turbo'].mockResolvedValue({
            success: false,
            error: 'Turbo not playable (state=TIMER)',
        });

        await turboChallenge('111');

        expect(contains(msgsAt('error'), 'Turbo not playable')).toBe(true);
    });
});

describe('CLI fill command', () => {
    test('default mode "one"', async () => {
        actionsHandlers['fill-challenge-now'].mockResolvedValue({ success: true, submitted: 1, skipped: 0 });

        await fillChallenge('111', {});

        expect(actionsHandlers['fill-challenge-now']).toHaveBeenCalledWith(null, '111', 'one');
        expect(contains(msgsAt('success'), 'submitted 1')).toBe(true);
    });

    test('--all maps to mode "all"', async () => {
        actionsHandlers['fill-challenge-now'].mockResolvedValue({ success: true, submitted: 2, skipped: 1 });

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

describe('CLI logout command', () => {
    test('clears the stored token when one is present', () => {
        settings.getSetting.mockReturnValue('tok');

        handleLogout();

        expect(settings.setSetting).toHaveBeenCalledWith('token', '');
        expect(contains(msgsAt('success'), 'Logged out')).toBe(true);
    });

    test('reports already-logged-out when no token was set', () => {
        settings.getSetting.mockReturnValue('');

        handleLogout();

        expect(settings.setSetting).toHaveBeenCalledWith('token', '');
        expect(contains(allMsgs(), 'Already logged out')).toBe(true);
    });
});

describe('CLI check-updates command', () => {
    test('reports up to date when no newer release', async () => {
        updateChecker.checkForUpdates.mockResolvedValue({ updateAvailable: false });

        await checkUpdates();

        expect(contains(msgsAt('success'), 'up to date')).toBe(true);
    });

    test('prints the version and download URL when an update is available', async () => {
        updateChecker.checkForUpdates.mockResolvedValue({
            updateAvailable: true,
            version: '2.0.0',
            downloadUrl: 'https://example.com/app.dmg',
            releaseDate: '2026-01-01T00:00:00Z',
            isPrerelease: false,
        });

        await checkUpdates();

        expect(contains(allMsgs(), '2.0.0')).toBe(true);
        expect(contains(allMsgs(), 'https://example.com/app.dmg')).toBe(true);
    });

    test('on error, prints the failure and the releases URL', async () => {
        updateChecker.checkForUpdates.mockResolvedValue({ error: 'rate limited' });

        await checkUpdates();

        expect(contains(msgsAt('error'), 'rate limited')).toBe(true);
        expect(contains(allMsgs(), 'releases/latest')).toBe(true);
    });

    test('tells the user it does not self-update when an update is available', async () => {
        updateChecker.checkForUpdates.mockResolvedValue({
            updateAvailable: true,
            version: '2.0.0',
            downloadUrl: 'https://example.com/app.dmg',
        });

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

        expect(boostApi.applyBoost).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'Failed to fetch challenges')).toBe(true);
    });

    test('boost --image: handler failure surfaces the error', async () => {
        actionsHandlers['apply-boost-to-entry'].mockResolvedValue({ success: false, error: 'entry not found' });

        await boostChallenge('111', { imageId: 'imgX' });

        expect(contains(msgsAt('error'), 'entry not found')).toBe(true);
    });

    test('boost: a thrown applyBoost is caught', async () => {
        boostApi.applyBoost.mockRejectedValue(new Error('boom'));

        await expect(boostChallenge('111', {})).resolves.toBeUndefined();
        expect(contains(msgsAt('error'), 'Failed to apply boost')).toBe(true);
    });

    test('turbo: a thrown handler is caught', async () => {
        actionsHandlers['play-auto-turbo'].mockRejectedValue(new Error('boom'));

        await expect(turboChallenge('111')).resolves.toBeUndefined();
        expect(contains(msgsAt('error'), 'Failed to play turbo')).toBe(true);
    });

    test('fill: a thrown handler is caught', async () => {
        actionsHandlers['fill-challenge-now'].mockRejectedValue(new Error('boom'));

        await expect(fillChallenge('111', {})).resolves.toBeUndefined();
        expect(contains(msgsAt('error'), 'Failed to fill challenge')).toBe(true);
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
