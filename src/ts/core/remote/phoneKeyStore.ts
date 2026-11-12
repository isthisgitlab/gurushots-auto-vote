/**
 * The Android remote mode's stored pairing key: one Preferences key (`gs_remote_access`, in
 * LOCAL_DATA_STORES, so the wipe clears it), read, written and cleared through the native
 * bridge's `nativePromise` — the one call every document of the app's WebView has, so the app's
 * own document and the bundled remote page (whose bundle registers no Capacitor plugin) share
 * this code. Dependency-free apart from the key's shape.
 */

import { ANDROID_PAIRING_KEY_PREF, isPairingKey } from './pairingKey';

import type { CapacitorGlobals } from '../types/capacitor';

/** What reading the stored key came to: the key, none stored, or a stored value that is not a key. */
export type StoredKey = { kind: 'key'; key: string; linkVersion: number } | { kind: 'none' } | { kind: 'invalid' };

const STORED_TARGET_PATTERN = /^([1-9]\d{0,2}):([A-Za-z0-9_-]{43})$/;

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
    if (isPairingKey(value)) return { kind: 'key', key: value, linkVersion: 1 };
    const target = STORED_TARGET_PATTERN.exec(value);
    return target === null ? { kind: 'invalid' } : { kind: 'key', key: target[2]!, linkVersion: Number(target[1]) };
};

/** Stores a canonical versioned pairing target; rejects when the write fails. */
export const storeKey = async (key: string, linkVersion: number): Promise<void> => {
    await nativeCall('set', { key: ANDROID_PAIRING_KEY_PREF, value: `${linkVersion}:${key}` });
};

/** Clears the stored pairing key; rejects when that fails. */
export const clearStoredKey = async (): Promise<void> => {
    await nativeCall('remove', { key: ANDROID_PAIRING_KEY_PREF });
};
