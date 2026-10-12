/**
 * Automatic-spend counter: how many exposure FILLS the currency automation has
 * spent on each challenge, so `autoExposureFillMax` caps them.
 *
 * Fills need their own record: exposure decays again after a fill, so without a
 * count the rule would re-fire every time exposure dropped and the pool ran dry,
 * draining the whole balance on one challenge. Swaps don't need one — the API's
 * own swap history (member.ranking.swaps) is the authoritative count — and a key
 * unlock is one-shot by nature (the boost is no longer LOCKED afterwards).
 *
 * Shape, keyed by challenge id: { "<challengeId>": { fills, at } }.
 *
 * Same platform-aware transport as swapBackStore, so on Capacitor its cache
 * MUST be hydrated at boot (initializeAutoSpendAsync, wired in Capacitor.tsx).
 * Mock mode uses createMemoryAutoSpendLedger() and never touches the file.
 */

import type { AutoSpendRecord, RawJsonStore } from './types/stores';
import * as logger from './logger';
import { createJsonStore } from './settings/storage';
import { isPlainObject } from './plainObject';
import { errorMessage } from './errorMessage';
import { storeLoaded } from './settings/storeTransport';
import * as runtime from './runtime';

// `strict`: a write the service's native bridge did not persist is a failed write: the cap is only as good as the count.
const AUTO_SPEND_KEY = 'gs_auto_spends';
// `atomic`: a crash in the middle of a write must not leave a cut-short file, which would read as untrusted for good.
const autoSpendStore = createJsonStore({
    fileName: 'autoSpends.json',
    prefKey: AUTO_SPEND_KEY,
    atomic: true,
    strict: true,
});

// What to do about a ledger that cannot be trusted: on Android it is read again every cycle; on the desktop the file
// is named, and deleting it starts the count over.
const recoveryStep = (): string =>
    runtime.isCapacitor() || runtime.isHeadlessService()
        ? 'tries again next cycle'
        : `delete ${autoSpendStore.getFilePath()} to start the fill count over`;

// Challenges run for days, not months; anything older is a finished challenge.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param r - an untrusted parsed-JSON value
 */
const isRecord = (r: unknown): r is AutoSpendRecord =>
    isPlainObject(r) && Number.isInteger(r.fills) && Number(r.fills) >= 0 && Number.isFinite(r.at);

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
    const live = (records: Record<string, unknown>): Record<string, AutoSpendRecord> => {
        const cutoff = Date.now() - MAX_AGE_MS;
        const kept: Record<string, AutoSpendRecord> = {};
        for (const [id, record] of Object.entries(records)) {
            if (isRecord(record) && record.at > cutoff) kept[id] = record;
        }
        return kept;
    };

    // Writes one challenge's count as `change` makes it; false when the ledger cannot be trusted or the write failed.
    const adjust = (challengeId: string | number, change: (fills: number) => number): boolean => {
        const records = read();
        if (!records) return false;
        const state = live(records);
        const key = String(challengeId);
        state[key] = { fills: Math.max(0, change(state[key]?.fills ?? 0)), at: Date.now() };
        try {
            store.writeRaw(JSON.stringify(state));
            return true;
        } catch (error) {
            logger.withCategory('currency').error(`auto-spend ledger not written: ${errorMessage(error)}`, null);
            return false;
        }
    };

    return {
        /**
         * Automatic fills spent on this challenge so far; unboundedly many when the ledger cannot be trusted, so that a
         * cap is never found open on a count that is not known.
         */
        fills: (challengeId: string | number): number => {
            const records = read();
            return records ? (live(records)[String(challengeId)]?.fills ?? 0) : Number.POSITIVE_INFINITY;
        },

        /**
         * Count one more automatic fill on this challenge, BEFORE it is made: a count that was not written down is a
         * fill that must not be made. False: not written, so not to be spent.
         */
        reserveFill: (challengeId: string | number): boolean => adjust(challengeId, (fills) => fills + 1),

        /** Take back a reserved fill that was not made (best effort: a count too high only holds back a fill). */
        releaseFill: (challengeId: string | number): void => {
            adjust(challengeId, (fills) => fills - 1);
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
