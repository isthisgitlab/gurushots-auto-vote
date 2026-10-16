/**
 * Automatic-spend counter: how many exposure FILLS the currency automation has
 * spent on each challenge, so `autoExposureFillMax` caps them, and on each
 * "Use Fill" mission (under `mission:<id>`), so a mission that a fill does not
 * move is not filled for on every pass.
 *
 * Fills need their own record: exposure decays again after a fill, so without a
 * count the rule would re-fire every time exposure dropped and the pool ran dry,
 * draining the whole balance on one challenge. Swaps don't need one — the API's
 * own swap history (member.ranking.swaps) is the authoritative count — and a key
 * unlock is one-shot by nature (the boost is no longer LOCKED afterwards).
 *
 * Shape, keyed by challenge id: { "<challengeId>": { fills, at } }; a mission's record also holds `progress`, the
 * mission's server progress when its latest fill was counted, and `before`, the progress the record held when that
 * fill was reserved (null: none), which a fill that is not made puts back.
 *
 * Same platform-aware transport as swapBackStore, so on Capacitor its cache
 * MUST be hydrated at boot (initializeAutoSpendAsync, wired in Capacitor.tsx).
 * Mock mode uses createMemoryAutoSpendLedger() and never touches the file.
 */

import type { AutoSpendRecord, RawJsonStore, ThroughResult } from './types/stores';
import * as logger from './logger';
import { createJsonStore } from './settings/storage';
import { isPlainObject } from './plainObject';
import { fileErrorMessage } from './errorMessage';
import { storeLoaded, throughStore } from './settings/storeTransport';
import * as runtime from './runtime';

// `strict`: a write the service's native bridge did not persist is a failed write: the cap is only as good as the count.
const AUTO_SPEND_KEY = 'gs_auto_spends';
// `atomic`: a crash in the middle of a write must not leave a cut-short file, which would read as untrusted for good.
// `shared`: the app window and the background service both count fills, and each count is saved by the native
// compare-and-write, so that neither erases the other's.
const autoSpendStore = createJsonStore({
    fileName: 'autoSpends.json',
    prefKey: AUTO_SPEND_KEY,
    atomic: true,
    strict: true,
    shared: true,
});

// What to do about a ledger that cannot be trusted: on Android it is read again every cycle; on the desktop the file
// is named, and deleting it starts the count over.
const recoveryStep = (): string =>
    runtime.isCapacitor() || runtime.isHeadlessService()
        ? 'tries again next cycle'
        : `delete ${autoSpendStore.getFilePath()} to start the fill count over`;

// Challenges run for days, not months; anything older is a finished challenge.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A ledger record: the fills counted, and for a mission the progress it had when the latest was. */
type AutoSpendEntry = AutoSpendRecord & { progress?: number; before?: number | null };

/** What `reserveFill` holds the count to, and records. */
type ReserveOptions = {
    /** refuse once this many are counted, as the count stands when the write is made */
    max?: number;
    /** the mission's progress when this fill is counted */
    progress?: number;
};

// The progress a record goes back to when a reserved fill is not made, as that reservation recorded it; a record
// without one (no progress was reserved) keeps what it has. Worked out on the record the write replaces.
const restoredProgress = (record: AutoSpendEntry | undefined) => {
    const progress = record?.before === undefined ? record?.progress : (record.before ?? undefined);
    return progress === undefined ? {} : { progress };
};

/**
 * @param r - an untrusted parsed-JSON value
 */
const isRecord = (r: unknown): r is AutoSpendEntry =>
    isPlainObject(r) &&
    Number.isInteger(r.fills) &&
    Number(r.fills) >= 0 &&
    Number.isFinite(r.at) &&
    (r.progress === undefined || Number.isFinite(r.progress)) &&
    (r.before === undefined || r.before === null || Number.isFinite(r.before));

/**
 * The ledger's text as its records, or null when it is not a JSON object (a store never written is an empty ledger).
 */
const parseRecords = (raw: string | null): Record<string, unknown> | null => {
    try {
        const parsed: unknown = raw === null ? {} : JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}). A ledger that was never written is empty; one that cannot be
 * trusted is not: a value that is not a JSON object, or a store that could not be read at all (`isLoaded` false),
 * means the count is unknown, and no fill is spent against it — nor is it written over, so what is there stays for
 * whoever can read it. A record older than the age a challenge lives to does not count.
 *
 * @param isLoaded - whether the store holds what is saved (see storeLoaded)
 * @param recovery - what the user can do about a ledger that cannot be trusted, said in the log
 */
const createAutoSpendLedger = (
    store: RawJsonStore,
    isLoaded: () => boolean = () => true,
    recovery: () => string = () => 'tries again next cycle',
) => {
    // Said once each time the ledger stops being trustworthy: the fills stop without a word otherwise.
    let said = false;
    // The ledger as it is now; null when it cannot be trusted.
    const read = (): Record<string, unknown> | null => {
        let records: Record<string, unknown> | null = null;
        let reason = 'could not be read';
        try {
            const raw = store.readRaw();
            const parsed: unknown = raw === null ? {} : JSON.parse(raw);
            if (isPlainObject(parsed)) records = parsed;
            else reason = 'is not a JSON object';
        } catch (error) {
            // The message of a parse error can quote the text: its name is all that is logged.
            reason = `is not valid JSON (${error instanceof Error ? error.name : 'unparseable'})`;
        }
        const trusted = records !== null && isLoaded();
        if (trusted) said = false;
        else if (!said) {
            said = true;
            logger
                .withCategory('currency')
                .warning(`auto-spend ledger ${reason} — no automatic fills until it can be read (${recovery()})`, null);
        }
        return trusted ? records : null;
    };

    // The records that still count: a challenge older than this is finished.
    const live = (records: Record<string, unknown>): Record<string, AutoSpendEntry> => {
        const cutoff = Date.now() - MAX_AGE_MS;
        const kept: Record<string, AutoSpendEntry> = {};
        for (const [id, record] of Object.entries(records)) {
            if (isRecord(record) && record.at > cutoff) kept[id] = record;
        }
        return kept;
    };

    // The record of one key as it is stored now; null when the ledger cannot be trusted.
    const entryOf = (key: string | number): AutoSpendEntry | undefined | null => {
        const records = read();
        return records ? live(records)[String(key)] : null;
    };

    // Writes one key's record as `change` makes it, on the ledger as it is when the write is made (through the store's
    // `updateThrough`: on Android by the native compare-and-write, so a count the other context saved is not erased,
    // and the change is made again on it); `change` answers null to write nothing. False when the ledger cannot be
    // trusted, `change` declined or the write failed.
    const adjust = async (
        challengeId: string | number,
        change: (record: AutoSpendEntry | undefined) => Omit<AutoSpendEntry, 'at'> | null,
    ): Promise<boolean> => {
        if (!read()) return false;
        const key = String(challengeId);
        // Worked out once: the update may be made again on a newer value.
        const at = Date.now();
        let result: ThroughResult;
        try {
            result = await throughStore(store, (current) => {
                const records = parseRecords(current);
                if (!records) return null;
                const state = live(records);
                const next = change(state[key]);
                if (!next) return null;
                state[key] = { ...next, at };
                return JSON.stringify(state);
            });
        } catch (error) {
            logger.withCategory('currency').error(`auto-spend ledger not written: ${fileErrorMessage(error)}`, null);
            return false;
        }
        if (result === 'failed') logger.withCategory('currency').error('auto-spend ledger not written', null);
        return result === 'saved';
    };

    return {
        /**
         * Automatic fills spent on this challenge so far; unboundedly many when the ledger cannot be trusted, so that a
         * cap is never found open on a count that is not known.
         */
        fills: (challengeId: string | number): number => {
            const entry = entryOf(challengeId);
            return entry === null ? Number.POSITIVE_INFINITY : (entry?.fills ?? 0);
        },

        /** The progress a mission had when its latest fill was counted; null when there is none, or none to trust. */
        lastProgress: (challengeId: string | number): number | null => entryOf(challengeId)?.progress ?? null,

        /**
         * Count one more automatic fill on this challenge, BEFORE it is made: a count that was not written down is a
         * fill that must not be made. With `max` the count is held to it where it is written, not where it was read:
         * one that has reached it is not counted. False: not counted, so not to be spent.
         */
        reserveFill: (challengeId: string | number, { max, progress }: ReserveOptions = {}): Promise<boolean> =>
            adjust(challengeId, (record) => {
                const fills = record?.fills ?? 0;
                if (max !== undefined && fills >= max) return null;
                if (progress === undefined) {
                    // Nothing new to record: what the record holds is what a release of this one goes back to.
                    return {
                        fills: fills + 1,
                        ...(record?.progress === undefined
                            ? {}
                            : { progress: record.progress, before: record.progress }),
                    };
                }
                return { fills: fills + 1, progress, before: record?.progress ?? null };
            }),

        /**
         * Take back a reserved fill that was not made (best effort: a count too high only holds back a fill). A
         * mission's record goes back to the progress it held before the reservation, so a fill that was not made does
         * not leave the progress it was reserved at behind.
         */
        releaseFill: async (challengeId: string | number): Promise<void> => {
            await adjust(challengeId, (record) => ({
                fills: Math.max(0, (record?.fills ?? 0) - 1),
                ...restoredProgress(record),
            }));
        },

        /**
         * Put a mission's recorded progress back to what it was before the latest reservation, the fills counted as
         * they are: for a fill that got no answer, which stays counted, but whose reserved progress says nothing about
         * whether it moved the mission.
         */
        restoreProgress: async (challengeId: string | number): Promise<void> => {
            await adjust(challengeId, (record) =>
                record ? { fills: record.fills, ...restoredProgress(record) } : null,
            );
        },
    };
};

/** Ledger over an in-memory store — mock mode, tests. */
const createMemoryAutoSpendLedger = () => {
    let raw: string | null = null;
    return createAutoSpendLedger({
        readRaw: () => raw,
        writeRaw: (data) => {
            raw = data;
        },
    });
};

const autoSpendLedger = createAutoSpendLedger(autoSpendStore, () => storeLoaded(AUTO_SPEND_KEY), recoveryStep);

export const initializeAutoSpendAsync = autoSpendStore.initializeAsync;
// The window flushes on teardown without waiting on the answer: a write that did not persist is logged here, not left
// as a rejection nobody handles.
export const flushAutoSpendWrites = (): Promise<void> =>
    autoSpendStore.flushPendingWrites().catch(() => {
        logger.withCategory('settings').error('auto-spend writes were not persisted', null);
    });
export { autoSpendLedger, createAutoSpendLedger, createMemoryAutoSpendLedger };
