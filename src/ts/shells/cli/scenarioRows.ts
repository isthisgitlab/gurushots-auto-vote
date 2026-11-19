/**
 * The scenario command rows of the CLI help, in help order; commandRows.ts
 * spreads them into COMMAND_ROWS at the scenarios' position.
 */

import { challengeCommand, row, scenarioCommand } from './commandKit';
import { runScenarioReset } from './commandHandlers';
import * as scenarioCommands from './commands/scenarios';

import type { CommandRow } from './commandKit';

const scenarioRows: readonly CommandRow[] = [
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
    row('scenario-simulate', scenarioCommands.scenarioSimulateCommand, [
        '  scenario-simulate <name> --subject=installation|candidate|active|completed --until=<ISO 8601> [--challenge=<id>]',
        '             [--assumptions=<file>] - A what-if run of the whole lifecycle until that time (spends nothing). A',
        '             challenge subject needs --challenge. The file assumes outcomes ({"outcomes":{"submit":"success"}}).',
    ]),
    row(
        'scenario-installation',
        scenarioCommands.scenarioInstallationCommand,
        [
            '  scenario-installation ["<name>"|--clear] [--executor=electron|cli|web|android-service|android-app] - Show the installation',
            '             scenario; with a name, set it (run by --executor, else by its current runtime, else by the CLI); --clear clears it',
        ],
        { usage: 'Usage: scenario-installation ["<name>"|--clear] [--executor=<runtime>]' },
    ),
    row(
        'scenario-owner-transfer',
        scenarioCommands.scenarioOwnerTransferCommand,
        [
            '  scenario-owner-transfer --executor=<runtime> --generation=<n> - Hand the installation scenario to another runtime;',
            '             <n> is the generation scenario-installation or scenario-snapshot showed',
        ],
        { usage: 'Usage: scenario-owner-transfer --executor=<runtime> --generation=<n>' },
    ),
    row(
        'scenario-pause',
        scenarioCommands.scenarioPauseCommand,
        [
            '  scenario-pause <challenge id|installation> - Pause a scenario: no rule runs and nothing is published until it resumes',
        ],
        { usage: 'Usage: scenario-pause <challenge id|installation>' },
    ),
    row(
        'scenario-resume',
        scenarioCommands.scenarioResumeCommand,
        ['  scenario-resume <challenge id|installation> - Resume a paused scenario'],
        { usage: 'Usage: scenario-resume <challenge id|installation>' },
    ),
    row(
        'scenario-handoff',
        scenarioCommands.scenarioHandoffCommand,
        [
            '  scenario-handoff <challenge id|installation> "<scenario>"|--clear --generation=<n> - Give a subject another scenario, or',
            '             none; <n> is the generation scenario-snapshot showed',
        ],
        { usage: 'Usage: scenario-handoff <challenge id|installation> "<scenario>"|--clear --generation=<n>' },
    ),
    row(
        'photo-pool',
        scenarioCommands.photoPoolCommand,
        [
            '  photo-pool list|save|create "<name>" <photo id>...|delete "<name>"|rename "<name>" "<new name>" - The named photo pools a',
            '             scenario phase draws from',
        ],
        {
            usage: 'Usage: photo-pool list  |  photo-pool save "<name>" <photo id>...  |  photo-pool create "<name>" <photo id>...  |  photo-pool delete "<name>"  |  photo-pool rename "<name>" "<new name>"',
        },
    ),
    row(
        'scenario-snapshot',
        scenarioCommands.scenarioSnapshotCommand,
        [
            '  scenario-snapshot <challenge id|installation> - Where a subject stands: its scenario, generation, pause, settings in force, pins and pool',
        ],
        { usage: 'Usage: scenario-snapshot <challenge id|installation>' },
    ),
    row(
        'stop-status',
        scenarioCommands.stopStatusCommand,
        [
            '  stop-status - The Stop fence: whether it blocks a start, whether the last Stop is saved, and whether the owner acknowledged it',
        ],
        { usage: 'Usage: stop-status' },
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
];

export { scenarioRows };
