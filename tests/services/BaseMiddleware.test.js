/**
 * BaseMiddleware — the token-handling wrapper the CLI and the IPC handlers
 * call into. cliVoteManual has its own suite (cliVoteManual.test.js); this one
 * covers login, the vote entry points, auth state, logout and the
 * token-requiring pass-throughs.
 */

jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    getExposureResolver: jest.fn(() => 'resolver'),
}));

jest.mock('../../src/js/services/auth', () => ({
    ...jest.requireActual('../../src/js/services/auth'),
    clearAuthToken: jest.fn(async () => true),
}));

jest.mock('../../src/js/voting/cancellation', () => ({ reset: jest.fn() }));

jest.mock('../../src/js/services/manualVote', () => ({
    voteAllChallengesManual: jest.fn(async () => ({ voted: 1, skipped: 0 })),
}));

const settings = require('../../src/js/settings');
const logger = require('../../src/js/logger');
const cancellation = require('../../src/js/voting/cancellation');
const { clearAuthToken } = require('../../src/js/services/auth');
const BaseMiddleware = require('../../src/js/services/BaseMiddleware');

/** One shared category logger so assertions can see every call. */
let cat;
beforeEach(() => {
    cat = {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
    };
    logger.withCategory.mockReturnValue(cat);
    settings.getSetting.mockReturnValue('tok');
});

const make = (strategy = {}) => new BaseMiddleware(strategy);

describe('cliLogin', () => {
    test('persists the token and reports success', async () => {
        const mw = make({ authenticate: jest.fn(async () => ({ token: 'new-tok' })) });
        await expect(mw.cliLogin('a@b.c', 'pw')).resolves.toEqual({ success: true, token: 'new-tok' });
        expect(mw.apiStrategy.authenticate).toHaveBeenCalledWith('a@b.c', 'pw');
        expect(settings.setSetting).toHaveBeenCalledWith('token', 'new-tok');
        expect(cat.endOperation).toHaveBeenCalledWith('cli-login', 'Authentication successful');
    });

    test('invalid credentials do not persist anything', async () => {
        const mw = make({ authenticate: jest.fn(async () => ({ error: 'bad' })) });
        await expect(mw.cliLogin('a', 'b')).resolves.toEqual({
            success: false,
            error: 'Login failed. Please check your credentials.',
        });
        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(cat.endOperation).toHaveBeenCalledWith('cli-login', null, 'Invalid credentials');
    });

    test('a thrown Error is reported by message', async () => {
        const mw = make({ authenticate: jest.fn().mockRejectedValue(new Error('offline')) });
        await expect(mw.cliLogin('a', 'b')).resolves.toEqual({ success: false, error: 'offline' });
        expect(cat.endOperation).toHaveBeenCalledWith('cli-login', null, 'offline');
    });

    test('a thrown non-Error value is reported as-is', async () => {
        const mw = make({ authenticate: jest.fn().mockRejectedValue('boom') });
        await expect(mw.cliLogin('a', 'b')).resolves.toEqual({ success: false, error: 'boom' });
        expect(cat.endOperation).toHaveBeenCalledWith('cli-login', null, 'boom');
    });
});

describe('guiLogin', () => {
    test('returns the token and the raw response on success', async () => {
        const response = { access_token: 'gui-tok' };
        const mw = make({ authenticate: jest.fn(async () => response) });
        await expect(mw.guiLogin('a', 'b')).resolves.toEqual({ success: true, token: 'gui-tok', data: response });
        expect(settings.setSetting).toHaveBeenCalledWith('token', 'gui-tok');
    });

    test('invalid credentials', async () => {
        const mw = make({ authenticate: jest.fn(async () => null) });
        await expect(mw.guiLogin('a', 'b')).resolves.toEqual({ success: false, error: 'Invalid credentials' });
    });

    test('a throw surfaces its message, or a generic one when it has none', async () => {
        const mw = make({ authenticate: jest.fn().mockRejectedValueOnce(new Error('dns')).mockRejectedValueOnce({}) });
        await expect(mw.guiLogin('a', 'b')).resolves.toEqual({ success: false, error: 'dns' });
        await expect(mw.guiLogin('a', 'b')).resolves.toEqual({ success: false, error: 'Authentication failed' });
    });
});

describe('runVotingCycle', () => {
    test('resets cancellation and returns the fetched challenges on success', async () => {
        const challenges = [{ id: 1 }];
        const fetchChallengesAndVote = jest.fn(async () => ({ success: true, message: 'done', challenges }));
        const mw = make({ fetchChallengesAndVote });
        await expect(mw.runVotingCycle(7)).resolves.toEqual({ success: true, message: 'done', challenges });
        expect(cancellation.reset).toHaveBeenCalled();
        expect(fetchChallengesAndVote).toHaveBeenCalledWith('tok', 'resolver', 7);
    });

    test('defaults to the whole active set and a stock success message', async () => {
        const fetchChallengesAndVote = jest.fn(async () => ({ success: true }));
        const mw = make({ fetchChallengesAndVote });
        await expect(mw.runVotingCycle()).resolves.toEqual({
            success: true,
            message: 'Voting cycle completed successfully',
            challenges: undefined,
        });
        expect(fetchChallengesAndVote).toHaveBeenCalledWith('tok', 'resolver', null);
    });

    test('no token → login-first error without calling the strategy', async () => {
        settings.getSetting.mockReturnValue('');
        const fetchChallengesAndVote = jest.fn();
        const mw = make({ fetchChallengesAndVote });
        await expect(mw.runVotingCycle()).resolves.toEqual({
            success: false,
            error: 'No authentication token found. Please login first.',
        });
        expect(fetchChallengesAndVote).not.toHaveBeenCalled();
        expect(cat.warning).toHaveBeenCalledWith('❌ No authentication token found. Please login first.', null);
    });

    test('a non-error failure still forwards the challenge list', async () => {
        const challenges = [{ id: 2 }];
        const mw = make({
            fetchChallengesAndVote: jest.fn(async () => ({ success: false, error: 'cancelled', challenges })),
        });
        await expect(mw.runVotingCycle(2)).resolves.toEqual({ success: false, error: 'cancelled', challenges });
    });

    test('a missing result is a generic failure', async () => {
        const mw = make({ fetchChallengesAndVote: jest.fn(async () => undefined) });
        await expect(mw.runVotingCycle()).resolves.toEqual({
            success: false,
            error: 'Voting cycle failed',
            challenges: undefined,
        });
    });
});

describe('cliVote', () => {
    test('no token → logs the login hint and fails without voting', async () => {
        settings.getSetting.mockReturnValue(null);
        const fetchChallengesAndVote = jest.fn();
        await expect(make({ fetchChallengesAndVote }).cliVote()).resolves.toEqual({
            success: false,
            error: 'No authentication token found',
        });
        expect(fetchChallengesAndVote).not.toHaveBeenCalled();
        expect(cat.error).toHaveBeenCalledWith('No authentication token found. Please login first', null);
        expect(cat.info).toHaveBeenCalledWith('Run the login command to authenticate', null);
    });

    test('whole-account run returns the strategy result and logs success', async () => {
        const result = { success: true, challenges: [] };
        const fetchChallengesAndVote = jest.fn(async () => result);
        await expect(make({ fetchChallengesAndVote }).cliVote()).resolves.toBe(result);
        expect(fetchChallengesAndVote).toHaveBeenCalledWith('tok', 'resolver', null);
        expect(cat.info).toHaveBeenCalledWith('=== GuruShots Auto Voter - CLI Voting ===', null);
        expect(cat.startOperation).toHaveBeenCalledWith('cli-vote', 'CLI Voting Process');
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote', 'Voting process completed successfully');
    });

    test('a single-challenge run labels its logs with the challenge id', async () => {
        const fetchChallengesAndVote = jest.fn(async () => null);
        await expect(make({ fetchChallengesAndVote }).cliVote(42)).resolves.toBeNull();
        expect(fetchChallengesAndVote).toHaveBeenCalledWith('tok', 'resolver', 42);
        expect(cat.startOperation).toHaveBeenCalledWith('cli-vote', 'CLI Voting Process (challenge 42)');
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote', 'Voting process completed successfully');
    });

    test.each([
        [{ success: false, error: 'inactive' }, 'inactive'],
        [{ success: false, message: 'cancelled' }, 'cancelled'],
        [{ success: false }, 'Voting process did not complete'],
    ])('a non-error failure %p is logged as a failed operation', async (result, reason) => {
        await make({ fetchChallengesAndVote: jest.fn(async () => result) }).cliVote();
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote', null, reason);
    });

    test('a thrown Error or non-Error is caught and reported', async () => {
        const fetchChallengesAndVote = jest.fn().mockRejectedValueOnce(new Error('503')).mockRejectedValueOnce('raw');
        const mw = make({ fetchChallengesAndVote });
        await expect(mw.cliVote()).resolves.toEqual({ success: false, error: '503' });
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote', null, '503');
        await expect(mw.cliVote()).resolves.toEqual({ success: false, error: 'raw' });
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote', null, 'raw');
    });
});

describe('cliVoteManual — edges', () => {
    test('no token → nothing is fetched', async () => {
        settings.getSetting.mockReturnValue(undefined);
        const getActiveChallenges = jest.fn();
        await expect(make({ getActiveChallenges }).cliVoteManual()).resolves.toBeUndefined();
        expect(getActiveChallenges).not.toHaveBeenCalled();
    });

    test('a null response is a failed fetch', async () => {
        await make({ getActiveChallenges: jest.fn(async () => null) }).cliVoteManual();
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote-manual', null, 'failed to fetch challenges');
    });

    test('a response without a challenge list is a failed fetch', async () => {
        await make({ getActiveChallenges: jest.fn(async () => ({})) }).cliVoteManual();
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote-manual', null, 'failed to fetch challenges');
    });

    test('summarises voted / skipped counts', async () => {
        await make({
            getActiveChallenges: jest.fn(async () => ({ challenges: [{ id: 1 }, { id: 2 }] })),
        }).cliVoteManual();
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote-manual', 'Manual vote: 1 voted, 0 skipped of 2');
    });

    test('a thrown Error or non-Error ends the operation with the reason', async () => {
        const getActiveChallenges = jest.fn().mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce('raw');
        const mw = make({ getActiveChallenges });
        await mw.cliVoteManual();
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote-manual', null, 'down');
        await mw.cliVoteManual();
        expect(cat.endOperation).toHaveBeenCalledWith('cli-vote-manual', null, 'raw');
    });
});

describe('guiVote', () => {
    test('runs the whole active set and reports success', async () => {
        const fetchChallengesAndVote = jest.fn(async () => ({ success: true }));
        await expect(make({ fetchChallengesAndVote }).guiVote()).resolves.toEqual({
            success: true,
            data: 'Voting process completed successfully!',
        });
        expect(fetchChallengesAndVote).toHaveBeenCalledWith('tok', 'resolver', null);
    });

    test('no token → login-first error', async () => {
        settings.getSetting.mockReturnValue('');
        await expect(make({ fetchChallengesAndVote: jest.fn() }).guiVote()).resolves.toEqual({
            success: false,
            error: 'No authentication token found. Please login first.',
        });
    });
});

describe('isAuthenticated', () => {
    test.each([
        ['a real token', 'tok', true],
        ['a whitespace-only token', '   ', false],
        ['an empty token', '', false],
        ['no token', undefined, false],
    ])('%s → %p', (_label, token, expected) => {
        settings.getSetting.mockReturnValue(token);
        expect(make().isAuthenticated()).toBe(expected);
    });
});

describe('logout', () => {
    test('clears the token through the shared auth core and logs it', async () => {
        await make().logout();
        expect(clearAuthToken).toHaveBeenCalledTimes(1);
        expect(cat.success).toHaveBeenCalledWith('Logged out successfully', null, null);
    });
});

describe('token-requiring pass-throughs', () => {
    test('getActiveChallenges / applyBoost forward the stored token', () => {
        const strategy = {
            getActiveChallenges: jest.fn(() => 'list'),
            applyBoost: jest.fn(() => 'boosted'),
        };
        const mw = make(strategy);
        expect(mw.getActiveChallenges()).toBe('list');
        expect(strategy.getActiveChallenges).toHaveBeenCalledWith('tok');
        expect(mw.applyBoost({ id: 3 })).toBe('boosted');
        expect(strategy.applyBoost).toHaveBeenCalledWith({ id: 3 }, 'tok');
    });

    test('throw before touching the API when logged out', () => {
        settings.getSetting.mockReturnValue('');
        const strategy = { getActiveChallenges: jest.fn(), applyBoost: jest.fn() };
        const mw = make(strategy);
        expect(() => mw.getActiveChallenges()).toThrow('No authentication token found');
        expect(() => mw.applyBoost({ id: 3 })).toThrow('No authentication token found');
        expect(strategy.getActiveChallenges).not.toHaveBeenCalled();
        expect(strategy.applyBoost).not.toHaveBeenCalled();
    });
});
