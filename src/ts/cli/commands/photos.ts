/**
 * CLI `list-photos`: the photo ids the Chosen Photos settings take, read from
 * your own library through the same handler the chooser uses; with `--suggest`, the
 * top photos the auto-submit rules favour for one challenge, through the handler
 * behind the Pick… "Auto" button. Everything the
 * server sent is stripped of terminal control characters before it is printed,
 * and the per-photo listing goes to the terminal only — the log files get a
 * count and whether the list was cut short, never the photos. `--suggest` prints
 * the ranked ids to the terminal only too, and its own log lines carry counts (the
 * shared visual check logs its shortlist of photo ids as it does for every fill).
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

// What each refusal of the suggestions handler means for the person at the terminal.
const SUGGEST_REFUSALS: Record<string, string> = {
    'invalid-args': `${INVALID_ID_TEXT} Use --challenge=<id>.`,
    'no-chosen-entered':
        'Submit Only Chosen Photos is on and every chosen photo is already entered. Update your Chosen Photos, or turn Submit Only off.',
    'no-chosen-unusable':
        'Submit Only Chosen Photos is on and none of your chosen photos can go in. Update your Chosen Photos, or turn Submit Only off.',
    'no-match': 'Nothing matches your Must Include tags. Loosen them, or choose photos by hand (list-photos).',
    'no-eligible': 'Your library has no photo this challenge accepts right now. Upload one, then try again.',
    'suggest-busy': 'Another ranking is still running. Wait for it, then run the command again.',
    'account-changed': 'You switched accounts while it ran. Run the command again.',
    'challenge-ended': "This challenge has ended or couldn't be read. Check it with: status",
    'fetch-failed': 'Ranking failed. Try again in a moment.',
    'suggest-failed': 'Ranking failed. Try again in a moment.',
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

/** How many photos the listing left out for having won a challenge, and why (a cut-short listing may hide more). */
const wonHiddenText = (listing: Listing): string =>
    `${listing.truncated ? 'at least ' : ''}${listing.wonCount} photo(s) that have won a challenge are hidden (a winning photo can't be entered again)`;

/** The note of the photos the listing left out for having won a challenge, when there are any. */
const printWonHidden = (listing: Listing): void => {
    if (listing.wonCount > 0) {
        const text = wonHiddenText(listing);
        ui().info(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
    }
};

/**
 * Print each photo as `id  allowed|not allowed  [labels]` on the terminal only —
 * the log files never get a photo.
 */
const printPhotos = (listing: Listing): void => {
    for (const photo of listing.photos) {
        const state = listing.allowedKnown ? (photo.allowed ? '  allowed' : '  not allowed') : '';
        const labels = photo.labels.map((label) => stripTerminalControl(label)).join(', ');
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
        const where = search ? `for "${stripTerminalControl(search)}"` : 'in your library';
        ui().info(
            result.wonCount > 0
                ? `No photos you can enter were found ${where}; ${wonHiddenText(result)}.`
                : `No photos found ${where}.`,
        );
        return 0;
    }
    ui().info(`=== Your photos (${result.photos.length}${result.truncated ? ', list cut short' : ''}) ===`);
    printPhotos(result);
    printWonHidden(result);
    if (result.truncated) ui().warning('The list was cut short; narrow it with --search=<tag> to find the rest.');
    if (!result.allowedKnown) {
        ui().info(
            'Eligibility is not shown without a challenge; pass --challenge=<id> to see which photos it accepts.',
        );
    }
    ui().info('Choose photos with: set-setting chosenPhotos \'["<id>"]\' --challenge=<id>');
    return 0;
};

/**
 * Print the photos the auto-submit rules favour for one challenge, best first, through the handler behind the
 * Pick… "Auto" button. Nothing is submitted, and the output says so and names the next steps.
 *
 * @param challengeId - the challenge to rank for
 * @returns the exit code
 */
const suggestPhotosCmd = async (challengeId: string): Promise<number> => {
    if (!ensureAuthenticated()) return 1;
    ui().info('Ranking your photos by your auto-submit rules; this can take a minute. Nothing is submitted.');
    const result = await handlers()['suggest-photos'](null, challengeId);
    if (!result?.success) {
        const code = String(result?.error);
        const reason = Object.hasOwn(SUGGEST_REFUSALS, code) ? SUGGEST_REFUSALS[code] : stripTerminalControl(code);
        ui().error(`Could not suggest photos: ${reason}`);
        return 1;
    }
    const id = stripTerminalControl(challengeId);
    ui().info(`=== Suggested photos for challenge ${id} (${result.photos.length}, best first) ===`);
    result.photos.forEach((photo, i) => {
        const labels = photo.labels.map((label) => stripTerminalControl(label)).join(', ');
        logger.printLine(`  ${i + 1}. ${stripTerminalControl(photo.id)}${labels ? `  [${labels}]` : ''}`);
    });
    if (result.statsLimited) {
        ui().warning('Popularity stats were only partly read, so this ranking leans on tags and the image check.');
    }
    ui().info('This is a ranking under your auto-submit rules, not a replay of the next fill. Nothing was submitted.');
    // This command prints the ids to the terminal only; its own log lines carry counts.
    const ids = JSON.stringify(result.photos.map((photo) => stripTerminalControl(photo.id)));
    logger.printLine(`Make them your chosen photos with: set-setting chosenPhotos '${ids}' --challenge=${id}`);
    ui().info(
        `submit --challenge=${id} ranks again on its own (one photo, or every empty slot with --all) and ignores Submit Only; it does not submit these exact photos.`,
    );
    return 0;
};

export { listPhotosCmd, suggestPhotosCmd, parseSearchFlag };
