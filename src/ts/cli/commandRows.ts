import { handleLogin, handleLogout } from './commands/auth';
import { showStatus, startContinuousVoting } from './commands/voting';
import {
    fillExposureCmd,
    parseSwapFlags,
    SWAP_BACK_USAGE,
    SWAP_USAGE,
    swapCmd,
    unlockBoostCmd,
} from './commands/actions';
import { PIN_USAGE } from './commands/pin';
import { showBankroll } from './commands/bankroll';
import { showDiscover } from './commands/join';
import { checkUpdates } from './commands/update';
import {
    applyProfile,
    deleteProfile,
    helpSettings,
    listSettings,
    resetAllSettings,
    resetWindows,
    saveProfileFromChallenge,
} from './commands/settings';
import { resetDataCmd, licensesCmd } from './commands/localData';
import { settingsRecoveryCmd } from './commands/settingsRecovery';
import * as scenarioCommands from './commands/scenarios';
import { showHelp } from './help';
import {
    challengeCommand,
    exitsZero,
    exitCodeOf,
    extractChallenge,
    flagAction,
    profileCommand,
    scenarioCommand,
} from './commandKit';
import {
    runBoost,
    runChallenges,
    runDeadlines,
    runExportTitleRules,
    runForgetPayment,
    runGetSetting,
    runImportTitleRules,
    runJoin,
    runListPhotos,
    runListProfiles,
    runListTitleRules,
    runLogs,
    runPin,
    runResetAllGlobalDefaults,
    runResetGlobalDefault,
    runResetSetting,
    runRun,
    runScenarioReset,
    runSetGlobalDefault,
    runSetSetting,
    runSubmit,
    runSwapBack,
    runTitleProfile,
    runTurbo,
    runVote,
} from './commandHandlers';

import type { CommandHandler } from './commandKit';

/**
 * One row per CLI command — the single home for its metadata: the handler, the usage text (the arg
 * shape its errors print), its verbatim help lines, any aliases, and whether it holds the CLI
 * session marker. help.ts renders the Commands block from the rows; commandTable.ts derives the
 * dispatch map from them.
 */
type CommandRow = {
    name: string;
    aliases?: readonly string[];
    handler: CommandHandler;
    usage?: string;
    help: readonly string[];
    markerless?: boolean;
};

// A handler that prints its command's usage reads the text back from its row, so the row stays the
// one home for it; the handlers live in commandHandlers.ts, on the other side of the module cycle.
const usageOf = (name: string): string => {
    const usage = COMMAND_ROWS.find((candidate) => candidate.name === name)?.usage;
    if (usage === undefined) throw new Error(`Command "${name}" carries no usage text in its row`);
    return usage;
};

// Builds one row; `extra` carries the row's optional aliases, usage text and markerless flag.
const row = (
    name: string,
    handler: CommandHandler,
    help: readonly string[],
    extra?: Pick<CommandRow, 'aliases' | 'usage' | 'markerless'>,
): CommandRow => ({ name, handler, help, ...extra });

// One row per command, in the order the help lists them.
const COMMAND_ROWS: readonly CommandRow[] = [
    row('login', async () => exitCodeOf(await handleLogin()), [
        '  login    - Authenticate with GuruShots and save token',
    ]),
    row('logout', async () => exitCodeOf(await handleLogout()), ['  logout   - Clear the saved authentication token']),
    row(
        'vote',
        runVote,
        [
            '  vote     - Run one manual voting cycle (votes to 100% regardless of settings; skips Manual Only challenges).',
            '             Add --challenge=<id> to manually vote a single challenge, which works on a Manual Only one too.',
        ],
        { usage: 'Usage: vote [--challenge=<id>]  (omit --challenge to vote every challenge)' },
    ),
    row('run', runRun, [
        '  run      - Run one full auto-strategy cycle (boost / turbo / auto-submit / threshold-aware vote).',
        '             Add --challenge=<id> to scope to a single challenge; on a Manual Only challenge it does nothing.',
    ]),
    row(
        'challenges',
        runChallenges,
        [
            '  challenges - List the active challenges with their ids — the id every --challenge=<id> command needs.',
            '             Add --challenge=<id> for one challenge in detail (its photo ids, to aim --image=<id> at).',
            '             Alias: list',
        ],
        { aliases: ['list'], usage: 'Usage: challenges [--challenge=<id>]' },
    ),
    row(
        'deadlines',
        runDeadlines,
        [
            '  deadlines - Show the deadline actions that will run on a challenge by itself (auto-submit, emergency',
            '             submit, boost, turbo) with the time each is due, and any Boost/Turbo conflict with what',
            '             blocks it and when a blocking pin gives way. Nothing is spent; the preview is a snapshot.',
        ],
        { usage: 'Usage: deadlines --challenge=<id>' },
    ),
    row('boost', challengeCommand('Usage: boost --challenge=<id> [--image=<id>]', runBoost), [
        '  boost    - Apply a boost to a challenge: boost --challenge=<id> [--image=<id>]',
    ]),
    row('pin', challengeCommand(PIN_USAGE, runPin), [
        '  pin      - Pin the photo Boost and Turbo land on (timing is unchanged; none clears a pin; no flags lists them):',
        '             pin --challenge=<id> [--boost=<imageId|none>] [--turbo=<imageId|none>]',
    ]),
    row(
        'turbo',
        runTurbo,
        [
            '  turbo    - Play the turbo mini-game on a challenge to earn a Turbo: turbo --challenge=<id>.',
            '             With --image=<id>, apply an already-won Turbo to that photo instead',
            '             (challenges --challenge=<id> lists the photo ids). Exits 1 when the Turbo',
            '             was not earned or applied.',
        ],
        { usage: 'Usage: turbo --challenge=<id> [--image=<id>]' },
    ),
    row(
        'submit',
        runSubmit,
        [
            "  submit   - Submit photo(s) to a challenge's empty slots: submit --challenge=<id> [--all | --image=<id>[,<id>…]]",
            '             --all submits to every empty slot (ranked by the auto-submit rules); --image submits exactly',
            '             the photos named, comma-separated (list-photos --challenge=<id> shows the ids). Exits 1 when',
            '             nothing was submitted. Exits 2 when the submit got no answer: the photo(s) may have been',
            '             submitted — check the challenge before retrying.',
        ],
        { usage: 'Usage: submit --challenge=<id> [--all | --image=<id>[,<id>…]]' },
    ),
    row(
        'unlock-boost',
        challengeCommand('Usage: unlock-boost --challenge=<id> [--yes]', flagAction(unlockBoostCmd, 'yes', '--yes')),
        [
            '  unlock-boost  - Spend a key to unlock a locked boost (does not apply it):',
            '             unlock-boost --challenge=<id> [--yes]',
        ],
    ),
    row(
        'swap',
        challengeCommand(SWAP_USAGE, async (challengeId, rest) =>
            exitCodeOf(await swapCmd(challengeId, parseSwapFlags(rest))),
        ),
        [
            '  swap     - Spend a swap to replace an entered photo: without --to it suggests a different one,',
            '             with --to=<id> it swaps in the photo you name (list-photos --challenge=<id> shows them):',
            '             swap --challenge=<id> --image=<id> [--to=<id>] [--yes]',
        ],
    ),
    row(
        'swap-back',
        runSwapBack,
        [
            "  swap-back - Swap a photo that was swapped out while boosted, turbo'd or guru-picked back in (it",
            "             gets its boost/turbo/Guru's pick back): swap-back --challenge=<id> --image=<current id> [--yes]",
            '             Without --image, list the recorded swap-back offers for the challenge.',
        ],
        { usage: SWAP_BACK_USAGE },
    ),
    row(
        'fill-exposure',
        challengeCommand('Usage: fill-exposure --challenge=<id> [--yes]', flagAction(fillExposureCmd, 'yes', '--yes')),
        [
            '  fill-exposure - Spend a fill to top exposure up to 100%: fill-exposure --challenge=<id> [--yes]',
            '             Currency actions spend nothing without --yes; they print the cost first.',
        ],
    ),
    // Continuous mode keeps running — no exit code.
    row(
        'start',
        async () => {
            await startContinuousVoting();
            return undefined;
        },
        ['  start    - Start continuous voting on a schedule (runs until stopped with Ctrl+C)'],
    ),
    row('status', exitsZero(showStatus), ['  status   - Show current status and settings']),
    row(
        'bankroll',
        exitsZero(showBankroll),
        ['  bankroll - Show your currency balances (keys / swaps / fills / coins). Alias: coins'],
        { aliases: ['coins'] },
    ),
    row('discover', exitsZero(showDiscover), [
        '  discover - List open (un-joined) challenges you can join, and the upcoming ones starting',
        '             within discoverUpcomingHours (24 by default; 0 = open only). An upcoming challenge',
        "             can't be joined until it starts, but you can choose its photos now.",
    ]),
    row(
        'join',
        runJoin,
        [
            '  join <id> [--yes [--max-coins=<coins>]] - Join an open challenge. Free joins immediately; paid joins',
            '             print the coin cost and require --yes before spending coins. --yes alone pays',
            '             up to the cost printed first; with --max-coins=<coins> it refuses (and spends nothing) if the cost',
            '             is above that. An upcoming challenge answers that it has not started. Exits 1 when the',
            '             challenge was not joined, including a paid challenge priced without --yes.',
        ],
        { usage: 'Usage: join <id> [--yes [--max-coins=<coins>]]' },
    ),
    row(
        'forget-payment',
        runForgetPayment,
        [
            '  forget-payment <id> - Forget a join payment the app could not confirm (it got no answer), after checking on the',
            '             GuruShots website that the coins were not taken. The next join asks for the price again; if the',
            '             coins were taken, joining again charges a second time, and auto-join may join it again within its',
            '             coin budget.',
        ],
        { usage: 'Usage: forget-payment <id>' },
    ),
    row(
        'list-photos',
        runListPhotos,
        [
            '  list-photos [--challenge=<id>] [--search=<tag>] [--sort=votes|newest|oldest] - List your photo ids, to choose',
            '             them for auto-join / auto-submit. With --challenge each photo shows whether that challenge accepts',
            '             it. --sort orders the whole library on the server — votes (the default), newest or oldest (the',
            '             date the photo was added to your library) — and the whole listing comes out in that order.',
            '             --search matches a tag exactly, and also lists the tags in your library that contain the term (3+',
            '             characters), so a partial term still shows the full tag to search with.',
            '             --stats also reads votes, views, likes and Guru picks for the listed photos — the first',
            '             --limit=<n> of them, 30 by default; a photo whose stats could not be read says so instead of',
            '             showing zeros.',
            '  list-photos --challenge=<id> --suggest - Rank your photos for that challenge by your auto-submit rules and list',
            '             the top 5, best first. It is a ranking under those rules, not a replay of the next fill, and',
            '             nothing is submitted. It cannot be combined with --search, --sort or --stats.',
        ],
        {
            usage: 'Usage: list-photos [--challenge=<id>] [--search=<tag>] [--sort=votes|newest|oldest] [--stats [--limit=<n>]]  or  list-photos --challenge=<id> --suggest',
        },
    ),
    row('check-updates', exitsZero(checkUpdates), ['  check-updates - Check GitHub for a newer release']),
    row(
        'get-setting',
        runGetSetting,
        [
            '  get-setting <key> [--challenge=<id>] - Get a setting value (effective value for a challenge with --challenge)',
        ],
        { usage: 'Usage: get-setting <key> [--challenge=<id>]' },
    ),
    row(
        'set-setting',
        runSetSetting,
        [
            '  set-setting <key> <value> [--challenge=<id>] - Set a setting value (per-challenge override with --challenge)',
        ],
        { usage: 'Usage: set-setting <key> <value> [--challenge=<id>]' },
    ),
    row(
        'set-global-default',
        runSetGlobalDefault,
        ['  set-global-default <key> <value> - Set global default with validation'],
        { usage: 'Usage: set-global-default <key> <value>' },
    ),
    row(
        'list-settings',
        async (argv) => {
            listSettings(extractChallenge(argv).challengeId);
            return 0;
        },
        ['  list-settings [--challenge=<id>] - Show all settings (per-challenge view with --challenge)'],
    ),
    row(
        'reset-setting',
        runResetSetting,
        [
            '  reset-setting <key> [--challenge=<id>] - Reset a setting to default (clear a challenge override with --challenge).',
            '             Without --challenge, a voting setting resets its global default.',
        ],
        { usage: 'Usage: reset-setting <key> [--challenge=<id>]' },
    ),
    row(
        'reset-global-default',
        runResetGlobalDefault,
        ["  reset-global-default <key> - Reset a voting setting's global default to its shipped value"],
        { usage: 'Usage: reset-global-default <key>' },
    ),
    row('reset-all-settings', exitsZero(resetAllSettings), [
        '  reset-all-settings - Reset all settings to defaults',
        "      To remove one challenge's own chosen-photos list (it then inherits from rules / global):",
        '             reset-setting chosenPhotos --challenge=<id>',
        '      To use no chosen photos for that challenge (overriding rules / global):',
        "             set-setting chosenPhotos '[]' --challenge=<id>",
    ]),
    row(
        'reset-all-global-defaults',
        runResetAllGlobalDefaults,
        [
            '  reset-all-global-defaults [--yes] - Without --yes, list the global defaults that differ from',
            '             their shipped values (current → default) and change nothing; with --yes, reset them all.',
        ],
        { usage: 'Usage: reset-all-global-defaults [--yes]' },
    ),
    row('list-profiles', runListProfiles, ['  list-profiles - Show saved challenge-settings profiles'], {
        usage: 'Usage: list-profiles',
    }),
    row(
        'save-profile',
        profileCommand('save-profile', saveProfileFromChallenge, {
            needsChallenge: true,
            challengeHint: "Please specify --challenge=<id> to snapshot that challenge's overrides",
        }),
        ['  save-profile "<name>" --challenge=<id> - Save a challenge\'s overrides as a named profile'],
    ),
    row(
        'apply-profile',
        profileCommand('apply-profile', applyProfile, {
            needsChallenge: true,
            challengeHint: 'Please specify --challenge=<id> to apply the profile to',
        }),
        ['  apply-profile "<name>" --challenge=<id> - Replace a challenge\'s overrides with a profile'],
    ),
    row(
        'delete-profile',
        profileCommand('delete-profile', (name) => deleteProfile(name)),
        ['  delete-profile "<name>" - Delete a saved profile'],
    ),
    row(
        'list-title-rules',
        runListTitleRules,
        ['  list-title-rules - Show the stored challenge rules: what each matches and what it does'],
        { usage: 'Usage: list-title-rules' },
    ),
    row(
        'export-title-rules',
        runExportTitleRules,
        [
            '  export-title-rules [file] [--overwrite] - Print (or write) the challenge rules as JSON,',
            '             to edit and import back. An existing file is refused without --overwrite.',
        ],
        { usage: 'Usage: export-title-rules [file] [--overwrite]' },
    ),
    row(
        'import-title-rules',
        runImportTitleRules,
        [
            '  import-title-rules <file> [--yes] - Check a title-rules JSON file and show what it replaces',
            '             (what would be stored, and every rule it drops or collapses, with the reason);',
            '             --yes imports it. A file that cannot be read or parsed is never merged.',
        ],
        { usage: 'Usage: import-title-rules <file> [--yes]' },
    ),
    row(
        'title-profile',
        runTitleProfile,
        [
            '  title-profile --challenge=<id> - Which rule or profile applies to a challenge,',
            '             and the settings they set',
        ],
        { usage: 'Usage: title-profile --challenge=<id>' },
    ),
    row(
        'list-scenarios',
        scenarioCommand('Usage: list-scenarios', 0, () => scenarioCommands.listScenarios()),
        ['  list-scenarios - Show saved scenarios and the example templates'],
    ),
    row(
        'scenario-template',
        scenarioCommand(
            'Usage: scenario-template <id> [file]',
            1,
            ([id, file]) => scenarioCommands.scenarioTemplate(id, file),
            2,
        ),
        ['  scenario-template <id> [file] - Print (or write) an example scenario to start from'],
    ),
    row(
        'import-scenario',
        scenarioCommand('Usage: import-scenario <file> [--overwrite] [--yes]', 1, ([file], flags) =>
            scenarioCommands.importScenarioCmd(file, { overwrite: flags.has('--overwrite'), yes: flags.has('--yes') }),
        ),
        [
            '  import-scenario <file> [--overwrite] [--yes] - Check a scenario file and show what it does; --yes imports it',
        ],
    ),
    row(
        'export-scenario',
        scenarioCommand(
            'Usage: export-scenario "<name>" [file]',
            1,
            ([name, file]) => scenarioCommands.exportScenarioCmd(name, file),
            2,
        ),
        ['  export-scenario "<name>" [file] - Print (or write) a scenario as JSON to share'],
    ),
    row(
        'rename-scenario',
        scenarioCommand('Usage: rename-scenario "<old>" "<new>"', 2, ([oldName, newName]) =>
            scenarioCommands.renameScenarioCmd(oldName, newName),
        ),
        ['  rename-scenario "<old>" "<new>" - Rename a scenario; its assignments follow'],
    ),
    row(
        'delete-scenario',
        scenarioCommand('Usage: delete-scenario "<name>"', 1, ([name]) => scenarioCommands.deleteScenarioCmd(name)),
        ['  delete-scenario "<name>" - Delete a scenario and clear its assignments'],
    ),
    row(
        'scenario-status',
        challengeCommand('Usage: scenario-status --challenge=<id>', (id) => scenarioCommands.scenarioStatusCmd(id)),
        ['  scenario-status --challenge=<id> - Where a challenge is in its scenario'],
    ),
    row(
        'scenario-dry-run',
        challengeCommand('Usage: scenario-dry-run --challenge=<id>', (id) => scenarioCommands.scenarioDryRunCmd(id)),
        ['  scenario-dry-run --challenge=<id> - What the scenario would do right now (spends nothing)'],
    ),
    row(
        'scenario-simulate',
        challengeCommand('Usage: scenario-simulate --challenge=<id>', (id) => scenarioCommands.scenarioSimulateCmd(id)),
        ['  scenario-simulate --challenge=<id> - A what-if timeline until the challenge closes (spends nothing)'],
    ),
    row(
        'scenario-reset',
        runScenarioReset,
        [
            "  scenario-reset --challenge=<id> - Forget a challenge's scenario progress (the plan restarts). It may spend again an action",
            "             whose outcome is unknown (no answer, or the app could not record it), and it restarts the scenario's",
            '             spend counter.',
            "  scenario-reset --all - Forget every challenge's scenario progress: the only way past a progress file that cannot be",
            '             read. The rules that already ran can run again, with the same warning as above.',
        ],
        { usage: 'Usage: scenario-reset --challenge=<id>  |  scenario-reset --all' },
    ),
    row(
        'scenario-vocabulary',
        scenarioCommand('Usage: scenario-vocabulary', 0, () => scenarioCommands.scenarioVocabulary()),
        [
            '  scenario-vocabulary - List every condition, selector and action a scenario can use',
            '             Assign one with: set-setting scenario "<name>" --challenge=<id> (or a challenge rule)',
        ],
    ),
    row('help-settings', exitsZero(helpSettings), [
        '  help-settings - Show detailed settings help (includes profile details)',
    ]),
    row('logs', runLogs, [
        '  logs [--error|--api|--settings|--lexicon] [--lines=<n>] - Show logs or the local lexicon report',
    ]),
    row('licenses', async () => licensesCmd(), ['  licenses - Print the third-party license notices'], {
        markerless: true,
    }),
    row(
        'reset-data',
        resetDataCmd,
        [
            '  reset-data --yes - Delete everything stored on this device: settings and the saved login, every store, logs and',
            '             the extracted vision runtime. It cannot be undone, so it does nothing without --yes. Quit the',
            '             desktop app, stop the web UI and wait for (or stop) any other CLI command or session first: it refuses to',
            '             delete while one is running.',
        ],
        { markerless: true },
    ),
    row('reset-windows', exitsZero(resetWindows), ['  reset-windows  - Reset window positions to default']),
    row('settings-recovery', settingsRecoveryCmd, [
        '  settings-recovery retry|start-fresh|report|acknowledge - When the saved settings are not in use: try importing',
        '             settings.json again, begin with default settings (settings.json is left as it is; refused while the import',
        '             may pass by itself, unless start-fresh --force), print what the import left unresolved (report), or mark',
        '             that report as seen (acknowledge)',
    ]),
    row('help', exitsZero(showHelp), ['  help     - Show this help message'], {
        aliases: ['--help', '-h'],
        markerless: true,
    }),
];

export { COMMAND_ROWS, usageOf };
