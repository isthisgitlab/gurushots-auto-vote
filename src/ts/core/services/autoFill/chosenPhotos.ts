/**
 * Auto-fill — the user's chosen photos (the Chosen Photos / Submit Only Chosen
 * Photos settings) as the join and fill paths use them: resolving the two
 * settings and the once-per-state Submit Only skip explanation. The lookup of
 * a chosen photo the themed fetch did not return, and its cross-pass memo,
 * live in chosenWalkMemo.ts; the skip lines read that memo's answers from here.
 *
 * The ids only FILTER the candidates the server already offered. A chosen id is
 * never sent to the API on its own — it must come back in the account's own
 * eligible-photo list, with `permission.allowed`, to be submitted.
 */

import { getEntries } from './challengeState';
import { oneLine } from '../../format/logSafe';
import { evictOldest, forgetWalkMemo, memoShowsLibraryMissing } from './chosenWalkMemo';

import type { Challenge } from '../../types/gurushots';
import type { FillLogger } from '../../types/autoFill';
import type { PhotoPoolBlock } from '../../types/stores';

/** The settings the Chosen Photos feature reads. */
type ChosenKey = 'chosenPhotos' | 'chosenPhotosOnly' | 'chosenPhotosInOrder';

/** What the Chosen Photos settings resolve to for one challenge. */
interface ChosenSettings {
    /** Photo ids the user chose; empty = no preference (and `only` is then false). */
    ids: string[];
    /** Submit Only Chosen Photos, as set — the caller decides whether its path honours it. */
    only: boolean;
    /** Use the photos in the order they were picked, not ranked. */
    inOrder: boolean;
    /**
     * Set when the challenge's phase draws from a photo pool that has nothing to give while Submit Only applies (the pool is
     * not saved on this account, or every photo of it is given out): nothing may be picked, and never anything else instead.
     */
    blocked?: PhotoPoolBlock;
}

const NO_CHOSEN: ChosenSettings = { ids: [], only: false, inOrder: false };

/**
 * Resolve the Chosen Photos settings for one challenge. The list applies as
 * saved: it belongs to whoever is signed in, and its ids only ever filter the
 * candidates the server returned, so an id that matches nothing can at worst
 * leave the pick to the other candidates.
 *
 * @param read - reads one setting for this challenge (the caller owns how a
 *   per-challenge value resolves: by cached id for a joined challenge, by rule
 *   and per-id override for an un-joined one)
 * @param blocked - the block of the challenge's photo pool, when it has one that leaves nothing to pick
 */
const resolveChosenPhotos = ({
    read,
    blocked = null,
}: {
    read: (key: ChosenKey) => unknown;
    /** What the challenge's photo pool says (settings getChosenPoolView): a block makes Submit Only on, with nothing to pick. */
    blocked?: PhotoPoolBlock | null;
}): ChosenSettings => {
    if (blocked !== null) return { ids: [], only: true, inOrder: false, blocked };
    const list = read('chosenPhotos');
    const ids = Array.isArray(list) ? list.map(String) : [];
    if (ids.length === 0) return NO_CHOSEN;
    return { ids, only: read('chosenPhotosOnly') === true, inOrder: read('chosenPhotosInOrder') === true };
};

/** The ids of a challenge's own entries, the photos a chosen list can no longer use. */
const enteredIds = (challenge: Challenge): Set<string> =>
    new Set(getEntries(challenge).map((entry) => String(entry?.id)));

/** Why Submit Only Chosen Photos left a challenge alone. */
type ChosenSkipReason = 'none-usable' | 'all-entered';

// The last reason logged per challenge. A skip repeats every scheduler cycle,
// so the line is only written when the state differs from the last one logged
// and is cleared again when the challenge stops skipping.
const loggedSkips: Map<string, string> = new Map();
const MAX_LOGGED_SKIPS = 64;

/**
 * The one wording for the Submit Only Chosen Photos skip lines — the log catalog's
 * English templates match against exactly this text, so the two drift together.
 */
const formatChosenSkipMessage = (
    label: string,
    tag: string,
    reason: ChosenSkipReason,
    missingFromLibrary: boolean,
): string => {
    if (reason === 'all-entered') {
        return `${label}: skipped ${tag} — every chosen photo is already entered there, and Submit Only Chosen Photos is on. Choose other photos or turn it off (Emergency Submit ignores it near the deadline)`;
    }
    return missingFromLibrary
        ? `${label}: skipped ${tag} — none of your chosen photos can go in there (not offered, used elsewhere, or tag-filtered), and Submit Only Chosen Photos is on (Emergency Submit still fills a slot near the deadline). Some left your library — remove them from the list`
        : `${label}: skipped ${tag} — none of your chosen photos can be submitted there (not offered, used elsewhere, or filtered by your tags), and Submit Only Chosen Photos is on (Emergency Submit still fills a slot near the deadline). Choose other photos or turn it off`;
};

const logChosenSkipOnce = (logger: FillLogger, challenge: Challenge, label: string, reason: ChosenSkipReason): void => {
    const key = String(challenge.id);
    // Submit-only, like the skip it explains: the swap's memo (`memoKey(challenge, 'swap')`) never reaches it.
    // A walk that found chosen photos missing from the library adds a hint to the line: logged again once it shows.
    const missingFromLibrary = memoShowsLibraryMissing(challenge);
    const logged = missingFromLibrary && reason === 'none-usable' ? `${reason}+missing` : reason;
    if (loggedSkips.get(key) === logged) return;
    if (!loggedSkips.has(key) && loggedSkips.size >= MAX_LOGGED_SKIPS) evictOldest(loggedSkips);
    loggedSkips.set(key, logged);
    const log = logger.withCategory(label === 'join' ? 'join' : 'autoSubmit');
    const tag = logger.challengeTag(challenge);
    // what happened -> why -> what next. Every wording points out that
    // Emergency Submit still fills the slot near the deadline.
    log.warning(formatChosenSkipMessage(label, tag, reason, missingFromLibrary), null);
};

/**
 * The one wording for the line a photo pool that has nothing to give writes: which pool, and why (not saved on this account,
 * or every photo of it given out in this phase). The pool's name is the user's text, shown on one line.
 */
const formatPoolBlockMessage = (label: string, tag: string, block: PhotoPoolBlock, poolName: string): string => {
    const name = oneLine(poolName);
    return block === 'pool-exhausted'
        ? `${label}: skipped ${tag} — photo pool ${name} has no photos left for this phase`
        : `${label}: skipped ${tag} — photo pool ${name} is not saved on this account`;
};

// The pool lines have a key of their own in the same table, so they neither hide nor are hidden by a chosen-photo skip line.
const poolKey = (challenge: Challenge): string => `pool:${String(challenge.id)}`;

/**
 * Writes the line for a pick a photo pool blocked, once per challenge and reason while it stays blocked (a skip repeats
 * every cycle); the line is written again after the pool stops blocking and blocks again, or when the reason changes.
 */
const logPoolBlockOnce = (
    logger: FillLogger,
    challenge: Challenge,
    label: string,
    block: PhotoPoolBlock,
    poolName: string,
): void => {
    const key = poolKey(challenge);
    if (loggedSkips.get(key) === block) return;
    if (!loggedSkips.has(key) && loggedSkips.size >= MAX_LOGGED_SKIPS) evictOldest(loggedSkips);
    loggedSkips.set(key, block);
    logger
        .withCategory(label === 'join' ? 'join' : 'autoSubmit')
        .warning(formatPoolBlockMessage(label, logger.challengeTag(challenge), block, poolName), null);
};

/** The challenge is no longer being skipped: forget the lines so a later skip is explained again. */
const clearChosenSkip = (challenge: Challenge): void => {
    loggedSkips.delete(String(challenge.id));
    loggedSkips.delete(poolKey(challenge));
};

/**
 * Drop everything remembered about the lists as they were: the walk memos (in chosenWalkMemo) and
 * the explained skips. A logout calls it, so the next sign-in is neither skipped on the strength of
 * a walk made for the last account nor denied a skip line it already got (tests also start clean
 * with it).
 */
const forgetChosenPhotosMemory = (): void => {
    forgetWalkMemo();
    loggedSkips.clear();
};

export {
    resolveChosenPhotos,
    enteredIds,
    formatChosenSkipMessage,
    logChosenSkipOnce,
    logPoolBlockOnce,
    clearChosenSkip,
    forgetChosenPhotosMemory,
};
export type { ChosenSettings, ChosenKey, ChosenSkipReason };
