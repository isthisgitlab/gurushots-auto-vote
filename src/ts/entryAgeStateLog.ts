/**
 * The entry-age ledger's state (entryAgeStore) over a raw-JSON store, and the writes that change it.
 *
 * Every write is one read-modify-write through the store. The app window saves behind a cache, so a change is only
 * in the stored value once its save has landed: the log keeps the changes it handed over and applies them, in
 * order, over what it reads, so a pass sees its own writes at once (and what a refresh brought in from the service).
 * Changes are idempotent, so applying one to a value that holds it already is harmless.
 *
 * What the log keeps: a change queued behind the cache until its save settles. A change that failed stays applied
 * until the next refresh that succeeds. A mark that landed (or was declined) stays too, while a failed mark is in the
 * log, so that the marks after it are made again with it in their order: a `clearPending` that landed against a
 * value which never got the `markPending` before it would otherwise be forgotten, and the replay would leave the
 * photo pending. Where the write is made before it returns (a desktop, the service, an in-memory store) a change is
 * kept only for those two reasons.
 *
 * At a refresh that succeeds, from the first failed mark on, every mark (failed, landed or still in flight) is made
 * again on the fresh value in its original order and leaves the log; an observation from there on is dropped (the next
 * fetch observes anew; an old listing replayed could drop entries the service added). Without a failed mark, failed
 * and landed changes are simply dropped.
 *
 * Logs name an error by its kind, never by its message: the message of a JSON parse error quotes the text, which
 * holds member and image ids.
 */

import type { EntryAgeRecord, RawJsonStore } from './types/stores';
import * as logger from './logger';
import { throughStore } from './settings/storeTransport';
import { isPlainObject } from './plainObject';
import { errorKind } from './errorMessage';
import { finiteOr } from './numbers';

// How many entry ids (and exact / uncertain ids) one record keeps.
export const MAX_IDS = 64;

export type StoredEntryAgeRecord = EntryAgeRecord & { uncertain: string[] };
export type State = Record<string, StoredEntryAgeRecord>;
// What a file written before the exact times held.
type LegacyEntryAgeRecord = Pick<EntryAgeRecord, 'closeTime' | 'entered'> & Partial<EntryAgeRecord>;
type Edit = (state: State) => State | null;
/** A `mark` is made again after a failure; an `observe` is not. */
type ChangeKind = 'mark' | 'observe';
type Change = {
    apply: (current: string | null) => string | null;
    failed: boolean;
    /** A mark whose own save settled, kept only while a failed mark is in the log (see createStateLog). */
    settled: boolean;
    kind: ChangeKind;
    edit: Edit;
};

/**
 * @param r - an untrusted parsed-JSON value
 */
const isRecord = (r: unknown): r is LegacyEntryAgeRecord =>
    isPlainObject(r) && Number.isFinite(r.closeTime) && isPlainObject(r.entered);

const isString = (value: unknown): value is string => typeof value === 'string';

const idList = (value: unknown): string[] => (Array.isArray(value) ? value.slice(0, MAX_IDS).filter(isString) : []);

/**
 * The ledger's state from its text. An unreadable or corrupt file reads as empty — every entry's
 * age is then unknown, which only means a boost is not held; it never blocks one. A record from a
 * file written before the exact times gets the fields it lacks, and a pending id that is not a non-empty string reads
 * as none.
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
                    pending: isString(record.pending) && record.pending !== '' ? record.pending : null,
                    uncertain: idList(record.uncertain),
                    exact: idList(record.exact),
                    memberId: typeof record.memberId === 'string' ? record.memberId : null,
                    observed: record.observed !== false,
                    firstSeen: finiteOr(record.firstSeen, 0) > 0 ? Number(record.firstSeen) : 0,
                };
            }
        }
        return state;
    } catch {
        logger.withCategory('boost').warning('entry-age ledger unreadable (not JSON)', null);
        return {};
    }
};

/**
 * @param refreshStore - re-reads the stored value where the cache can be behind it (the app window); true when it did
 */
export const createStateLog = (store: RawJsonStore, refreshStore?: () => Promise<boolean>) => {
    let changes: Change[] = [];
    store.onDiscard?.(() => {
        changes = [];
    });

    const forget = (change: Change) => {
        changes = changes.filter((c) => c !== change);
    };

    // Whether a mark whose save settled stays in the log: while a failed mark is there, the marks after it are made
    // again with it, in their order.
    const keepsLanded = (change: Change): boolean =>
        change.kind === 'mark' && changes.some((c) => c.kind === 'mark' && c.failed);

    // Makes `edit` of the stored state (answering null to change nothing); the caller never sees a failure.
    const write = (kind: ChangeKind, edit: Edit) => {
        const change: Change = {
            apply: (current) => {
                const next = edit(parseState(current));
                return next ? JSON.stringify(next) : null;
            },
            failed: false,
            settled: false,
            kind,
            edit,
        };
        const immediate = store.updateNow?.(change.apply) ?? null;
        if (immediate !== null) {
            if (immediate === 'failed') change.failed = true;
            else change.settled = true;
            if (change.failed || keepsLanded(change)) changes.push(change);
            return;
        }
        const queued = store.updateThrough !== undefined;
        if (queued) changes.push(change);
        throughStore(store, change.apply).then(
            (result) => {
                if (!queued) return;
                if (result === 'failed') change.failed = true;
                else if (keepsLanded(change)) change.settled = true;
                else forget(change);
            },
            (error: unknown) => {
                logger.withCategory('boost').warning(`entry-age ledger not written (${errorKind(error)})`, null);
                forget(change);
            },
        );
    };

    return {
        read: (): State => {
            try {
                let raw = store.readRaw();
                for (const change of changes) {
                    try {
                        raw = change.apply(raw) ?? raw;
                    } catch (error) {
                        logger
                            .withCategory('boost')
                            .warning(`entry-age change not applied (${errorKind(error)})`, null);
                    }
                }
                return parseState(raw);
            } catch (error) {
                logger
                    .withCategory('boost')
                    .warning(`entry-age ledger unreadable (read failed: ${errorKind(error)})`, null);
                return {};
            }
        },

        write,

        refresh: async (): Promise<void> => {
            if (!refreshStore) return;
            let failure = 'the read failed';
            try {
                if (await refreshStore()) {
                    // From the first failed mark on, the marks are made again on the fresh value in their order (a photo
                    // may still be missing from a lagging listing, and a forgotten pending photo would have the boost
                    // submit a second one), those still in flight too: left in the log, one would land before the
                    // replay and be undone by it. An observation is not made again: the next fetch observes anew.
                    const first = changes.findIndex((c) => c.kind === 'mark' && c.failed);
                    const replay = first === -1 ? [] : changes.slice(first).filter((c) => c.kind === 'mark');
                    const before = first === -1 ? changes : changes.slice(0, first);
                    // What is before the first failed mark: changes still in flight, and failed observations (dropped).
                    // A landed mark is only kept behind a failed one, so none is here.
                    changes = before.filter((change) => !change.failed);
                    for (const change of replay) write(change.kind, change.edit);
                    return;
                }
            } catch (error) {
                failure = errorKind(error);
            }
            logger
                .withCategory('boost')
                .warning(`entry-age ledger not refreshed (${failure}) — using the cached copy`, null);
        },
    };
};
