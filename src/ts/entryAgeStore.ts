/**
 * When each entry of a challenge entered it, so a boost can wait until its target
 * photo has been in the challenge for `boostFreshEntryWait` (a boost spent on a
 * photo the moment it is entered gets few votes). The API reports no entry time,
 * so the app records one: a photo the app submits is stamped at the submit; any
 * other entry at the first challenge fetch (a refresh, a pass, the CLI) that shows it.
 *
 * Also remembers the photo a boost fill-new submitted and is waiting on
 * (`pending`), so the next pass boosts that photo instead of submitting another.
 *
 * Shape, keyed by challenge id:
 *   { "<challengeId>": { closeTime, entered: { "<imageId>": unixSec }, pending, uncertain, exact, memberId, observed } }
 * An `entered` time of 0 means "already there when the app first saw the
 * challenge" (or its submit time was never recorded) — its age is unknown, so it never holds a boost. An id in `exact`
 * went in through the app (its time is the submit); any other time is the first
 * fetch that showed the entry, so the entry went in at or before it. The UI
 * shows both (observeAll, services/entryTimes).
 *
 * Same platform-aware transport as currencyAutoStore, so on Capacitor its cache
 * MUST be hydrated at boot (initializeEntryAgesAsync, wired in Capacitor.tsx).
 * The store is shared with the Android background service: every write is a
 * read-modify-write through the store (throughStore), and the ledger reads its
 * own writes before they have landed (the app window saves behind a cache).
 * Mock mode uses createMemoryEntryAgeLedger() and never touches the file.
 */

import type { EntryTimes, RawJsonStore } from './types/stores';
import type { Challenge } from './types/gurushots';
import { createJsonStore } from './settings/storage';
import { createStateLog, MAX_IDS } from './entryAgeStateLog';
import type { State, StoredEntryAgeRecord } from './entryAgeStateLog';
import { finiteOr } from './numbers';

// `shared`: the Android background service records entries too (gs_entry_ages is on its native allow-list), and each
// change is saved by the native compare-and-write so that neither context erases the other's.
const entryAgeStore = createJsonStore({
    fileName: 'entryAges.json',
    prefKey: 'gs_entry_ages',
    atomic: true,
    shared: true,
});

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

/** The account the listing belongs to: the first entry's `member_id`, null when none has one. */
const memberIdOf = (challenge: Challenge): string | null => {
    const entries = Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries : [];
    for (const entry of entries) {
        if (typeof entry?.member_id === 'string' && entry.member_id !== '') return entry.member_id;
    }
    return null;
};

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

const sameRecord = (a: StoredEntryAgeRecord, b: StoredEntryAgeRecord): boolean =>
    a.closeTime === b.closeTime &&
    a.memberId === b.memberId &&
    a.observed === b.observed &&
    a.pending === b.pending &&
    sameIds(a.exact, b.exact) &&
    sameIds(a.uncertain, b.uncertain) &&
    sameTimes(a.entered, b.entered);

/** Whether a time stamped `at` is within the grace a listing that lags a submit is waited for. */
const withinGrace = (at: number | undefined, now: number): boolean =>
    Number.isFinite(at) && now - Number(at) <= PENDING_GRACE_SEC;

/** Whether `existing` is the record of another account than the listing's (compared only when both are known). */
const isOtherAccount = (existing: StoredEntryAgeRecord | undefined, listingMember: string | null): boolean =>
    existing?.memberId != null && listingMember !== null && existing.memberId !== listingMember;

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
 * The record `challenge` should now hold: an id seen for the first time is
 * stamped `now` (or left unknown, 0, on the challenge's first sighting), an id no longer
 * entered is forgotten. Null when nothing changed from `existing`.
 *
 * The record of another account is not carried: the listing is built as if there were none. A listing with no entries
 * does not replace a record that has some: a challenge the member is in always has an entry, so it is a bad response.
 * @param now - Unix seconds
 */
const observedRecord = (
    existing: StoredEntryAgeRecord | undefined,
    challenge: Challenge,
    now: number,
): StoredEntryAgeRecord | null => {
    const ids = entryIdsOf(challenge);
    const listingMember = memberIdOf(challenge);
    if (ids.length === 0 && existing && Object.keys(existing.entered).length > 0) return null;
    const known = isOtherAccount(existing, listingMember) ? undefined : existing;
    const entered = listedTimes(known, ids, now);
    const { pending, exact, uncertain } = heldBack(known, entered, now);
    const kept = capped(entered, exact, [...ids, ...(pending ? [pending] : []), ...exact]);
    const record: StoredEntryAgeRecord = {
        closeTime: Number(challenge.close_time),
        entered: kept.entered,
        pending,
        uncertain,
        exact: kept.exact,
        memberId: listingMember ?? known?.memberId ?? null,
        observed: true,
    };
    return known && sameRecord(known, record) ? null : record;
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

/** Per challenge and entry of `challenges`, the entries whose time `state` knows. */
const knownTimes = (state: State, challenges: readonly Challenge[]): EntryTimes => {
    const times: EntryTimes = {};
    for (const challenge of challenges) {
        const challengeId = String(challenge?.id ?? '');
        const record = state[challengeId];
        if (!record) continue;
        const known: EntryTimes[string] = {};
        for (const id of entryIdsOf(challenge)) {
            const at = finiteOr(record.entered[id], 0);
            if (at > 0) known[id] = { at, exact: record.exact.includes(id) };
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
    memberId: null,
    observed: false,
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

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}); see createStateLog for how its writes reach the store.
 *
 * @param refreshStore - re-reads the stored value where the cache can be behind it (the app window); true when it did
 */
const createEntryAgeLedger = (store: RawJsonStore, refreshStore?: () => Promise<boolean>) => {
    const { read, write: writeChange, refresh } = createStateLog(store, refreshStore);
    const observing = (edit: (state: State) => State | null) => writeChange('observe', edit);
    const write = (edit: (state: State) => State | null) => writeChange('mark', edit);

    return {
        /**
         * Record the current entries of `challenge`. Writes only when something changed.
         * @param now - Unix seconds
         */
        observe: (challenge: Challenge, now: number) => {
            observing((state) => observeChallenges(state, [challenge], now));
        },

        /**
         * Record the entries of every challenge of one fetch with at most one write, and answer when each entry
         * went in (the entries whose time is known): per challenge id, per entry id.
         * @param now - Unix seconds
         */
        observeAll: (challenges: readonly Challenge[], now: number): EntryTimes => {
            const before = read();
            const after = observeChallenges(before, challenges, now);
            if (after) observing((state) => observeChallenges(state, challenges, now));
            return knownTimes(after ?? before, challenges);
        },

        /**
         * Re-read the stored value where the cache of the app window can be behind it (the service wrote it), before
         * a read that wants the service's marks. A read that fails is logged and the cache stays.
         */
        refresh,

        /**
         * When the entry entered the challenge (Unix seconds), 0 when that is
         * unknown, null when the entry isn't recorded.
         */
        enteredAt: (challengeId: string | number, imageId: string | number): number | null => {
            const at = read()[String(challengeId)]?.entered[String(imageId)];
            return finiteOr(at, null);
        },

        /**
         * The photo a boost fill-new submitted and is waiting to boost, if any.
         */
        pending: (challengeId: string | number): string | null => read()[String(challengeId)]?.pending ?? null,

        isUncertain: (challengeId: string | number, imageId: string | number): boolean =>
            read()[String(challengeId)]?.uncertain?.includes(String(imageId)) === true,

        markUncertain: (challenge: Challenge, imageId: string | number, now: number) => {
            write((state) => uncertainEdit(state, challenge, String(imageId), now));
        },

        /**
         * Record a photo a boost fill-new just submitted: entered `now` (exactly), and the
         * one the boost is waiting on.
         * @param now - Unix seconds
         */
        markPending: (challenge: Challenge, imageId: string | number, now: number) => {
            write((state) => pendingEdit(state, challenge, String(imageId), now));
        },

        /**
         * Record photos the app just submitted (a fill, a join, a swap): each entered `now`, exactly. A challenge
         * no fetch has seen yet gets a record that the next fetch completes.
         * @param now - Unix seconds
         */
        markSubmitted: (challengeId: string | number, imageIds: readonly (string | number)[], now: number) => {
            write((state) => submittedEdit(state, String(challengeId), imageIds.map(String), now));
        },

        /**
         * The boost landed (or gave up): stop waiting on the pending photo `imageId`. Only that photo: a clear made
         * again after a failed write must not erase a pending photo another context set meanwhile.
         * @param now - Unix seconds
         */
        clearPending: (challengeId: string | number, imageId: string | number, now: number) => {
            write((state) => {
                const record = state[String(challengeId)];
                if (record?.pending !== String(imageId)) return null;
                return withRecord(state, String(challengeId), { ...record, pending: null }, now);
            });
        },
    };
};

/** Ledger over an in-memory store — mock mode, tests. */
const createMemoryEntryAgeLedger = () => {
    let raw: string | null = null;
    return createEntryAgeLedger({
        readRaw: () => raw,
        writeRaw: (data) => {
            raw = data;
        },
    });
};

const entryAgeLedger = createEntryAgeLedger(entryAgeStore, entryAgeStore.refreshAsync);

export const initializeEntryAgesAsync = entryAgeStore.initializeAsync;
export const flushEntryAgeWrites = entryAgeStore.flushPendingWrites;
export { entryAgeLedger, createEntryAgeLedger, createMemoryEntryAgeLedger };
