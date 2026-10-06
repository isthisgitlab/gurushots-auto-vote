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

import { resolveMemberId } from './memberIdentity';
import { getEntries } from './challengeState';

import type { Challenge } from '../../types/gurushots';
import type { FillLogger, RankDeps } from '../../types/autoFill';
import type { PickerPhoto } from '../../types/photoPicker';
import { errorMessage } from '../../errorMessage';
import { oneLine } from '../../format/logSafe';

/** The settings the Chosen Photos feature reads. */
type ChosenKey = 'chosenPhotos' | 'chosenPhotosOnly' | 'chosenPhotosMemberId';

/** What the Chosen Photos settings resolve to for one challenge. */
interface ChosenSettings {
    /** Photo ids the user chose; empty = no preference (and `only` is then false). */
    ids: string[];
    /** Submit Only Chosen Photos, as set — the caller decides whether its path honours it. */
    only: boolean;
}

const NO_CHOSEN: ChosenSettings = { ids: [], only: false };

// Logged once per (saved account, current account): a per-challenge line would
// repeat on every cycle for every challenge the list applies to.
const warnedMismatch: Set<string> = new Set();

/**
 * Resolve the Chosen Photos settings for one challenge.
 *
 * A list saved while another account was signed in is ignored (both settings),
 * because photo ids belong to one account: acting on another account's ids
 * would at best match nothing. The account is only looked up when a list is
 * set AND a saving account was recorded; an unrecorded or unknown account
 * counts as "cannot tell", which applies the list.
 *
 * @param read - reads one setting for this challenge (the caller owns how a
 *   per-challenge value resolves: by cached id for a joined challenge, by rule
 *   and per-id override for an un-joined one)
 */
const resolveChosenPhotos = async ({
    read,
    token,
    getCurrentMemberProfile,
    logger,
    label,
}: {
    read: (key: ChosenKey) => unknown;
    token: string;
    getCurrentMemberProfile: RankDeps['getCurrentMemberProfile'];
    logger: FillLogger;
    label: string;
}): Promise<ChosenSettings> => {
    const list = read('chosenPhotos');
    const ids = Array.isArray(list) ? list.map(String) : [];
    if (ids.length === 0) return NO_CHOSEN;

    const savedBy = read('chosenPhotosMemberId');
    if (typeof savedBy === 'string' && savedBy !== '' && getCurrentMemberProfile) {
        const current = await resolveMemberId(token, getCurrentMemberProfile, logger, label);
        if (current !== null && current !== savedBy) {
            const pair = `${savedBy}>${current}`;
            if (!warnedMismatch.has(pair)) {
                warnedMismatch.add(pair);
                logger
                    .withCategory(label === 'join' ? 'join' : 'autoFill')
                    .warning(
                        `${label}: your Chosen Photos were saved while another account was signed in, so they are ignored — remove them (chooser → Remove those lists, or clear-chosen-photos), then choose photos for this account`,
                        null,
                    );
            }
            return NO_CHOSEN;
        }
    }
    return { ids, only: read('chosenPhotosOnly') === true };
};

/** The ids of a challenge's own entries, the photos a chosen list can no longer use. */
const enteredIds = (challenge: Challenge): Set<string> =>
    new Set(getEntries(challenge).map((entry) => String(entry?.id)));

/** What a walk learned about one chosen id. */
type WalkOutcome = { state: 'found'; photo: PickerPhoto } | { state: 'refused' } | { state: 'not-found' };

interface WalkMemo {
    /** When the outcomes were last cleared; they expire after WALK_MEMO_TTL_MS. */
    at: number;
    /** The challenge's entry count when the outcomes were last reconciled. */
    entryCount: number;
    /** One outcome per chosen photo id. */
    outcomes: Map<string, WalkOutcome>;
    /** How many walks in a row were cut short before reaching every unresolved id. */
    truncatedWalks: number;
    /** The earliest the library may be walked again for the ids in `backoffIds`. */
    nextWalkAt: number;
    /** The unresolved ids the current wait covers; an id outside it is not made to wait. */
    backoffIds: Set<string>;
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
const MAX_WALK_MEMOS = 64;

// Per challenge: the photo ids are the chosen list's own concern, so editing the
// list keeps what is already known about the ids it still holds.
const walkMemos: Map<string, WalkMemo> = new Map();

const truncatedWalkDelay = (truncatedWalks: number): number =>
    Math.min(TRUNCATED_WALK_RETRY_MS * 2 ** (truncatedWalks - 1), MAX_TRUNCATED_WALK_RETRY_MS);

/**
 * This challenge's memo with its outcomes brought up to date: all dropped once
 * they are older than the TTL, and — when the entry count changed since — only
 * the negative ones (a found photo is still checked for eligibility on every
 * pass). Null when the challenge has none.
 */
const readMemo = (challenge: Challenge, now: number): WalkMemo | null => {
    const memo = walkMemos.get(String(challenge.id));
    if (!memo) return null;
    if (now - memo.at >= WALK_MEMO_TTL_MS) {
        memo.outcomes.clear();
        memo.at = now;
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
 * A submit that used remembered photos failed. When the server answered and
 * refused (`refused`), those photos are not allowed here: mark as refused the
 * submitted ids the memo had found. When there was no answer (a throw, a
 * transport failure) nothing was learned about the photos, so they go back to
 * unresolved and the next pass looks them up again. Everything else the memo
 * knows stays either way.
 */
const downgradeRememberedChosen = (
    challenge: Challenge,
    submitted: readonly string[],
    answer: 'refused' | 'no-answer',
): void => {
    const memo = walkMemos.get(String(challenge.id));
    if (!memo) return;
    for (const id of submitted) {
        if (memo.outcomes.get(id)?.state !== 'found') continue;
        if (answer === 'refused') memo.outcomes.set(id, { state: 'refused' });
        else memo.outcomes.delete(id);
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
    memo,
    outcomes,
    now,
    unresolved,
    cutShort,
}: {
    challenge: Challenge;
    memo: WalkMemo | null;
    outcomes: Map<string, WalkOutcome>;
    now: number;
    /** The ids the walk was looking for. */
    unresolved: readonly string[];
    /** The walk failed or ended before reaching every one of them. */
    cutShort: boolean;
}): void => {
    const gainedId = memo ? unresolved.some((id) => !memo.backoffIds.has(id)) : false;
    const previous = memo && !gainedId ? memo.truncatedWalks : 0;
    const truncatedWalks = cutShort ? previous + 1 : 0;
    const nextWalkAt = cutShort ? now + truncatedWalkDelay(truncatedWalks) : 0;
    const backoffIds = cutShort ? new Set(unresolved.filter((id) => !outcomes.has(id))) : new Set<string>();
    if (memo) {
        Object.assign(memo, { truncatedWalks, nextWalkAt, backoffIds });
        return;
    }
    if (walkMemos.size >= MAX_WALK_MEMOS) walkMemos.clear();
    walkMemos.set(String(challenge.id), {
        at: now,
        entryCount: getEntries(challenge).length,
        outcomes,
        truncatedWalks,
        nextWalkAt,
        backoffIds,
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
 * caller already walked the unfiltered library (`allowWalk` false). Its outcome
 * is remembered per challenge and photo (WALK_MEMO_TTL_MS; a changed entry count
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
    deps,
    label,
}: {
    challenge: Challenge;
    token: string;
    ids: readonly string[];
    eligible: PickerPhoto[];
    wantCount: number;
    allowWalk: boolean;
    deps: Pick<RankDeps, 'getEligiblePhotosWalk'> & { logger: FillLogger };
    label: string;
}): Promise<PickerPhoto[]> => {
    const present = new Map(eligible.map((photo) => [String(photo.id), photo]));
    const missing = ids.filter((id) => !present.has(id));
    const usable = ids.filter((id) => present.get(id)?.permission?.allowed === true).length;
    if (missing.length === 0 || usable >= Math.min(ids.length, wantCount)) return [];

    const now = Date.now();
    const memo = readMemo(challenge, now);
    const unresolved = missing.filter((id) => !memo?.outcomes.has(id));
    // The wait only holds for ids it was set for: a newly chosen id is looked up at once.
    const waiting = memo !== null && now < memo.nextWalkAt && unresolved.every((id) => memo.backoffIds.has(id));
    if (unresolved.length === 0 || !allowWalk || !deps.getEligiblePhotosWalk || waiting) {
        return foundPhotos(memo?.outcomes, missing);
    }

    let walk;
    try {
        walk = await deps.getEligiblePhotosWalk(challenge.id, token, { logLabel: label });
    } catch (error) {
        deps.logger
            .withCategory(label === 'join' ? 'join' : 'autoFill')
            .debug(`${label}: could not look for your chosen photos: ${oneLine(errorMessage(error) || error)}`, null);
        // A failing walk waits like a cut-short one, so a library that is down is not hit every cycle.
        const kept = memo?.outcomes ?? new Map<string, WalkOutcome>();
        rememberWalk({ challenge, memo, outcomes: kept, now, unresolved, cutShort: true });
        return foundPhotos(kept, missing);
    }
    const outcomes = memo?.outcomes ?? new Map<string, WalkOutcome>();
    const tally = recordWalk(unresolved, walk, outcomes);
    const notReached = unresolved.length - tally.found - tally.refused - tally.notFound;
    deps.logger
        .withCategory(label === 'join' ? 'join' : 'autoFill')
        .info(
            `${label}: looked for your chosen photos outside the themed search for ${deps.logger.challengeTag(challenge)} — ${tally.found} found, ${tally.refused} not allowed here, ${tally.notFound} not in your library, ${notReached} not reached`,
            null,
        );
    rememberWalk({ challenge, memo, outcomes, now, unresolved, cutShort: notReached > 0 });
    return foundPhotos(outcomes, missing);
};

/** Why Submit Only Chosen Photos left a challenge alone. */
type ChosenSkipReason = 'none-usable' | 'all-entered';

// The last reason logged per challenge. A skip repeats every scheduler cycle,
// so the line is only written when the state differs from the last one logged
// and is cleared again when the challenge stops skipping.
const loggedSkips: Map<string, ChosenSkipReason> = new Map();
const MAX_LOGGED_SKIPS = 64;

const logChosenSkipOnce = (logger: FillLogger, challenge: Challenge, label: string, reason: ChosenSkipReason): void => {
    const key = String(challenge.id);
    if (loggedSkips.get(key) === reason) return;
    if (loggedSkips.size >= MAX_LOGGED_SKIPS) loggedSkips.clear();
    loggedSkips.set(key, reason);
    const log = logger.withCategory(label === 'join' ? 'join' : 'autoFill');
    const tag = logger.challengeTag(challenge);
    // what happened -> why -> what next. Emergency Submit ignores the setting
    // near the deadline, so the way to keep a slot empty is to turn that off too.
    if (reason === 'all-entered') {
        log.warning(
            `${label}: skipped ${tag} — every chosen photo is already entered there, and Submit Only Chosen Photos is on. Choose other photos or turn that setting off; Emergency Submit ignores it near the deadline, so turn Emergency Submit off for this challenge to keep the slot empty`,
            null,
        );
        return;
    }
    log.warning(
        `${label}: skipped ${tag} — none of your chosen photos can be submitted there (not offered for this challenge, already used in another one, or filtered out by your tag settings), and Submit Only Chosen Photos is on. Choose other photos or turn that setting off; Emergency Submit ignores it near the deadline, so turn Emergency Submit off for this challenge to keep the slot empty`,
        null,
    );
};

/** The challenge is no longer being skipped: forget the line so a later skip is explained again. */
const clearChosenSkip = (challenge: Challenge): void => {
    loggedSkips.delete(String(challenge.id));
};

// Test-only: drop the process-wide state between cases.
const __resetChosenPhotos = (): void => {
    warnedMismatch.clear();
    walkMemos.clear();
    loggedSkips.clear();
};

export {
    resolveChosenPhotos,
    enteredIds,
    resolveMissingChosen,
    downgradeRememberedChosen,
    logChosenSkipOnce,
    clearChosenSkip,
    __resetChosenPhotos,
};
export type { ChosenSettings, ChosenKey, ChosenSkipReason };
