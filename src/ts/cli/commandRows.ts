import { handleLogin, handleLogout } from './commands/auth';
import { startContinuousVoting } from './commands/voting';
import { parseSwapFlags, SWAP_BACK_USAGE, SWAP_USAGE, swapCmd } from './commands/actions';
import { fillExposureCmd, unlockBoostCmd } from './commands/spend';
import { showStatus } from './commands/status';
import { PIN_USAGE } from './commands/pin';
import { showBankroll } from './commands/bankroll';
import { showDiscover } from './commands/join';
import { checkUpdates } from './commands/update';
import { helpSettings, resetWindows } from './commands/settings';
import { resetDataCmd, licensesCmd } from './commands/localData';
import { settingsRecoveryCmd } from './commands/settingsRecovery';
import { showHelp } from './help';
import { challengeCommand, exitsZero, exitCodeOf, flagAction, row } from './commandKit';
import { settingsRows } from './settingsRows';
import { scenarioRows } from './scenarioRows';
import {
    runBoost,
    runChallenges,
    runDeadlines,
    runExportTitleRules,
    runForgetPayment,
    runImportTitleRules,
    runJoin,
    runListPhotos,
    runListTitleRules,
    runLogs,
    runPin,
    runRun,
    runSubmit,
    runSwapBack,
    runTitleProfile,
    runTurbo,
    runVote,
} from './commandHandlers';

import type { CommandRow } from './commandKit';

/**
 * One row per CLI command, in the order the help lists them: the rows
 * defined below plus the settings/profile and scenario groups
 * (settingsRows.ts, scenarioRows.ts) spread in at their positions.
 * help.ts renders the Commands block from the rows; commandTable.ts derives
 * the dispatch map from them.
 */

// A handler that prints its command's usage reads the text back from its row, so the row stays the
// one home for it; the handlers live in commandHandlers.ts, on the other side of the module cycle.
const usageOf = (name: string): string => {
    const usage = COMMAND_ROWS.find((candidate) => candidate.name === name)?.usage;
    if (usage === undefined) throw new Error(`Command "${name}" carries no usage text in its row`);
    return usage;
};

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
            '             --limit=<n> of them (at most 500), 30 by default; a photo whose stats could not be read',
            '             says so instead of showing zeros.',
            '  list-photos --challenge=<id> --suggest - Rank your photos for that challenge by your auto-submit rules and list',
            '             the top 5, best first. It is a ranking under those rules, not a replay of the next fill, and',
            '             nothing is submitted. It cannot be combined with --search, --sort or --stats.',
        ],
        {
            usage: 'Usage: list-photos [--challenge=<id>] [--search=<tag>] [--sort=votes|newest|oldest] [--stats [--limit=<n>]]  or  list-photos --challenge=<id> --suggest',
        },
    ),
    row('check-updates', exitsZero(checkUpdates), ['  check-updates - Check GitHub for a newer release']),
    ...settingsRows,
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
    ...scenarioRows,
    row('help-settings', exitsZero(helpSettings), [
        '  help-settings - Show detailed settings help (includes profile details)',
    ]),
    row(
        'logs',
        runLogs,
        [
            '  logs [--error|--api|--settings|--lexicon] [--lines=<n>] - Show logs or the local lexicon report',
            '  logs [--error|--api|--settings] --follow - Follow the log file as it is written; Ctrl+C stops',
        ],
        { usage: 'Usage: logs [--error|--api|--settings|--lexicon] [--lines=<n>] [--follow]' },
    ),
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
