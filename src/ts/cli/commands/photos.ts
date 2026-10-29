/**
 * CLI `list-photos`: the photo ids the Chosen Photos settings take, read from
 * your own library through the same handler the chooser uses; with `--suggest`, the
 * top photos the auto-submit rules favour for one challenge, through the handler
 * behind the Pick… "Auto" button. Everything the
 * server sent is stripped of terminal control characters before it is printed,
 * and the per-photo listing goes to the terminal only — the log files get a
 * count and whether the list was cut short, never the photos. `--search` also
 * prints the library's tags that contain the term — terminal only, best effort,
 * like the picker's suggestions — with a hint to rerun the search for one of
 * them, quoted for the shell. `--stats` reads the picker's Show-stats numbers
 * (votes, views, likes, Guru picks) for the first --limit=<n> printed photos,
 * one throttled chunk at a time, and annotates the same lines. `--suggest` prints
 * the ranked ids to the terminal only too, and its own log lines carry counts (the
 * shared visual check logs its shortlist of photo ids as it does for every fill).
 */

import * as logger from '../../logger';
import { stripTerminalControl } from '../../format/logSafe';
import { isLibraryOrder } from '../../librarySort';
import { suggestedTags } from '../../tagSuggestions';
import { LIBRARY_BATCH_PHOTOS } from '../../settings/limits';
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

// The default cap on the photos a `--stats` listing reads numbers for.
const STATS_DEFAULT_LIMIT = 30;
// The hard cap on it: a `--limit` above this is a usage error — the reads go
// out one throttled chunk at a time and a bigger ask only stalls the listing.
const STATS_MAX_LIMIT = 500;

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

/**
 * `--sort=votes|newest|oldest` (or `--sort <name>`) from an argument list.
 * A bare `--sort` whose next argument is another flag (or the end) has no
 * value and reads as null, the same way a missing `--search` value does.
 */
const parseSortFlag = (argv: string[]): string | null => {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--sort') {
            const value = argv[i + 1];
            return typeof value === 'string' && !value.startsWith('--') ? value : null;
        }
        if (argv[i].startsWith('--sort=')) return argv[i].slice('--sort='.length);
    }
    return null;
};

/** The text a `--sort` value that is not a library order is refused with. */
const BAD_SORT_TEXT = 'Use --sort=votes, --sort=newest or --sort=oldest.';

type Listing = Extract<Awaited<ReturnType<ActionHandlers['get-library-photos']>>, { success: true }>;
type PhotoStat = Extract<Awaited<ReturnType<ActionHandlers['get-photo-stats']>>, { success: true }>['stats'][number];

// What a failed stats read is reported as: one warning line — the listing is the
// primary output and the command never fails for the stats.
const STATS_REFUSALS: Record<string, string> = {
    'invalid-args': INVALID_ID_TEXT,
    superseded: 'a newer request replaced this one',
};

/**
 * Read the display stats for at most `limit` of `ids`, one chunk at a time: the
 * handler's single-flight queue answers a parallel second call `superseded`, so
 * each `get-photo-stats` chunk is awaited in turn, never `Promise.all`. The map
 * carries a stat per answered id and null per `missing` id (the breaker
 * cool-down) — that photo prints "stats not read", never zeros. On a failed
 * call the refusal is worded and returned; the remaining chunks are not fetched
 * and the ids they cover simply print without a stats suffix.
 */
const fetchPhotoStats = async (
    ids: string[],
    limit: number,
): Promise<{ stats: Map<string, PhotoStat | null>; failed: string | null }> => {
    const stats = new Map<string, PhotoStat | null>();
    const wanted = ids.slice(0, limit);
    for (let start = 0; start < wanted.length; start += LIBRARY_BATCH_PHOTOS) {
        const reply = await handlers()['get-photo-stats'](null, wanted.slice(start, start + LIBRARY_BATCH_PHOTOS));
        if (!reply?.success) {
            const code = String(reply?.error);
            const reason = Object.hasOwn(STATS_REFUSALS, code) ? STATS_REFUSALS[code] : stripTerminalControl(code);
            return { stats, failed: reason };
        }
        for (const stat of reply.stats) stats.set(stat.id, stat);
        for (const id of reply.missing) stats.set(id, null);
    }
    return { stats, failed: null };
};

/** The per-photo stats suffix: the four numbers, "stats not read" for a photo the read missed, or nothing past the cap. */
const statsSuffix = (stat: PhotoStat | null | undefined): string => {
    if (stat === undefined) return '';
    if (stat === null) return '  — stats not read';
    const picks = stat.guruPicks === 1 ? 'Guru pick' : 'Guru picks';
    return `  — ${stat.votes} votes, ${stat.views} views, ${stat.likes} likes, ${stat.guruPicks} ${picks}`;
};

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
 * A value as one POSIX shell word: wrapped in single quotes, with each single
 * quote inside closed and reopened (`'\''`). The rerun hint is pasted into a
 * shell, so a tag it carries must not split into two arguments or run as code.
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The picker's tag suggestions, best effort like in the GUI: the library's tags
 * that CONTAIN the term, minus the term itself, offered for one exact search.
 * A failed, superseded or empty reply prints nothing, and both lines are
 * terminal only, like the photo lines. Never changes the exit code.
 */
const printTagSuggestions = async (search: string, challengeId: string | null, sort: string | null): Promise<void> => {
    const reply = await handlers()['search-photo-tags'](null, search);
    if (!reply?.success) return;
    const tags = suggestedTags(reply.tags, search);
    if (tags.length === 0) return;
    logger.printLine(`Matching tags: ${tags.map((tag) => stripTerminalControl(tag)).join(', ')}`);
    const rerun = [
        `--search=${shellQuote(stripTerminalControl(tags[0]))}`,
        ...(challengeId === null ? [] : [`--challenge=${shellQuote(stripTerminalControl(challengeId))}`]),
        ...(sort === null ? [] : [`--sort=${shellQuote(stripTerminalControl(sort))}`]),
    ].join(' ');
    logger.printLine(`Search one with: list-photos ${rerun}`);
};

/**
 * Print each photo as `id  allowed|not allowed  [labels]  [— stats]` on the
 * terminal only — the log files never get a photo. `stats` carries the
 * `--stats` read (null when it was not asked for); a photo past its cap has no
 * entry and prints without a suffix.
 */
const printPhotos = (listing: Listing, stats: Map<string, PhotoStat | null> | null): void => {
    for (const photo of listing.photos) {
        const state = listing.allowedKnown ? (photo.allowed ? '  allowed' : '  not allowed') : '';
        const labels = photo.labels.map((label) => stripTerminalControl(label)).join(', ');
        const statsText = stats === null ? '' : statsSuffix(stats.get(photo.id));
        logger.printLine(`  • ${stripTerminalControl(photo.id)}${state}${labels ? `  [${labels}]` : ''}${statsText}`);
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
 * @param sort - a whole-library server order (`votes`|`newest`|`oldest`, checked with isLibraryOrder);
 *   null reads the default votes order
 * @param statsLimit - with a number, also read votes/views/likes/Guru picks for at most this many
 *   printed photos (`--stats [--limit=<n>]`); null lists without stats
 * @returns the exit code
 */
const listPhotosCmd = async (
    challengeId: string | null,
    search: string | null,
    sort: string | null = null,
    statsLimit: number | null = null,
): Promise<number> => {
    if (!ensureAuthenticated()) return 1;
    if (sort !== null && !isLibraryOrder(sort)) {
        ui().error(`Could not list your photos: "${stripTerminalControl(sort)}" is not a sort. ${BAD_SORT_TEXT}`);
        return 1;
    }
    const result = await handlers()['get-library-photos'](
        null,
        challengeId,
        search,
        undefined,
        undefined,
        undefined,
        undefined,
        sort ?? undefined,
    );
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
        if (search) await printTagSuggestions(search, challengeId, sort);
        return 0;
    }
    // The stats come before the listing (they annotate its lines) and can only
    // make it warn: a failed read is one warning line, never a failed command.
    let stats: Map<string, PhotoStat | null> | null = null;
    if (statsLimit !== null) {
        const read = await fetchPhotoStats(
            result.photos.map((photo) => photo.id),
            statsLimit,
        );
        if (read.failed !== null) {
            ui().warning(`Could not read the photo stats (${read.failed}); the list follows without them.`);
        }
        stats = read.stats;
    }
    ui().info(`=== Your photos (${result.photos.length}${result.truncated ? ', list cut short' : ''}) ===`);
    printPhotos(result, stats);
    printWonHidden(result);
    if (result.truncated) ui().warning('The list was cut short; narrow it with --search=<tag> to find the rest.');
    if (!result.allowedKnown) {
        ui().info(
            'Eligibility is not shown without a challenge; pass --challenge=<id> to see which photos it accepts.',
        );
    }
    if (challengeId === null) {
        ui().info('Choose photos for every challenge with: set-global-default chosenPhotos \'["<id>"]\'');
        ui().info('or for one challenge with: set-setting chosenPhotos \'["<id>"]\' --challenge=<id>');
    } else {
        ui().info(
            `Choose photos with: set-setting chosenPhotos '["<id>"]' --challenge=${stripTerminalControl(challengeId)}`,
        );
    }
    if (search) await printTagSuggestions(search, challengeId, sort);
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

export {
    listPhotosCmd,
    suggestPhotosCmd,
    parseSearchFlag,
    parseSortFlag,
    BAD_SORT_TEXT,
    shellQuote,
    STATS_DEFAULT_LIMIT,
    STATS_MAX_LIMIT,
};
