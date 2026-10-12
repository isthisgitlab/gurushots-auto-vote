/**
 * The Android and Capacitor side of createJsonStore (settings/storage.ts): keyed reads and writes through the native
 * bridge of the background service, and the ordered write-behind of the app's Preferences.
 */

import * as logger from '../logger';
import type { PreferencesPlugin } from '@capacitor/preferences';
import type { AndroidHeadlessStore } from '../types/settings';

/**
 * The Android headless-service bridge, read at call time (absent everywhere
 * else).
 */
const headlessStore = (): AndroidHeadlessStore | undefined =>
    (globalThis as typeof globalThis & { AndroidHeadlessStore?: AndroidHeadlessStore }).AndroidHeadlessStore;

export const readHeadlessKey = (prefKey: string, fallback: string | null): string | null => {
    try {
        // aislop-ignore-next-line ai-slop/hidden-fallback -- an absent key is the caller's cached value; the read contract
        return headlessStore()?.readKey?.(prefKey) ?? fallback;
    } catch (err) {
        logger.withCategory('settings').error(`Headless ${prefKey} read failed:`, err);
        // aislop-ignore-next-line ai-slop/hidden-fallback -- logged via the settings logger; the caller's cached value is the read contract
        return fallback;
    }
};

/**
 * Writes one key through the native bridge. The bridge answers `false` when it did not persist the value (a
 * refused key, a value that is no JSON, a failed commit). A write that was not passes quietly, except for a `strict`
 * store, which throws, and which takes nothing but a `true` for a write that was (no bridge, or none that answers,
 * is not one).
 */
export const writeHeadlessKey = (prefKey: string, data: string, strict: boolean): void => {
    const answer = ((): boolean | void => {
        try {
            return headlessStore()?.writeKey?.(prefKey, data);
        } catch (err) {
            logger.withCategory('settings').error(`Headless ${prefKey} write failed:`, err);
            return false;
        }
    })();
    if (strict && answer !== true) throw new Error(`Headless ${prefKey} was not persisted`);
};

/**
 * The ordered write-behind of one Capacitor key: writes apply in issue order, and one that fails is logged without
 * breaking the queue. The last write holds the whole value (every write is the full text), so what a flush has to say
 * is whether THAT one persisted: an earlier failure that a later write made up for is nothing to report, and no flag is
 * left for whichever flush comes first to swallow.
 *
 * A `strict` store's flush rejects when the last write failed, and the cache is rolled back to what is known to be
 * persisted, so a value that did not reach storage is not read back, applied, or written along with a later one.
 *
 * @param rollBack - puts the store's cache back to a persisted value (null: nothing was)
 */
export const createWriteBehind = (
    prefKey: string,
    strict: boolean,
    preferences: () => PreferencesPlugin,
    rollBack: (persisted: string | null) => void,
) => {
    let chain = Promise.resolve();
    let issued = 0;
    // Whether the latest write persisted, and the text that is known to be in Preferences.
    let lastPersisted = true;
    let persisted: string | null = null;
    return {
        queue: (data: string) => {
            const mine = ++issued;
            chain = chain
                .then(() => preferences().set({ key: prefKey, value: data }))
                .then(
                    () => {
                        persisted = data;
                        if (mine === issued) lastPersisted = true;
                    },
                    (err) => {
                        logger.withCategory('settings').error(`Capacitor ${prefKey} write failed:`, err);
                        if (mine !== issued) return;
                        lastPersisted = false;
                        if (strict) rollBack(persisted);
                    },
                );
        },
        /** What hydrating or refreshing found in Preferences: that is what is persisted. */
        confirm: (value: string | null) => {
            persisted = value;
        },
        drained: () => chain,
        flush: async () => {
            await chain;
            if (strict && !lastPersisted) throw new Error(`Capacitor ${prefKey} was not persisted`);
        },
    };
};
export { headlessStore };
