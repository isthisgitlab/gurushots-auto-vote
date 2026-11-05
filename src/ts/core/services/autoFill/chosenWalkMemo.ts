/**
 * Auto-fill — the cross-pass memo of the chosen-photos lookup: what each walk
 * of the library learned about a chosen photo id (found, refused here, not
 * found), its retry backoff, and the reads the Boost-pinned submit makes on
 * it. Split out of chosenPhotos.ts, which keeps the settings resolution and
 * the Submit Only skip lines and reads this memo's answers from here.
 */

import { getEntries } from './challengeState';

import type { Challenge } from '../../types/gurushots';
import type { FillLogger, RankDeps } from '../../types/autoFill';
import type { LibraryUsage, PickerPhoto } from '../../types/photoPicker';
import { errorMessage } from '../../errorMessage';
import { oneLine } from '../../format/logSafe';

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
    /**
     * Whether the last walk stopped only at the page cap (the first 1,000 photos by votes): an id
     * it did not reach is beyond what a walk can reach at all, which is the Boost-pinned submit's
     * definitive answer. A walk stopped by the budget or a failed page resets it.
     */
    pageCapped: boolean;
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
        // The page-cap flag is part of the same expired answer: a fresh walk must say so again.
        memo.pageCapped = false;
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
    pageCapped,
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
    /** The walk stopped only at the page cap (see WalkMemo.pageCapped). */
    pageCapped: boolean;
}): void => {
    const gainedId = memo ? unresolved.some((id) => !memo.knownIds.has(id)) : false;
    const previous = memo && !gainedId ? memo.truncatedWalks : 0;
    const truncatedWalks = cutShort ? previous + 1 : 0;
    const nextWalkAt = cutShort ? now + truncatedWalkDelay(truncatedWalks) : 0;
    const knownIds = new Set([...(memo?.knownIds ?? []), ...unresolved]);
    if (memo) {
        Object.assign(memo, { truncatedWalks, nextWalkAt, knownIds, pageCapped });
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
        pageCapped,
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
        rememberWalk({ challenge, usage, memo, outcomes: kept, now, unresolved, cutShort: true, pageCapped: false });
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
    rememberWalk({
        challenge,
        usage,
        memo,
        outcomes,
        now,
        unresolved,
        cutShort: notReached > 0,
        pageCapped: walk.stop === 'page-cap',
    });
    return foundPhotos(outcomes, missing);
};

/**
 * What the submit-usage walk last learned about one chosen photo id, with the
 * memo brought up to date (a TTL-expired outcome reads as none). Null when the
 * memo holds no outcome for the id — the walk did not run for it, was cut
 * short, threw, or sits out its retry wait. Read by the Boost-pinned submit to
 * tell a definitive empty pick (a walked refusal, not found) from a transient
 * one: a `refused` outcome carrying `until` is an inference from a failed
 * submit (the server did not say which photo it refused), not the walk's own
 * verdict.
 */
const chosenWalkOutcome = (challenge: Challenge, id: string): WalkOutcome | null =>
    readMemo(challenge, Date.now(), 'submit')?.outcomes.get(id) ?? null;

/**
 * Whether the submit-usage walk that last ran for this challenge stopped only at the page cap
 * (the first 1,000 photos by votes): an id it did not reach is beyond what any walk can reach,
 * which is the Boost-pinned submit's definitive "not submittable here". A walk stopped by the
 * budget or a failed page is not a page cap, and an expired memo is no answer; both read false.
 *
 * `pageCapped` covers the whole memo, not one photo id: a walk that stopped at the page cap read
 * the same first 1,000 photos by votes whichever ids it was looking for, so a pin absent from it
 * is outside what the app can read.
 */
const lastWalkStoppedAtPageCap = (challenge: Challenge): boolean =>
    readMemo(challenge, Date.now(), 'submit')?.pageCapped === true;

/** The walk-memo half of forgetChosenPhotosMemory: drop every challenge's walk memos. */
const forgetWalkMemo = (): void => {
    walkMemos.clear();
};

/** Whether any submit-usage outcome records a chosen photo that left the library (the Submit Only skip line's hint). */
const memoShowsLibraryMissing = (challenge: Challenge): boolean =>
    [...(walkMemos.get(memoKey(challenge, 'submit'))?.outcomes.values() ?? [])].some(
        (outcome) => outcome.state === 'not-found',
    );

export {
    resolveMissingChosen,
    refuseRememberedChosen,
    chosenWalkOutcome,
    lastWalkStoppedAtPageCap,
    forgetWalkMemo,
    memoShowsLibraryMissing,
    evictOldest,
};
