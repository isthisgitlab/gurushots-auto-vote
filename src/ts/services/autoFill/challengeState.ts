/**
 * Auto-fill — the local challenge object as the fill paths see it: entry and
 * free-slot reads, reflecting a submit or a boost/turbo apply locally, and the
 * pre-submit live re-fetch that merges fresh member state in place.
 */

import { finiteOr } from '../../numbers';

import type { Challenge, ChallengeMember, RankingEntry } from '../../types/gurushots';
import type { AdoptableMember, FillLogger, RankDeps } from '../../types/autoFill';
import { errorMessage } from '../../errorMessage';

const getEntries = (challenge: Partial<Challenge> | null | undefined): RankingEntry[] => {
    const entries = challenge?.member?.ranking?.entries;
    return Array.isArray(entries) ? entries : [];
};

const getSlotsRemaining = (challenge: Partial<Challenge> | null | undefined): number => {
    const max = finiteOr(challenge?.max_photo_submits, 0);
    return Math.max(0, max - getEntries(challenge).length);
};

/**
 * Appends a freshly submitted entry to the local challenge object. The challenge
 * is not re-fetched mid-cycle, so this is what makes getSlotsRemaining count the
 * consumed slot and lets a due turbo/boost act on the new entry. The entry
 * carries the boosted/turbo flags that boost/turbo entry selection reads.
 */
const reflectNewEntry = (
    challenge: Partial<Challenge> | null | undefined,
    imageId: string | number | null | undefined,
) => {
    const ranking = challenge?.member?.ranking;
    if (!ranking || !imageId) return;
    if (!Array.isArray(ranking.entries)) ranking.entries = [];
    // Coerce the server-supplied id to a string before it joins shared
    // challenge state (mirrors how _postBoost stringifies the image_id).
    ranking.entries.push({ id: String(imageId), turbo: false, boosted: false, boost: -1, boosting: false });
};

/**
 * Mark an entry as boosted/turboed on the local challenge object after the apply
 * succeeded, so the *other* action running later in the same pass sees the conflict.
 *
 * Without this, `pickEntryAvoidingConflict` reads flags that are still whatever the
 * pass-start snapshot carried: turbo would apply to entry X, then boost — which runs later
 * under the default timer ordering — would still see `entries[X].turbo === false` and pick
 * the same entry. GuruShots allows one boost and one turbo per challenge but on *different*
 * entries, so the second action was silently wasted.
 *
 * @param imageId - entry the action was applied to
 * @param field - conflict flag to raise
 */
const reflectEntryFlag = (
    challenge: Partial<Challenge> | null | undefined,
    imageId: string | number,
    field: 'turbo' | 'boosted',
) => {
    const entries = challenge?.member?.ranking?.entries;
    if (!Array.isArray(entries) || !imageId) return;
    const target = String(imageId);
    const entry = entries.find((candidate) => String(candidate?.id) === target);
    if (entry) entry[field] = true;
};

/**
 * Whether a re-fetched `member` has a shape every later consumer of the
 * challenge object can survive: the entries array (the merge guards), member.boost
 * (runBoost destructures it without a guard and reads .timeout), and
 * ranking.exposure (evaluateVotingDecision reads .exposure_factor off it
 * unguarded). A partial payload would otherwise crash the whole voting pass, not
 * just this challenge — stale beats crashed.
 */
const isAdoptableMember = (member: ChallengeMember | undefined): member is AdoptableMember =>
    Boolean(member) &&
    typeof member === 'object' &&
    Array.isArray(member.ranking?.entries) &&
    member.ranking?.exposure != null &&
    Boolean(member.boost) &&
    typeof member.boost === 'object';

/**
 * Merge, don't blindly replace: entries reflected locally earlier this cycle
 * (reflectNewEntry after a fill-new submit) may not have propagated into
 * get_my_active_challenges yet — dropping them would resurrect the very
 * double-submit the refresh exists to prevent. Union by id only grows the entry
 * count, which errs toward fewer submits. An id-less prev entry (malformed) can't
 * be matched, so it is kept — again the fewer-submits direction. Mutates
 * `freshEntries`.
 */
const mergeLocalEntries = (prevEntries: RankingEntry[], freshEntries: RankingEntry[]) => {
    const freshIds = new Set(
        freshEntries.filter((entry) => entry && entry.id != null).map((entry) => String(entry.id)),
    );
    for (const entry of prevEntries) {
        // An id-less entry (malformed upstream data) can't be matched by id;
        // dedupe it by object identity instead so a repeated refresh — or the
        // mock-mode case where prev and fresh are the same array — never
        // appends a second copy of it.
        const isDuplicate = entry?.id == null ? freshEntries.includes(entry) : freshIds.has(String(entry.id));
        if (entry && !isDuplicate) {
            freshEntries.push(entry);
        }
    }
};

/**
 * Id → raised boost/turbo flags for every id-bearing entry that has either set.
 */
const collectRaisedEntryFlags = (entries: RankingEntry[]): Map<string, { turbo: boolean; boosted: boolean }> => {
    const flags: Map<string, { turbo: boolean; boosted: boolean }> = new Map();
    for (const entry of entries) {
        if (!entry || entry.id == null) continue;
        if (entry.turbo || entry.boosted) {
            flags.set(String(entry.id), { turbo: !!entry.turbo, boosted: !!entry.boosted });
        }
    }
    return flags;
};

/**
 * Carry locally-raised boost/turbo flags across the member swap.
 *
 * Replacing `member` wholesale means an entry that IS in the fresh payload comes back
 * with the server's flags — and the server has not registered an apply from seconds ago,
 * so it reports turbo/boosted false. That would silently undo reflectEntryFlag: with the
 * default action order (turbo, then autoFill, then boost) a turbo applied earlier in the
 * pass would have its flag wiped by the refresh, and boost would then pick the very entry
 * turbo had just consumed. Only ever raise a flag, never clear one — if either side says an
 * entry is taken, treat it as taken. That errs toward using a different entry, which is the
 * safe direction: boost and turbo may both be spent, but never on the same entry. Mutates
 * `freshEntries`.
 */
const carryLocalEntryFlags = (prevEntries: RankingEntry[], freshEntries: RankingEntry[]) => {
    const localFlags = collectRaisedEntryFlags(prevEntries);
    if (localFlags.size === 0) return;
    for (const entry of freshEntries) {
        const flags = entry && entry.id != null ? localFlags.get(String(entry.id)) : null;
        if (!flags) continue;
        if (flags.turbo) entry.turbo = true;
        if (flags.boosted) entry.boosted = true;
    }
};

/**
 * Re-fetch live challenge state right before a submit so an entry added
 * outside this pass (e.g. a manual submission made while autorun was working
 * through earlier challenges) is seen before we consume a slot. The
 * pass-start snapshot can be minutes old by the time a fill fires; there is
 * no single-challenge endpoint, so this re-fetches the full active list.
 *
 * Returns:
 *   'refreshed'   – fresh member state merged into `challenge` (in place)
 *   'gone'        – fetch succeeded with a non-empty list that does not
 *                   contain this challenge → caller must skip the submit
 *   'unavailable' – dep not wired, fetch threw, payload malformed, or the
 *                   challenges list came back empty → caller proceeds with
 *                   the pass-start data (stale-over-skip policy)
 *
 * An empty list is 'unavailable', NOT 'gone': makePostRequest never rejects
 * on transport failure — it returns null and getActiveChallenges resolves
 * with { challenges: [] } — so an empty list is exactly what a network blip
 * looks like. Treating it as 'gone' would silently skip legitimate fills on
 * every API hiccup.
 *
 * @param label - calling flow (autoFill/emergencyFill/fillNew)
 */
const refreshChallengeState = async (
    challenge: Challenge,
    token: string,
    { getActiveChallenges, logger }: Pick<RankDeps, 'getActiveChallenges'> & { logger: FillLogger },
    label: string,
): Promise<'refreshed' | 'gone' | 'unavailable'> => {
    if (typeof getActiveChallenges !== 'function') return 'unavailable';
    const log = logger.withCategory('autoFill');
    // Collapse CR/LF in the cause before interpolation (same forgery guard
    // challengeTag applies): the message can carry server-influenced text.
    const staleWarning = (cause: unknown) =>
        log.warning(
            `${label}: could not refresh live challenge state for ${logger.challengeTag(challenge)}${cause ? ` (${String(cause).replace(/[\r\n]+/g, ' ')})` : ''}; ` +
                'proceeding with pass-start data — a manually submitted entry may not be seen and could be duplicated',
            null,
        );
    let response;
    try {
        response = await getActiveChallenges(token);
    } catch (error) {
        staleWarning(errorMessage(error) || error);
        return 'unavailable';
    }
    if (!Array.isArray(response?.challenges) || response.challenges.length === 0) {
        staleWarning('empty challenge list — likely a transport failure');
        return 'unavailable';
    }
    const fresh = response.challenges.find((c) => String(c?.id) === String(challenge.id));
    if (!fresh) {
        log.info(
            `${label}: ${logger.challengeTag(challenge)} is no longer in the active challenge list — not submitting a new photo to it`,
            null,
        );
        return 'gone';
    }
    const member = fresh.member;
    if (!isAdoptableMember(member)) {
        staleWarning('malformed challenge payload');
        return 'unavailable';
    }
    // prevEntries is sliced because in mock mode `fresh` can be the identical
    // cached object, making prev and fresh the same array.
    const prevEntries = getEntries(challenge).slice();
    challenge.member = member;
    mergeLocalEntries(prevEntries, member.ranking.entries);
    carryLocalEntryFlags(prevEntries, member.ranking.entries);
    return 'refreshed';
};

export { getEntries, getSlotsRemaining, reflectNewEntry, reflectEntryFlag, refreshChallengeState };
