/**
 * Auto-fill — the user's chosen photos (the Chosen Photos / Submit Only Chosen
 * Photos settings) as the join and fill paths use them: resolving the two
 * settings, the lookup of a chosen photo the themed fetch did not return (and
 * its cross-pass memo), and the once-per-state skip explanation.
 *
 * The ids only FILTER the candidates the server already offered. A chosen id is
 * never sent to the API on its own — it must come back in the account's own
 * eligible-photo list, with `permission.allowed`, to be submitted.
 */

import { getEntries } from './challengeState';

import type { Challenge } from '../../types/gurushots';
import type { FillLogger, RankDeps } from '../../types/autoFill';
import type { LibraryUsage, PickerPhoto } from '../../types/photoPicker';
import { errorMessage } from '../../errorMessage';
import { oneLine } from '../../format/logSafe';

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
 */
const resolveChosenPhotos = ({ read }: { read: (key: ChosenKey) => unknown }): ChosenSettings => {
    const list = read('chosenPhotos');
    const ids = Array.isArray(list) ? list.map(String) : [];
    if (ids.length === 0) return NO_CHOSEN;
    return { ids, only: read('chosenPhotosOnly') === true, inOrder: read('chosenPhotosInOrder') === true };
};

/** The ids of a challenge's own entries, the photos a chosen list can no longer use. */
const enteredIds = (challenge: Challenge): Set<string> =>
    new Set(getEntries(challenge).map((entry) => String(entry?.id)));

/** What a walk learned about one chosen id. */
type WalkOutcome =
    | { state: 'found'; photo: PickerPhoto }
    // `until` is set when the refusal was inferred from a failed submit (see
    // refuseRememberedChosen); a refusal the walk itself saw has none and lasts the TTL.
    | { state: 'refused'; until?: number }
    | { state: 'not-found' };

interface WalkMemo {
    /** When the outcomes were last cleared; they expire after WALK_MEMO_TTL_MS. */
    at: number;
    /** The challenge's entry count when the outcomes were last reconciled. */
    entryCount: number;
    /** One outcome per chosen photo id. */
    outcomes: Map<string, WalkOutcome>;
    /** How many walks in a row were cut short before reaching every unresolved id. */
    truncatedWalks: number;
    /** The earliest the library may be walked again for the ids in `knownIds`. */
    nextWalkAt: number;
    /**
     * Every id a walk has been looked for so far. It outlives the outcomes (TTL expiry, an entry
     * change): a known id put back as unresolved waits out the current backoff and keeps the count,
     * only an id never looked for before is looked up at once and starts the count over.
     */
    knownIds: Set<string>;
}

// How long a walk's outcomes are trusted. Long enough that the lookup is not
// repeated every scheduler cycle, short enough that a photo the user frees or
// uploads in the meantime is picked up within a fill or two.
const WALK_MEMO_TTL_MS = 30 * 60_000;
// When a walk was cut short, an id it did not reach is still unresolved; trying
// again on every cycle would repeat a walk of up to PAGINATE_BUDGET_MS each time.
// The wait doubles with each consecutive cut-short walk, up to the cap.
const TRUNCATED_WALK_RETRY_MS = 5 * 60_000;
const MAX_TRUNCATED_WALK_RETRY_MS = 60 * 60_000;
// A submit that fails with a server answer says nothing about WHICH photo it refused (the body
// has no per-photo field), so every remembered chosen photo in the pick is held back for a short
// while only; a refusal the walk itself saw (permission.allowed false) lasts the full TTL.
const SUBMIT_REFUSAL_TTL_MS = 10 * 60_000;
const MAX_WALK_MEMOS = 64;

// Per challenge and usage: the photo ids are the chosen list's own concern, so editing the
// list keeps what is already known about the ids it still holds. A walk's verdicts are those of its usage (the
// server filters `allowed` per usage), so a swap's memo is kept apart from the submit one, which keeps the bare
// challenge id as its key.
const walkMemos: Map<string, WalkMemo> = new Map();

const memoKey = (challenge: Challenge, usage: LibraryUsage): string =>
    usage === 'swap' ? `${challenge.id}:swap` : String(challenge.id);

/** Makes room in a capped map by dropping its oldest entry (a Map iterates in insertion order), not every entry. */
const evictOldest = (map: Map<string, unknown>): void => {
    for (const key of map.keys()) {
        map.delete(key);
        return;
    }
};

const truncatedWalkDelay = (truncatedWalks: number): number =>
    Math.min(TRUNCATED_WALK_RETRY_MS * 2 ** (truncatedWalks - 1), MAX_TRUNCATED_WALK_RETRY_MS);

/**
 * This challenge's memo with its outcomes brought up to date: all dropped once
 * they are older than the TTL, and — when the entry count changed since — only
 * the negative ones (a found photo is still checked for eligibility on every
 * pass). Null when the challenge has none.
 */
const readMemo = (challenge: Challenge, now: number, usage: LibraryUsage): WalkMemo | null => {
    const memo = walkMemos.get(memoKey(challenge, usage));
    if (!memo) return null;
    if (now - memo.at >= WALK_MEMO_TTL_MS) {
        memo.outcomes.clear();
        memo.at = now;
    }
    for (const [id, outcome] of memo.outcomes) {
        if (outcome.state === 'refused' && outcome.until !== undefined && outcome.until <= now) {
            memo.outcomes.delete(id);
        }
    }
    const entryCount = getEntries(challenge).length;
    if (memo.entryCount !== entryCount) {
        for (const [id, outcome] of memo.outcomes) {
            if (outcome.state !== 'found') memo.outcomes.delete(id);
        }
        memo.entryCount = entryCount;
    }
    return memo;
};

const foundPhotos = (outcomes: ReadonlyMap<string, WalkOutcome> | undefined, ids: readonly string[]): PickerPhoto[] =>
    ids.flatMap((id) => {
        const outcome = outcomes?.get(id);
        return outcome?.state === 'found' ? [outcome.photo] : [];
    });

/**
 * A submit that used remembered photos was answered by the server with a failure.
 * Which photo it refused is not said, so the submitted ids the memo had found are
 * held back for SUBMIT_REFUSAL_TTL_MS, then looked up again. A submit that got no
 * answer at all (a throw, a transport failure) taught nothing, and the caller leaves
 * the memo as it is.
 */
const refuseRememberedChosen = (challenge: Challenge, submitted: readonly string[], now: number): void => {
    // Submit-only: a refused swap goes through the swap preview, not this memo.
    const memo = walkMemos.get(memoKey(challenge, 'submit'));
    if (!memo) return;
    for (const id of submitted) {
        if (memo.outcomes.get(id)?.state === 'found') {
            memo.outcomes.set(id, { state: 'refused', until: now + SUBMIT_REFUSAL_TTL_MS });
        }
    }
};

/**
 * What a walk says about each id still unresolved, written into `outcomes`:
 * found (and allowed), refused (found, but not allowed here), or not found —
 * the last only from a complete walk. An id a truncated walk did not reach gets
 * no outcome. Returns how many of each.
 */
const recordWalk = (
    unresolved: readonly string[],
    walk: { items: PickerPhoto[]; truncated: boolean },
    outcomes: Map<string, WalkOutcome>,
): { found: number; refused: number; notFound: number } => {
    const byId = new Map(walk.items.map((photo) => [String(photo.id), photo]));
    const tally = { found: 0, refused: 0, notFound: 0 };
    for (const id of unresolved) {
        const photo = byId.get(id);
        if (photo?.permission?.allowed === true) {
            outcomes.set(id, { state: 'found', photo });
            tally.found += 1;
        } else if (photo) {
            outcomes.set(id, { state: 'refused' });
            tally.refused += 1;
        } else if (!walk.truncated) {
            outcomes.set(id, { state: 'not-found' });
            tally.notFound += 1;
        }
    }
    return tally;
};

/**
 * Store what a walk learned: the memo's outcomes, and when the library may be
 * walked again (right away after a walk that reached every unresolved id; after
 * a growing wait when it was cut short or failed, for the ids it left
 * unresolved). An id the wait does not cover starts the count over: a newly
 * chosen photo is not made to wait out the backoff of older ones.
 */
const rememberWalk = ({
    challenge,
    usage,
    memo,
    outcomes,
    now,
    unresolved,
    cutShort,
}: {
    challenge: Challenge;
    usage: LibraryUsage;
    memo: WalkMemo | null;
    outcomes: Map<string, WalkOutcome>;
    now: number;
    /** The ids the walk was looking for. */
    unresolved: readonly string[];
    /** The walk failed or ended before reaching every one of them. */
    cutShort: boolean;
}): void => {
    const gainedId = memo ? unresolved.some((id) => !memo.knownIds.has(id)) : false;
    const previous = memo && !gainedId ? memo.truncatedWalks : 0;
    const truncatedWalks = cutShort ? previous + 1 : 0;
    const nextWalkAt = cutShort ? now + truncatedWalkDelay(truncatedWalks) : 0;
    const knownIds = new Set([...(memo?.knownIds ?? []), ...unresolved]);
    if (memo) {
        Object.assign(memo, { truncatedWalks, nextWalkAt, knownIds });
        return;
    }
    if (walkMemos.size >= MAX_WALK_MEMOS) evictOldest(walkMemos);
    walkMemos.set(memoKey(challenge, usage), {
        at: now,
        entryCount: getEntries(challenge).length,
        outcomes,
        truncatedWalks,
        nextWalkAt,
        knownIds,
    });
};

/**
 * The records of chosen photos the themed fetch did not return, to merge into
 * the candidates.
 *
 * `ids` are the chosen photos not yet entered. A photo is missing when the
 * fetch did not return it at all; the lookup (one unfiltered walk of the
 * library) only runs when that leaves fewer usable chosen photos than the pick
 * can use — min(chosen not yet entered, slots wanted) — and never when the
 * caller already walked the unfiltered library (`allowWalk` false). When the
 * pick goes by the user's order (`inOrder`) the lookup is needed whenever a
 * missing photo stands before the `wantCount`-th usable one in the list, however
 * many usable ones stand behind it: the order says which photo goes first. Its outcome
 * is remembered per challenge, usage and photo (WALK_MEMO_TTL_MS; a changed entry count
 * drops only the negative outcomes): "not found" is only ever recorded from a
 * complete walk, so a photo beyond a truncated walk stays unresolved and the
 * walk is retried with a growing wait (TRUNCATED_WALK_RETRY_MS, doubling).
 *
 * Only the matching chosen records are returned; never the rest of the walk.
 */
const resolveMissingChosen = async ({
    challenge,
    token,
    ids,
    eligible,
    wantCount,
    allowWalk,
    inOrder = false,
    deps,
    label,
    usage = 'submit',
}: {
    challenge: Challenge;
    token: string;
    ids: readonly string[];
    eligible: PickerPhoto[];
    wantCount: number;
    allowWalk: boolean;
    inOrder?: boolean;
    deps: Pick<RankDeps, 'getEligiblePhotosWalk'> & { logger: FillLogger };
    label: string;
    /** What the walk reads eligibility for; its memo is kept per usage. */
    usage?: LibraryUsage;
}): Promise<PickerPhoto[]> => {
    const present = new Map(eligible.map((photo) => [String(photo.id), photo]));
    const missing = ids.filter((id) => !present.has(id));
    if (missing.length === 0) return [];
    // Ranked, any usable chosen photo fills a slot as well as another: look up only when too few are
    // usable. In list order a missing photo matters while fewer than `wantCount` usable ones stand before it.
    const isUsable = (id: string) => present.get(id)?.permission?.allowed === true;
    const usable = inOrder ? ids.slice(0, ids.indexOf(missing[0])).filter(isUsable) : ids.filter(isUsable);
    if (usable.length >= (inOrder ? wantCount : Math.min(ids.length, wantCount))) return [];

    const now = Date.now();
    const memo = readMemo(challenge, now, usage);
    const unresolved = missing.filter((id) => !memo?.outcomes.has(id));
    // The wait holds for every id already looked for: only a newly chosen id is looked up at once.
    const waiting = memo !== null && now < memo.nextWalkAt && unresolved.every((id) => memo.knownIds.has(id));
    if (unresolved.length === 0 || !allowWalk || !deps.getEligiblePhotosWalk || waiting) {
        return foundPhotos(memo?.outcomes, missing);
    }

    let walk;
    try {
        walk = await deps.getEligiblePhotosWalk(challenge.id, token, { logLabel: label, usage });
    } catch (error) {
        deps.logger
            .withCategory(label === 'join' ? 'join' : 'autoSubmit')
            .debug(`${label}: could not look for your chosen photos: ${oneLine(errorMessage(error) || error)}`, null);
        // A failing walk waits like a cut-short one, so a library that is down is not hit every cycle.
        const kept = memo?.outcomes ?? new Map<string, WalkOutcome>();
        rememberWalk({ challenge, usage, memo, outcomes: kept, now, unresolved, cutShort: true });
        return foundPhotos(kept, missing);
    }
    const outcomes = memo?.outcomes ?? new Map<string, WalkOutcome>();
    const tally = recordWalk(unresolved, walk, outcomes);
    const notReached = unresolved.length - tally.found - tally.refused - tally.notFound;
    deps.logger
        .withCategory(label === 'join' ? 'join' : 'autoSubmit')
        .info(
            `${label}: looked for your chosen photos outside the themed search for ${deps.logger.challengeTag(challenge)} — ${tally.found} found, ${tally.refused} not allowed here, ${tally.notFound} not in your library, ${notReached} not reached`,
            null,
        );
    rememberWalk({ challenge, usage, memo, outcomes, now, unresolved, cutShort: notReached > 0 });
    return foundPhotos(outcomes, missing);
};

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
        ? `${label}: skipped ${tag} — none of your chosen photos can go in there (not offered, used elsewhere, or tag-filtered), and Submit Only Chosen Photos is on. Some left your library — remove them from the list`
        : `${label}: skipped ${tag} — none of your chosen photos can be submitted there (not offered, used elsewhere, or filtered by your tags), and Submit Only Chosen Photos is on. Choose other photos or turn it off`;
};

const logChosenSkipOnce = (logger: FillLogger, challenge: Challenge, label: string, reason: ChosenSkipReason): void => {
    const key = String(challenge.id);
    // Submit-only, like the skip it explains: the swap's memo (`memoKey(challenge, 'swap')`) never reaches it.
    // A walk that found chosen photos missing from the library adds a hint to the line: logged again once it shows.
    const missingFromLibrary = [...(walkMemos.get(memoKey(challenge, 'submit'))?.outcomes.values() ?? [])].some(
        (outcome) => outcome.state === 'not-found',
    );
    const logged = missingFromLibrary && reason === 'none-usable' ? `${reason}+missing` : reason;
    if (loggedSkips.get(key) === logged) return;
    if (!loggedSkips.has(key) && loggedSkips.size >= MAX_LOGGED_SKIPS) evictOldest(loggedSkips);
    loggedSkips.set(key, logged);
    const log = logger.withCategory(label === 'join' ? 'join' : 'autoSubmit');
    const tag = logger.challengeTag(challenge);
    // what happened -> why -> what next. The all-entered wording points out
    // that Emergency Submit ignores the setting near the deadline.
    log.warning(formatChosenSkipMessage(label, tag, reason, missingFromLibrary), null);
};

/** The challenge is no longer being skipped: forget the line so a later skip is explained again. */
const clearChosenSkip = (challenge: Challenge): void => {
    loggedSkips.delete(String(challenge.id));
};

/**
 * Drop everything remembered about the lists as they were: the walk memos and the explained skips.
 * A logout calls it, so the next sign-in is neither skipped on the strength of a walk made for the
 * last account nor denied a skip line it already got (tests also start clean with it).
 */
const forgetChosenPhotosMemory = (): void => {
    walkMemos.clear();
    loggedSkips.clear();
};

export {
    resolveChosenPhotos,
    enteredIds,
    resolveMissingChosen,
    refuseRememberedChosen,
    formatChosenSkipMessage,
    logChosenSkipOnce,
    clearChosenSkip,
    forgetChosenPhotosMemory,
};
export type { ChosenSettings, ChosenKey, ChosenSkipReason };
