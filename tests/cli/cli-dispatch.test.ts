/**
 * Unit tests for the CLI entry point (src/ts/cli/cli.ts). The module is a
 * script: it reads process.argv, registers process-level error handlers and
 * runs main() on load. Each test sets argv and re-requires it in an isolated
 * module registry with every command module mocked, then asserts which
 * command ran, with what arguments, and the exit code. process.exit is a
 * recording no-op (so every exit code a run produces is observable) and
 * process.on is captured, never installed.
 */

import type * as loggerModule from '../../src/ts/logger';
import type * as settingsModule from '../../src/ts/settings';
import type * as randomizerModule from '../../src/ts/api/randomizer';
import type * as guardsModule from '../../src/ts/cli/guards';
import type * as authModule from '../../src/ts/cli/commands/auth';
import type * as votingModule from '../../src/ts/cli/commands/voting';
import type * as actionsModule from '../../src/ts/cli/commands/actions';
import type * as bankrollModule from '../../src/ts/cli/commands/bankroll';
import type * as joinModule from '../../src/ts/cli/commands/join';
import type * as photosModule from '../../src/ts/cli/commands/photos';
import type * as updateModule from '../../src/ts/cli/commands/update';
import type * as logsModule from '../../src/ts/cli/commands/logs';
import type * as settingsCommandsModule from '../../src/ts/cli/commands/settings';
import type * as scenariosModule from '../../src/ts/cli/commands/scenarios';
import { invalid } from '../helpers/invalid';

type Mods = {
    logger: jest.MockedObjectDeep<typeof loggerModule> & { __calls: { level: string; msg: unknown }[] };
    settings: jest.MockedObjectDeep<typeof settingsModule>;
    randomizer: jest.MockedObjectDeep<typeof randomizerModule>;
    guards: jest.MockedObjectDeep<typeof guardsModule>;
    auth: jest.MockedObjectDeep<typeof authModule>;
    voting: jest.MockedObjectDeep<typeof votingModule>;
    actions: jest.MockedObjectDeep<typeof actionsModule>;
    bankroll: jest.MockedObjectDeep<typeof bankrollModule>;
    join: jest.MockedObjectDeep<typeof joinModule>;
    photos: jest.MockedObjectDeep<typeof photosModule>;
    update: jest.MockedObjectDeep<typeof updateModule>;
    logs: jest.MockedObjectDeep<typeof logsModule>;
    cmd: jest.MockedObjectDeep<typeof settingsCommandsModule>;
    scenarios: jest.MockedObjectDeep<typeof scenariosModule>;
};
type Loaded = Mods & { msgs: (level: string) => string[]; exitCodes: unknown[] };

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: unknown }[] = [];
    const rec = (level: string) => (msg: unknown) => calls.push({ level, msg });
    const cat = { info: rec('info'), error: rec('error'), debug: rec('debug'), warning: rec('warning') };
    // printLine is the console-only writer: what reaches it is never a one-line log entry.
    return {
        __calls: calls,
        withCategory: jest.fn(() => cat),
        printLine: rec('stdout'),
        printDocument: rec('stdout'),
        cleanup: jest.fn(),
    };
});

jest.mock('../../src/ts/settings', () => ({
    loadSettings: jest.fn(() => ({ mock: false })),
    seedIntentProfiles: jest.fn(),
}));

jest.mock('../../src/ts/api/randomizer', () => ({ initializeHeaders: jest.fn() }));

// This test loads real command helpers while fs is globally mocked. Mock
// Electron so its package entry point does not try to download a binary.
jest.mock('electron', () => ({}));

jest.mock('../../src/ts/cli/guards', () => ({
    requireChallenge: jest.fn(({ challengeId }: { challengeId: string | null }) => challengeId),
    requireProfileArgs: jest.fn((command: string, { rest }: { rest: string[] }) => rest[0]),
}));

jest.mock('../../src/ts/cli/commands/auth', () => ({ handleLogin: jest.fn(), handleLogout: jest.fn() }));

// parseChallengeFlag / parseSwapFlags / the usage strings are pure helpers —
// keep the real ones so the dispatcher's argv handling is tested end to end.
jest.mock('../../src/ts/cli/commands/voting', () => {
    const { parseChallengeFlag } = jest.requireActual<typeof import('../../src/ts/cli/commands/voting')>(
        '../../src/ts/cli/commands/voting',
    );
    return {
        parseChallengeFlag,
        runVotingCycle: jest.fn(),
        voteChallengeManual: jest.fn(),
        startContinuousVoting: jest.fn(),
        showStatus: jest.fn(),
    };
});

jest.mock('../../src/ts/cli/commands/actions', () => {
    const { parseSwapFlags, SWAP_USAGE, SWAP_BACK_USAGE } = jest.requireActual<
        typeof import('../../src/ts/cli/commands/actions')
    >('../../src/ts/cli/commands/actions');
    return {
        parseSwapFlags,
        SWAP_USAGE,
        SWAP_BACK_USAGE,
        boostChallenge: jest.fn(),
        turboChallenge: jest.fn(),
        fillChallenge: jest.fn(),
        unlockBoostCmd: jest.fn(),
        swapCmd: jest.fn(),
        swapBackCmd: jest.fn(),
        fillExposureCmd: jest.fn(),
    };
});

jest.mock('../../src/ts/cli/commands/bankroll', () => ({ showBankroll: jest.fn() }));
jest.mock('../../src/ts/cli/commands/join', () => ({ showDiscover: jest.fn(), joinChallengeCmd: jest.fn() }));
jest.mock('../../src/ts/cli/commands/photos', () => ({
    ...jest.requireActual<typeof import('../../src/ts/cli/commands/photos')>('../../src/ts/cli/commands/photos'),
    listPhotosCmd: jest.fn(async () => 0),
}));
jest.mock('../../src/ts/cli/commands/update', () => ({ checkUpdates: jest.fn() }));
jest.mock('../../src/ts/cli/commands/logs', () => ({ showLogs: jest.fn() }));
jest.mock('../../src/ts/cli/commands/scenarios', () =>
    Object.fromEntries(
        [
            'listScenarios',
            'scenarioTemplate',
            'importScenarioCmd',
            'exportScenarioCmd',
            'renameScenarioCmd',
            'deleteScenarioCmd',
            'scenarioStatusCmd',
            'scenarioResetCmd',
            'scenarioDryRunCmd',
            'scenarioSimulateCmd',
            'scenarioVocabulary',
        ].map((name) => [name, jest.fn(async () => 0)]),
    ),
);
jest.mock('../../src/ts/cli/commands/settings', () => ({
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    setGlobalDefault: jest.fn(),
    beforeChosenPhotosWrite: jest.fn(async () => () => undefined),
    clearChosenPhotos: jest.fn(() => true),
    listSettings: jest.fn(),
    resetSetting: jest.fn(),
    resetAllSettings: jest.fn(),
    helpSettings: jest.fn(),
    resetWindows: jest.fn(),
    listProfiles: jest.fn(),
    saveProfileFromChallenge: jest.fn(),
    applyProfile: jest.fn(),
    deleteProfile: jest.fn(),
}));

const flush = () => new Promise((r) => setImmediate(r));

let exitSpy: jest.SpiedFunction<typeof process.exit>;
let onSpy: jest.SpiedFunction<typeof process.on>;
let processHandlers: Record<string | symbol, (...args: unknown[]) => void>;
const originalArgv = process.argv;

beforeEach(() => {
    processHandlers = {};
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(invalid(() => undefined));
    onSpy = jest.spyOn(process, 'on').mockImplementation((event, fn) => {
        processHandlers[event] = fn;
        return process;
    });
});

afterEach(() => {
    exitSpy.mockRestore();
    onSpy.mockRestore();
    process.argv = originalArgv;
});

/**
 * Load cli.ts with the given argv in a fresh registry. `setup` receives the
 * fresh mock modules before the script runs so a test can program them.
 */
const run = async (argv: string[], setup?: (mods: Mods) => void) => {
    let m!: Loaded;
    process.argv = ['node', 'cli.ts', ...argv];
    jest.isolateModules(() => {
        m = invalid<Loaded>({
            logger: require('../../src/ts/logger') as typeof loggerModule,
            settings: require('../../src/ts/settings') as typeof settingsModule,
            randomizer: require('../../src/ts/api/randomizer') as typeof randomizerModule,
            guards: require('../../src/ts/cli/guards') as typeof guardsModule,
            auth: require('../../src/ts/cli/commands/auth') as typeof authModule,
            voting: require('../../src/ts/cli/commands/voting') as typeof votingModule,
            actions: require('../../src/ts/cli/commands/actions') as typeof actionsModule,
            bankroll: require('../../src/ts/cli/commands/bankroll') as typeof bankrollModule,
            join: require('../../src/ts/cli/commands/join') as typeof joinModule,
            photos: require('../../src/ts/cli/commands/photos') as typeof photosModule,
            update: require('../../src/ts/cli/commands/update') as typeof updateModule,
            logs: require('../../src/ts/cli/commands/logs') as typeof logsModule,
            cmd: require('../../src/ts/cli/commands/settings') as typeof settingsCommandsModule,
            scenarios: require('../../src/ts/cli/commands/scenarios') as typeof scenariosModule,
        });
        setup?.(m);
        require('../../src/ts/cli/cli');
    });
    await flush();
    await flush();
    m.msgs = (level) => m.logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
    m.exitCodes = exitSpy.mock.calls.map((c) => c[0]);
    return m;
};

describe('startup', () => {
    test('initialises headers, seeds intent profiles, registers handlers and cleans up', async () => {
        const m = await run(['status']);
        expect(m.randomizer.initializeHeaders).toHaveBeenCalled();
        expect(m.settings.seedIntentProfiles).toHaveBeenCalled();
        expect(Object.keys(processHandlers).sort()).toEqual(['uncaughtException', 'unhandledRejection']);
        expect(m.voting.showStatus).toHaveBeenCalled();
        expect(m.exitCodes).toEqual([0]);
        expect(m.logger.cleanup).toHaveBeenCalled();
    });

    test('a failed intent-profile seed is a warning, not fatal', async () => {
        const m = await run(['status'], (mods) =>
            mods.settings.seedIntentProfiles.mockImplementation(() => {
                throw new Error('seed');
            }),
        );
        expect(m.msgs('warning')).toEqual(['Intent profile seeding failed (non-fatal):']);
        expect(m.voting.showStatus).toHaveBeenCalled();
        expect(m.exitCodes).toEqual([0]);
    });

    test('a thrown command exits 1', async () => {
        const m = await run(['login'], (mods) => mods.auth.handleLogin.mockRejectedValue(new Error('x')));
        expect(m.msgs('error')).toEqual(['Error']);
        expect(m.exitCodes).toEqual([1]);
    });

    test('a failure escaping main (cleanup throws) is caught and exits 1', async () => {
        const m = await run(['logout'], (mods) =>
            mods.logger.cleanup.mockImplementation(() => {
                throw new Error('cleanup');
            }),
        );
        expect(m.auth.handleLogout).toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Error caught in main() call']);
        expect(m.exitCodes).toEqual([0, 1]);
    });

    test.each([
        ['unhandledRejection', 'Unhandled Promise Rejection', [new Error('r'), Promise.resolve()]],
        ['uncaughtException', 'Uncaught Exception', [new Error('u')]],
    ])('the %s handler logs and exits 1', async (event, message, args) => {
        const m = await run(['status']);
        exitSpy.mockClear();
        processHandlers[event](...args);
        expect(m.msgs('error')).toContain(message);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

describe('help and unknown commands', () => {
    test.each([['help'], ['--help'], ['-h']])('%s prints help in REAL mode', async (flag) => {
        const m = await run([flag]);
        // The help is printed whole, on the console only, with its line breaks (not as a log entry).
        expect(m.msgs('info')).toEqual([]);
        const [text] = m.msgs('stdout');
        expect(text.split('\n').length).toBeGreaterThan(30);
        expect(text).toContain('\nCommands:\n  login    - Authenticate with GuruShots and save token\n  logout ');
        expect(text).toContain('GuruShots Auto Voter - CLI (REAL MODE)');
        expect(text).toContain('Current mode: REAL (live API calls)');
        // clear-chosen-photos clears every list; a single challenge's list goes with reset-setting.
        expect(text).toContain('clear-chosen-photos');
        expect(text).toContain('reset-setting chosenPhotos --challenge=<id>');
        expect(text).toContain(
            "To use no chosen photos for that challenge (overriding rules / global):\n             set-setting chosenPhotos '[]' --challenge=<id>",
        );
        expect(m.exitCodes).toEqual([0]);
    });

    test('help in MOCK mode says so', async () => {
        const m = await run(['help'], (mods) => mods.settings.loadSettings.mockReturnValue(invalid({ mock: true })));
        const [text] = m.msgs('stdout');
        expect(text).toContain('(MOCK MODE)');
        expect(text).toContain('Current mode: MOCK (simulated API calls)');
    });

    test('no command points at help and exits 1', async () => {
        const m = await run([]);
        expect(m.msgs('info')).toEqual(['No command specified. Use "help" to see available commands']);
        expect(m.exitCodes).toEqual([1]);
    });

    test('an unknown command is an error', async () => {
        const m = await run(['frobnicate']);
        expect(m.msgs('error')).toEqual(['Unknown command: frobnicate']);
        expect(m.exitCodes).toEqual([1]);
    });

    test.each(['constructor', 'toString', '__proto__'])(
        'an Object.prototype name (%s) is an unknown command',
        async (name) => {
            const m = await run([name]);
            expect(m.msgs('error')).toEqual([`Unknown command: ${name}`]);
            expect(m.exitCodes).toEqual([1]);
        },
    );
});

describe('simple commands', () => {
    test.each([
        ['login', 'auth', 'handleLogin'],
        ['logout', 'auth', 'handleLogout'],
        ['check-updates', 'update', 'checkUpdates'],
        ['status', 'voting', 'showStatus'],
        ['bankroll', 'bankroll', 'showBankroll'],
        ['coins', 'bankroll', 'showBankroll'],
        ['discover', 'join', 'showDiscover'],
        ['reset-all-settings', 'cmd', 'resetAllSettings'],
        ['help-settings', 'cmd', 'helpSettings'],
        ['reset-windows', 'cmd', 'resetWindows'],
    ])('%s → %s.%s and exits 0', async (command, mod, fn) => {
        const m = await run([command]);
        expect(
            invalid<Record<string, Record<string, jest.Mock<unknown, unknown[]>>>>(m)[mod][fn],
        ).toHaveBeenCalledTimes(1);
        expect(m.exitCodes).toEqual([0]);
    });

    test('start keeps running (no exit)', async () => {
        const m = await run(['start']);
        expect(m.voting.startContinuousVoting).toHaveBeenCalled();
        expect(m.exitCodes).toEqual([]);
    });
});

describe('vote / run', () => {
    test('bare vote runs a manual cycle over every challenge', async () => {
        const m = await run(['vote']);
        expect(m.voting.runVotingCycle).toHaveBeenCalledWith(1, { isManual: true });
        expect(m.voting.voteChallengeManual).not.toHaveBeenCalled();
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([[['--challenge=12']], [['--challenge', '12']]])('vote %p votes one challenge', async (tail) => {
        const m = await run(['vote', ...tail]);
        expect(m.voting.voteChallengeManual).toHaveBeenCalledWith('12');
        expect(m.voting.runVotingCycle).not.toHaveBeenCalled();
    });

    test.each([[['--challenge=']], [['--challenge']]])('vote %p (empty) refuses to vote everything', async (tail) => {
        const m = await run(['vote', ...tail]);
        expect(m.msgs('error')).toEqual(['Please specify a challenge id with --challenge']);
        expect(m.voting.runVotingCycle).not.toHaveBeenCalled();
        expect(m.exitCodes).toEqual([1]);
    });

    test.each([
        [[], null],
        [['--challenge=5'], '5'],
    ])('run %p passes the scope to a strategy cycle', async (tail, challengeId) => {
        const m = await run(['run', ...tail]);
        expect(m.voting.runVotingCycle).toHaveBeenCalledWith(1, { isManual: false, challengeId });
        expect(m.exitCodes).toEqual([0]);
    });
});

describe('challenge-scoped actions', () => {
    test.each([
        [['--challenge=5', '--image=abc'], 'abc'],
        [['--image=', '--challenge', '5'], null],
        [['--challenge=5'], null],
    ])('boost %p', async (tail, imageId) => {
        const m = await run(['boost', ...tail]);
        expect(m.guards.requireChallenge).toHaveBeenCalledWith(
            { challengeId: '5' },
            'Usage: boost --challenge=<id> [--image=<id>]',
        );
        expect(m.actions.boostChallenge).toHaveBeenCalledWith('5', { imageId });
        expect(m.exitCodes).toEqual([0]);
    });

    test('turbo', async () => {
        const m = await run(['turbo', '--challenge=5']);
        expect(m.actions.turboChallenge).toHaveBeenCalledWith('5');
    });

    test.each([
        [['--challenge=5', '--all'], true],
        [['--challenge=5'], false],
    ])('submit %p', async (tail, all) => {
        const m = await run(['submit', ...tail]);
        expect(m.actions.fillChallenge).toHaveBeenCalledWith('5', { all });
    });

    test.each<[string, 'unlockBoostCmd' | 'fillExposureCmd']>([
        ['unlock-boost', 'unlockBoostCmd'],
        ['fill-exposure', 'fillExposureCmd'],
    ])('%s forwards --yes', async (command, fn) => {
        const m = await run([command, '--challenge=5', '--yes']);
        expect(m.actions[fn]).toHaveBeenCalledWith('5', { yes: true });
        expect(m.exitCodes).toEqual([0]);
    });

    test.each<[boolean, number]>([
        [true, 0],
        [false, 1],
    ])('swap exit code follows the command result (%p → %p)', async (result, code) => {
        const m = await run(['swap', '--challenge=5', '--image=a', '--to=b', '--yes'], (mods) =>
            mods.actions.swapCmd.mockResolvedValue(result),
        );
        expect(m.guards.requireChallenge).toHaveBeenCalledWith({ challengeId: '5' }, m.actions.SWAP_USAGE);
        expect(m.actions.swapCmd).toHaveBeenCalledWith('5', { imageId: 'a', to: 'b', yes: true });
        expect(m.exitCodes).toEqual([code]);
    });

    test.each([
        [true, 0],
        [false, 1],
    ])('swap-back exit code follows the command result (%p → %p)', async (result, code) => {
        const m = await run(['swap-back', '--challenge=5', '--image=a'], (mods) =>
            mods.actions.swapBackCmd.mockResolvedValue(result),
        );
        expect(m.actions.swapBackCmd).toHaveBeenCalledWith('5', { imageId: 'a', yes: false });
        expect(m.exitCodes).toEqual([code]);
    });

    test('join picks the first positional id and --yes', async () => {
        const m = await run(['join', '--yes', '77']);
        expect(m.join.joinChallengeCmd).toHaveBeenCalledWith('77', { yes: true });
        expect(m.exitCodes).toEqual([0]);
    });
});

describe('list-photos', () => {
    test.each([
        [['list-photos'], null, null],
        [['list-photos', '--challenge=5'], '5', null],
        [['list-photos', '--search=sunset'], null, 'sunset'],
        [['list-photos', '--search', 'sun set', '--challenge', '5'], '5', 'sun set'],
    ])('%j reads the library', async (argv, challengeId, search) => {
        const m = await run(argv);
        expect(m.photos.listPhotosCmd).toHaveBeenCalledWith(challengeId, search);
        expect(m.exitCodes).toEqual([0]);
    });

    test("the exit code is the command's", async () => {
        const m = await run(['list-photos'], (mods) => mods.photos.listPhotosCmd.mockResolvedValue(1));
        expect(m.exitCodes).toEqual([1]);
    });

    test.each([
        [['list-photos', 'extra']],
        [['list-photos', '--search']],
        [['list-photos', '--search=a', 'stray']],
        [['list-photos', '--searchx']],
        [['list-photos', '--search-term=a']],
    ])('%j is a usage error', async (argv) => {
        const m = await run(argv);
        expect(m.photos.listPhotosCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Wrong arguments']);
        expect(m.msgs('info')).toEqual(['Usage: list-photos [--challenge=<id>] [--search=<tag>]']);
        expect(m.exitCodes).toEqual([1]);
    });
});

describe('settings commands', () => {
    test('get-setting with key and challenge', async () => {
        const m = await run(['get-setting', 'exposure', '--challenge=5']);
        expect(m.cmd.getSetting).toHaveBeenCalledWith('exposure', '5');
        expect(m.exitCodes).toEqual([0]);
    });

    test('get-setting without a key exits 1 with usage', async () => {
        const m = await run(['get-setting']);
        expect(m.msgs('error')).toEqual(['Please specify a setting key']);
        expect(m.exitCodes[0]).toBe(1);
    });

    test('set-setting with key, value and challenge', async () => {
        const m = await run(['set-setting', '--challenge', '5', 'exposure', '80']);
        expect(m.cmd.setSetting).toHaveBeenCalledWith('exposure', '80', '5');
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [true, 1],
        [false, 0],
    ])('set-setting stamps the chosen-photos owner only after a saved write (%p)', async (saved, stamped) => {
        const stamp = jest.fn<void, []>();
        const m = await run(['set-setting', 'chosenPhotos', '["a"]', '--challenge=5'], (mods) => {
            mods.cmd.beforeChosenPhotosWrite.mockResolvedValue(stamp);
            mods.cmd.setSetting.mockReturnValue(saved);
        });
        expect(m.cmd.beforeChosenPhotosWrite).toHaveBeenCalledWith('chosenPhotos', '["a"]');
        // The check (and its warning) comes before the write; the stamp after it.
        expect(m.cmd.beforeChosenPhotosWrite.mock.invocationCallOrder[0]).toBeLessThan(
            m.cmd.setSetting.mock.invocationCallOrder[0],
        );
        expect(stamp).toHaveBeenCalledTimes(stamped);
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([[['--challenge=5']], [['5']], [['--yes']]])(
        'clear-chosen-photos %p is refused, since it clears every list',
        async (tail) => {
            const m = await run(['clear-chosen-photos', ...tail]);
            expect(m.cmd.clearChosenPhotos).not.toHaveBeenCalled();
            expect(m.msgs('error')).toEqual([`Unexpected arguments: ${tail.join(' ')}`]);
            expect(m.msgs('info')).toEqual(['Usage: clear-chosen-photos']);
            expect(m.exitCodes[0]).toBe(1);
        },
    );

    test.each([
        [true, 0],
        [false, 1],
    ])('clear-chosen-photos exit code follows the result (%p → %p)', async (ok, code) => {
        const m = await run(['clear-chosen-photos'], (mods) => mods.cmd.clearChosenPhotos.mockReturnValue(ok));
        expect(m.cmd.clearChosenPhotos).toHaveBeenCalledTimes(1);
        expect(m.exitCodes).toEqual([code]);
    });

    test.each([[[]], [['exposure']]])('set-setting %p missing key/value exits 1', async (tail) => {
        const m = await run(['set-setting', ...tail]);
        expect(m.msgs('error')).toEqual(['Please specify both key and value']);
        expect(m.exitCodes[0]).toBe(1);
    });

    test('list-settings forwards the challenge (or null)', async () => {
        const m = await run(['list-settings']);
        expect(m.cmd.listSettings).toHaveBeenCalledWith(null);
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [true, 0],
        [false, 1],
    ])('reset-setting exit code follows the result (%p → %p)', async (ok, code) => {
        const m = await run(['reset-setting', 'exposure'], (mods) => mods.cmd.resetSetting.mockReturnValue(ok));
        expect(m.cmd.resetSetting).toHaveBeenCalledWith('exposure', null);
        expect(m.exitCodes).toEqual([code]);
    });

    test('reset-setting without a key exits 1 with usage', async () => {
        const m = await run(['reset-setting']);
        expect(m.msgs('error')).toEqual(['Please specify a setting key']);
        expect(m.exitCodes[0]).toBe(1);
    });

    test('set-global-default with key and value', async () => {
        const m = await run(['set-global-default', 'exposure', '80']);
        expect(m.cmd.setGlobalDefault).toHaveBeenCalledWith('exposure', '80');
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [true, 1],
        [false, 0],
    ])('set-global-default stamps the chosen-photos owner only after a saved write (%p)', async (saved, stamped) => {
        const stamp = jest.fn<void, []>();
        const m = await run(['set-global-default', 'chosenPhotos', '["a"]'], (mods) => {
            mods.cmd.beforeChosenPhotosWrite.mockResolvedValue(stamp);
            mods.cmd.setGlobalDefault.mockReturnValue(saved);
        });
        expect(m.cmd.beforeChosenPhotosWrite.mock.invocationCallOrder[0]).toBeLessThan(
            m.cmd.setGlobalDefault.mock.invocationCallOrder[0],
        );
        expect(stamp).toHaveBeenCalledTimes(stamped);
    });

    test.each([[[]], [['exposure']]])('set-global-default %p missing args exits 1', async (tail) => {
        const m = await run(['set-global-default', ...tail]);
        expect(m.msgs('error')).toEqual(['Please specify both setting key and value']);
        expect(m.exitCodes[0]).toBe(1);
    });
});

describe('profile commands', () => {
    test('list-profiles', async () => {
        const m = await run(['list-profiles']);
        expect(m.cmd.listProfiles).toHaveBeenCalled();
        expect(m.exitCodes).toEqual([0]);
    });

    test('list-profiles rejects stray arguments', async () => {
        const m = await run(['list-profiles', 'oops']);
        expect(m.msgs('error')).toEqual(['Unexpected arguments: oops']);
        expect(m.exitCodes[0]).toBe(1);
    });

    test.each<[string, 'saveProfileFromChallenge' | 'applyProfile']>([
        ['save-profile', 'saveProfileFromChallenge'],
        ['apply-profile', 'applyProfile'],
    ])('%s validates with a challenge requirement and dispatches', async (command, fn) => {
        const m = await run([command, 'tactic', '--challenge=5']);
        expect(m.guards.requireProfileArgs).toHaveBeenCalledWith(
            command,
            { challengeId: '5', rest: ['tactic'] },
            expect.objectContaining({ needsChallenge: true }),
        );
        expect(m.cmd[fn]).toHaveBeenCalledWith('tactic', '5');
        expect(m.exitCodes).toEqual([0]);
    });

    test('delete-profile needs no challenge', async () => {
        const m = await run(['delete-profile', 'tactic']);
        expect(m.guards.requireProfileArgs).toHaveBeenCalledWith('delete-profile', {
            challengeId: null,
            rest: ['tactic'],
        });
        expect(m.cmd.deleteProfile).toHaveBeenCalledWith('tactic');
    });
});

describe('logs', () => {
    test.each([
        [[], { category: 'app', lines: 100 }],
        [['--error', '--lines=20'], { category: 'error', lines: 20 }],
        [['--api'], { category: 'api', lines: 100 }],
        [['--settings', '--lines=abc'], { category: 'settings', lines: 100 }],
    ])('logs %p', async (tail, opts) => {
        const m = await run(['logs', ...tail]);
        expect(m.logs.showLogs).toHaveBeenCalledWith(opts);
        expect(m.exitCodes).toEqual([0]);
    });
});

describe('scenario commands', () => {
    test.each<[string[], keyof typeof scenariosModule, unknown[]]>([
        [['list-scenarios'], 'listScenarios', []],
        [['scenario-template', 'eveningBoost'], 'scenarioTemplate', ['eveningBoost', undefined]],
        [['scenario-template', 'eveningBoost', 'out.json'], 'scenarioTemplate', ['eveningBoost', 'out.json']],
        [['import-scenario', 'plan.json'], 'importScenarioCmd', ['plan.json', { overwrite: false, yes: false }]],
        [
            ['import-scenario', 'plan.json', '--overwrite', '--yes'],
            'importScenarioCmd',
            ['plan.json', { overwrite: true, yes: true }],
        ],
        [['export-scenario', 'My plan'], 'exportScenarioCmd', ['My plan', undefined]],
        [['export-scenario', 'My plan', 'out.json'], 'exportScenarioCmd', ['My plan', 'out.json']],
        [['rename-scenario', 'Old', 'New'], 'renameScenarioCmd', ['Old', 'New']],
        [['delete-scenario', 'My plan'], 'deleteScenarioCmd', ['My plan']],
        [['scenario-status', '--challenge=7'], 'scenarioStatusCmd', ['7']],
        [['scenario-dry-run', '--challenge=7'], 'scenarioDryRunCmd', ['7']],
        [['scenario-simulate', '--challenge=7'], 'scenarioSimulateCmd', ['7']],
        [['scenario-reset', '--challenge=7'], 'scenarioResetCmd', ['7']],
        [['scenario-vocabulary'], 'scenarioVocabulary', []],
    ])('%p runs %s', async (argv, fn, args) => {
        const m = await run(argv);
        expect(m.scenarios[fn]).toHaveBeenCalledWith(...args);
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [['list-scenarios', 'extra']],
        [['scenario-template']],
        [['import-scenario']],
        [['export-scenario', 'a', 'b', 'c']],
        [['rename-scenario', 'only-one']],
        [['delete-scenario']],
        [['scenario-vocabulary', 'x']],
    ])('%p is a usage error', async (argv) => {
        const m = await run(argv);
        expect(m.msgs('error')).toContain('Wrong arguments');
        expect(m.exitCodes).toEqual([1]);
    });

    test('a failing command exits with its code', async () => {
        const m = await run(['delete-scenario', 'Plan'], (mods) =>
            mods.scenarios.deleteScenarioCmd.mockResolvedValue(1),
        );
        expect(m.exitCodes).toEqual([1]);
    });
});
