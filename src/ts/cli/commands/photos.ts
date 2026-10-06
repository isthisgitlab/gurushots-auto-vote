/**
 * CLI `list-photos`: the photo ids the Chosen Photos settings take, read from
 * your own library through the same handler the chooser uses. Everything the
 * server sent is stripped of terminal control characters before it is printed,
 * and the per-photo listing goes to the terminal only — the log files get a
 * count and whether the list was cut short, never the photos.
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

type Listing = Extract<Awaited<ReturnType<ActionHandlers['get-library-photos']>>, { success: true }>;

/**
 * Print each photo as `id  allowed|not allowed  [labels]` on the terminal only —
 * the log files never get a photo.
 */
const printPhotos = (listing: Listing): void => {
    for (const photo of listing.photos) {
        const state = listing.allowedKnown ? (photo.allowed ? '  allowed' : '  not allowed') : '';
        const labels = photo.labels.map(stripTerminalControl).join(', ');
        logger.printLine(`  • ${stripTerminalControl(photo.id)}${state}${labels ? `  [${labels}]` : ''}`);
        if (listing.allowedKnown && !photo.allowed && photo.message) {
            logger.printLine(`      ${stripTerminalControl(photo.message)}`);
        }
    }
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
        const reason = Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : stripTerminalControl(code);
        ui().error(`Could not list your photos: ${reason}`);
        return 1;
    }
    if (result.photos.length === 0) {
        ui().info(`No photos found${search ? ` for "${stripTerminalControl(search)}"` : ' in your library'}.`);
        return 0;
    }
    ui().info(`=== Your photos (${result.photos.length}${result.truncated ? ', list cut short' : ''}) ===`);
    printPhotos(result);
    if (result.truncated) ui().warning('The list was cut short; narrow it with --search=<tag> to find the rest.');
    if (!result.allowedKnown) {
        ui().info(
            'Eligibility is not shown without a challenge; pass --challenge=<id> to see which photos it accepts.',
        );
    }
    ui().info('Choose photos with: set-setting chosenPhotos \'["<id>"]\' --challenge=<id>');
    return 0;
};

export { listPhotosCmd, parseSearchFlag };
