/**
 * What one challenge's entry-age record should hold: the pure state helpers of
 * the ledger (entryAgeStore) — how a fetch's listing becomes a record, what each
 * write changes in it, and what two records being equal means. No store and no
 * log of their own; the record shapes come from entryAgeStateLog.
 */

import type { EntryAgeRecord, EntryTimes } from './types/stores';
import type { Challenge } from './types/gurushots';
import { MAX_IDS } from './entryAgeStateLog';
import type { State, StoredEntryAgeRecord } from './entryAgeStateLog';
import { finiteOr } from './numbers';

// How long a pending fill-new photo may be missing from the challenge listing
// before it counts as not entered. Covers listing lag after a submit; past it, a
// submit that never landed stops blocking the boost. An exact (app-submitted) or
// uncertain photo is kept the same way.
const PENDING_GRACE_SEC = 600;
// The close time of a record a submit made before any fetch saw the challenge: the next fetch replaces it.
const PLACEHOLDER_CLOSE_SEC = 31 * 24 * 60 * 60;

/** @param challenge @returns */
const entryIdsOf = (challenge: Challenge): string[] =>
    (Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries : [])
        .map((entry) => entry?.id)
        .filter((id) => id !== undefined && id !== null && id !== '')
        .map(String);

/**
 * `state` with `record` set for `challengeId`, every challenge that has closed dropped.
 * @param now - Unix seconds
 */
const withRecord = (state: State, challengeId: string, record: StoredEntryAgeRecord, now: number): State => {
    const next: State = {};
    for (const [id, existing] of Object.entries(state)) {
        if (existing.closeTime > now) next[id] = existing;
    }
    next[challengeId] = record;
    return next;
};

/**
 * `entered` held to MAX_IDS ids, the ids of `priority` first, and the `exact` ids that are left in it.
 */
const capped = (
    entered: Record<string, number>,
    exact: readonly string[],
    priority: readonly string[],
): { entered: Record<string, number>; exact: string[] } => {
    const ids = [...new Set([...priority.filter((id) => id in entered), ...Object.keys(entered)])].slice(0, MAX_IDS);
    const kept = Object.fromEntries(ids.map((id) => [id, entered[id]]));
    return { entered: kept, exact: [...new Set(exact)].filter((id) => id in kept) };
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((id) => b.includes(id));

const sameTimes = (a: Record<string, number>, b: Record<string, number>): boolean =>
    Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((id) => a[id] === b[id]);

/** Two latches are the same when both are absent or both name the same photo and Boost window. */
const sameLatch = (a: EntryAgeRecord['pinSubmitFailed'], b: EntryAgeRecord['pinSubmitFailed']): boolean => {
    if (!a || !b) return !a && !b;
    return a.imageId === b.imageId && a.boostDeadline === b.boostDeadline;
};

const sameRecord = (a: StoredEntryAgeRecord, b: StoredEntryAgeRecord): boolean =>
    a.closeTime === b.closeTime &&
    a.observed === b.observed &&
    a.firstSeen === b.firstSeen &&
    a.pending === b.pending &&
    sameIds(a.exact, b.exact) &&
    sameIds(a.uncertain, b.uncertain) &&
    sameLatch(a.pinSubmitFailed, b.pinSubmitFailed) &&
    sameTimes(a.entered, b.entered);

/** Whether a time stamped `at` is within the grace a listing that lags a submit is waited for. */
const withinGrace = (at: number | undefined, now: number): boolean =>
    Number.isFinite(at) && now - Number(at) <= PENDING_GRACE_SEC;

/**
 * The time of each listed entry: what the record holds, or `now` for one new to a record already seen. On a first
 * sighting (no record, or one a submit made before any fetch saw the challenge) an entry the app did not submit is
 * unknown (0): the API reports no time, and the member's join time says nothing of a photo that may have been swapped
 * in since.
 */
const listedTimes = (
    existing: StoredEntryAgeRecord | undefined,
    ids: readonly string[],
    now: number,
): Record<string, number> => {
    const firstSighting = !existing || !existing.observed;
    const exactIds = new Set(existing?.exact);
    const entered: Record<string, number> = {};
    for (const id of ids) {
        entered[id] = firstSighting && !exactIds.has(id) ? 0 : finiteOr(existing?.entered[id], firstSighting ? 0 : now);
    }
    return entered;
};

/**
 * What the record holds that the listing does not show. The listing can lag a submit, so a pending photo, an exact one
 * (with its time and its flag) and an uncertain one missing from this poll are kept for PENDING_GRACE_SEC — dropping
 * a pending one at once would make the next boost fill-new submit a second photo. The kept ones that are not listed
 * get their time in `entered`.
 */
const heldBack = (existing: StoredEntryAgeRecord | undefined, entered: Record<string, number>, now: number) => {
    if (!existing) return { pending: null, exact: [], uncertain: [] };
    const held = (id: string) => id in entered || withinGrace(existing.entered[id], now);
    const keep = (id: string) => {
        if (!(id in entered)) entered[id] = Number(existing.entered[id]);
    };
    const pending = existing.pending != null && held(existing.pending) ? existing.pending : null;
    if (pending) keep(pending);
    const exact = existing.exact.filter(held);
    exact.forEach(keep);
    return { pending, exact, uncertain: existing.uncertain.filter(held) };
};

/**
 * The first fetch that showed the record's entries, for the time an entry of unknown age is shown at: `now` on a first
 * sighting; the record's own once it has one. A record from a file written before it was kept has none: the entries of
 * unknown age were there before the first entry a fetch stamped, so it takes the smallest such time (not an app submit,
 * exact or uncertain), or `now` when there is none.
 */
const firstSeenOf = (known: StoredEntryAgeRecord | undefined, now: number): number => {
    if (!known?.observed) return now;
    if (known.firstSeen > 0) return known.firstSeen;
    // A fold, not Math.min(...): a corrupt file with a huge map must not overflow the arguments.
    const earliest = Object.entries(known.entered).reduce(
        (least, [id, at]) =>
            Number.isFinite(at) && at > 0 && at < least && !known.exact.includes(id) && !known.uncertain.includes(id)
                ? at
                : least,
        Number.POSITIVE_INFINITY,
    );
    return Number.isFinite(earliest) ? earliest : now;
};

/**
 * The record `challenge` should now hold: an id seen for the first time is
 * stamped `now` (or left unknown, 0, on the challenge's first sighting), an id no longer
 * entered is forgotten. Null when nothing changed from `existing`.
 *
 * A listing with no entries does not replace a record that has some: a challenge the member is in
 * always has an entry, so it is a bad response.
 * @param now - Unix seconds
 */
const observedRecord = (
    existing: StoredEntryAgeRecord | undefined,
    challenge: Challenge,
    now: number,
): StoredEntryAgeRecord | null => {
    const ids = entryIdsOf(challenge);
    if (ids.length === 0 && existing && Object.keys(existing.entered).length > 0) return null;
    const entered = listedTimes(existing, ids, now);
    const { pending, exact, uncertain } = heldBack(existing, entered, now);
    // The Boost-pinned-submit latch is carried like pending/exact/uncertain are,
    // and dropped once its Boost window has passed: it never outlives it.
    const pinSubmitFailed =
        existing?.pinSubmitFailed && existing.pinSubmitFailed.boostDeadline > now ? existing.pinSubmitFailed : null;
    const kept = capped(entered, exact, [...ids, ...(pending ? [pending] : []), ...exact]);
    const record: StoredEntryAgeRecord = {
        closeTime: Number(challenge.close_time),
        entered: kept.entered,
        pending,
        uncertain,
        exact: kept.exact,
        observed: true,
        firstSeen: firstSeenOf(existing, now),
        pinSubmitFailed,
    };
    return existing && sameRecord(existing, record) ? null : record;
};

/**
 * `state` with every challenge of `challenges` observed; null when nothing changed.
 * @param now - Unix seconds
 */
const observeChallenges = (state: State, challenges: readonly Challenge[], now: number): State | null => {
    let next = state;
    let changed = false;
    for (const challenge of challenges) {
        const challengeId = String(challenge?.id ?? '');
        if (!challengeId) continue;
        const record = observedRecord(next[challengeId], challenge, now);
        if (record) {
            next = withRecord(next, challengeId, record, now);
            changed = true;
        }
    }
    return changed ? next : null;
};

/**
 * Per challenge and entry of `challenges`, when `state` has each entry going in: its recorded time, exact when the app
 * submitted it; or, for a recorded entry of unknown age (0), the first fetch that showed the record — it was there by
 * then. An entry the record does not hold is left out.
 */
const knownTimes = (state: State, challenges: readonly Challenge[]): EntryTimes => {
    const times: EntryTimes = {};
    for (const challenge of challenges) {
        const challengeId = String(challenge?.id ?? '');
        const record = state[challengeId];
        if (!record) continue;
        const known: EntryTimes[string] = {};
        for (const id of entryIdsOf(challenge)) {
            const entered = finiteOr(record.entered[id], null);
            if (entered === null) continue;
            const at = entered > 0 ? entered : record.firstSeen;
            if (at > 0) known[id] = { at, exact: entered > 0 && record.exact.includes(id) };
        }
        if (Object.keys(known).length > 0) times[challengeId] = known;
    }
    return times;
};

/** The record a submit makes for a challenge no fetch has seen yet. */
const blankRecord = (closeTime: number): StoredEntryAgeRecord => ({
    closeTime,
    entered: {},
    pending: null,
    uncertain: [],
    exact: [],
    observed: false,
    firstSeen: 0,
    pinSubmitFailed: null,
});

/** The ids a write that has no listing keeps first when a record is full: the pending photo and the exact ones. */
const heldFirst = (record: StoredEntryAgeRecord): string[] => [
    ...(record.pending ? [record.pending] : []),
    ...record.exact,
];

/** `record` with `entered` and `exact` held to the size of a record, the ids of `priority` kept first. */
const recorded = (
    record: StoredEntryAgeRecord,
    entered: Record<string, number>,
    exact: readonly string[],
    priority: readonly string[],
): StoredEntryAgeRecord => ({ ...record, ...capped(entered, exact, priority) });

/** `state` with the photo `id` marked uncertain (null when it already is); its earlier time is kept. */
const uncertainEdit = (state: State, challenge: Challenge, id: string, now: number): State | null => {
    const challengeId = String(challenge.id);
    const current = state[challengeId];
    if (current?.uncertain.includes(id)) return null;
    const base = current ?? blankRecord(Number(challenge.close_time));
    const entered = { ...base.entered, [id]: finiteOr(base.entered[id], now) };
    const record = recorded(base, entered, base.exact, [...heldFirst(base), id]);
    return withRecord(
        state,
        challengeId,
        { ...record, closeTime: Number(challenge.close_time), uncertain: [...base.uncertain, id] },
        now,
    );
};

/** `state` with the photo `id` entered `now` (exactly) and pending. */
const pendingEdit = (state: State, challenge: Challenge, id: string, now: number): State => {
    const challengeId = String(challenge.id);
    const base = state[challengeId] ?? blankRecord(Number(challenge.close_time));
    const record = recorded(base, { ...base.entered, [id]: now }, [...base.exact, id], [id, ...base.exact]);
    return withRecord(state, challengeId, { ...record, closeTime: Number(challenge.close_time), pending: id }, now);
};

/** `state` with the photos `ids` entered `now` (exactly). */
const submittedEdit = (state: State, challengeId: string, ids: readonly string[], now: number): State => {
    const base = state[challengeId] ?? blankRecord(now + PLACEHOLDER_CLOSE_SEC);
    const entered = { ...base.entered, ...Object.fromEntries(ids.map((id) => [id, now])) };
    const record = recorded(base, entered, [...base.exact, ...ids], [...ids, ...heldFirst(base)]);
    return withRecord(state, challengeId, record, now);
};

/** `state` with the Boost-pinned-submit failure latch set for `challenge`; the record's other fields are left as they are. */
const pinSubmitFailedEdit = (
    state: State,
    challenge: Challenge,
    imageId: string | number,
    boostDeadline: number,
): State | null => {
    const challengeId = String(challenge.id);
    const base = state[challengeId] ?? blankRecord(Number(challenge.close_time));
    return withRecord(
        state,
        challengeId,
        {
            ...base,
            closeTime: Number(challenge.close_time),
            pinSubmitFailed: { imageId: String(imageId), boostDeadline },
        },
        Math.floor(Date.now() / 1000),
    );
};

export { withRecord, observeChallenges, knownTimes, uncertainEdit, pendingEdit, submittedEdit, pinSubmitFailedEdit };
