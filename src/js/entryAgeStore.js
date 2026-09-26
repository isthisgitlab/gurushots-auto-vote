// @ts-check
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
 *   { "<challengeId>": { closeTime, entered: { "<imageId>": unixSec }, pending } }
 * An `entered` time of 0 means "already there when the app first saw the
 * challenge" — its age is unknown, so it never holds a boost.
 *
 * Same platform-aware transport as currencyAutoStore, so on Capacitor its cache
 * MUST be hydrated at boot (initializeEntryAgesAsync, wired in Capacitor.jsx).
 * Mock mode uses createMemoryEntryAgeLedger() and never touches the file.
 */

/** @import { EntryAgeRecord, RawJsonStore } from './types/stores' */
/** @import { Challenge } from './types/gurushots' */
import * as logger from './logger';
import { createJsonStore } from './settings/storage';

const entryAgeStore = createJsonStore({ fileName: 'entryAges.json', prefKey: 'gs_entry_ages' });

// How long a pending fill-new photo may be missing from the challenge listing
// before it counts as not entered. Covers listing lag after a submit; past it, a
// submit that never landed stops blocking the boost.
const PENDING_GRACE_SEC = 600;

/**
 * @param {any} r - an untrusted parsed-JSON value
 * @returns {r is EntryAgeRecord}
 */
const isRecord = (r) =>
    r && Number.isFinite(r.closeTime) && r.entered && typeof r.entered === 'object' && !Array.isArray(r.entered);

/** @param {Challenge} challenge @returns {string[]} */
const entryIdsOf = (challenge) =>
    (Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries : [])
        .map((entry) => entry?.id)
        .filter((id) => id !== undefined && id !== null && id !== '')
        .map(String);

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}). An unreadable or corrupt
 * file reads as empty — every entry's age is then unknown, which only means a
 * boost is not held; it never blocks one.
 * @param {RawJsonStore} store
 */
const createEntryAgeLedger = (store) => {
    /** @returns {Record<string, EntryAgeRecord>} */
    const read = () => {
        try {
            const parsed = JSON.parse(store.readRaw() || '{}');
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            /** @type {Record<string, EntryAgeRecord>} */
            const state = {};
            for (const [id, record] of Object.entries(parsed)) {
                if (isRecord(record)) state[id] = record;
            }
            return state;
        } catch (error) {
            logger
                .withCategory('boost')
                .warning(
                    `entry-age ledger unreadable: ${/** @type {Error | undefined} */ (error)?.message || error}`,
                    null,
                );
            return {};
        }
    };

    /**
     * Write `record` for `challengeId`, dropping every challenge that has closed.
     * @param {Record<string, EntryAgeRecord>} state
     * @param {string} challengeId
     * @param {EntryAgeRecord} record
     * @param {number} now - Unix seconds
     */
    const write = (state, challengeId, record, now) => {
        /** @type {Record<string, EntryAgeRecord>} */
        const next = {};
        for (const [id, existing] of Object.entries(state)) {
            if (existing.closeTime > now) next[id] = existing;
        }
        next[challengeId] = record;
        store.writeRaw(JSON.stringify(next));
    };

    return {
        /**
         * Record the current entries of `challenge`: an id seen for the first time
         * is stamped `now` (or 0 on the challenge's first sighting), an id no longer
         * entered is forgotten. Writes only when something changed.
         * @param {Challenge} challenge
         * @param {number} now - Unix seconds
         */
        observe: (challenge, now) => {
            const challengeId = String(challenge?.id ?? '');
            if (!challengeId) return;
            const state = read();
            const existing = state[challengeId];
            const ids = entryIdsOf(challenge);
            /** @type {Record<string, number>} */
            const entered = {};
            for (const id of ids) {
                const known = existing?.entered[id];
                entered[id] = Number.isFinite(known) ? known : existing ? now : 0;
            }
            // The listing can lag a submit, so a pending photo missing from this poll
            // is kept (with its entry time) for PENDING_GRACE_SEC — dropping it at once
            // would make the next boost fill-new submit a second photo.
            const pendingAt = existing?.pending ? existing.entered[existing.pending] : undefined;
            const keepPending =
                existing?.pending != null &&
                (ids.includes(existing.pending) ||
                    (Number.isFinite(pendingAt) && now - Number(pendingAt) <= PENDING_GRACE_SEC));
            const pending = keepPending ? /** @type {string} */ (existing?.pending) : null;
            if (pending && !(pending in entered)) entered[pending] = Number(pendingAt);
            const unchanged =
                existing &&
                existing.pending === pending &&
                Object.keys(existing.entered).length === Object.keys(entered).length &&
                Object.keys(entered).every((id) => existing.entered[id] === entered[id]);
            if (unchanged) return;
            write(state, challengeId, { closeTime: Number(challenge.close_time), entered, pending }, now);
        },

        /**
         * When the entry entered the challenge (Unix seconds), 0 when that is
         * unknown, null when the entry isn't recorded.
         * @param {string|number} challengeId
         * @param {string|number} imageId
         * @returns {number|null}
         */
        enteredAt: (challengeId, imageId) => {
            const at = read()[String(challengeId)]?.entered[String(imageId)];
            return Number.isFinite(at) ? /** @type {number} */ (at) : null;
        },

        /**
         * The photo a boost fill-new submitted and is waiting to boost, if any.
         * @param {string|number} challengeId
         * @returns {string|null}
         */
        pending: (challengeId) => read()[String(challengeId)]?.pending ?? null,

        /**
         * Record a photo a boost fill-new just submitted: entered `now`, and the
         * one the boost is waiting on.
         * @param {Challenge} challenge
         * @param {string|number} imageId
         * @param {number} now - Unix seconds
         */
        markPending: (challenge, imageId, now) => {
            const challengeId = String(challenge.id);
            const state = read();
            const entered = { ...(state[challengeId]?.entered ?? {}), [String(imageId)]: now };
            write(
                state,
                challengeId,
                { closeTime: Number(challenge.close_time), entered, pending: String(imageId) },
                now,
            );
        },

        /**
         * The boost landed (or gave up): stop waiting on a pending photo.
         * @param {string|number} challengeId
         * @param {number} now - Unix seconds
         */
        clearPending: (challengeId, now) => {
            const state = read();
            const record = state[String(challengeId)];
            if (!record?.pending) return;
            write(state, String(challengeId), { ...record, pending: null }, now);
        },
    };
};

/** Ledger over an in-memory store — mock mode, tests. */
const createMemoryEntryAgeLedger = () => {
    /** @type {string | null} */
    let raw = null;
    return createEntryAgeLedger({
        readRaw: () => raw,
        writeRaw: (data) => {
            raw = data;
        },
    });
};

const entryAgeLedger = createEntryAgeLedger(entryAgeStore);

export const initializeEntryAgesAsync = entryAgeStore.initializeAsync;
export const flushEntryAgeWrites = entryAgeStore.flushPendingWrites;
export { entryAgeLedger, createEntryAgeLedger, createMemoryEntryAgeLedger };
