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
                        `${label}: your Chosen Photos were saved while another account was signed in, so they are ignored — choose them again for this account or clear them`,
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

// ---------------------------------------------------------------------------
// The lookup of chosen photos the themed fetch did not return.
// ---------------------------------------------------------------------------

/** What a walk learned about one chosen id. */
type WalkOutcome = { state: 'found'; photo: PickerPhoto } | { state: 'refused' } | { state: 'not-found' };

interface WalkMemo {
    /** When the entry was created; it expires after WALK_MEMO_TTL_MS. */
    at: number;
    /** The challenge's entry count then; a different count drops the entry. */
    entryCount: number;
    /** When the library was last walked for this entry. */
    walkedAt: number;
    outcomes: Map<string, WalkOutcome>;
}

// How long a walk's outcome is trusted. Long enough that the lookup is not
// repeated every scheduler cycle, short enough that a photo the user frees or
// uploads in the meantime is picked up within a fill or two.
const WALK_MEMO_TTL_MS = 30 * 60_000;
// When a walk was cut short, an id it did not reach is still unresolved; trying
// again on every cycle would repeat a walk of up to PAGINATE_BUDGET_MS each time.
const RETRY_TRUNCATED_WALK_MS = 5 * 60_000;
const MAX_WALK_MEMOS = 64;

const walkMemos: Map<string, WalkMemo> = new Map();

// The chosen list is part of the key so editing it never reuses a stale answer.
const memoKey = (challenge: Challenge, ids: readonly string[]): string =>
    `${challenge.id}|${[...ids].sort().join(',')}`;

/** The memo for this challenge and list while it is still valid, else null (dropping an expired one). */
const readMemo = (challenge: Challenge, ids: readonly string[], now: number): WalkMemo | null => {
    const key = memoKey(challenge, ids);
    const memo = walkMemos.get(key);
    if (!memo) return null;
    if (now - memo.at >= WALK_MEMO_TTL_MS || memo.entryCount !== getEntries(challenge).length) {
        walkMemos.delete(key);
        return null;
    }
    return memo;
};

const foundPhotos = (outcomes: ReadonlyMap<string, WalkOutcome> | undefined, ids: readonly string[]): PickerPhoto[] =>
    ids.flatMap((id) => {
        const outcome = outcomes?.get(id);
        return outcome?.state === 'found' ? [outcome.photo] : [];
    });

/**
 * The chosen photos an earlier walk found for this challenge, without any
 * request — what the emergency path and its stand-down probe use, since neither
 * may walk the library.
 */
const recallChosenPhotos = (challenge: Challenge, ids: readonly string[]): PickerPhoto[] =>
    foundPhotos(readMemo(challenge, ids, Date.now())?.outcomes, ids);

/** Drop every remembered walk for a challenge (a submit using a remembered photo failed). */
const forgetChosenWalks = (challenge: Challenge): void => {
    const prefix = `${challenge.id}|`;
    for (const key of [...walkMemos.keys()]) {
        if (key.startsWith(prefix)) walkMemos.delete(key);
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
 * The records of chosen photos the themed fetch did not return, to merge into
 * the candidates.
 *
 * `ids` are the chosen photos not yet entered. A photo is missing when the
 * fetch did not return it at all; the lookup (one unfiltered walk of the
 * library) only runs when that leaves fewer usable chosen photos than the pick
 * can use — min(chosen not yet entered, slots wanted) — and never when the
 * caller already walked the unfiltered library (`allowWalk` false). Its outcome
 * is remembered per challenge and list (WALK_MEMO_TTL_MS, or until the entry
 * count changes): "not found" is only ever recorded from a complete walk, so a
 * photo beyond a truncated walk stays unresolved and is retried later.
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
    const memo = readMemo(challenge, ids, now);
    const unresolved = missing.filter((id) => !memo?.outcomes.has(id));
    const dueForWalk = !memo || now - memo.walkedAt >= RETRY_TRUNCATED_WALK_MS;
    if (unresolved.length === 0 || !allowWalk || !deps.getEligiblePhotosWalk || !dueForWalk) {
        return foundPhotos(memo?.outcomes, missing);
    }

    let walk;
    try {
        walk = await deps.getEligiblePhotosWalk(challenge.id, token, { logLabel: label });
    } catch (error) {
        deps.logger
            .withCategory(label === 'join' ? 'join' : 'autoFill')
            .debug(`${label}: could not look for your chosen photos: ${errorMessage(error) || error}`, null);
        return foundPhotos(memo?.outcomes, missing);
    }
    const outcomes = new Map(memo?.outcomes);
    const tally = recordWalk(unresolved, walk, outcomes);
    const notReached = unresolved.length - tally.found - tally.refused - tally.notFound;
    deps.logger
        .withCategory(label === 'join' ? 'join' : 'autoFill')
        .info(
            `${label}: looked for your chosen photos outside the themed search for ${deps.logger.challengeTag(challenge)} — ${tally.found} found, ${tally.refused} not allowed here, ${tally.notFound} not in your library, ${notReached} not reached`,
            null,
        );
    if (walkMemos.size >= MAX_WALK_MEMOS) walkMemos.clear();
    walkMemos.set(memoKey(challenge, ids), {
        at: memo?.at ?? now,
        entryCount: getEntries(challenge).length,
        walkedAt: now,
        outcomes,
    });
    return foundPhotos(outcomes, missing);
};

// ---------------------------------------------------------------------------
// The skip explanation, once per state change.
// ---------------------------------------------------------------------------

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
    recallChosenPhotos,
    forgetChosenWalks,
    logChosenSkipOnce,
    clearChosenSkip,
    __resetChosenPhotos,
};
export type { ChosenSettings, ChosenKey, ChosenSkipReason };
