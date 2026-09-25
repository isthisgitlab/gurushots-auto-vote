/**
 * Swap-back ledger: which entry slots currently hold a replacement for a photo
 * that was swapped out while boosted or turbo'd.
 *
 * A boost/turbo belongs to the PHOTO, not the slot: swapping a boosted photo
 * out leaves the replacement without it (and the boost can't be used again in
 * that challenge), while swapping the original back in restores it. The API's
 * swap history (member.ranking.swaps) carries no boost/turbo flag, so the app
 * records it itself at swap time — which also means only swaps made through
 * this app are known here.
 *
 * Shape, keyed by challenge id:
 *   { "<challengeId>": [{ currentId, previousId, previousMemberId, kind, at }] }
 *   currentId  - the photo now in the slot (moves along if it is swapped again)
 *   previousId - the boosted/turbo'd original to swap back in
 *   kind       - 'boost' | 'turbo'
 *
 * Uses the same platform-aware transport as joinState/metadata, so on
 * Capacitor its cache MUST be hydrated at boot (initializeSwapBackAsync, wired
 * in Capacitor.jsx). Mock mode uses createMemoryLedger() and never touches the
 * persisted file.
 */

const logger = require('./logger');
const { createJsonStore } = require('./settings/storage');

const swapBackStore = createJsonStore({ fileName: 'swapBacks.json', prefKey: 'gs_swap_backs' });

// Challenges run for days, not months; anything older is a finished challenge.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const isRecord = (r) =>
    r &&
    typeof r.currentId === 'string' &&
    typeof r.previousId === 'string' &&
    (r.kind === 'boost' || r.kind === 'turbo');

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}). An unreadable or corrupt
 * file reads as empty — losing a swap-back offer is harmless, the original can
 * still be swapped back on gurushots.com.
 */
const createLedger = (store) => {
    const read = () => {
        try {
            const parsed = JSON.parse(store.readRaw() || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            logger.withCategory('currency').warning(`swap-back ledger unreadable: ${error?.message || error}`, null);
            return {};
        }
    };

    const write = (state) => {
        const cutoff = Date.now() - MAX_AGE_MS;
        const pruned = {};
        for (const [challengeId, records] of Object.entries(state)) {
            const kept = (Array.isArray(records) ? records : []).filter((r) => isRecord(r) && r.at > cutoff);
            if (kept.length > 0) pruned[challengeId] = kept;
        }
        store.writeRaw(JSON.stringify(pruned));
    };

    const recordsOf = (state, challengeId) =>
        (Array.isArray(state[String(challengeId)]) ? state[String(challengeId)] : []).filter(isRecord);

    return {
        /** Swap-back records for one challenge. */
        list: (challengeId) => recordsOf(read(), challengeId),

        /**
         * Update the ledger after `oldEntry` was swapped for `newId`: a record
         * pointing at the old photo follows the slot to the new one, and a
         * boosted/turbo'd old photo starts a new record.
         */
        onSwapped: (challengeId, oldEntry, newId) => {
            const state = read();
            const key = String(challengeId);
            const oldId = String(oldEntry?.id);
            const records = recordsOf(state, key)
                .map((r) => (r.currentId === oldId ? { ...r, currentId: String(newId), at: Date.now() } : r))
                // A plain swap put the original back in its slot: nothing left to swap back.
                .filter((r) => r.currentId !== r.previousId);
            const kind = oldEntry?.boosted === true ? 'boost' : oldEntry?.turbo ? 'turbo' : null;
            if (kind) {
                records.push({
                    currentId: String(newId),
                    previousId: oldId,
                    previousMemberId: String(oldEntry?.member_id ?? ''),
                    kind,
                    at: Date.now(),
                });
            }
            state[key] = records;
            write(state);
        },

        /** Drop the record for the slot now holding `currentId` (after a swap back). */
        remove: (challengeId, currentId) => {
            const state = read();
            const key = String(challengeId);
            state[key] = recordsOf(state, key).filter((r) => r.currentId !== String(currentId));
            write(state);
        },
    };
};

/** Ledger over an in-memory store — mock mode, tests. */
const createMemoryLedger = () => {
    let raw = null;
    return createLedger({
        readRaw: () => raw,
        writeRaw: (data) => {
            raw = data;
        },
    });
};

const swapBackLedger = createLedger(swapBackStore);

// Process-wide in-memory ledger for mock mode, shared by the manual swap
// handlers and the mock voting pass so a mock automatic swap is offered for
// swap-back exactly like a real one.
const mockSwapBackLedger = createMemoryLedger();

module.exports = {
    swapBackLedger,
    mockSwapBackLedger,
    createLedger,
    createMemoryLedger,
    initializeSwapBackAsync: swapBackStore.initializeAsync,
    flushSwapBackWrites: swapBackStore.flushPendingWrites,
};
