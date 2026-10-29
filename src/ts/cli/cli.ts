#!/usr/bin/env node

/**
 * GuruShots Auto Voter - CLI Entry Point
 *
 * Thin dispatcher: parses argv, routes to a command module, and owns
 * process-level concerns (init, exit codes, unhandled error handlers).
 * Every command that loads the settings (all but help, licenses and reset-data) holds the CLI session marker while it
 * runs (settings/cliSessionLock.ts).
 * The command table (name → handler) is cli/commandTable.ts, built from the
 * handler factories in cli/commandKit.ts; `help` text is cli/help.ts.
 * The actual command logic lives in:
 *   - cli/commands/auth.ts     login flow
 *   - cli/commands/voting.ts   vote cycles, continuous mode
 *   - cli/commands/status.ts   the status banner
 *   - cli/commands/settings.ts get / set / list / reset
 *   - cli/prompts.ts           readline I/O helpers (used by auth)
 *
 * Run: pnpm cli:<command>, or node --import tsx src/ts/cli/cli.ts <command> [...args]
 */

import * as logger from '../logger';
logger.withCategory('api').debug('CLI module loaded, starting initialization', null);

import * as settings from '../settings';
import { UserDataUnavailableError } from '../runtime';
import { fileErrorMessage } from '../errorMessage';
import { initializeHeaders } from '../api/randomizer';
import { COMMANDS, holdsSessionMarker } from './commandTable';
import { holdCliSessionLock } from '../settings/cliSessionLock';
import { usageError } from './commandKit';
import { reportSettingsRecovery } from './commands/settingsRecovery';
import { showUnofficialNotice } from './commands/unofficialNotice';

export type { CommandHandler } from './commandKit';

const args = process.argv.slice(2);
const command = args[0];

const dispatch = (name: string | undefined, argv: string[]): number | Promise<number | undefined> => {
    if (!name) {
        logger.withCategory('ui').info('No command specified. Use "help" to see available commands');
        return 1;
    }
    if (!Object.hasOwn(COMMANDS, name)) {
        return usageError(`Unknown command: ${name}`, 'Use "help" to see available commands');
    }
    return COMMANDS[name](argv);
};

/**
 * Takes the marker the desktop app and the local-data wipe look for: this process may be using the saved login or
 * writing the app's data. It is released when the process exits, however it ends. Best effort: a marker that cannot be
 * written only costs those checks, so the command still runs.
 */
const holdSessionMarker = (name: string | undefined) => {
    if (!name || !Object.hasOwn(COMMANDS, name) || !holdsSessionMarker(name)) return;
    try {
        process.on('exit', holdCliSessionLock());
    } catch (error) {
        logger
            .withCategory('settings')
            .warning(
                `Could not mark this command as running (a local-data wipe will not wait for it): ${fileErrorMessage(error) ?? 'unknown error'}`,
            );
    }
};

const main = async () => {
    try {
        // Before anything reads or writes the settings: the headers are saved on a first run.
        holdSessionMarker(command);
        initializeHeaders();
        // Seed the curated intent presets once (idempotent; never fatal) so
        // the `settings` command lists them and they can be applied from CLI.
        try {
            settings.seedIntentProfiles();
        } catch (err) {
            logger.withCategory('settings').warning('Intent profile seeding failed (non-fatal):', err);
        }
        reportSettingsRecovery();
        showUnofficialNotice();
        logger.withCategory('api').debug('main: Command is:', command);

        const code = await dispatch(command, args.slice(1));
        if (code !== undefined) process.exit(code);
    } catch (error) {
        if (error instanceof UserDataUnavailableError) {
            logger.withCategory('ui').error(error.message);
        } else {
            logger.withCategory('api').error('Error');
        }
        logger.withCategory('api').debug('Full main function error details:', error);
        process.exit(1);
    } finally {
        logger.cleanup();
    }
};

process.on('unhandledRejection', (reason, promise) => {
    logger.withCategory('api').error('Unhandled Promise Rejection');
    logger.withCategory('api').debug('Unhandled Promise Rejection details:', { reason, promise });
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    logger.withCategory('api').error('Uncaught Exception');
    logger.withCategory('api').debug('Uncaught Exception details:', error);
    process.exit(1);
});

main().catch((error) => {
    logger.withCategory('api').error('Error caught in main() call');
    logger.withCategory('error').debug('Main() call error details:', error);
    process.exit(1);
});
