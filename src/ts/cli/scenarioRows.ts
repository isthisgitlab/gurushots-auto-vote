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
];

export { scenarioRows };
