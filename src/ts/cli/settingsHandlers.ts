/**
 * The CLI command handlers for the settings commands (get / set / reset, the
 * global defaults included) and the profiles list, delegating to
 * commands/settings.ts. Like every handler module it reads `usageOf`
 * (commandRows.ts) only inside handler bodies, never at module scope — the
 * rows need these handlers at init.
 */
import {
    getSetting,
    listProfiles,
    resetAllGlobalDefaults,
    resetGlobalDefault,
    resetSetting,
    setGlobalDefault,
    setSetting,
} from './commands/settings';
import { extractChallenge, usageError } from './commandKit';

import type { CommandHandler } from './commandKit';
import { usageOf } from './commandRows';

const runGetSetting: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0]) return usageError('Please specify a setting key', usageOf('get-setting'));
    getSetting(rest[0], challengeId);
    return 0;
};

const runSetSetting: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0] || rest[1] === undefined) {
        return usageError('Please specify both key and value', usageOf('set-setting'));
    }
    // A name that is no setting, or a value it refuses, is a failure: the exit code says so to a script.
    return setSetting(rest[0], rest[1], challengeId) ? 0 : 1;
};

const runResetSetting: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    if (!rest[0]) return usageError('Please specify a setting key', usageOf('reset-setting'));
    return resetSetting(rest[0], challengeId) ? 0 : 1;
};

const runSetGlobalDefault: CommandHandler = async ([key, value]) => {
    if (!key || !value) {
        return usageError(
            'Please specify both setting key and value',
            usageOf('set-global-default'),
            'Example: set-global-default exposure 80',
        );
    }
    return setGlobalDefault(key, value) ? 0 : 1;
};

// Exactly one positional key: a reset names one thing, so a typo must not read as a second argument.
const runResetGlobalDefault: CommandHandler = async (argv) => {
    if (argv.length !== 1) return usageError('Please specify a setting key', usageOf('reset-global-default'));
    return resetGlobalDefault(argv[0]) ? 0 : 1;
};

// --yes alone flips it from a listing of what would change into the reset itself;
// anything else alongside it is a typo and a usage error.
const runResetAllGlobalDefaults: CommandHandler = async (argv) => {
    const yesArgs = argv.filter((a) => a === '--yes');
    if (argv.length !== yesArgs.length || yesArgs.length > 1) {
        return usageError('Wrong arguments', usageOf('reset-all-global-defaults'));
    }
    return resetAllGlobalDefaults(yesArgs.length > 0) ? 0 : 1;
};

const runListProfiles: CommandHandler = async (argv) => {
    const { rest } = extractChallenge(argv);
    if (rest.length > 0) return usageError(`Unexpected arguments: ${rest.join(' ')}`, usageOf('list-profiles'));
    listProfiles();
    return 0;
};

export {
    runGetSetting,
    runListProfiles,
    runResetAllGlobalDefaults,
    runResetGlobalDefault,
    runResetSetting,
    runSetGlobalDefault,
    runSetSetting,
};
