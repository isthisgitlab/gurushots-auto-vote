/**
 * The CLI command handlers for the photo/challenge action commands (boost,
 * turbo, submit, swap-back, list-photos): argv parsing and the strict usage
 * errors, delegating to the command implementations in commands/actions.ts,
 * commands/submit.ts and commands/photos.ts. Like every handler module it
 * reads `usageOf` (commandRows.ts) only inside handler bodies, never at
 * module scope — the rows need these handlers at init.
 */
import { boostChallenge, swapBackCmd, turboChallenge } from './commands/actions';
import { fillChallenge, submitPickedCmd } from './commands/submit';
import {
    listPhotosCmd,
    parseSearchFlag,
    parseSortFlag,
    suggestPhotosCmd,
    STATS_DEFAULT_LIMIT,
    STATS_MAX_LIMIT,
} from './commands/photos';
import { requireChallenge } from './guards';
import { exitCodeOf, extractChallenge, usageError } from './commandKit';

import type { CommandHandler } from './commandKit';
import { usageOf } from './commandRows';

// extractChallenge keeps only the first --challenge and drops the rest, so a
// repeat would silently act on the first id while the user asked for two. The
// spend/submit commands count the flag themselves (both spellings: an argv
// entry equal to `--challenge` or starting with `--challenge=`) and refuse a
// repeat before anything runs.
const repeatedChallenge = (argv: string[]): boolean =>
    argv.filter((a) => a === '--challenge' || a.startsWith('--challenge=')).length > 1;

const runListPhotos: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const usage = usageOf('list-photos');
    const suggestFlags = rest.filter((arg) => arg === '--suggest');
    const statsFlags = rest.filter((arg) => arg === '--stats');
    const limitArgs = rest.filter((arg) => arg.startsWith('--limit='));
    const listRest = rest.filter((arg) => arg !== '--suggest' && arg !== '--stats' && !arg.startsWith('--limit='));
    const search = parseSearchFlag(listRest);
    const sort = parseSortFlag(listRest);
    // Anything that is neither a --search/--sort flag nor its value is a typo.
    const unexpected = listRest.filter(
        (arg, i) =>
            arg !== '--search' &&
            !arg.startsWith('--search=') &&
            arg !== '--sort' &&
            !arg.startsWith('--sort=') &&
            listRest[i - 1] !== '--search' &&
            listRest[i - 1] !== '--sort',
    );
    const limitText = limitArgs[0]?.slice('--limit='.length);
    const limit = limitText !== undefined && /^\d+$/.test(limitText) ? Number(limitText) : null;
    // A --sort with no value of its own (nothing after it, or another flag) names
    // what it is missing, not just "wrong arguments".
    if (listRest.some((arg) => arg === '--sort') && sort === null) {
        return usageError('--sort needs one of votes|newest|oldest', usage);
    }
    if (
        suggestFlags.length > 1 ||
        statsFlags.length > 1 ||
        limitArgs.length > 1 ||
        unexpected.length > 0 ||
        (listRest.some((arg) => arg === '--search') && search === null)
    ) {
        return usageError('Wrong arguments', usage);
    }
    if (limitText !== undefined && (limit === null || limit < 1)) {
        return usageError('--limit needs a positive whole number of photos to read stats for', usage);
    }
    if (limit !== null && limit > STATS_MAX_LIMIT) {
        return usageError(`--limit can be at most ${STATS_MAX_LIMIT}`, usage);
    }
    if (statsFlags.length > 0 && suggestFlags.length > 0) {
        return usageError('--stats cannot be combined with --suggest', usage);
    }
    if (limitArgs.length > 0 && statsFlags.length === 0) {
        return usageError('--limit only goes with --stats', usage);
    }
    if (suggestFlags.length > 0) {
        // The suggestions rank for one challenge and are not a search.
        if (challengeId === null || listRest.length > 0) {
            return usageError('Wrong arguments', usage);
        }
        return suggestPhotosCmd(challengeId);
    }
    return listPhotosCmd(challengeId, search, sort, statsFlags.length > 0 ? (limit ?? STATS_DEFAULT_LIMIT) : null);
};

const runBoost = async (challengeId: string, rest: string[]) => {
    const imageArg = rest.find((a) => a.startsWith('--image='));
    const imageId = imageArg ? imageArg.slice('--image='.length) || null : null;
    await boostChallenge(challengeId, { imageId });
    return 0;
};

// Like `join`: it names which photo a won Turbo lands on, so a flag it does not recognise (`--images=`,
// a space-form `--image`, a repeat) is a usage error, never a silent auto-play. Exits 1 when the Turbo
// was not earned or applied.
const runTurbo: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const usage = usageOf('turbo');
    if (repeatedChallenge(argv)) return usageError('Wrong arguments', usage);
    const id = requireChallenge({ challengeId }, usage);
    const imageArgs = rest.filter((a) => a.startsWith('--image='));
    if (rest.some((a) => !a.startsWith('--image=')) || imageArgs.length > 1) {
        return usageError('Wrong arguments', usage);
    }
    const imageId = imageArgs[0]?.slice('--image='.length) ?? null;
    if (imageId === '') return usageError('--image needs a photo id (challenges --challenge=<id> lists them)', usage);
    return exitCodeOf(await turboChallenge(id, { imageId }));
};

// `submit` sends photos, so like `turbo` its arguments are strict: a typo
// (`--images=`), a space form or a repeat is a usage error, never a silent
// auto-submit. After --challenge, the rest may hold --all at most once (every
// empty slot, ranked by the auto-submit rules) or --image=<ids> at most once
// (exactly those photos, comma-separated) — never both. Exit codes: 0 sent,
// 1 failed (including an unknown id), 2 the submit got no answer (the photo(s)
// may have been submitted).
const runSubmit: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const usage = usageOf('submit');
    if (repeatedChallenge(argv)) return usageError('Wrong arguments', usage);
    const id = requireChallenge({ challengeId }, usage);
    const allArgs = rest.filter((a) => a === '--all');
    const imageArgs = rest.filter((a) => a.startsWith('--image='));
    if (
        rest.some((a) => a !== '--all' && !a.startsWith('--image=')) ||
        allArgs.length > 1 ||
        imageArgs.length > 1 ||
        (allArgs.length > 0 && imageArgs.length > 0)
    ) {
        return usageError('Wrong arguments', usage);
    }
    if (imageArgs.length > 0) {
        const imageId = imageArgs[0].slice('--image='.length);
        if (imageId === '') {
            return usageError('--image needs a photo id (list-photos --challenge=<id> lists them)', usage);
        }
        const ids = imageId.split(',');
        if (ids.some((entry) => entry === '')) {
            return usageError(
                '--image carries an empty photo id; pass --image=<id>[,<id>…] with a photo id between the commas',
                usage,
            );
        }
        if (new Set(ids).size !== ids.length) {
            return usageError(
                '--image names the same photo more than once; pass --image=<id>[,<id>…] with each photo once',
                usage,
            );
        }
        return submitPickedCmd(id, ids);
    }
    return fillChallenge(id, { all: allArgs.length > 0 });
};

// `swap-back` spends a swap, so like `join` its arguments are strict: `--to=` belongs to `swap`,
// and a typo, a space form or a repeat is a usage error, never a spend. Without --image the
// command is a read-only listing of the recorded swap-back offers.
const runSwapBack: CommandHandler = async (argv) => {
    const { challengeId, rest } = extractChallenge(argv);
    const usage = usageOf('swap-back');
    if (repeatedChallenge(argv)) return usageError('Wrong arguments', usage);
    const id = requireChallenge({ challengeId }, usage);
    const imageArgs = rest.filter((a) => a.startsWith('--image='));
    const yesArgs = rest.filter((a) => a === '--yes');
    if (rest.some((a) => !a.startsWith('--image=') && a !== '--yes') || imageArgs.length > 1 || yesArgs.length > 1) {
        return usageError('Wrong arguments', usage);
    }
    const imageId = imageArgs[0]?.slice('--image='.length);
    if (imageId === '')
        return usageError('--image needs a photo id (list-photos --challenge=<id> shows the ids)', usage);
    return exitCodeOf(
        await swapBackCmd(id, {
            ...(imageId === undefined ? {} : { imageId }),
            yes: yesArgs.length > 0,
        }),
    );
};

export { runBoost, runListPhotos, runSubmit, runSwapBack, runTurbo };
