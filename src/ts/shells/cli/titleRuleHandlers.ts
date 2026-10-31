/**
 * The CLI command handlers for the title-rules commands (list / export /
 * import and the per-challenge profile read), delegating to
 * commands/titleRules.ts. Like every handler module it reads `usageOf`
 * (commandRows.ts) only inside handler bodies, never at module scope — the
 * rows need these handlers at init.
 */
import { exportTitleRulesCmd, importTitleRulesCmd, listTitleRulesCmd, titleProfileCmd } from './commands/titleRules';
import { exitCodeOf, usageError } from './commandKit';

import type { CommandHandler } from './commandKit';
import { usageOf } from './commandRows';

const runListTitleRules: CommandHandler = async (argv) => {
    if (argv.length > 0) return usageError('Wrong arguments', usageOf('list-title-rules'));
    listTitleRulesCmd();
    return 0;
};

const runExportTitleRules: CommandHandler = async (argv) => {
    const positionals = argv.filter((a) => !a.startsWith('--'));
    const overwriteArgs = argv.filter((a) => a === '--overwrite');
    const unknown = argv.filter((a) => a.startsWith('--') && a !== '--overwrite');
    if (positionals.length > 1 || overwriteArgs.length > 1 || unknown.length > 0) {
        return usageError('Wrong arguments', usageOf('export-title-rules'));
    }
    return exportTitleRulesCmd(positionals[0], overwriteArgs.length > 0);
};

const runImportTitleRules: CommandHandler = async (argv) => {
    const positionals = argv.filter((a) => !a.startsWith('--'));
    const yesArgs = argv.filter((a) => a === '--yes');
    const unknown = argv.filter((a) => a.startsWith('--') && a !== '--yes');
    if (positionals.length !== 1 || yesArgs.length > 1 || unknown.length > 0) {
        return usageError('Wrong arguments', usageOf('import-title-rules'));
    }
    return importTitleRulesCmd(positionals[0], yesArgs.length > 0);
};

// A read-only command, but strict like the actions: `--challenge 123` (space form), a repeat or
// any other argument must not quietly read as a listing.
const runTitleProfile: CommandHandler = async (argv) => {
    const detailArgs = argv.filter((a) => a.startsWith('--challenge='));
    if (argv.length !== detailArgs.length || detailArgs.length > 1 || detailArgs[0] === '--challenge=') {
        return usageError('Wrong arguments', usageOf('title-profile'));
    }
    const challengeId = detailArgs[0]?.slice('--challenge='.length);
    if (challengeId === undefined) {
        return usageError('Please specify a challenge id with --challenge', usageOf('title-profile'));
    }
    return exitCodeOf(await titleProfileCmd(challengeId));
};

export { runExportTitleRules, runImportTitleRules, runListTitleRules, runTitleProfile };
