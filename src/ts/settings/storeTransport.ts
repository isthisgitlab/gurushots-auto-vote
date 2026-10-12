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
 * breaking the queue. A `strict` store's flush also tells the caller about a write that failed since the last flush.
 */
export const createWriteBehind = (prefKey: string, strict: boolean, preferences: () => PreferencesPlugin) => {
    let chain = Promise.resolve();
    // The error of the last write that failed, until a flush reports it.
    let failed: unknown = null;
    return {
        queue: (data: string) => {
            chain = chain
                .then(() => preferences().set({ key: prefKey, value: data }))
                .catch((err) => {
                    logger.withCategory('settings').error(`Capacitor ${prefKey} write failed:`, err);
                    failed = err;
                });
        },
        drained: () => chain,
        flush: async () => {
            await chain;
            const cause = failed;
            failed = null;
            if (strict && cause !== null) throw new Error(`Capacitor ${prefKey} was not persisted`, { cause });
        },
    };
};
export { headlessStore };
