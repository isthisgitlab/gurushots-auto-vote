/**
 * The settings and profile command rows of the CLI help, in help order;
 * commandRows.ts spreads them into COMMAND_ROWS at the settings' position.
 * Like every handler module it reads `usageOf` (commandRows.ts) only inside
 * handler bodies, never at module scope — the rows need these handlers at init.
 */

import { exitsZero, extractChallenge, profileCommand, repeatedChallenge, row, usageError } from './commandKit';
import { usageOf } from './commandRows';
import {
    runGetSetting,
    runListProfiles,
    runResetAllGlobalDefaults,
    runResetGlobalDefault,
    runResetSetting,
    runSetGlobalDefault,
    runSetSetting,
} from './settingsHandlers';
import {
    applyProfile,
    deleteProfile,
    listSettings,
    resetAllSettings,
    saveProfileFromChallenge,
} from './commands/settings';

import type { CommandRow } from './commandKit';

const settingsRows: readonly CommandRow[] = [
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
            // A repeated --challenge would show the first id's view while the
            // user named two — refuse before anything reads, like every
            // command that reads the flag.
            if (repeatedChallenge(argv)) return usageError('Wrong arguments', usageOf('list-settings'));
            listSettings(extractChallenge(argv).challengeId);
            return 0;
        },
        ['  list-settings [--challenge=<id>] - Show all settings (per-challenge view with --challenge)'],
        { usage: 'Usage: list-settings [--challenge=<id>]' },
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
];

export { settingsRows };
