/**
 * CLI parity guard: every window.api invoke channel in the manifest — alias
 * targets included — is reachable from the CLI. Each channel maps either to
 * the CLI command(s) that reach it, with the flag that reaches it (null when
 * the bare command does, as `challenges` → get-active-challenges or
 * `run` → cleanup-stale-*), or to a written reason it does not apply to the
 * CLI. A channel added to the manifest without a mapping fails this test and
 * `pnpm typecheck` (the mapping is keyed by the channel-literal union, so a
 * missing entry is a compile error); so does a mapped command that vanishes
 * from COMMAND_ROWS or loses the flag its entries name. Mirrors
 * tests/web/channel-parity.test.ts for the CLI side.
 */

import type * as commandRowsModule from '../../src/ts/cli/commandRows';
import type * as manifestModule from '../../src/ts/ipc/manifest';

const { COMMAND_ROWS } = require('../../src/ts/cli/commandRows') as typeof commandRowsModule;
const { aliases, allInvokeChannels, invokeChannels } = require('../../src/ts/ipc/manifest') as typeof manifestModule;

// Every channel the manifest exposes, as the literal union the mapping's keys are checked against.
type InvokeChannel = (typeof invokeChannels)[number] | (typeof aliases)[keyof typeof aliases];

/** The channel's CLI reach: the command(s), and the flag or subcommand word that reaches it (null = the bare command). */
type CliMapping = { commands: readonly string[]; flag: string | null };

/** Why the channel has no CLI path (the plan's "Not applicable" list). */
type NotApplicable = { reason: string };

type ParityEntry = CliMapping | NotApplicable;

/**
 * The guard's check: over the given channels, every mapped command must be a
 * COMMAND_ROWS row and every named flag must appear in that row's usage or
 * help; a channel with neither mapping fails, as does a mapping key the
 * channel list does not hold (both directions).
 */
const checkCliParity = (channels: readonly string[], mapping: Record<string, ParityEntry>): string[] => {
    const problems: string[] = [];
    const rowsByName = new Map(COMMAND_ROWS.map((row) => [row.name, row] as const));
    for (const channel of channels) {
        const entry: ParityEntry | undefined = mapping[channel];
        if (entry === undefined) {
            problems.push(`${channel}: no CLI command reaches this channel and no not-applicable reason is recorded`);
            continue;
        }
        if (!('commands' in entry)) {
            if (entry.reason.trim() === '') problems.push(`${channel}: the not-applicable entry carries no reason`);
            continue;
        }
        for (const name of entry.commands) {
            const row = rowsByName.get(name);
            if (row === undefined) {
                problems.push(`${channel}: mapped command "${name}" is not a COMMAND_ROWS row`);
                continue;
            }
            const flag = entry.flag;
            if (flag !== null && ![row.usage ?? '', ...row.help].some((text) => text.includes(flag))) {
                problems.push(`${channel}: "${flag}" appears in no usage or help line of "${name}"`);
            }
        }
    }
    for (const channel of Object.keys(mapping)) {
        if (!channels.includes(channel)) problems.push(`${channel}: mapped, but the manifest has no such channel`);
    }
    return problems;
};

/**
 * Channel → CLI reach, in the manifest's order. The reach of every mapping
 * was checked against the code: the command's handler calls the channel's
 * `buildHandlers()` entry (directly or through the handler maps), or the same
 * facade / middleware function it wraps — noted where that is not a direct
 * handler call.
 */
const CLI_PARITY: Record<InvokeChannel, ParityEntry> = {
    // Settings
    'get-settings': { commands: ['list-settings'], flag: null }, // listSettings reads the stored blob through the same loadSettings the handler wraps
    'get-setting': { commands: ['get-setting'], flag: null }, // both reach settings.getSetting
    'set-setting': { commands: ['set-setting'], flag: null },
    'save-settings': { commands: ['set-setting'], flag: null }, // every CLI settings write saves through the same facade save
    'get-environment-info': {
        reason: 'Renderer bootstrap: the renderer reads it to boot its UI; the CLI runs in the environment itself.',
    },
    'get-settings-recovery': { commands: ['settings-recovery'], flag: 'start-fresh' }, // the start-fresh gate reads the recovery state; the notice before every CLI command prints it
    'retry-settings-import': { commands: ['settings-recovery'], flag: 'retry' },
    'start-fresh-settings': { commands: ['settings-recovery'], flag: 'start-fresh' },
    'get-import-report': { commands: ['settings-recovery'], flag: 'report' },
    'acknowledge-import-report': { commands: ['settings-recovery'], flag: 'acknowledge' },
    'get-third-party-notices': { commands: ['licenses'], flag: null },
    'wipe-local-data': { commands: ['reset-data'], flag: '--yes' },

    // Voting / strategy
    'gui-vote': { commands: ['run'], flag: null }, // middleware.guiVote → _runVote → fetchChallengesAndVote: the strategy pass bare `run` also runs
    'get-active-challenges': { commands: ['challenges'], flag: null }, // challengesCmd fetches through getMiddleware().getActiveChallenges()
    authenticate: { commands: ['login'], flag: null }, // cliLogin and the handler both call strategy.authenticate
    'run-voting-cycle': { commands: ['run'], flag: null }, // cliVote(null) and the handler both funnel into fetchChallengesAndVote
    'run-voting-cycle-for-challenge': { commands: ['run'], flag: '--challenge' },
    'vote-on-challenge': { commands: ['vote'], flag: '--challenge' }, // the handler's own comment: the same code path as vote-on-challenge-manual, which vote --challenge calls
    'vote-on-challenge-manual': { commands: ['vote'], flag: '--challenge' },
    'vote-all-challenges-manual': { commands: ['vote'], flag: null }, // cliVoteManual shares voteAllChallengesManual with the handler
    'get-deadline-actions': { commands: ['deadlines'], flag: '--challenge' },
    'refresh-api': { reason: 'Re-reads mode/token for the long-lived window; every CLI command loads them fresh.' },

    // Logger
    'log-debug': { reason: 'Renderer-side logging; the CLI logs in-process.' },
    'log-error': { reason: 'Renderer-side logging; the CLI logs in-process.' },
    'log-warning': { reason: 'Renderer-side logging; the CLI logs in-process.' },
    'log-api': { reason: 'Renderer-side logging; the CLI logs in-process.' },
    'get-log-file': { commands: ['logs'], flag: null }, // bare logs prints the app log through the same logger path getter the channel answers
    'get-error-log-file': { commands: ['logs'], flag: '--error' },
    'get-api-log-file': { commands: ['logs'], flag: '--api' },
    'get-log-backlog': { reason: 'Window feed; the CLI uses logs / logs --follow over the files.' },

    // Schema-based settings
    'get-global-default': { commands: ['set-global-default'], flag: null }, // reads the stored default back after a write (settings.getGlobalDefault, the method the channel wraps)
    'set-global-default': { commands: ['set-global-default'], flag: null },
    'get-challenge-override': { commands: ['get-setting'], flag: '--challenge' }, // reads the override to label the value override/inherited
    'set-challenge-override': { commands: ['set-setting'], flag: '--challenge' },
    'set-challenge-overrides': {
        reason: 'Bulk editor save; covered by set-setting --challenge (one key at a time) and apply-profile.',
    },
    'remove-challenge-override': { commands: ['reset-setting'], flag: '--challenge' },
    'get-effective-setting': { commands: ['get-setting'], flag: '--challenge' },
    'get-title-rules': { commands: ['list-title-rules', 'export-title-rules'], flag: null }, // both read the stored rules through settings.getTitleRules
    'set-title-rules': { commands: ['import-title-rules'], flag: '--yes' }, // --yes calls settings.setTitleRules, the method the channel wraps
    'get-title-profile': { commands: ['title-profile'], flag: '--challenge' },
    'get-entry-pins': { commands: ['pin', 'status'], flag: null }, // bare pin lists the pins; status prints the pinned list
    'set-entry-pin': { commands: ['pin'], flag: '--boost' }, // --boost=<id|none> / --turbo=<id|none> save through the set-entry-pin handler
    'get-challenge-overrides': { commands: ['save-profile'], flag: '--challenge' }, // the snapshot reads the challenge's overrides
    'replace-challenge-overrides': {
        reason: 'Bulk editor save; covered by set-setting --challenge and apply-profile.',
    },
    'get-challenge-profiles': { commands: ['list-profiles'], flag: null },
    'save-challenge-profile': { commands: ['save-profile'], flag: '--challenge' },
    'delete-challenge-profile': { commands: ['delete-profile'], flag: null },
    'apply-challenge-profile': { commands: ['apply-profile'], flag: '--challenge' },
    'cleanup-stale-challenge-setting': { commands: ['run'], flag: null }, // run calls the cleanup handler after its cycle, with the renderer's gates; start never prunes
    'cleanup-stale-metadata': { commands: ['run', 'start'], flag: null }, // the voting pass both run prunes metadata in real mode through the cleanupStaleMetadata the channel wraps
    'get-settings-schema': { reason: 'Folded into set-setting, help-settings and list-settings.' },
    'get-validation-error': { reason: 'Folded into set-setting, help-settings and list-settings.' },

    // Resets
    'reset-setting': { commands: ['reset-setting'], flag: null },
    'reset-global-default': { commands: ['reset-global-default'], flag: null },
    'reset-all-global-defaults': { commands: ['reset-all-global-defaults'], flag: '--yes' },
    'reset-all-settings': { commands: ['reset-all-settings'], flag: null },
    'is-setting-modified': { reason: 'Folded into set-setting, help-settings and list-settings.' },
    'is-global-default-modified': { reason: 'Folded into set-setting, help-settings and list-settings.' },

    // Misc
    'open-external-url': { reason: 'Window and OS shell.' },
    'should-cancel-voting': { reason: 'Ctrl+C: the CLI cancels through its own signal handling.' },
    'set-cancel-voting': { reason: 'Ctrl+C: the CLI cancels through its own signal handling.' },
    'apply-boost-to-entry': { commands: ['boost'], flag: '--image' },
    'play-auto-turbo': { commands: ['turbo'], flag: null },
    'fill-challenge-now': { commands: ['submit'], flag: '--all' },
    'submit-picked-photos': { commands: ['submit'], flag: '--image' },
    'suggest-photos': { commands: ['list-photos'], flag: '--suggest' },
    'get-bankroll': { commands: ['bankroll'], flag: null },
    'get-member-challenges': { commands: ['discover'], flag: null },
    'get-open-chosen-annotations': { commands: ['discover'], flag: null }, // the discover listing carries the annotations: the get-member-challenges handler embeds the same annotator this channel wraps
    'join-challenge': { commands: ['join'], flag: null },
    'forget-unconfirmed-payment': { commands: ['forget-payment'], flag: null },
    'get-library-photos': { commands: ['list-photos'], flag: null },
    'search-photo-tags': { commands: ['list-photos'], flag: '--search' },
    'get-photo-stats': { commands: ['list-photos'], flag: '--stats' },
    'get-auto-join-active': { commands: ['status'], flag: null },
    'get-auto-claim-status': { commands: ['status'], flag: null },
    'key-unlock-boost': { commands: ['unlock-boost'], flag: '--yes' },
    'preview-swap-photo': { commands: ['swap'], flag: '--image' }, // the dry run previews
    'swap-entry-photo': { commands: ['swap'], flag: '--to' }, // --to names the replacement of the confirmed spend
    'get-swap-backs': { commands: ['swap-back'], flag: null }, // without --image the command lists the recorded offers
    'swap-back-entry-photo': { commands: ['swap-back'], flag: '--image' },
    'fill-exposure': { commands: ['fill-exposure'], flag: '--yes' },

    // User-defined scenarios
    'get-scenarios': { commands: ['list-scenarios'], flag: null },
    'check-scenario': { commands: ['import-scenario'], flag: null }, // the --yes-less preview runs the same validation the channel wraps
    'save-scenario': { commands: ['import-scenario'], flag: '--yes' }, // the import's write path
    'rename-scenario': { commands: ['rename-scenario'], flag: null },
    'delete-scenario': { commands: ['delete-scenario'], flag: null },
    'preview-scenario-import': { commands: ['import-scenario'], flag: null },
    'import-scenario': { commands: ['import-scenario'], flag: '--yes' },
    'export-scenario': { commands: ['export-scenario'], flag: null },
    'get-scenario-status': { commands: ['scenario-status'], flag: '--challenge' },
    'reset-scenario-state': { commands: ['scenario-reset'], flag: '--challenge' },
    'reset-all-scenario-state': { commands: ['scenario-reset'], flag: '--all' },
    'dry-run-scenario': { commands: ['scenario-dry-run'], flag: '--challenge' },
    'simulate-scenario': { commands: ['scenario-simulate'], flag: '--challenge' },

    // Window control
    'reload-window': { reason: 'Window and OS shell.' },
    'refresh-menu': { reason: 'Window and OS shell.' },

    // AutoUpdater
    'check-for-updates': { commands: ['check-updates'], flag: null },
    'download-update': { reason: 'The CLI does not self-install, by design (cli/commands/update.ts).' },
    'install-update': { reason: 'The CLI does not self-install, by design (cli/commands/update.ts).' },
    'skip-update-version': { reason: 'The CLI does not self-install, by design (cli/commands/update.ts).' },
    'clear-skip-version': { reason: 'The CLI does not self-install, by design (cli/commands/update.ts).' },
    'can-auto-update': { reason: 'The CLI does not self-install, by design (cli/commands/update.ts).' },
    'get-releases-url': { commands: ['check-updates'], flag: null }, // prints the releases URL, to fetch the update by hand

    // Log streaming
    'start-log-stream': { reason: 'Window feed; the CLI uses logs / logs --follow over the files.' },
    'stop-log-stream': { reason: 'Window feed; the CLI uses logs / logs --follow over the files.' },

    // Alias target (api.applyTurbo; the channel is deliberately not in invokeChannels)
    'apply-turbo-to-entry': { commands: ['turbo'], flag: '--image' },
};

describe('cli parity guard', () => {
    test('the mapping covers the manifest invoke surface exactly, once per channel', () => {
        expect(Object.keys(CLI_PARITY).sort()).toEqual([...allInvokeChannels()].sort());
    });

    test('every mapped command is a COMMAND_ROWS row whose usage or help names its flag', () => {
        expect(checkCliParity(allInvokeChannels(), CLI_PARITY)).toEqual([]);
    });

    test('a channel with neither mapping fails the check (the guard works in both directions)', () => {
        const problems = checkCliParity([...allInvokeChannels(), 'totally-unknown-channel'], CLI_PARITY);
        expect(problems).toContainEqual(
            'totally-unknown-channel: no CLI command reaches this channel and no not-applicable reason is recorded',
        );
    });
});
