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
 * MUST be hydrated at boot (initializeAutoSpendAsync, wired in Capacitor.jsx).
 * Mock mode uses createMemoryAutoSpendLedger() and never touches the file.
 */

const logger = require('./logger');
const { createJsonStore } = require('./settings/storage');

const autoSpendStore = createJsonStore({ fileName: 'autoSpends.json', prefKey: 'gs_auto_spends' });

// Challenges run for days, not months; anything older is a finished challenge.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const isRecord = (r) => r && Number.isInteger(r.fills) && r.fills >= 0 && Number.isFinite(r.at);

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}). An unreadable or corrupt
 * file reads as empty — fail-soft like the swap-back ledger; the per-challenge
 * cap then restarts, which at worst allows `autoExposureFillMax` more fills.
 */
const createAutoSpendLedger = (store) => {
    const read = () => {
        try {
            const parsed = JSON.parse(store.readRaw() || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            logger.withCategory('currency').warning(`auto-spend ledger unreadable: ${error?.message || error}`, null);
            return {};
        }
    };

    return {
        /** Automatic fills spent on this challenge so far. */
        fills: (challengeId) => {
            const record = read()[String(challengeId)];
            return isRecord(record) ? record.fills : 0;
        },

        /** Count one more automatic fill on this challenge. */
        addFill: (challengeId) => {
            const cutoff = Date.now() - MAX_AGE_MS;
            const state = {};
            for (const [id, record] of Object.entries(read())) {
                if (isRecord(record) && record.at > cutoff) state[id] = record;
            }
            const key = String(challengeId);
            state[key] = { fills: (state[key]?.fills ?? 0) + 1, at: Date.now() };
            store.writeRaw(JSON.stringify(state));
        },
    };
};

/** Ledger over an in-memory store — mock mode, tests. */
const createMemoryAutoSpendLedger = () => {
    let raw = null;
    return createAutoSpendLedger({
        readRaw: () => raw,
        writeRaw: (data) => {
            raw = data;
        },
    });
};

const autoSpendLedger = createAutoSpendLedger(autoSpendStore);

module.exports = {
    autoSpendLedger,
    createAutoSpendLedger,
    createMemoryAutoSpendLedger,
    initializeAutoSpendAsync: autoSpendStore.initializeAsync,
    flushAutoSpendWrites: autoSpendStore.flushPendingWrites,
};
