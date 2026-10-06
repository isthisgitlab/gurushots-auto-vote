/**
 * CLI `list-photos`: the photo ids the Chosen Photos settings take, read from
 * your own library through the same handler the chooser uses. Everything the
 * server sent is stripped of terminal control characters before it is printed.
 */

import * as logger from '../../logger';
import { stripTerminalControl } from '../../format/logSafe';
import { ensureAuthenticated, INVALID_ID_TEXT } from '../guards';

import type { NullEventHandlers } from '../../types/cli';
import type * as actions_handlersModule from '../../ipc/actions.handlers';
type ActionHandlers = NullEventHandlers<ReturnType<typeof actions_handlersModule.buildHandlers>>;
let _handlers: ActionHandlers | undefined;
const handlers = (): ActionHandlers =>
    (_handlers ??= (
        require('../../ipc/actions.handlers') as typeof import('../../ipc/actions.handlers')
    ).buildHandlers());

const ui = () => logger.withCategory('ui');

// What each refusal of the handler means for the person at the terminal.
const REFUSALS: Record<string, string> = {
    'invalid-args': `${INVALID_ID_TEXT} Use --challenge=<id> and a short --search=<tag>.`,
    'no-challenge-context':
        'Reading your library needs a challenge to look through, and you have no active or open challenge yet. Join one first (see: discover), or pass --challenge=<id>.',
    superseded: 'A newer request replaced this one. Run the command again.',
};

/**
 * `--search=<tag>` (or `--search <tag>`) from an argument list.
 */
const parseSearchFlag = (argv: string[]): string | null => {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--search') return argv[i + 1] ?? null;
        if (argv[i].startsWith('--search=')) return argv[i].slice('--search='.length);
    }
    return null;
};

/**
 * Print the library as `id  allowed|not allowed  labels`.
 *
 * @param challengeId - read the library as this challenge sees it (the allowed flags then apply to it)
 * @param search - a tag to narrow the listing to
 * @returns the exit code
 */
const listPhotosCmd = async (challengeId: string | null, search: string | null): Promise<number> => {
    if (!ensureAuthenticated()) return 1;
    const result = await handlers()['get-library-photos'](null, challengeId, search);
    if (!result?.success) {
        const code = String(result?.error);
        ui().error(`Could not list your photos: ${REFUSALS[code] ?? stripTerminalControl(code)}`);
        return 1;
    }
    ui().info(`=== Your photos${result.photos.length ? ` (${result.photos.length})` : ''} ===`);
    for (const photo of result.photos) {
        const state = result.allowedKnown ? (photo.allowed ? '  allowed' : '  not allowed') : '';
        const labels = photo.labels.map(stripTerminalControl).join(', ');
        ui().info(`  • ${stripTerminalControl(photo.id)}${state}${labels ? `  [${labels}]` : ''}`);
        if (result.allowedKnown && !photo.allowed && photo.message) {
            ui().info(`      ${stripTerminalControl(photo.message)}`);
        }
    }
    if (result.truncated) ui().warning('The list was cut short; narrow it with --search=<tag> to find the rest.');
    ui().info('Choose photos with: set-setting chosenPhotos \'["<id>"]\' --challenge=<id>');
    return 0;
};

export { listPhotosCmd, parseSearchFlag };
