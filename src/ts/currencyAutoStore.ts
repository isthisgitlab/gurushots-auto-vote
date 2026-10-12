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

// `strict`: a write the service's native bridge did not persist is a failed write: the cap is only as good as the count.
const AUTO_SPEND_KEY = 'gs_auto_spends';
const autoSpendStore = createJsonStore({ fileName: 'autoSpends.json', prefKey: AUTO_SPEND_KEY, strict: true });

// Challenges run for days, not months; anything older is a finished challenge.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param r - an untrusted parsed-JSON value
 */
const isRecord = (r: unknown): r is AutoSpendRecord =>
    isPlainObject(r) && Number.isInteger(r.fills) && Number(r.fills) >= 0 && Number.isFinite(r.at);

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}). A corrupt file reads as
 * empty — the per-challenge cap then restarts, which at worst allows
 * `autoExposureFillMax` more fills — but a store that could not be read at all
 * (`isLoaded` false) is not an empty one: the count is unknown, and nothing is
 * spent against it.
 *
 * @param isLoaded - whether the store holds what is saved (see storeLoaded)
 */
const createAutoSpendLedger = (store: RawJsonStore, isLoaded: () => boolean = () => true) => {
    // The ledger as it is now; null when it cannot be trusted (the store was never loaded).
    const read = (): Record<string, unknown> | null => {
        let records: Record<string, unknown> = {};
        try {
            const parsed: unknown = JSON.parse(store.readRaw() || '{}');
            if (isPlainObject(parsed)) records = parsed;
        } catch (error) {
            logger
                .withCategory('currency')
                .warning(`auto-spend ledger unreadable: ${errorMessage(error) || error}`, null);
        }
        return isLoaded() ? records : null;
    };

    // Writes one challenge's count as `change` makes it; false when the ledger cannot be trusted or the write failed.
    const adjust = (challengeId: string | number, change: (fills: number) => number): boolean => {
        const records = read();
        if (!records) return false;
        const cutoff = Date.now() - MAX_AGE_MS;
        const state: Record<string, AutoSpendRecord> = {};
        for (const [id, record] of Object.entries(records)) {
            if (isRecord(record) && record.at > cutoff) state[id] = record;
        }
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
            if (!records) return Number.POSITIVE_INFINITY;
            const record = records[String(challengeId)];
            return isRecord(record) ? record.fills : 0;
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

const autoSpendLedger = createAutoSpendLedger(autoSpendStore, () => storeLoaded(AUTO_SPEND_KEY));

export const initializeAutoSpendAsync = autoSpendStore.initializeAsync;
export const flushAutoSpendWrites = autoSpendStore.flushPendingWrites;
export { autoSpendLedger, createAutoSpendLedger, createMemoryAutoSpendLedger };
