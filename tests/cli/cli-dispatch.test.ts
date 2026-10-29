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
import type * as runtimeModule from '../../src/ts/runtime';
import type * as randomizerModule from '../../src/ts/api/randomizer';
import type * as guardsModule from '../../src/ts/cli/guards';
import type * as authModule from '../../src/ts/cli/commands/auth';
import type * as votingModule from '../../src/ts/cli/commands/voting';
import type * as statusModule from '../../src/ts/cli/commands/status';
import type * as actionsModule from '../../src/ts/cli/commands/actions';
import type * as submitModule from '../../src/ts/cli/commands/submit';
import type * as spendModule from '../../src/ts/cli/commands/spend';
import type * as bankrollModule from '../../src/ts/cli/commands/bankroll';
import type * as joinModule from '../../src/ts/cli/commands/join';
import type * as pinModule from '../../src/ts/cli/commands/pin';
import type * as photosModule from '../../src/ts/cli/commands/photos';
import type * as deadlinesModule from '../../src/ts/cli/commands/deadlines';
import type * as updateModule from '../../src/ts/cli/commands/update';
import type * as logsModule from '../../src/ts/cli/commands/logs';
import type * as settingsCommandsModule from '../../src/ts/cli/commands/settings';
import type * as scenariosModule from '../../src/ts/cli/commands/scenarios';
import type * as cliSessionLockModule from '../../src/ts/settings/cliSessionLock';
import { invalid } from '../helpers/invalid';
import { CURRENT_NOTICE_VERSION } from '../../src/ts/noticeVersion';

type Mods = {
    logger: jest.MockedObjectDeep<typeof loggerModule> & { __calls: { level: string; msg: unknown }[] };
    settings: jest.MockedObjectDeep<typeof settingsModule>;
    randomizer: jest.MockedObjectDeep<typeof randomizerModule>;
    guards: jest.MockedObjectDeep<typeof guardsModule>;
    auth: jest.MockedObjectDeep<typeof authModule>;
    voting: jest.MockedObjectDeep<typeof votingModule>;
    status: jest.MockedObjectDeep<typeof statusModule>;
    actions: jest.MockedObjectDeep<typeof actionsModule>;
    submit: jest.MockedObjectDeep<typeof submitModule>;
    spend: jest.MockedObjectDeep<typeof spendModule>;
    bankroll: jest.MockedObjectDeep<typeof bankrollModule>;
    join: jest.MockedObjectDeep<typeof joinModule>;
    pin: jest.MockedObjectDeep<typeof pinModule>;
    photos: jest.MockedObjectDeep<typeof photosModule>;
    deadlines: jest.MockedObjectDeep<typeof deadlinesModule>;
    update: jest.MockedObjectDeep<typeof updateModule>;
    logs: jest.MockedObjectDeep<typeof logsModule>;
    cmd: jest.MockedObjectDeep<typeof settingsCommandsModule>;
    scenarios: jest.MockedObjectDeep<typeof scenariosModule>;
    sessionLock: jest.MockedObjectDeep<typeof cliSessionLockModule> & { __release: jest.Mock<void, []> };
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
        printStderr: rec('stderr'),
        cleanup: jest.fn(),
    };
});

jest.mock('../../src/ts/settings', () => ({
    loadSettings: jest.fn(() => ({ app: { mock: false } })),
    getSettingsRecovery: jest.fn(() => null),
    getSetting: jest.fn(() => 1),
    setSetting: jest.fn(() => true),
    seedIntentProfiles: jest.fn(),
    // The facade's check, as the plain image-id pattern.
    isPinnableImageId: jest.fn((value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)),
}));

jest.mock('../../src/ts/api/randomizer', () => ({ initializeHeaders: jest.fn() }));

// The marker a running command holds in the user-data directory: recorded, never written.
jest.mock('../../src/ts/settings/cliSessionLock', () => {
    const release = jest.fn<void, []>();
    return { __release: release, holdCliSessionLock: jest.fn(() => release) };
});

// This test loads real command helpers while fs is globally mocked. Mock
// Electron so its package entry point does not try to download a binary.
jest.mock('electron', () => ({}));

jest.mock('../../src/ts/cli/guards', () => ({
    requireChallenge: jest.fn(({ challengeId }: { challengeId: string | null }) => challengeId),
    requireProfileArgs: jest.fn((command: string, { rest }: { rest: string[] }) => rest[0]),
    // The usage line the profile commands print: the real helper's exact format.
    profileUsage: (command: string, needsChallenge: boolean): string =>
        needsChallenge ? `Usage: ${command} "<name>" --challenge=<id>` : `Usage: ${command} "<name>"`,
    ensureAuthenticated: jest.fn(() => true),
    // The worded refusals the real command modules build on at module scope.
    INVALID_ID_TEXT: 'Invalid challenge or image id.',
    resolveChallenge: jest.fn(async () => null),
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
    };
});

jest.mock('../../src/ts/cli/commands/status', () => ({
    showStatus: jest.fn(),
    rankingTail: jest.fn(() => null),
}));

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
        swapCmd: jest.fn(),
        swapBackCmd: jest.fn(),
    };
});

jest.mock('../../src/ts/cli/commands/submit', () => ({
    fillChallenge: jest.fn(),
    submitPickedCmd: jest.fn(async () => 0),
}));

jest.mock('../../src/ts/cli/commands/spend', () => ({
    unlockBoostCmd: jest.fn(),
    fillExposureCmd: jest.fn(),
}));

jest.mock('../../src/ts/cli/commands/deadlines', () => ({ deadlinesCmd: jest.fn(async () => true) }));

jest.mock('../../src/ts/cli/commands/pin', () => ({
    PIN_USAGE: 'Usage: pin --challenge=<id> [--boost=<imageId|none>] [--turbo=<imageId|none>]',
    pinCmd: jest.fn(),
}));

jest.mock('../../src/ts/cli/commands/bankroll', () => ({ showBankroll: jest.fn() }));
jest.mock('../../src/ts/cli/commands/join', () => ({
    showDiscover: jest.fn(),
    joinChallengeCmd: jest.fn(async () => 0),
    forgetPaymentCmd: jest.fn(async () => 0),
}));
jest.mock('../../src/ts/cli/commands/photos', () => ({
    ...jest.requireActual<typeof import('../../src/ts/cli/commands/photos')>('../../src/ts/cli/commands/photos'),
    listPhotosCmd: jest.fn(async () => 0),
    suggestPhotosCmd: jest.fn(async () => 0),
}));
jest.mock('../../src/ts/cli/commands/update', () => ({ checkUpdates: jest.fn() }));
jest.mock('../../src/ts/cli/commands/logs', () => ({ showLogs: jest.fn(), followLogs: jest.fn(async () => 0) }));
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
            'scenarioResetAllCmd',
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
            status: require('../../src/ts/cli/commands/status') as typeof statusModule,
            actions: require('../../src/ts/cli/commands/actions') as typeof actionsModule,
            submit: require('../../src/ts/cli/commands/submit') as typeof submitModule,
            spend: require('../../src/ts/cli/commands/spend') as typeof spendModule,
            bankroll: require('../../src/ts/cli/commands/bankroll') as typeof bankrollModule,
            join: require('../../src/ts/cli/commands/join') as typeof joinModule,
            pin: require('../../src/ts/cli/commands/pin') as typeof pinModule,
            photos: require('../../src/ts/cli/commands/photos') as typeof photosModule,
            deadlines: require('../../src/ts/cli/commands/deadlines') as typeof deadlinesModule,
            update: require('../../src/ts/cli/commands/update') as typeof updateModule,
            logs: require('../../src/ts/cli/commands/logs') as typeof logsModule,
            cmd: require('../../src/ts/cli/commands/settings') as typeof settingsCommandsModule,
            scenarios: require('../../src/ts/cli/commands/scenarios') as typeof scenariosModule,
            sessionLock: require('../../src/ts/settings/cliSessionLock') as typeof cliSessionLockModule,
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
        // `exit` releases the session marker `status` holds like every command that loads the settings.
        expect(Object.keys(processHandlers).sort()).toEqual(['exit', 'uncaughtException', 'unhandledRejection']);
        expect(m.status.showStatus).toHaveBeenCalled();
        expect(m.exitCodes).toEqual([0]);
        expect(m.logger.cleanup).toHaveBeenCalled();
    });

    test('saved settings that are not in use are said on stderr before the command runs', async () => {
        const m = await run(['status'], (mods) =>
            mods.settings.getSettingsRecovery.mockReturnValue({
                code: 'settings-corrupt',
                path: '/u/settings.json.corrupt-1',
                blocking: false,
            }),
        );
        expect(m.msgs('stderr')).toEqual([expect.stringContaining('/u/settings.json.corrupt-1')]);
        expect(m.status.showStatus).toHaveBeenCalled();
        expect(m.exitCodes).toEqual([0]);
    });

    test('with the settings in use nothing is said', async () => {
        const m = await run(['status']);
        expect(m.msgs('stderr')).toEqual([]);
    });

    test('the unofficial-tool notice is said on stderr before the command runs, once', async () => {
        const m = await run(['status'], (mods) => mods.settings.getSetting.mockReturnValue(0));
        expect(m.msgs('stderr')).toEqual([expect.stringContaining('not affiliated with or endorsed by GuruShots')]);
        expect(m.settings.setSetting).toHaveBeenCalledWith('noticeAcknowledgedVersion', CURRENT_NOTICE_VERSION);
        expect(m.status.showStatus).toHaveBeenCalled();
    });

    test('a failed intent-profile seed is a warning, not fatal', async () => {
        const m = await run(['status'], (mods) =>
            mods.settings.seedIntentProfiles.mockImplementation(() => {
                throw new Error('seed');
            }),
        );
        expect(m.msgs('warning')).toEqual(['Intent profile seeding failed (non-fatal):']);
        expect(m.status.showStatus).toHaveBeenCalled();
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [true, 0],
        [false, 1],
    ])('login that answers %p (token saved) exits %p', async (saved, code) => {
        const m = await run(['login'], (mods) => mods.auth.handleLogin.mockResolvedValue(saved));
        expect(m.exitCodes).toEqual([code]);
    });

    test('a thrown command exits 1', async () => {
        const m = await run(['login'], (mods) => mods.auth.handleLogin.mockRejectedValue(new Error('x')));
        expect(m.msgs('error')).toEqual(['Error']);
        expect(m.exitCodes).toEqual([1]);
    });

    test('a user-data folder that cannot be created is said in plain words and exits 1', async () => {
        const m = await run(['status'], (mods) =>
            mods.randomizer.initializeHeaders.mockImplementation(() => {
                const runtime = require('../../src/ts/runtime') as typeof runtimeModule;
                throw new runtime.UserDataUnavailableError('/data/gurushots', 'EACCES');
            }),
        );
        expect(m.msgs('error')).toEqual([expect.stringContaining('/data/gurushots')]);
        expect(m.msgs('error')[0]).toContain('EACCES');
        expect(m.msgs('error')).not.toContain('Error');
        expect(m.status.showStatus).not.toHaveBeenCalled();
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

describe('the CLI session marker', () => {
    test.each([
        ['vote', []],
        ['run', []],
        ['start', []],
        ['login', []],
        ['logout', []],
        ['boost', ['--challenge=1']],
        ['turbo', ['--challenge=1']],
        ['submit', ['--challenge=1']],
        ['deadlines', ['--challenge=1']],
        ['join', ['1']],
        ['swap', ['--challenge=1']],
        ['fill-exposure', ['--challenge=1']],
        ['set-setting', ['exposure', '80']],
        ['reset-all-settings', []],
        ['discover', []],
        ['check-updates', []],
        // Anything that loads the settings can write them back, so the read-only commands hold it too.
        ['status', []],
        ['get-setting', ['exposure']],
        ['list-settings', []],
        ['list-profiles', []],
        ['list-photos', []],
        ['list-scenarios', []],
        ['logs', []],
        ['help-settings', []],
    ])('%s holds it until the process exits', async (command, tail) => {
        const m = await run([command, ...tail]);

        expect(m.sessionLock.holdCliSessionLock).toHaveBeenCalledTimes(1);
        // Released when the process exits, however it ends; never earlier.
        expect(processHandlers.exit).toBe(m.sessionLock.__release);
        expect(m.sessionLock.__release).not.toHaveBeenCalled();
    });

    test.each([
        ['help', []],
        ['--help', []],
        ['-h', []],
        ['licenses', []],
        ['reset-data', []],
    ])('%s holds none: it never loads the settings, or checks for sessions itself', async (command, tail) => {
        const m = await run([command, ...tail]);

        expect(m.sessionLock.holdCliSessionLock).not.toHaveBeenCalled();
        expect(processHandlers.exit).toBeUndefined();
    });

    test.each([[[]], [['frobnicate']], [['constructor']]])(
        'none is held for %p (no command, or an unknown one)',
        async (argv) => {
            const m = await run(argv);

            expect(m.sessionLock.holdCliSessionLock).not.toHaveBeenCalled();
        },
    );

    test('is held before the settings are first written (the headers, the presets), and before the command runs', async () => {
        const m = await run(['logout']);

        expect(m.sessionLock.holdCliSessionLock.mock.invocationCallOrder[0]).toBeLessThan(
            m.randomizer.initializeHeaders.mock.invocationCallOrder[0],
        );
        expect(m.sessionLock.holdCliSessionLock.mock.invocationCallOrder[0]).toBeLessThan(
            m.settings.seedIntentProfiles.mock.invocationCallOrder[0],
        );
        expect(m.sessionLock.holdCliSessionLock.mock.invocationCallOrder[0]).toBeLessThan(
            m.auth.handleLogout.mock.invocationCallOrder[0],
        );
    });

    test('a marker that cannot be written is one warning with the cause, and the command still runs', async () => {
        const m = await run(['logout'], (mods) =>
            mods.sessionLock.holdCliSessionLock.mockImplementation(() => {
                throw Object.assign(new Error("EACCES: permission denied, open '/Users/me/data/cli-session-1.lock'"), {
                    code: 'EACCES',
                });
            }),
        );

        expect(m.msgs('warning')).toEqual([
            "Could not mark this command as running (a local-data wipe will not wait for it): EACCES: permission denied, open 'cli-session-1.lock'",
        ]);
        expect(m.auth.handleLogout).toHaveBeenCalled();
        expect(m.msgs('error')).toEqual([]);
        expect(m.exitCodes).toEqual([0]);
        expect(processHandlers.exit).toBeUndefined();
    });

    test('a marker failure with no message is still one warning', async () => {
        const m = await run(['logout'], (mods) =>
            mods.sessionLock.holdCliSessionLock.mockImplementation(() => {
                throw null;
            }),
        );

        expect(m.msgs('warning')).toEqual([expect.stringContaining('unknown error')]);
        expect(m.exitCodes).toEqual([0]);
    });
});

// The Commands block, pinned byte for byte: help must print exactly this — the command rows' help
// lines joined with newlines, between the "Commands:" header and the blank line before "Examples:".
const COMMANDS_BLOCK = `Commands:
  login    - Authenticate with GuruShots and save token
  logout   - Clear the saved authentication token
  vote     - Run one manual voting cycle (votes to 100% regardless of settings; skips Manual Only challenges).
             Add --challenge=<id> to manually vote a single challenge, which works on a Manual Only one too.
  run      - Run one full auto-strategy cycle (boost / turbo / auto-submit / threshold-aware vote).
             Add --challenge=<id> to scope to a single challenge; on a Manual Only challenge it does nothing.
  challenges - List the active challenges with their ids — the id every --challenge=<id> command needs.
             Add --challenge=<id> for one challenge in detail (its photo ids, to aim --image=<id> at).
             Alias: list
  deadlines - Show the deadline actions that will run on a challenge by itself (auto-submit, emergency
             submit, boost, turbo) with the time each is due, and any Boost/Turbo conflict with what
             blocks it and when a blocking pin gives way. Nothing is spent; the preview is a snapshot.
  boost    - Apply a boost to a challenge: boost --challenge=<id> [--image=<id>]
  pin      - Pin the photo Boost and Turbo land on (timing is unchanged; none clears a pin; no flags lists them):
             pin --challenge=<id> [--boost=<imageId|none>] [--turbo=<imageId|none>]
  turbo    - Play the turbo mini-game on a challenge to earn a Turbo: turbo --challenge=<id>.
             With --image=<id>, apply an already-won Turbo to that photo instead
             (challenges --challenge=<id> lists the photo ids). Exits 1 when the Turbo
             was not earned or applied.
  submit   - Submit photo(s) to a challenge's empty slots: submit --challenge=<id> [--all | --image=<id>[,<id>…]]
             --all submits to every empty slot (ranked by the auto-submit rules); --image submits exactly
             the photos named, comma-separated (list-photos --challenge=<id> shows the ids). Exits 1 when
             nothing was submitted. Exits 2 when the submit got no answer: the photo(s) may have been
             submitted — check the challenge before retrying.
  unlock-boost  - Spend a key to unlock a locked boost (does not apply it):
             unlock-boost --challenge=<id> [--yes]
  swap     - Spend a swap to replace an entered photo: without --to it suggests a different one,
             with --to=<id> it swaps in the photo you name (list-photos --challenge=<id> shows them):
             swap --challenge=<id> --image=<id> [--to=<id>] [--yes]
  swap-back - Swap a photo that was swapped out while boosted, turbo'd or guru-picked back in (it
             gets its boost/turbo/Guru's pick back): swap-back --challenge=<id> --image=<current id> [--yes]
             Without --image, list the recorded swap-back offers for the challenge.
  fill-exposure - Spend a fill to top exposure up to 100%: fill-exposure --challenge=<id> [--yes]
             Currency actions spend nothing without --yes; they print the cost first.
  start    - Start continuous voting on a schedule (runs until stopped with Ctrl+C)
  status   - Show current status and settings
  bankroll - Show your currency balances (keys / swaps / fills / coins). Alias: coins
  discover - List open (un-joined) challenges you can join, and the upcoming ones starting
             within discoverUpcomingHours (24 by default; 0 = open only). An upcoming challenge
             can't be joined until it starts, but you can choose its photos now.
  join <id> [--yes [--max-coins=<coins>]] - Join an open challenge. Free joins immediately; paid joins
             print the coin cost and require --yes before spending coins. --yes alone pays
             up to the cost printed first; with --max-coins=<coins> it refuses (and spends nothing) if the cost
             is above that. An upcoming challenge answers that it has not started. Exits 1 when the
             challenge was not joined, including a paid challenge priced without --yes.
  forget-payment <id> - Forget a join payment the app could not confirm (it got no answer), after checking on the
             GuruShots website that the coins were not taken. The next join asks for the price again; if the
             coins were taken, joining again charges a second time, and auto-join may join it again within its
             coin budget.
  list-photos [--challenge=<id>] [--search=<tag>] [--sort=votes|newest|oldest] - List your photo ids, to choose
             them for auto-join / auto-submit. With --challenge each photo shows whether that challenge accepts
             it. --sort orders the whole library on the server — votes (the default), newest or oldest (the
             date the photo was added to your library) — and the whole listing comes out in that order.
             --search matches a tag exactly, and also lists the tags in your library that contain the term (3+
             characters), so a partial term still shows the full tag to search with.
             --stats also reads votes, views, likes and Guru picks for the listed photos — the first
             --limit=<n> of them (at most 500), 30 by default; a photo whose stats could not be read
             says so instead of showing zeros.
  list-photos --challenge=<id> --suggest - Rank your photos for that challenge by your auto-submit rules and list
             the top 5, best first. It is a ranking under those rules, not a replay of the next fill, and
             nothing is submitted. It cannot be combined with --search, --sort or --stats.
  check-updates - Check GitHub for a newer release
  get-setting <key> [--challenge=<id>] - Get a setting value (effective value for a challenge with --challenge)
  set-setting <key> <value> [--challenge=<id>] - Set a setting value (per-challenge override with --challenge)
  set-global-default <key> <value> - Set global default with validation
  list-settings [--challenge=<id>] - Show all settings (per-challenge view with --challenge)
  reset-setting <key> [--challenge=<id>] - Reset a setting to default (clear a challenge override with --challenge).
             Without --challenge, a voting setting resets its global default.
  reset-global-default <key> - Reset a voting setting's global default to its shipped value
  reset-all-settings - Reset all settings to defaults
      To remove one challenge's own chosen-photos list (it then inherits from rules / global):
             reset-setting chosenPhotos --challenge=<id>
      To use no chosen photos for that challenge (overriding rules / global):
             set-setting chosenPhotos '[]' --challenge=<id>
  reset-all-global-defaults [--yes] - Without --yes, list the global defaults that differ from
             their shipped values (current → default) and change nothing; with --yes, reset them all.
  list-profiles - Show saved challenge-settings profiles
  save-profile "<name>" --challenge=<id> - Save a challenge's overrides as a named profile
  apply-profile "<name>" --challenge=<id> - Replace a challenge's overrides with a profile
  delete-profile "<name>" - Delete a saved profile
  list-title-rules - Show the stored challenge rules: what each matches and what it does
  export-title-rules [file] [--overwrite] - Print (or write) the challenge rules as JSON,
             to edit and import back. An existing file is refused without --overwrite.
  import-title-rules <file> [--yes] - Check a title-rules JSON file and show what it replaces
             (what would be stored, and every rule it drops or collapses, with the reason);
             --yes imports it. A file that cannot be read or parsed is never merged.
  title-profile --challenge=<id> - Which rule or profile applies to a challenge,
             and the settings they set
  list-scenarios - Show saved scenarios and the example templates
  scenario-template <id> [file] - Print (or write) an example scenario to start from
  import-scenario <file> [--overwrite] [--yes] - Check a scenario file and show what it does; --yes imports it
  export-scenario "<name>" [file] - Print (or write) a scenario as JSON to share
  rename-scenario "<old>" "<new>" - Rename a scenario; its assignments follow
  delete-scenario "<name>" - Delete a scenario and clear its assignments
  scenario-status --challenge=<id> - Where a challenge is in its scenario
  scenario-dry-run --challenge=<id> - What the scenario would do right now (spends nothing)
  scenario-simulate --challenge=<id> - A what-if timeline until the challenge closes (spends nothing)
  scenario-reset --challenge=<id> - Forget a challenge's scenario progress (the plan restarts). It may spend again an action
             whose outcome is unknown (no answer, or the app could not record it), and it restarts the scenario's
             spend counter.
  scenario-reset --all - Forget every challenge's scenario progress: the only way past a progress file that cannot be
             read. The rules that already ran can run again, with the same warning as above.
  scenario-vocabulary - List every condition, selector and action a scenario can use
             Assign one with: set-setting scenario "<name>" --challenge=<id> (or a challenge rule)
  help-settings - Show detailed settings help (includes profile details)
  logs [--error|--api|--settings|--lexicon] [--lines=<n>] - Show logs or the local lexicon report
  logs [--error|--api|--settings] --follow - Follow every log file of the category as it is written; a --- line names
             the file new output comes from; Ctrl+C stops
  licenses - Print the third-party license notices
  reset-data --yes - Delete everything stored on this device: settings and the saved login, every store, logs and
             the extracted vision runtime. It cannot be undone, so it does nothing without --yes. Quit the
             desktop app, stop the web UI and wait for (or stop) any other CLI command or session first: it refuses to
             delete while one is running.
  reset-windows  - Reset window positions to default
  settings-recovery retry|start-fresh|report|acknowledge - When the saved settings are not in use: try importing
             settings.json again, begin with default settings (settings.json is left as it is; refused while the import
             may pass by itself, unless start-fresh --force), print what the import left unresolved (report), or mark
             that report as seen (acknowledge)
  help     - Show this help message`;

describe('help and unknown commands', () => {
    test.each([['help'], ['--help'], ['-h']])('%s prints help in REAL mode', async (flag) => {
        const m = await run([flag]);
        // The help is printed whole, on the console only, with its line breaks (not as a log entry).
        expect(m.msgs('info')).toEqual([]);
        const [text] = m.msgs('stdout');
        expect(text.split('\n').length).toBeGreaterThan(30);
        expect(text).toContain(COMMANDS_BLOCK);
        expect(text).toContain('GuruShots Auto Voter - CLI (REAL MODE)');
        expect(text).toContain('Current mode: REAL (live API calls)');
        expect(m.exitCodes).toEqual([0]);
    });

    test('help in MOCK mode says so', async () => {
        const m = await run(['help'], (mods) =>
            mods.settings.loadSettings.mockReturnValue(invalid({ app: { mock: true } })),
        );
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
        ['status', 'status', 'showStatus'],
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

// The three spellings a repeated --challenge can take, shared by the refusal
// tables below.
const repeatForms: Array<[string, string[]]> = [
    ['both in the = form', ['--challenge=1', '--challenge=2']],
    ['both in the space form', ['--challenge', '1', '--challenge', '2']],
    ['the forms mixed', ['--challenge=1', '--challenge', '2']],
];

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

    test.each([
        [['--challenge=5'], {}],
        [['--challenge=5', '--boost=abc'], { boost: 'abc' }],
        [['--challenge=5', '--turbo=none'], { turbo: null }],
        [['--turbo=NONE', '--challenge', '5', '--boost=x'], { boost: 'x', turbo: null }],
        [['--challenge=5', '--boost=entry_007', '--turbo=a-B_9'], { boost: 'entry_007', turbo: 'a-B_9' }],
        [['--challenge=5', '--boost=none', '--turbo=none'], { boost: null, turbo: null }],
    ])('pin %p', async (tail, pins) => {
        const m = await run(['pin', ...tail], (mods) => mods.pin.pinCmd.mockResolvedValue(true));
        expect(m.guards.requireChallenge).toHaveBeenCalledWith({ challengeId: '5' }, m.pin.PIN_USAGE);
        expect(m.pin.pinCmd).toHaveBeenCalledWith('5', pins);
        expect(m.exitCodes).toEqual([0]);
    });

    test('pin exits 1 when the pin could not be read or saved', async () => {
        const m = await run(['pin', '--challenge=5', '--boost=abc'], (mods) =>
            mods.pin.pinCmd.mockResolvedValue(false),
        );
        expect(m.exitCodes).toEqual([1]);
    });

    test.each([['--boost='], ['--turbo=']])('pin %s with no value is a usage error', async (flag) => {
        const m = await run(['pin', '--challenge=5', flag]);
        expect(m.pin.pinCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual([`${flag.slice(0, -1)} needs an image id, or none to clear the pin`]);
        expect(m.msgs('info')).toEqual([m.pin.PIN_USAGE]);
        expect(m.exitCodes).toEqual([1]);
    });

    test.each([
        [['--boost', 'abc']],
        [['--boots=abc']],
        [['--boost=abc', 'stray']],
        [['--yes']],
        [['--boost=a', '--boost=b']],
        [['--turbo=a', '--turbo=b']],
    ])('pin %p is a usage error, never a listing', async (tail) => {
        const m = await run(['pin', '--challenge=5', ...tail]);
        expect(m.pin.pinCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Wrong arguments']);
        expect(m.msgs('info')).toEqual([m.pin.PIN_USAGE]);
        expect(m.exitCodes).toEqual([1]);
    });

    test.each([
        ['--boost=has space', 'boost'],
        ['--turbo=a\nb', 'turbo'],
        ['--boost=' + 'a'.repeat(65), 'boost'],
        ['--turbo=../x', 'turbo'],
    ])('pin %j names the characters an image id may use and logs no raw input', async (arg, kind) => {
        const m = await run(['pin', '--challenge=5', arg]);
        expect(m.pin.pinCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual([
            `--${kind} takes an image id: letters, digits, _ and -, at most 64 characters (or none to clear the pin)`,
        ]);
        expect(m.msgs('info')).toEqual([m.pin.PIN_USAGE]);
        expect(m.exitCodes).toEqual([1]);
    });

    test('pin --boost and --turbo naming the same image is a usage error', async () => {
        const m = await run(['pin', '--challenge=5', '--boost=abc', '--turbo=abc']);
        expect(m.pin.pinCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual([
            '--boost and --turbo name the same image: a photo is pinned for one feature only',
        ]);
        expect(m.exitCodes).toEqual([1]);
    });

    test('turbo', async () => {
        const m = await run(['turbo', '--challenge=5']);
        expect(m.actions.turboChallenge).toHaveBeenCalledWith('5', { imageId: null });
    });

    test.each([
        [['--challenge=5', '--all'], true],
        [['--challenge=5'], false],
    ])('submit %p', async (tail, all) => {
        const m = await run(['submit', ...tail]);
        expect(m.submit.fillChallenge).toHaveBeenCalledWith('5', { all });
    });

    test.each([
        [['--challenge=5', '--image=abc'], ['abc']],
        [
            ['--challenge=5', '--image=abc,def'],
            ['abc', 'def'],
        ],
    ])('submit %p submits the picked photos', async (tail, ids) => {
        const m = await run(['submit', ...tail]);
        expect(m.submit.submitPickedCmd).toHaveBeenCalledWith('5', ids);
        expect(m.submit.fillChallenge).not.toHaveBeenCalled();
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [['--all', '--image=a']],
        [['--images=a']],
        [['--image=a', '--image=b']],
        [['--image', 'a']],
        [['stray']],
    ])('submit %p is a usage error and submits nothing', async (tail) => {
        const m = await run(['submit', '--challenge=5', ...tail]);
        expect(m.submit.submitPickedCmd).not.toHaveBeenCalled();
        expect(m.submit.fillChallenge).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Wrong arguments']);
        expect(m.msgs('info')).toEqual(['Usage: submit --challenge=<id> [--all | --image=<id>[,<id>…]]']);
        expect(m.exitCodes).toEqual([1]);
    });

    test('submit --image with no value names what is missing', async () => {
        const m = await run(['submit', '--challenge=5', '--image=']);
        expect(m.submit.submitPickedCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')[0]).toContain('--image needs a photo id');
        expect(m.exitCodes).toEqual([1]);
    });

    test.each<[string, 'unlockBoostCmd' | 'fillExposureCmd']>([
        ['unlock-boost', 'unlockBoostCmd'],
        ['fill-exposure', 'fillExposureCmd'],
    ])('%s forwards --yes', async (command, fn) => {
        const m = await run([command, '--challenge=5', '--yes']);
        expect(m.spend[fn]).toHaveBeenCalledWith('5', { yes: true });
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

    test('swap-back without --image asks for the recorded offers', async () => {
        const m = await run(['swap-back', '--challenge=5']);
        expect(m.actions.swapBackCmd).toHaveBeenCalledWith('5', { imageId: undefined, yes: false });
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([[['--to=b']], [['--yes', '--yes']], [['--image=a', '--image=b']], [['--image', 'a']], [['stray']]])(
        'swap-back %p is a usage error and swaps nothing',
        async (tail) => {
            const m = await run(['swap-back', '--challenge=5', ...tail]);
            expect(m.actions.swapBackCmd).not.toHaveBeenCalled();
            expect(m.msgs('error')).toEqual(['Wrong arguments']);
            expect(m.msgs('info')).toEqual([
                'Usage: swap-back --challenge=<id>  |  swap-back --challenge=<id> --image=<id> [--yes]',
            ]);
            expect(m.exitCodes).toEqual([1]);
        },
    );

    test('swap-back --image with no value names what is missing', async () => {
        const m = await run(['swap-back', '--challenge=5', '--image=']);
        expect(m.actions.swapBackCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')[0]).toContain('--image needs a photo id');
        expect(m.exitCodes).toEqual([1]);
    });

    // A repeated --challenge would silently act on the first id while the user
    // named two — for a spend that is money on the wrong challenge. Every
    // challenge command refuses it in any spelling, before anything runs.
    const repeatCommands: Array<[string, 'actions' | 'spend', string, string]> = [
        ['boost', 'actions', 'boostChallenge', 'Usage: boost --challenge=<id> [--image=<id>]'],
        ['swap', 'actions', 'swapCmd', 'Usage: swap --challenge=<id> --image=<id> [--to=<id>] [--yes]'],
        ['unlock-boost', 'spend', 'unlockBoostCmd', 'Usage: unlock-boost --challenge=<id> [--yes]'],
        ['fill-exposure', 'spend', 'fillExposureCmd', 'Usage: fill-exposure --challenge=<id> [--yes]'],
    ];
    type RepeatRow = [string, string, 'actions' | 'spend', string, string, string[]];
    const repeatRows: RepeatRow[] = repeatCommands.flatMap(([command, mod, fn, usage]) =>
        repeatForms.map(([label, argv]): RepeatRow => [`${command}: ${label}`, command, mod, fn, usage, argv]),
    );
    test.each(repeatRows)('%s prints the usage and exits 1', async (_label, command, mod, fn, usage, argv) => {
        const m = await run([command, ...argv]);
        expect(invalid<Record<string, jest.Mock<Promise<unknown>, unknown[]>>>(m[mod])[fn]).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Wrong arguments']);
        expect(m.msgs('info')).toEqual([usage]);
        expect(m.exitCodes).toEqual([1]);
    });

    test('deadlines passes the challenge and exits with the command result', async () => {
        const m = await run(['deadlines', '--challenge=7'], (mods) =>
            mods.deadlines.deadlinesCmd.mockResolvedValue(false),
        );
        expect(m.deadlines.deadlinesCmd).toHaveBeenCalledWith('7');
        expect(m.exitCodes).toEqual([1]);
    });

    test('deadlines with no arguments names what is missing', async () => {
        const m = await run(['deadlines']);
        expect(m.deadlines.deadlinesCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Please specify a challenge id with --challenge']);
        expect(m.msgs('info')).toEqual(['Usage: deadlines --challenge=<id>']);
        expect(m.exitCodes).toEqual([1]);
    });

    test.each([
        [['--challenge', '7']],
        [['--challenge=']],
        [['--challenge=7', '--challenge=8']],
        [['--challenge=7', 'extra']],
    ])('deadlines %p is a usage error', async (tail) => {
        const m = await run(['deadlines', ...tail]);
        expect(m.deadlines.deadlinesCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Wrong arguments']);
        expect(m.msgs('info')).toEqual(['Usage: deadlines --challenge=<id>']);
        expect(m.exitCodes).toEqual([1]);
    });

    test('join picks the first positional id and --yes', async () => {
        const m = await run(['join', '--yes', '77']);
        expect(m.join.joinChallengeCmd).toHaveBeenCalledWith('77', { yes: true });
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [0, 0],
        [1, 1],
    ])('join exits with what the command answers (%p): 1 when it did not join', async (answer, code) => {
        const m = await run(['join', '77'], (mods) => mods.join.joinChallengeCmd.mockResolvedValue(answer));
        expect(m.exitCodes).toEqual([code]);
    });

    test('join --max-coins names the most a confirmed join may cost', async () => {
        const m = await run(['join', '77', '--yes', '--max-coins=30']);
        expect(m.join.joinChallengeCmd).toHaveBeenCalledWith('77', { yes: true, maxCoins: 30 });
        const zero = await run(['join', '77', '--yes', '--max-coins=0']);
        expect(zero.join.joinChallengeCmd).toHaveBeenCalledWith('77', { yes: true, maxCoins: 0 });
    });

    // `join` spends coins: anything that is not exactly `<id> [--yes] [--max-coins=<digits>]` joins nothing.
    test.each([
        [['77', '--yes', '--max-coins=']],
        [['77', '--yes', '--max-coins=abc']],
        [['77', '--yes', '--max-coins=-5']],
        [['77', '--yes', '--max-coins=1.5']],
        [['77', '--yes', `--max-coins=${'9'.repeat(400)}`]],
        [['77', '--yes', `--max-coins=${'9'.repeat(17)}`]],
        [['77', '--yes', '--max-coins', '25']],
        [['77', '--yes', '--max-coins']],
        [['--max-coins', '25', '77', '--yes']],
        [['77', '--yes', '--max-coin=25']],
        [['77', '--yes', '--maxcoins=25']],
        [['77', '--yes', '--max-coins=25', '--max-coins=30']],
        [['77', '--yes', '--yes']],
        [['77', '--force']],
        [['77', '88', '--yes']],
        [['77', '-y']],
    ])('join %p is a usage error and joins nothing', async (args) => {
        const m = await run(['join', ...args]);
        expect(m.join.joinChallengeCmd).not.toHaveBeenCalled();
        expect(m.exitCodes).toEqual([1]);
    });

    test('join takes the id and the flags in any order, and the largest cap that is an exact integer', async () => {
        const safe = String(Number.MAX_SAFE_INTEGER);
        const m = await run(['join', '--max-coins=25', '--yes', '77']);
        expect(m.join.joinChallengeCmd).toHaveBeenCalledWith('77', { yes: true, maxCoins: 25 });
        const big = await run(['join', '77', `--max-coins=${safe}`]);
        expect(big.join.joinChallengeCmd).toHaveBeenCalledWith('77', { yes: false, maxCoins: Number(safe) });
        // No id still reaches the command, which prints its usage.
        const none = await run(['join', '--yes']);
        expect(none.join.joinChallengeCmd).toHaveBeenCalledWith(undefined, { yes: true });
    });
});

// The commands that read --challenge through extractChallenge / parseChallengeFlag
// (outside the challenge-scoped actions above): a repeated flag would silently act
// on the first id while the user named two — read, write or vote on it. Every one
// refuses it in any spelling, prints its usage and exits 1, before anything runs.
describe('a repeated --challenge in the settings, profile, photo, vote and run commands', () => {
    const readCommands: Array<[string, keyof Mods, string, string]> = [
        [
            'vote',
            'voting',
            'voteChallengeManual',
            'Usage: vote [--challenge=<id>]  (omit --challenge to vote every challenge)',
        ],
        ['run', 'voting', 'runVotingCycle', 'Usage: run [--challenge=<id>]'],
        ['get-setting', 'cmd', 'getSetting', 'Usage: get-setting <key> [--challenge=<id>]'],
        ['set-setting', 'cmd', 'setSetting', 'Usage: set-setting <key> <value> [--challenge=<id>]'],
        ['reset-setting', 'cmd', 'resetSetting', 'Usage: reset-setting <key> [--challenge=<id>]'],
        ['list-settings', 'cmd', 'listSettings', 'Usage: list-settings [--challenge=<id>]'],
        ['list-profiles', 'cmd', 'listProfiles', 'Usage: list-profiles'],
        [
            'list-photos',
            'photos',
            'listPhotosCmd',
            'Usage: list-photos [--challenge=<id>] [--search=<tag>] [--sort=votes|newest|oldest] [--stats [--limit=<n>]]  or  list-photos --challenge=<id> --suggest',
        ],
        ['apply-profile', 'cmd', 'applyProfile', 'Usage: apply-profile "<name>" --challenge=<id>'],
        ['save-profile', 'cmd', 'saveProfileFromChallenge', 'Usage: save-profile "<name>" --challenge=<id>'],
        ['delete-profile', 'cmd', 'deleteProfile', 'Usage: delete-profile "<name>"'],
    ];
    type ReadRepeatRow = [string, string, keyof Mods, string, string, string[]];
    const readRepeatRows: ReadRepeatRow[] = readCommands.flatMap(([command, mod, fn, usage]) =>
        repeatForms.map(([label, argv]): ReadRepeatRow => [`${command}: ${label}`, command, mod, fn, usage, argv]),
    );
    test.each(readRepeatRows)('%s prints the usage and exits 1', async (_label, command, mod, fn, usage, argv) => {
        const m = await run([command, ...argv]);
        expect(
            invalid<Record<string, Record<string, jest.Mock<unknown, unknown[]>>>>(m)[mod][fn],
        ).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Wrong arguments']);
        expect(m.msgs('info')).toEqual([usage]);
        expect(m.exitCodes).toEqual([1]);
    });
});

describe('forget-payment', () => {
    test.each([
        [0, 0],
        [1, 1],
    ])('takes exactly one plain challenge id, and exits with what the command answers (%p)', async (answer, code) => {
        const m = await run(['forget-payment', '77'], (mods) => mods.join.forgetPaymentCmd.mockResolvedValue(answer));
        expect(m.join.forgetPaymentCmd).toHaveBeenCalledWith('77');
        expect(m.exitCodes).toEqual([code]);
    });

    // It changes what a later join pays for, so anything but `<digits>` touches nothing: a colon in the id
    // would reach a record that is keyed by account.
    test.each([
        [[]],
        [['77', '88']],
        [['--yes']],
        [['77', '--yes']],
        [['--challenge=77']],
        [['555:123']],
        [['abc']],
        [['-1']],
        [['1.5']],
        [['7 7']],
        [['']],
    ])('forget-payment %p is a usage error and forgets nothing', async (args) => {
        const m = await run(['forget-payment', ...args]);
        expect(m.join.forgetPaymentCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Wrong arguments']);
        expect(m.exitCodes).toEqual([1]);
    });
});

describe('list-photos', () => {
    test.each([
        [['list-photos'], null, null, null, null],
        [['list-photos', '--challenge=5'], '5', null, null, null],
        [['list-photos', '--search=sunset'], null, 'sunset', null, null],
        [['list-photos', '--search', 'sun set', '--challenge', '5'], '5', 'sun set', null, null],
        [['list-photos', '--sort=newest'], null, null, 'newest', null],
        [['list-photos', '--sort', 'oldest', '--challenge', '5'], '5', null, 'oldest', null],
        [['list-photos', '--sort=newest', '--search=sunset'], null, 'sunset', 'newest', null],
        [['list-photos', '--sort=votes'], null, null, 'votes', null],
    ])('%j reads the library', async (argv, challengeId, search, sort, statsLimit) => {
        const m = await run(argv);
        expect(m.photos.listPhotosCmd).toHaveBeenCalledWith(challengeId, search, sort, statsLimit);
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [['list-photos', '--stats'], null, 30],
        [['list-photos', '--stats', '--limit=5'], null, 5],
        [['list-photos', '--limit=12', '--challenge=5', '--stats'], '5', 12],
    ])('%j reads the stats with the default or named cap', async (argv, challengeId, statsLimit) => {
        const m = await run(argv);
        expect(m.photos.listPhotosCmd).toHaveBeenCalledWith(challengeId, null, null, statsLimit);
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [['--stats', '--suggest'], '--stats cannot be combined with --suggest'],
        [['--limit=5'], '--limit only goes with --stats'],
        [['--stats', '--limit=0'], '--limit needs a positive whole number of photos to read stats for'],
        [['--stats', '--limit=abc'], '--limit needs a positive whole number of photos to read stats for'],
        [['--stats', '--limit=-2'], '--limit needs a positive whole number of photos to read stats for'],
    ])('list-photos %p is refused with the named message', async (tail, message) => {
        const m = await run(['list-photos', ...tail]);
        expect(m.photos.listPhotosCmd).not.toHaveBeenCalled();
        expect(m.photos.suggestPhotosCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual([message]);
        expect(m.exitCodes).toEqual([1]);
    });

    test.each([
        [['--stats', '--stats']],
        [['--stats', '--limit=1', '--limit=2']],
        [['--stats=true']],
        [['--stats', '--limit', '5']],
        [['--statsx']],
    ])('list-photos %p is a generic usage error', async (tail) => {
        const m = await run(['list-photos', ...tail]);
        expect(m.photos.listPhotosCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Wrong arguments']);
        expect(m.exitCodes).toEqual([1]);
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
        [['list-photos', '--sort=a', 'stray']],
        [['list-photos', '--sortx']],
        [['list-photos', '--sort-term=a']],
        // --suggest ranks for one challenge and is not a search or a sort.
        [['list-photos', '--suggest']],
        [['list-photos', '--search=a', '--suggest']],
        [['list-photos', '--challenge=5', '--suggest', '--search=a']],
        [['list-photos', '--challenge=5', '--suggest', '--search', 'a']],
        [['list-photos', '--challenge=5', '--suggest', '--sort=newest']],
        [['list-photos', '--challenge=5', '--suggest', '--suggest']],
        [['list-photos', '--challenge=5', '--suggest', 'stray']],
    ])('%j is a usage error', async (argv) => {
        const m = await run(argv);
        expect(m.photos.listPhotosCmd).not.toHaveBeenCalled();
        expect(m.photos.suggestPhotosCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['Wrong arguments']);
        expect(m.msgs('info')).toEqual([
            'Usage: list-photos [--challenge=<id>] [--search=<tag>] [--sort=votes|newest|oldest] [--stats [--limit=<n>]]  or  list-photos --challenge=<id> --suggest',
        ]);
        expect(m.exitCodes).toEqual([1]);
    });

    // A --sort with no value of its own (end of the line, or another flag next)
    // names what it is missing rather than the generic wrong-arguments text.
    test.each([
        [['list-photos', '--sort']],
        [['list-photos', '--sort', '--search=sunset']],
        [['list-photos', '--challenge=5', '--sort', '--suggest']],
    ])('%j is refused with the --sort message', async (argv) => {
        const m = await run(argv);
        expect(m.photos.listPhotosCmd).not.toHaveBeenCalled();
        expect(m.photos.suggestPhotosCmd).not.toHaveBeenCalled();
        expect(m.msgs('error')).toEqual(['--sort needs one of votes|newest|oldest']);
        expect(m.msgs('info')).toEqual([
            'Usage: list-photos [--challenge=<id>] [--search=<tag>] [--sort=votes|newest|oldest] [--stats [--limit=<n>]]  or  list-photos --challenge=<id> --suggest',
        ]);
        expect(m.exitCodes).toEqual([1]);
    });

    // An unknown sort VALUE passes the parse table and is refused by the command itself.
    test.each([[['list-photos', '--sort=strongest']], [['list-photos', '--sort=toString']]])(
        '%j hands the unknown sort to the command, which refuses it',
        async (argv) => {
            const m = await run(argv);
            expect(m.photos.listPhotosCmd).toHaveBeenCalledWith(null, null, argv[1]!.slice('--sort='.length), null);
            expect(m.photos.suggestPhotosCmd).not.toHaveBeenCalled();
            expect(m.exitCodes).toEqual([0]);
        },
    );

    test.each([[['list-photos', '--challenge=5', '--suggest']], [['list-photos', '--suggest', '--challenge', '5']]])(
        '%j ranks the challenge’s photos without reading the library',
        async (argv) => {
            const m = await run(argv);
            expect(m.photos.suggestPhotosCmd).toHaveBeenCalledWith('5');
            expect(m.photos.listPhotosCmd).not.toHaveBeenCalled();
            expect(m.exitCodes).toEqual([0]);
        },
    );

    test("the suggestions' exit code is the command's", async () => {
        const m = await run(['list-photos', '--challenge=5', '--suggest'], (mods) =>
            mods.photos.suggestPhotosCmd.mockResolvedValue(1),
        );
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
        const m = await run(['set-setting', '--challenge', '5', 'exposure', '80'], (mods) =>
            mods.cmd.setSetting.mockReturnValue(true),
        );
        expect(m.cmd.setSetting).toHaveBeenCalledWith('exposure', '80', '5');
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [true, 0],
        [false, 1],
    ])(
        'set-setting exit code follows the result: a name that is no setting or a value it refuses fails (%p → %p)',
        async (saved, code) => {
            const m = await run(['set-setting', 'exposure', '999'], (mods) =>
                mods.cmd.setSetting.mockReturnValue(saved),
            );
            expect(m.exitCodes).toEqual([code]);
        },
    );

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
        const m = await run(['set-global-default', 'exposure', '80'], (mods) =>
            mods.cmd.setGlobalDefault.mockReturnValue(true),
        );
        expect(m.cmd.setGlobalDefault).toHaveBeenCalledWith('exposure', '80');
        expect(m.exitCodes).toEqual([0]);
    });

    test('set-global-default of a name that is no setting, or a refused value, exits 1', async () => {
        const m = await run(['set-global-default', 'nope', '80'], (mods) =>
            mods.cmd.setGlobalDefault.mockReturnValue(false),
        );
        expect(m.exitCodes).toEqual([1]);
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
    test.each<[string[], 'showLogs' | 'followLogs', { category: string; lines: number }]>([
        [[], 'showLogs', { category: 'app', lines: 100 }],
        [['--error', '--lines=20'], 'showLogs', { category: 'error', lines: 20 }],
        [['--api'], 'showLogs', { category: 'api', lines: 100 }],
        [['--lexicon'], 'showLogs', { category: 'lexicon', lines: 100 }],
        [['--follow'], 'followLogs', { category: 'app', lines: 100 }],
        [['--error', '--follow', '--lines=3'], 'followLogs', { category: 'error', lines: 3 }],
    ])('logs %p runs %s with %p', async (tail, fn, opts) => {
        const m = await run(['logs', ...tail]);
        const called = fn === 'showLogs' ? m.logs.showLogs : m.logs.followLogs;
        expect(called).toHaveBeenCalledWith(opts);
        expect(m.exitCodes).toEqual([0]);
    });

    test.each([
        [['--tail']],
        [['--lines=1', '--lines=2']],
        [['--lines', '20']],
        [['--lines=abc']],
        [['--lines=0']],
        [['--error', '--api']],
        [['--follow', '--follow']],
        [['--lexicon', '--follow']],
        [['stray']],
    ])('logs %p is a usage error that runs nothing', async (tail) => {
        const m = await run(['logs', ...tail]);
        expect(m.exitCodes).toEqual([1]);
        expect(m.logs.showLogs).not.toHaveBeenCalled();
        expect(m.logs.followLogs).not.toHaveBeenCalled();
        expect(m.msgs('info')).toContain('Usage: logs [--error|--api|--settings|--lexicon] [--lines=<n>] [--follow]');
    });

    test('the --lexicon --follow refusal says why', async () => {
        const m = await run(['logs', '--lexicon', '--follow']);
        expect(m.msgs('error')).toContain('--follow tails a log file; the lexicon report is not a file');
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
        [['scenario-reset', '--all'], 'scenarioResetAllCmd', []],
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

    test.each([[['scenario-reset', '--all', '--challenge=7']], [['scenario-reset', '--all', 'x']]])(
        '%p: --all takes no other arguments, and resets nothing',
        async (argv) => {
            const m = await run(argv);
            expect(m.msgs('error')).toContain('--all takes no other arguments');
            expect(m.scenarios.scenarioResetAllCmd).not.toHaveBeenCalled();
            expect(m.scenarios.scenarioResetCmd).not.toHaveBeenCalled();
            expect(m.exitCodes).toEqual([1]);
        },
    );

    test('a failing command exits with its code', async () => {
        const m = await run(['delete-scenario', 'Plan'], (mods) =>
            mods.scenarios.deleteScenarioCmd.mockResolvedValue(1),
        );
        expect(m.exitCodes).toEqual([1]);
    });
});
