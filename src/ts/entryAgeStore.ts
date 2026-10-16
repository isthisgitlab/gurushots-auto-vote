/**
 * When each entry of a challenge entered it, so a boost can wait until its target
 * photo has been in the challenge for `boostFreshEntryWait` (a boost spent on a
 * photo the moment it is entered gets few votes). The API reports no entry time,
 * so the app records one: the instant it first sees an entry id — its own submit
 * reflected into the pass, or the first poll after a manual one.
 *
 * Also remembers the photo a boost fill-new submitted and is waiting on
 * (`pending`), so the next pass boosts that photo instead of submitting another.
 *
 * Shape, keyed by challenge id:
 *   { "<challengeId>": { closeTime, entered: { "<imageId>": unixSec }, pending, uncertain, exact, memberId, observed } }
 * An `entered` time of 0 means "already there when the app first saw the
 * challenge" — its age is unknown, so it never holds a boost. An id in `exact`
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

import type { EntryAgeRecord, EntryTimes, RawJsonStore } from './types/stores';
import type { Challenge } from './types/gurushots';
import * as logger from './logger';
import { createJsonStore } from './settings/storage';
import { throughStore } from './settings/storeTransport';
import { isPlainObject } from './plainObject';
import { finiteOr } from './numbers';
import { errorMessage } from './errorMessage';

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
// How many entry ids (and exact / uncertain ids) one record keeps.
const MAX_IDS = 64;
// The close time of a record a submit made before any fetch saw the challenge: the next fetch replaces it.
const PLACEHOLDER_CLOSE_SEC = 31 * 24 * 60 * 60;

type StoredEntryAgeRecord = EntryAgeRecord & { uncertain: string[] };
type State = Record<string, StoredEntryAgeRecord>;
// What a file written before the exact times held.
type LegacyEntryAgeRecord = Pick<EntryAgeRecord, 'closeTime' | 'entered' | 'pending'> & Partial<EntryAgeRecord>;

/**
 * @param r - an untrusted parsed-JSON value
 */
const isRecord = (r: unknown): r is LegacyEntryAgeRecord =>
    isPlainObject(r) && Number.isFinite(r.closeTime) && isPlainObject(r.entered);

const messageOf = (error: unknown): string => errorMessage(error) ?? String(error);

const isString = (value: unknown): value is string => typeof value === 'string';

const idList = (value: unknown): string[] => (Array.isArray(value) ? value.slice(0, MAX_IDS).filter(isString) : []);

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
 * The ledger's state from its text. An unreadable or corrupt file reads as empty — every entry's
 * age is then unknown, which only means a boost is not held; it never blocks one. A record from a
 * file written before the exact times gets the fields it lacks.
 */
const parseState = (raw: string | null): State => {
    try {
        const parsed: unknown = JSON.parse(raw || '{}');
        if (!isPlainObject(parsed)) return {};
        const state: State = {};
        for (const [id, record] of Object.entries(parsed)) {
            if (isRecord(record)) {
                state[id] = {
                    ...record,
                    uncertain: idList(record.uncertain),
                    exact: idList(record.exact),
                    memberId: typeof record.memberId === 'string' ? record.memberId : null,
                    observed: record.observed !== false,
                };
            }
        }
        return state;
    } catch (error) {
        logger.withCategory('boost').warning(`entry-age ledger unreadable: ${messageOf(error)}`, null);
        return {};
    }
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

/**
 * Whether the listing is the first this record has met: no record, a record a submit made before any fetch saw the
 * challenge, or one of another account (compared only when both accounts are known).
 */
const isFirstSighting = (existing: StoredEntryAgeRecord | undefined, listingMember: string | null): boolean =>
    !existing ||
    !existing.observed ||
    (existing.memberId !== null && listingMember !== null && existing.memberId !== listingMember);

/**
 * The time of each listed entry: what the record holds, or `now` for one new to a record already seen. On a first
 * sighting an entry the app did not submit is unknown (0), except the only entry of a challenge, which went in when
 * the member joined.
 */
const listedTimes = (
    existing: StoredEntryAgeRecord | undefined,
    challenge: Challenge,
    ids: readonly string[],
    firstSighting: boolean,
    now: number,
): Record<string, number> => {
    const joinedAt = finiteOr(challenge?.member?.time_joined, 0);
    const firstAt = ids.length === 1 && joinedAt > 0 ? joinedAt : 0;
    const exactIds = new Set(existing?.exact);
    const entered: Record<string, number> = {};
    for (const id of ids) {
        entered[id] =
            firstSighting && !exactIds.has(id)
                ? firstAt
                : finiteOr(existing?.entered[id], firstSighting ? firstAt : now);
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
 * @param now - Unix seconds
 */
const observedRecord = (
    existing: StoredEntryAgeRecord | undefined,
    challenge: Challenge,
    now: number,
): StoredEntryAgeRecord | null => {
    const ids = entryIdsOf(challenge);
    const listingMember = memberIdOf(challenge);
    const entered = listedTimes(existing, challenge, ids, isFirstSighting(existing, listingMember), now);
    const { pending, exact, uncertain } = heldBack(existing, entered, now);
    const kept = capped(entered, exact, [...ids, ...(pending ? [pending] : []), ...exact]);
    const record: StoredEntryAgeRecord = {
        closeTime: Number(challenge.close_time),
        entered: kept.entered,
        pending,
        uncertain,
        exact: kept.exact,
        memberId: listingMember ?? existing?.memberId ?? null,
        observed: true,
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

type Change = { apply: (current: string | null) => string | null; failed: boolean };

/**
 * The ledger's state over a raw-JSON store, and the writes that change it.
 *
 * Every write is one read-modify-write through the store. The app window saves behind a cache, so a change is only
 * in the stored value once its save has landed: the log keeps the changes it handed over and applies them, in
 * order, over what it reads, so a pass sees its own writes at once (and what a refresh brought in from the service).
 * A change leaves the log when its save settled (saved, or declined); a failed one stays applied until the next
 * refresh that succeeds. Changes are idempotent, so applying one to a value that holds it already is harmless. Where
 * the write is made before it returns (a desktop, the service, an in-memory store) nothing is kept.
 *
 * @param refreshStore - re-reads the stored value where the cache can be behind it (the app window); true when it did
 */
const createStateLog = (store: RawJsonStore, refreshStore?: () => Promise<boolean>) => {
    let changes: Change[] = [];
    store.onDiscard?.(() => {
        changes = [];
    });

    const forget = (change: Change) => {
        changes = changes.filter((c) => c !== change);
    };

    return {
        read: (): State => {
            try {
                let raw = store.readRaw();
                for (const change of changes) {
                    try {
                        raw = change.apply(raw) ?? raw;
                    } catch (error) {
                        logger.withCategory('boost').warning(`entry-age change not applied: ${messageOf(error)}`, null);
                    }
                }
                return parseState(raw);
            } catch (error) {
                logger.withCategory('boost').warning(`entry-age ledger unreadable: ${messageOf(error)}`, null);
                return {};
            }
        },

        // Makes `edit` of the stored state (answering null to change nothing); the caller never sees a failure.
        write: (edit: (state: State) => State | null) => {
            const change: Change = {
                apply: (current) => {
                    const next = edit(parseState(current));
                    return next ? JSON.stringify(next) : null;
                },
                failed: false,
            };
            const immediate = store.updateNow?.(change.apply) ?? null;
            if (immediate !== null) {
                if (immediate === 'failed') {
                    change.failed = true;
                    changes.push(change);
                }
                return;
            }
            const queued = store.updateThrough !== undefined;
            if (queued) changes.push(change);
            throughStore(store, change.apply).then(
                (result) => {
                    if (!queued) return;
                    if (result === 'failed') change.failed = true;
                    else forget(change);
                },
                (error: unknown) => {
                    logger.withCategory('boost').warning(`entry-age ledger not written: ${messageOf(error)}`, null);
                    forget(change);
                },
            );
        },

        refresh: async (): Promise<void> => {
            if (!refreshStore) return;
            let failure = 'the read failed';
            try {
                if (await refreshStore()) {
                    changes = changes.filter((change) => !change.failed);
                    return;
                }
            } catch (error) {
                failure = messageOf(error);
            }
            logger
                .withCategory('boost')
                .warning(`entry-age ledger not refreshed (${failure}) — using the cached copy`, null);
        },
    };
};

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}); see createStateLog for how its writes reach the store.
 *
 * @param refreshStore - re-reads the stored value where the cache can be behind it (the app window); true when it did
 */
const createEntryAgeLedger = (store: RawJsonStore, refreshStore?: () => Promise<boolean>) => {
    const { read, write, refresh } = createStateLog(store, refreshStore);

    return {
        /**
         * Record the current entries of `challenge`. Writes only when something changed.
         * @param now - Unix seconds
         */
        observe: (challenge: Challenge, now: number) => {
            write((state) => observeChallenges(state, [challenge], now));
        },

        /**
         * Record the entries of every challenge of one fetch with at most one write, and answer when each entry
         * went in (the entries whose time is known): per challenge id, per entry id.
         * @param now - Unix seconds
         */
        observeAll: (challenges: readonly Challenge[], now: number): EntryTimes => {
            const before = read();
            const after = observeChallenges(before, challenges, now);
            if (after) write((state) => observeChallenges(state, challenges, now));
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
         * The boost landed (or gave up): stop waiting on a pending photo.
         * @param now - Unix seconds
         */
        clearPending: (challengeId: string | number, now: number) => {
            write((state) => {
                const record = state[String(challengeId)];
                if (!record?.pending) return null;
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
