/**
 * Unit tests for the CLI voting commands (commands/voting.ts) and the status
 * banner (commands/status.ts): manual and
 * strategy cycles, single-challenge manual vote fallbacks, --challenge flag
 * parsing, continuous mode (scheduler wiring + graceful shutdown) and the
 * status banner. The middleware, scheduler, auth service and handlers are
 * mocked; process signal / exit / stdin hooks are stubbed per test.
 */

jest.mock('../../src/ts/core/logger', () => {
    const calls: { level: string; msg: unknown; data?: unknown }[] = [];
    const rec = (level: string) => (msg: unknown, data?: unknown) => calls.push({ level, msg, data });
    const cat = {
        info: rec('info'),
        warning: rec('warning'),
        error: rec('error'),
        success: rec('success'),
        debug: rec('debug'),
        startOperation: rec('startOperation'),
        endOperation: rec('endOperation'),
    };
    return { __calls: calls, withCategory: jest.fn(() => cat) };
});

jest.mock('../../src/ts/core/settings', () => ({
    loadSettings: jest.fn(() => ({ app: { mock: true }, auth: { token: '' }, challenges: {} })),
    getEffectiveSetting: jest.fn(),
    // The execution-mode lines: no running flag, no fence, no installation scenario.
    getSetting: jest.fn(() => false),
    readStopFence: jest.fn(() => ({ state: 'missing' })),
    getInstallationScenario: jest.fn(() => null),
    getEntryPins: jest.fn(() => ({ boost: null, turbo: null })),
    SETTINGS_SCHEMA: { chosenPhotos: { type: 'photos', perChallenge: true, default: [] } },
}));

jest.mock('../../src/ts/core/apiFactory', () => {
    const mw = {
        isAuthenticated: jest.fn(() => true),
        getActiveChallenges: jest.fn(),
        cliVote: jest.fn(),
        cliVoteManual: jest.fn(),
    };
    return { __mw: mw, getMiddleware: jest.fn(() => mw) };
});

// The mode lines read the installation's pause through the lifecycle handlers; the stop command records through the
// same module's priority routes.
jest.mock('../../src/ts/core/ipc/scenarioLifecycle.handlers', () => {
    const handlers = {
        'get-scenario-snapshot': jest.fn(async () => ({ success: true as const, paused: null })),
        'withdraw-installation': jest.fn(async () => ({ success: true as const, outcome: 'none' })),
        'record-full-stop': jest.fn(async () => ({ success: true as const, epoch: 3 })),
    };
    return { __handlers: handlers, buildLifecycleHandlers: () => handlers };
});

jest.mock('../../src/ts/shells/cli/runScheduler', () => ({ createScheduler: jest.fn() }));
jest.mock('../../src/ts/core/dateFormat', () => ({ formatDateTime: jest.fn(() => 'NOW') }));
jest.mock('../../src/ts/core/voting/boostWindow', () => ({ openBoostWindows: jest.fn(() => []) }));
jest.mock('../../src/ts/core/services/auth', () => ({ clearTokenUnlessStayingLoggedIn: jest.fn() }));

jest.mock('../../src/ts/core/ipc/voting.handlers', () => {
    const handlers = { 'vote-on-challenge-manual': jest.fn() };
    return { __handlers: handlers, buildHandlers: () => handlers };
});

// status reads the automation header through the shared handlers too.
jest.mock('../../src/ts/core/ipc/actions.handlers', () => {
    const handlers = {
        'get-auto-claim-status': jest.fn(async () => ({ success: true as const, enabled: false, nextClaimAt: 0 })),
        'get-auto-join-active': jest.fn(async () => ({ success: true as const, active: false })),
    };
    return { __handlers: handlers, buildHandlers: () => handlers };
});

import { invalid } from '../helpers/invalid';
import type { ConfigV2 } from '../../src/ts/core/types/config';
import loggerModule = require('../../src/ts/core/logger');
const logger = jest.mocked(
    invalid<typeof loggerModule & { __calls: { level: string; msg: unknown; data?: unknown }[] }>(loggerModule),
);
import settingsModule = require('../../src/ts/core/settings');
// The configuration `loadSettings` answers: the app preferences, the sign-in state and the challenges' records.
const config = (over: { app?: object; auth?: object; challenges?: object } = {}) =>
    invalid<ConfigV2>({
        app: { mock: true, ...over.app },
        auth: { token: '', ...over.auth },
        challenges: over.challenges ?? {},
    });

const settings = jest.mocked(settingsModule);
import type * as apiFactoryModule from '../../src/ts/core/apiFactory';
import type * as runSchedulerModule from '../../src/ts/shells/cli/runScheduler';
import type * as boostWindowModule from '../../src/ts/core/voting/boostWindow';
import type * as authModule from '../../src/ts/core/services/auth';
import type * as votingModule from '../../src/ts/shells/cli/commands/voting';
import type * as statusModule from '../../src/ts/shells/cli/commands/status';
import type * as votingHandlersModule from '../../src/ts/core/ipc/voting.handlers';
import type * as lifecycleHandlersModule from '../../src/ts/core/ipc/scenarioLifecycle.handlers';
const { __mw: mw } = jest.mocked(
    require('../../src/ts/core/apiFactory') as typeof apiFactoryModule & {
        __mw: jest.Mocked<
            Pick<
                ReturnType<typeof apiFactoryModule.getMiddleware>,
                'isAuthenticated' | 'getActiveChallenges' | 'cliVote' | 'cliVoteManual'
            >
        >;
    },
);
const { createScheduler } = jest.mocked(require('../../src/ts/shells/cli/runScheduler') as typeof runSchedulerModule);
const { openBoostWindows } = jest.mocked(require('../../src/ts/core/voting/boostWindow') as typeof boostWindowModule);
const { clearTokenUnlessStayingLoggedIn } = jest.mocked(
    require('../../src/ts/core/services/auth') as typeof authModule,
);
// The handler-module mocks expose their jest.fn table for the assertions.
type HandlersMock = {
    __handlers: jest.Mocked<Pick<ReturnType<typeof votingHandlersModule.buildHandlers>, 'vote-on-challenge-manual'>>;
};
const votingHandlers = invalid<HandlersMock>(require('../../src/ts/core/ipc/voting.handlers')).__handlers;
const { runVotingCycle, voteChallengeManual, parseChallengeFlag, startContinuousVoting, stopAllAutomation } =
    require('../../src/ts/shells/cli/commands/voting') as typeof votingModule;
const { showStatus } = require('../../src/ts/shells/cli/commands/status') as typeof statusModule;

// The lifecycle-handler mock's table (the stop command's priority routes).
const lifecycle = invalid<{
    __handlers: jest.Mocked<
        Pick<
            ReturnType<typeof lifecycleHandlersModule.buildLifecycleHandlers>,
            'withdraw-installation' | 'record-full-stop'
        >
    >;
}>(require('../../src/ts/core/ipc/scenarioLifecycle.handlers')).__handlers;

const msgs = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));

beforeEach(() => {
    logger.__calls.length = 0;
    // mockReset (not just the global clearAllMocks) so a queued *Once value
    // from one test can never leak into the next under --randomize.
    [mw.cliVote, mw.cliVoteManual, votingHandlers['vote-on-challenge-manual'], clearTokenUnlessStayingLoggedIn].forEach(
        (m) => m.mockReset(),
    );
    mw.isAuthenticated.mockReturnValue(true);
    mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'Sunset' }] }));
    settings.loadSettings.mockReturnValue(config());
    openBoostWindows.mockReturnValue([]);
});

describe('runVotingCycle', () => {
    test('defaults to strategy cycle 1 and reports REAL mode', async () => {
        settings.loadSettings.mockReturnValue(config({ app: { mock: false } }));
        mw.cliVote.mockResolvedValue({ success: true, challenges: [] });
        await expect(runVotingCycle()).resolves.toEqual({ success: true, challenges: [] });
        expect(mw.cliVote).toHaveBeenCalledWith(null, 'full');
        expect(msgs('info')[0]).toBe('--- Voting Cycle 1 (REAL MODE) ---');
        expect(logger.__calls.find((c) => c.level === 'startOperation')!.msg).toBe('vote-cycle-1');
    });

    test('scoped strategy cycle names the challenge', async () => {
        mw.cliVote.mockResolvedValue(invalid(undefined));
        await expect(runVotingCycle(4, { challengeId: '9' })).resolves.toEqual({ success: true, challenges: null });
        expect(mw.cliVote).toHaveBeenCalledWith('9', 'full');
        expect(msgs('info')[0]).toBe('--- Voting Cycle 4 (challenge 9) (MOCK MODE) ---');
    });

    test('the armed cycle asks the middleware for the installation cycle only, and names it so', async () => {
        mw.cliVote.mockResolvedValue({ success: true, challenges: [] });
        await expect(runVotingCycle(3, { mode: 'armed' })).resolves.toEqual({ success: true, challenges: [] });
        expect(mw.cliVote).toHaveBeenCalledWith(null, 'armed');
        expect(msgs('info')[0]).toBe('--- Installation Cycle 3 (MOCK MODE) ---');
    });

    test('manual cycle votes to 100%, ignores the scope and surfaces no list', async () => {
        await expect(runVotingCycle(2, { isManual: true, challengeId: '9' })).resolves.toEqual({
            success: true,
            challenges: null,
        });
        expect(mw.cliVoteManual).toHaveBeenCalled();
        expect(mw.cliVote).not.toHaveBeenCalled();
        expect(msgs('info')[0]).toBe('--- Manual Voting Cycle 2 (MOCK MODE) ---');
        expect(msgs('info')).toContain(
            'Mode: Manual (votes to 100% regardless of threshold settings; skips Manual Only challenges)',
        );
        expect(logger.__calls.find((c) => c.level === 'startOperation')!.msg).toBe('manual-vote-cycle-2');
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
    // Every refusal comes back as a bare { success: false } — the
    // user-facing reason is the log line resolveChallenge prints, and the
    // only field a caller reads is `success`.
    test('a thrown non-Error fetch failure reports the failed-fetch message', async () => {
        mw.getActiveChallenges.mockRejectedValue('offline');
        await expect(voteChallengeManual('111')).resolves.toEqual({ success: false });
        expect(msgs('error')).toEqual([
            'Could not read the active challenges from GuruShots: offline, so nothing was shown or changed. Check the connection and try again. If the login has expired, run login first.',
        ]);
    });

    test('a fetchFailed read reports the failed-fetch message, never "not found"', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [], fetchFailed: true }));
        await expect(voteChallengeManual('111')).resolves.toEqual({ success: false });
        expect(msgs('error')).toEqual([
            'Could not read the active challenges from GuruShots, so nothing was shown or changed. Check the connection and try again. If the login has expired, run login first.',
        ]);
        expect(votingHandlers['vote-on-challenge-manual']).not.toHaveBeenCalled();
    });

    test('a null response reports the failed-fetch message, never "not found"', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid(null));
        await expect(voteChallengeManual('111')).resolves.toEqual({ success: false });
        expect(msgs('error')).toEqual([
            'Could not read the active challenges from GuruShots, so nothing was shown or changed. Check the connection and try again. If the login has expired, run login first.',
        ]);
        expect(votingHandlers['vote-on-challenge-manual']).not.toHaveBeenCalled();
    });

    test('a good fetch without the id reports not found', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [] }));
        await expect(voteChallengeManual('111')).resolves.toEqual({ success: false });
        expect(msgs('error')).toEqual(['Challenge 111 not found among active challenges']);
    });

    test('a marked challenge refuses with the worded reason, before the handler runs', async () => {
        mw.getActiveChallenges.mockResolvedValue(
            invalid({ challenges: [{ id: 111, title: 'Sunset', dataIssues: ['close_time'] }] }),
        );
        await expect(voteChallengeManual('111')).resolves.toEqual({ success: false });
        expect(msgs('error')).toEqual(['Challenge 111: challenge data cannot be read']);
        expect(votingHandlers['vote-on-challenge-manual']).not.toHaveBeenCalled();
    });

    test('a challenge lost by a prune-unsafe read refuses as unreadable, like every channel', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [], pruneUnsafe: true }));
        await expect(voteChallengeManual('111')).resolves.toEqual({ success: false });
        expect(votingHandlers['vote-on-challenge-manual']).not.toHaveBeenCalled();
    });

    test('success without a message uses the default wording', async () => {
        votingHandlers['vote-on-challenge-manual'].mockResolvedValue(invalid({ success: true }));
        await voteChallengeManual('111');
        expect(votingHandlers['vote-on-challenge-manual']).toHaveBeenCalledWith(null, '111', 'Sunset');
        expect(msgs('success')).toEqual(['Voted on "Sunset"']);
    });

    test('failure without an error uses the default wording and returns the result', async () => {
        votingHandlers['vote-on-challenge-manual'].mockResolvedValue(invalid(null));
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
    let scheduler: jest.Mocked<Pick<ReturnType<typeof createScheduler>, 'start' | 'stopAll'>>;
    let signalHandlers: Record<string | symbol, (...args: unknown[]) => void>;
    let onSpy: jest.SpiedFunction<typeof process.on>;
    let resumeSpy: jest.SpiedFunction<typeof process.stdin.resume>;
    let exitSpy: jest.SpiedFunction<typeof process.exit>;

    beforeEach(() => {
        // The full Stop the shutdown awaits: a durable one by default (a test of the unsaved one overrides it).
        scheduler = {
            start: jest.fn().mockResolvedValue(undefined),
            stopAll: jest.fn().mockResolvedValue({ outcome: 'stopped', durable: true, epoch: 1, withdrawal: 'none' }),
        };
        createScheduler.mockReturnValue(invalid(scheduler));
        signalHandlers = {};
        onSpy = jest.spyOn(process, 'on').mockImplementation((sig, fn) => {
            signalHandlers[sig] = fn;
            return process;
        });
        resumeSpy = jest.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(invalid(() => undefined));
    });
    afterEach(() => {
        onSpy.mockRestore();
        resumeSpy.mockRestore();
        exitSpy.mockRestore();
    });

    test('does nothing but warn when not authenticated', async () => {
        settings.loadSettings.mockReturnValue(config({ app: { mock: false } }));
        mw.isAuthenticated.mockReturnValue(false);
        await startContinuousVoting();
        expect(msgs('info')[0]).toBe('=== Starting Continuous Voting Mode (REAL MODE) ===');
        expect(createScheduler).not.toHaveBeenCalled();
    });

    test('hands the scheduler the full cycle and the installation-only cycle of an armed one', async () => {
        mw.cliVote.mockResolvedValue({ success: true, challenges: [] });
        await startContinuousVoting();
        const deps = createScheduler.mock.calls[0][0];
        await deps.runVotingCycle(1);
        expect(mw.cliVote).toHaveBeenLastCalledWith(null, 'full');
        await deps.runArmedCycle!(2);
        expect(mw.cliVote).toHaveBeenLastCalledWith(null, 'armed');
    });

    test('a cycle while not authenticated runs nothing and answers failure', async () => {
        mw.isAuthenticated.mockReturnValue(false);
        await expect(runVotingCycle(1)).resolves.toEqual({ success: false, challenges: null });
        expect(mw.cliVote).not.toHaveBeenCalled();
    });

    test('an armed mode change says the scenario work is still enabled; other modes say nothing', async () => {
        mw.cliVote.mockResolvedValue({ success: true, challenges: [] });
        await startContinuousVoting();
        const { onModeChange } = createScheduler.mock.calls[0][0];
        onModeChange?.('voting');
        expect(msgs('info')).not.toContain(
            'Mode: Scenario active; voting paused. Unattended scenario work (claiming rewards, resuming voting) is still enabled. Press Ctrl+C to stop all automation.',
        );
        onModeChange?.('armed');
        expect(msgs('info')).toContain(
            'Mode: Scenario active; voting paused. Unattended scenario work (claiming rewards, resuming voting) is still enabled. Press Ctrl+C to stop all automation.',
        );
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

    test('a second signal while shutting down changes nothing: one full Stop, one exit', async () => {
        clearTokenUnlessStayingLoggedIn.mockResolvedValue(false);
        const slowStop = new Promise<{ outcome: 'stopped'; durable: true; epoch: number; withdrawal: 'none' }>(
            (resolve) =>
                setTimeout(() => resolve({ outcome: 'stopped', durable: true, epoch: 1, withdrawal: 'none' }), 20),
        );
        scheduler.stopAll.mockReturnValue(slowStop);
        await startContinuousVoting();
        signalHandlers.SIGINT();
        signalHandlers.SIGTERM();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 40));
        expect(scheduler.stopAll).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('shutdown awaits the full Stop, reports a cleared token and exits 0', async () => {
        clearTokenUnlessStayingLoggedIn.mockResolvedValue(true);
        await shutdown();
        expect(scheduler.stopAll).toHaveBeenCalled();
        expect(msgs('info')).toContain('Cleared saved token (Stay Logged In is off)');
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('a Stop that could not be saved is said before the exit', async () => {
        scheduler.stopAll.mockResolvedValue({
            outcome: 'stopped-locally',
            durable: false,
            reason: 'not-saved',
            withdrawal: 'none',
        });
        await shutdown();
        expect(msgs('warning')).toContain('The Stop could not be saved: automation stopped in this process only.');
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('a Stop route that throws is reported and still exits 0', async () => {
        scheduler.stopAll.mockRejectedValue(new Error('fence gone'));
        await shutdown();
        expect(msgs('error')).toContain('Failed to record the Stop on shutdown');
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

describe('stopAllAutomation', () => {
    beforeEach(() => {
        lifecycle['withdraw-installation'].mockImplementation(async () => ({
            success: true as const,
            outcome: 'none',
        }));
        lifecycle['record-full-stop'].mockImplementation(async () => ({ success: true as const, epoch: 3 }));
    });

    test('records the full stop first, withdraws under the epoch it answered, and says what it cannot know', async () => {
        await expect(stopAllAutomation()).resolves.toBe(0);
        expect(lifecycle['record-full-stop']).toHaveBeenCalledWith(
            null,
            expect.stringMatching(/^stop-/),
            expect.any(Number),
        );
        // The withdrawal follows the durable Stop, under the epoch the record answered (3).
        expect(lifecycle['withdraw-installation']).toHaveBeenCalledWith(null, 3);
        expect(msgs('info')).toContain(
            '🛑 Full Stop recorded (epoch 3). The running app or service stops at its next check.',
        );
        // Never a claim that the running app already stopped — with an installation scenario and without one.
        expect(msgs('info')).toContain('Owner status unavailable — the running app or service reports its own state.');
    });

    test('a Stop that cannot be recorded withdraws nothing', async () => {
        lifecycle['record-full-stop'].mockImplementation(async () => ({ success: false, error: 'not-saved' }));
        await expect(stopAllAutomation()).resolves.toBe(1);
        expect(lifecycle['withdraw-installation']).not.toHaveBeenCalled();
    });

    test("a withdrawal that changed nothing is silent; one that withdrew says the user's settings apply again", async () => {
        await stopAllAutomation();
        expect(msgs('info')).not.toContain("The installation's published settings were withdrawn");
        lifecycle['withdraw-installation'].mockImplementation(async () => ({
            success: true as const,
            outcome: 'withdrawn',
        }));
        await stopAllAutomation();
        expect(msgs('info')).toContain(
            "The installation's published settings were withdrawn; your own settings apply again.",
        );
    });

    test('a withdrawal that was refused is a warning and never refuses the Stop', async () => {
        lifecycle['withdraw-installation'].mockImplementation(async () => ({
            success: false,
            error: 'withdrawal-not-saved',
        }));
        await expect(stopAllAutomation()).resolves.toBe(0);
        expect(msgs('warning')).toContain(
            "The installation's published settings could not be withdrawn: they may still apply until the next full Stop.",
        );
        lifecycle['withdraw-installation'].mockRejectedValue(new Error('locked'));
        await expect(stopAllAutomation()).resolves.toBe(0);
        expect(msgs('warning')).toContain('The installation settings could not be withdrawn');
    });

    test.each([
        ['not-saved', 'it could not be saved'],
        ['unreadable', 'the saved Stop record cannot be read'],
        ['oversize', 'the Stop record does not fit its cell'],
        ['strange-reason', 'strange-reason'],
    ])('a refused record (%s) is said with its reason and exits 1', async (reason, said) => {
        lifecycle['record-full-stop'].mockImplementation(async () => ({ success: false, error: reason }));
        await expect(stopAllAutomation()).resolves.toBe(1);
        expect(msgs('error')).toContain(
            `The Stop could not be recorded (${said}): automation on this computer may still run. Close the running app, or try again.`,
        );
    });

    test('a record route that throws is an error, withdraws nothing, and exits 1', async () => {
        lifecycle['record-full-stop'].mockRejectedValue(new Error('gone'));
        await expect(stopAllAutomation()).resolves.toBe(1);
        expect(msgs('error')).toContain('The Stop could not be recorded');
        expect(lifecycle['withdraw-installation']).not.toHaveBeenCalled();
    });
});

describe('showStatus', () => {
    test('unauthenticated REAL mode: no token line and no boost-window fetch', async () => {
        settings.loadSettings.mockReturnValue(
            config({ app: { mock: false, checkFrequencyMin: 3, checkFrequencyMax: 3 } }),
        );
        settings.getEffectiveSetting.mockReturnValue(1);
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
        settings.loadSettings.mockReturnValue(
            config({
                app: { checkFrequencyMin: 2, checkFrequencyMax: 5 },
                challenges: { 42: { values: { exposure: 80 } }, 43: { pins: { boost: 'imgA' } } },
            }),
        );
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

    test('per-challenge settings are masked like every other settings print', async () => {
        settings.loadSettings.mockReturnValue(
            config({
                challenges: {
                    42: {
                        values: {
                            chosenPhotos: ['p1', 'p2'],
                            lastUsername: 'me@example.com',
                            apiHeaders: { 'x-token': 'abc' },
                        },
                    },
                },
            }),
        );
        await showStatus();
        const printed = msgs('info').join('\n');
        expect(printed).toContain('    chosenPhotos: 2 photo(s)');
        expect(printed).toContain('    lastUsername: [REDACTED]');
        expect(printed).toContain('    apiHeaders: [REDACTED]');
        expect(printed).not.toMatch(/p1|me@example\.com|abc/);
    });

    test('pins are listed under their own label, not as a challenge’s settings', async () => {
        settings.loadSettings.mockReturnValue(
            config({ challenges: { 42: { pins: { boost: 'imgA' } }, 43: { pins: { turbo: 'imgB' } } } }),
        );
        settings.getEntryPins.mockImplementation((id) =>
            String(id) === '42' ? { boost: 'imgA', turbo: null } : { boost: null, turbo: 'imgB' },
        );
        await showStatus();
        const info = msgs('info');
        expect(info).toContain('\nPinned entries:');
        expect(info).toContain('  Challenge 42: Boost imgA, Turbo none');
        expect(info).toContain('  Challenge 43: Boost none, Turbo imgB');
        expect(info).not.toContain('  Challenge entryPins:');
    });

    test('only challenge ids that hold a valid pin are listed, and an id is printed as plain text', async () => {
        const forged = '77\nChallenge 1: Boost forged\u001b[2J';
        settings.loadSettings.mockReturnValue(
            config({
                challenges: {
                    42: { pins: { boost: 'imgA' } },
                    junk: { pins: 'x' },
                    43: { pins: { boost: 'bad id' } },
                    [forged]: { pins: { turbo: 'imgB' } },
                },
            }),
        );
        settings.getEntryPins.mockImplementation((id) =>
            String(id) === '42'
                ? { boost: 'imgA', turbo: null }
                : id === forged
                  ? { boost: null, turbo: 'imgB' }
                  : { boost: null, turbo: null },
        );
        await showStatus();
        const info = msgs('info');
        expect(info).toContain('  Challenge 42: Boost imgA, Turbo none');
        expect(info).toContain('  Challenge 77 Challenge 1: Boost forged: Boost none, Turbo imgB');
        expect(info.filter((line) => line.includes('Challenge junk') || line.includes('Challenge 43'))).toEqual([]);
        expect(
            info
                .filter((line) => line.startsWith('  Challenge '))
                .some((line) => line.includes('\u001b') || line.includes('\n')),
        ).toBe(false);
    });

    test('a long challenge id is cut to 64 characters after it is cleaned', async () => {
        const long = `${'7'.repeat(70)}`;
        settings.loadSettings.mockReturnValue(config({ challenges: { [long]: { pins: {} } } }));
        settings.getEntryPins.mockReturnValue({ boost: 'imgA', turbo: null });
        await showStatus();
        expect(msgs('info')).toContain(`  Challenge ${'7'.repeat(64)}: Boost imgA, Turbo none`);
    });

    test('no pins prints no pinned-entries section', async () => {
        settings.loadSettings.mockReturnValue(config({ challenges: {} }));
        await showStatus();
        expect(msgs('info')).not.toContain('\nPinned entries:');
        settings.loadSettings.mockReturnValue(config());
        await showStatus();
        expect(msgs('info')).not.toContain('\nPinned entries:');
    });

    test('no challenge with values of its own prints no section', async () => {
        settings.loadSettings.mockReturnValue(
            config({ auth: { token: 't' }, challenges: { 42: { pins: { boost: 'imgA' } } } }),
        );
        await showStatus();
        expect(msgs('info')).toContain('Token: ✅ Present');
        expect(msgs('info')).not.toContain('\nChallenge Settings:');
    });

    test('a non-array challenge list is treated as empty', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: 'bad' }));
        await showStatus();
        expect(openBoostWindows).toHaveBeenCalledWith([], expect.any(Number));
    });

    test('a thrown non-Error boost-window fetch is reported inline', async () => {
        mw.getActiveChallenges.mockRejectedValue('offline');
        await showStatus();
        expect(msgs('info')).toContain('  (unavailable — offline)');
    });

    test('the full unauthenticated banner, line for line', async () => {
        settings.loadSettings.mockReturnValue(
            config({
                app: {
                    mock: false,
                    theme: 'latvian',
                    language: 'en',
                    apiTimeout: 30,
                    checkFrequencyMin: 3,
                    checkFrequencyMax: 3,
                },
            }),
        );
        settings.getEffectiveSetting.mockReturnValue(7);
        mw.isAuthenticated.mockReturnValue(false);
        await showStatus();
        expect(msgs('info')).toEqual([
            '=== GuruShots Auto Voter - Status ===',
            'Mode: REAL (live API calls)',
            'Authentication: ❌ Not authenticated',
            'Last reported mode: Stopped (time unknown)',
            'Installation scenario: none',
            'Owner status unavailable (a running app reports its own state)',
            'Auto-claim: off',
            'Auto-join: off',
            '\nSettings:',
            '  Theme: latvian',
            '  Language: en',
            '  Timezone: Europe/Riga',
            '  API Timeout: 30s',
            '  Check Frequency: 3min',
            '  Last Minute Check Frequency: 7min',
            '\nTo change mode, run: login',
        ]);
    });

    test('the full authenticated banner, line for line', async () => {
        settings.loadSettings.mockReturnValue(
            config({
                app: { theme: 'latvian', language: 'en', apiTimeout: 30, checkFrequencyMin: 2, checkFrequencyMax: 5 },
                auth: { token: 'tok' },
                challenges: { 42: { values: { exposure: 80 } } },
            }),
        );
        settings.getEffectiveSetting.mockReturnValue(2);
        settings.getEntryPins.mockReturnValue({ boost: 'imgA', turbo: null });
        openBoostWindows.mockReturnValue(invalid([{ id: 111, title: 'Sunset', remaining: 300 }]));
        mw.getActiveChallenges.mockResolvedValue(
            invalid({
                challenges: [
                    {
                        id: 111,
                        title: 'Sunset',
                        member: {
                            ranking: { total: { rank: 3, votes: 3, benchmark: [{ benchmark: '1', score: '10' }] } },
                        },
                    },
                ],
            }),
        );
        await showStatus();
        expect(msgs('info')).toEqual([
            '=== GuruShots Auto Voter - Status ===',
            'Mode: MOCK (simulated API calls)',
            'Authentication: ✅ Authenticated',
            'Token: ✅ Present',
            'Last reported mode: Stopped (time unknown)',
            'Installation scenario: none',
            'Owner status unavailable (a running app reports its own state)',
            'Auto-claim: off',
            'Auto-join: off',
            '\nSettings:',
            '  Theme: latvian',
            '  Language: en',
            '  Timezone: Europe/Riga',
            '  API Timeout: 30s',
            '  Check Frequency: 2–5min (random per cycle)',
            '  Last Minute Check Frequency: 2min',
            '\nChallenge Settings:',
            '  Challenge 42:',
            '    exposure: 80',
            '\nPinned entries:',
            '  Challenge 42: Boost imgA, Turbo none',
            '\nBoost Window Open:',
            '  • Sunset — 5m',
            '\nStanding:',
            '  • Sunset — rank 3 — top 1 needs 8 votes',
            '\nTo change mode, run: login',
        ]);
    });
});
