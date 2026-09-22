/**
 * Unit tests for the CLI voting commands (commands/voting.js): manual and
 * strategy cycles, single-challenge manual vote fallbacks, --challenge flag
 * parsing, continuous mode (scheduler wiring + graceful shutdown) and the
 * status banner. The middleware, scheduler, auth service and handlers are
 * mocked; process signal / exit / stdin hooks are stubbed per test.
 */

jest.mock('../../src/js/logger.js', () => {
    const calls = [];
    const rec = (level) => (msg, data) => calls.push({ level, msg, data });
    const cat = {
        info: rec('info'),
        error: rec('error'),
        success: rec('success'),
        debug: rec('debug'),
        startOperation: rec('startOperation'),
        endOperation: rec('endOperation'),
    };
    return { __calls: calls, withCategory: jest.fn(() => cat) };
});

jest.mock('../../src/js/settings', () => ({
    loadSettings: jest.fn(() => ({ mock: true })),
    getEffectiveSetting: jest.fn(),
}));

jest.mock('../../src/js/apiFactory', () => {
    const mw = {
        isAuthenticated: jest.fn(() => true),
        getActiveChallenges: jest.fn(),
        cliVote: jest.fn(),
        cliVoteManual: jest.fn(),
    };
    return { __mw: mw, getMiddleware: jest.fn(() => mw) };
});

jest.mock('../../src/js/scheduling/runScheduler', () => ({ createScheduler: jest.fn() }));
jest.mock('../../src/js/dateFormat', () => ({ formatDateTime: jest.fn(() => 'NOW') }));
jest.mock('../../src/js/voting/boostWindow', () => ({ openBoostWindows: jest.fn(() => []) }));
jest.mock('../../src/js/services/auth', () => ({ clearTokenUnlessStayingLoggedIn: jest.fn() }));

jest.mock('../../src/js/ipc/voting.handlers', () => {
    const handlers = { 'vote-on-challenge-manual': jest.fn() };
    return { __handlers: handlers, buildHandlers: () => handlers };
});

const logger = require('../../src/js/logger.js');
const settings = require('../../src/js/settings');
const { __mw: mw } = require('../../src/js/apiFactory');
const { createScheduler } = require('../../src/js/scheduling/runScheduler');
const { openBoostWindows } = require('../../src/js/voting/boostWindow');
const { clearTokenUnlessStayingLoggedIn } = require('../../src/js/services/auth');
const votingHandlers = require('../../src/js/ipc/voting.handlers').__handlers;
const {
    runVotingCycle,
    voteChallengeManual,
    parseChallengeFlag,
    startContinuousVoting,
    showStatus,
} = require('../../src/js/cli/commands/voting');

const msgs = (level) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));

beforeEach(() => {
    logger.__calls.length = 0;
    // mockReset (not just the global clearAllMocks) so a queued *Once value
    // from one test can never leak into the next under --randomize.
    [mw.cliVote, mw.cliVoteManual, votingHandlers['vote-on-challenge-manual'], clearTokenUnlessStayingLoggedIn].forEach(
        (m) => m.mockReset(),
    );
    mw.isAuthenticated.mockReturnValue(true);
    mw.getActiveChallenges.mockResolvedValue({ challenges: [{ id: 111, title: 'Sunset' }] });
    settings.loadSettings.mockReturnValue({ mock: true });
    openBoostWindows.mockReturnValue([]);
});

describe('runVotingCycle', () => {
    test('defaults to strategy cycle 1 and reports REAL mode', async () => {
        settings.loadSettings.mockReturnValue({ mock: false });
        mw.cliVote.mockResolvedValue({ success: true, challenges: [] });
        await expect(runVotingCycle()).resolves.toEqual({ success: true, challenges: [] });
        expect(mw.cliVote).toHaveBeenCalledWith(null);
        expect(msgs('info')[0]).toBe('--- Voting Cycle 1 (REAL MODE) ---');
        expect(logger.__calls.find((c) => c.level === 'startOperation').msg).toBe('vote-cycle-1');
    });

    test('scoped strategy cycle names the challenge', async () => {
        mw.cliVote.mockResolvedValue(undefined);
        await expect(runVotingCycle(4, { challengeId: '9' })).resolves.toEqual({ success: true, challenges: null });
        expect(mw.cliVote).toHaveBeenCalledWith('9');
        expect(msgs('info')[0]).toBe('--- Voting Cycle 4 (challenge 9) (MOCK MODE) ---');
    });

    test('manual cycle votes to 100%, ignores the scope and surfaces no list', async () => {
        await expect(runVotingCycle(2, { isManual: true, challengeId: '9' })).resolves.toEqual({
            success: true,
            challenges: null,
        });
        expect(mw.cliVoteManual).toHaveBeenCalled();
        expect(mw.cliVote).not.toHaveBeenCalled();
        expect(msgs('info')[0]).toBe('--- Manual Voting Cycle 2 (MOCK MODE) ---');
        expect(msgs('info')).toContain('Mode: Manual (votes to 100% regardless of threshold settings)');
        expect(logger.__calls.find((c) => c.level === 'startOperation').msg).toBe('manual-vote-cycle-2');
    });

    test.each([
        [{ isManual: true }, 'manual voting'],
        [{}, 'voting'],
    ])('a thrown cycle (%p) is reported and returns failure', async (opts, noun) => {
        mw.cliVoteManual.mockRejectedValueOnce(new Error('x'));
        mw.cliVote.mockRejectedValueOnce(new Error('x'));
        await expect(runVotingCycle(3, opts)).resolves.toEqual({ success: false, challenges: null });
        expect(msgs('error')).toEqual([`Error during ${noun} cycle 3`]);
        expect(msgs('debug')).toEqual([`Full ${noun} cycle error details:`]);
    });
});

describe('voteChallengeManual fallbacks', () => {
    test('a thrown non-Error fetch failure is stringified', async () => {
        mw.getActiveChallenges.mockRejectedValue('offline');
        await expect(voteChallengeManual('111')).resolves.toEqual({
            success: false,
            error: 'Failed to fetch challenges',
        });
        expect(msgs('error')).toEqual(['Failed to fetch challenges: offline']);
    });

    test('a response without a list reports not found', async () => {
        mw.getActiveChallenges.mockResolvedValue(undefined);
        await expect(voteChallengeManual('111')).resolves.toEqual({
            success: false,
            error: 'Challenge 111 not found',
        });
    });

    test('success without a message uses the default wording', async () => {
        votingHandlers['vote-on-challenge-manual'].mockResolvedValue({ success: true });
        await voteChallengeManual('111');
        expect(votingHandlers['vote-on-challenge-manual']).toHaveBeenCalledWith(null, '111', 'Sunset');
        expect(msgs('success')).toEqual(['Voted on "Sunset"']);
    });

    test('failure without an error uses the default wording and returns the result', async () => {
        votingHandlers['vote-on-challenge-manual'].mockResolvedValue(null);
        await expect(voteChallengeManual('111')).resolves.toBeNull();
        expect(msgs('error')).toEqual(['Failed to vote']);
    });

    test('a thrown non-Error handler failure falls back to "Failed to vote"', async () => {
        votingHandlers['vote-on-challenge-manual'].mockRejectedValue('kaput');
        await expect(voteChallengeManual('111')).resolves.toEqual({ success: false, error: 'Failed to vote' });
        expect(msgs('error')).toEqual(['Failed to vote on "Sunset": kaput']);
    });
});

describe('parseChallengeFlag', () => {
    test.each([
        [[], null],
        [['--all'], null],
        [['--challenge', '5'], '5'],
        [['--challenge'], null],
        [['--challenge', ''], null],
        [['x', '--challenge=7'], '7'],
        [['--challenge='], null],
    ])('%p → %p', (argv, expected) => {
        expect(parseChallengeFlag(argv)).toBe(expected);
    });
});

describe('startContinuousVoting', () => {
    let scheduler;
    let signalHandlers;
    let onSpy;
    let resumeSpy;
    let exitSpy;

    beforeEach(() => {
        scheduler = { start: jest.fn().mockResolvedValue(undefined), stop: jest.fn() };
        createScheduler.mockReturnValue(scheduler);
        signalHandlers = {};
        onSpy = jest.spyOn(process, 'on').mockImplementation((sig, fn) => {
            signalHandlers[sig] = fn;
            return process;
        });
        resumeSpy = jest.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    });
    afterEach(() => {
        onSpy.mockRestore();
        resumeSpy.mockRestore();
        exitSpy.mockRestore();
    });

    test('does nothing but warn when not authenticated', async () => {
        settings.loadSettings.mockReturnValue({ mock: false });
        mw.isAuthenticated.mockReturnValue(false);
        await startContinuousVoting();
        expect(msgs('info')[0]).toBe('=== Starting Continuous Voting Mode (REAL MODE) ===');
        expect(createScheduler).not.toHaveBeenCalled();
    });

    test('wires the scheduler, registers signal handlers and keeps the process alive', async () => {
        mw.cliVote.mockResolvedValue({ success: true, challenges: [] });
        await startContinuousVoting();

        expect(msgs('info')[0]).toBe('=== Starting Continuous Voting Mode (MOCK MODE) ===');
        expect(scheduler.start).toHaveBeenCalled();
        expect(signalHandlers.SIGINT).toBe(signalHandlers.SIGTERM);
        expect(resumeSpy).toHaveBeenCalled();
        expect(msgs('info')).toContain('Press Ctrl+C to stop');

        const deps = createScheduler.mock.calls[0][0];
        await expect(deps.runVotingCycle(5)).resolves.toEqual({ success: true, challenges: [] });
        expect(msgs('info')).toContain('--- Voting Cycle 5 (MOCK MODE) ---');
        await expect(deps.getActiveChallenges()).resolves.toEqual({ challenges: [{ id: 111, title: 'Sunset' }] });
    });

    const shutdown = async () => {
        await startContinuousVoting();
        signalHandlers.SIGINT();
        // Let the clear-token promise chain (then/catch/finally) settle.
        await new Promise((r) => setImmediate(r));
    };

    test('shutdown stops the scheduler, reports a cleared token and exits 0', async () => {
        clearTokenUnlessStayingLoggedIn.mockResolvedValue(true);
        await shutdown();
        expect(scheduler.stop).toHaveBeenCalled();
        expect(msgs('info')).toContain('Cleared saved token (Stay Logged In is off)');
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('shutdown with Stay Logged In on keeps the token quietly', async () => {
        clearTokenUnlessStayingLoggedIn.mockResolvedValue(false);
        await shutdown();
        expect(msgs('info')).not.toContain('Cleared saved token (Stay Logged In is off)');
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('a failed token clear is reported and still exits 0', async () => {
        clearTokenUnlessStayingLoggedIn.mockRejectedValue(new Error('disk'));
        await shutdown();
        expect(msgs('error')).toEqual(['Failed to clear token on shutdown']);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});

describe('showStatus', () => {
    test('unauthenticated REAL mode: no token line and no boost-window fetch', async () => {
        settings.loadSettings.mockReturnValue({ mock: false, checkFrequencyMin: 3, checkFrequencyMax: 3 });
        settings.getEffectiveSetting.mockReturnValue(undefined);
        mw.isAuthenticated.mockReturnValue(false);
        await showStatus();
        const info = msgs('info');
        expect(info).toContain('Mode: REAL (live API calls)');
        expect(info).toContain('Authentication: ❌ Not authenticated');
        expect(info.some((l) => l.startsWith('Token:'))).toBe(false);
        expect(info).toContain('  Check Frequency: 3min');
        expect(info).toContain('  Last Minute Check Frequency: 1min');
        expect(mw.getActiveChallenges).not.toHaveBeenCalled();
    });

    test('authenticated without a token, random frequency and per-challenge settings', async () => {
        settings.loadSettings.mockReturnValue({
            mock: true,
            checkFrequencyMin: 2,
            checkFrequencyMax: 5,
            challengeSettings: { 42: { exposure: 80 } },
        });
        settings.getEffectiveSetting.mockReturnValue(2);
        await showStatus();
        const info = msgs('info');
        expect(info).toContain('Token: ❌ Missing');
        expect(info).toContain('  Check Frequency: 2–5min (random per cycle)');
        expect(info).toContain('  Last Minute Check Frequency: 2min');
        expect(info).toContain('  Challenge 42:');
        expect(info).toContain('    exposure: 80');
        expect(info).toContain('  None');
    });

    test('an empty challengeSettings map prints no section', async () => {
        settings.loadSettings.mockReturnValue({ mock: true, token: 't', challengeSettings: {} });
        await showStatus();
        expect(msgs('info')).toContain('Token: ✅ Present');
        expect(msgs('info')).not.toContain('\nChallenge Settings:');
    });

    test('a non-array challenge list is treated as empty', async () => {
        mw.getActiveChallenges.mockResolvedValue({ challenges: 'bad' });
        await showStatus();
        expect(openBoostWindows).toHaveBeenCalledWith([], expect.any(Number));
    });

    test('a thrown non-Error boost-window fetch is reported inline', async () => {
        mw.getActiveChallenges.mockRejectedValue('offline');
        await showStatus();
        expect(msgs('info')).toContain('  (unavailable — offline)');
    });
});
