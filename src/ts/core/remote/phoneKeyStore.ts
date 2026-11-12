/**
 * The Android remote mode's stored pairing key: one Preferences key (`gs_remote_access`, in
 * LOCAL_DATA_STORES, so the wipe clears it), read, written and cleared through the native
 * bridge's `nativePromise` — the one call every document of the app's WebView has, so the app's
 * own document and the bundled remote page (whose bundle registers no Capacitor plugin) share
 * this code. Dependency-free apart from the key's shape.
 */

import { ANDROID_PAIRING_KEY_PREF } from './pairingKey';

import type { CapacitorGlobals } from '../types/capacitor';

/** What reading the stored key came to: the current key, none stored, or an invalid stored value. */
export type StoredKey = { kind: 'key'; key: string } | { kind: 'none' } | { kind: 'invalid' };

const STORED_KEY_PATTERN = /^2:([A-Za-z0-9_-]{43})$/;

const nativeCall = (method: 'get' | 'set' | 'remove', options: object): Promise<unknown> => {
    const call = (globalThis as CapacitorGlobals).Capacitor?.nativePromise;
    if (typeof call !== 'function') {
        return Promise.reject(new Error('No native bridge to reach the app preferences'));
    }
    return call('Preferences', method, options);
};

/**
 * The stored pairing key. Rejects when the native read fails: the caller decides what an unknown
 * state means. A stored value that does not read as a key is `invalid`, not `none` — it is said, not
 * hidden.
 */
export const readStoredKey = async (): Promise<StoredKey> => {
    const answer = await nativeCall('get', { key: ANDROID_PAIRING_KEY_PREF });
    const value = (answer as { value?: unknown } | null)?.value;
    if (value === undefined || value === null) return { kind: 'none' };
    if (typeof value !== 'string') return { kind: 'invalid' };
    const key = STORED_KEY_PATTERN.exec(value)?.[1];
    return key === undefined ? { kind: 'invalid' } : { kind: 'key', key };
};

/** Stores the canonical current pairing key; rejects when the write fails. */
export const storeKey = async (key: string): Promise<void> => {
    await nativeCall('set', { key: ANDROID_PAIRING_KEY_PREF, value: `2:${key}` });
};

/** Clears the stored pairing key; rejects when that fails. */
export const clearStoredKey = async (): Promise<void> => {
    await nativeCall('remove', { key: ANDROID_PAIRING_KEY_PREF });
};
