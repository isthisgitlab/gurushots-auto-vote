/**
 * The headless family's storage member: the AndroidHeadlessStore bridge the
 * background service's stores persist through (settings/storeTransport.ts).
 * The bridge is a globalThis read made at call time — headlessStore() reads
 * it on every call, and so does every member here. The per-key memory cache
 * the branch keeps (a key the native store does not persist retains its
 * per-cycle cache) is kept here too.
 *
 * There is no Capacitor plugin on the bare service WebView, and no compare-
 * and-write of its own: the service writes through the bridge's pair, and a
 * shared key's change is the keyed compare-and-write (headlessUpdate).
 */

import type { PlatformStorage } from '../../platform/port';

type StoreTransportModule = typeof import('../../settings/storeTransport');

// Reached at call time: the setup file loads the helpers that import this
// family, so an import-time module graph (storeTransport's runtime and
// logger, which reach node:path and node:os and the fs) lands in the setup's
// registry before a test file registers its own mocks
// (platforms/node/index.ts states the reason in full).
const storeTransport = (): StoreTransportModule => require('../../settings/storeTransport') as StoreTransportModule;

const createHeadlessStorage = (): PlatformStorage => {
    // The per-key cache the reads answer while the bridge has no value for the
    // key, and what a write leaves behind (the branch's cachedJson).
    const caches = new Map<string, string | null>();
    return {
        // The bridge read (jsonStore readRaw's headless branch): an absent key answers the cache, and a read that
        // failed is remembered (readFailed). The strict store's throw stays with the factory, which owns the flag.
        readRaw: (store) => storeTransport().readHeadlessKey(store.prefKey, caches.get(store.prefKey) ?? null, false),
        // The bridge write (jsonStore writeRaw's headless branch): only a write that is confirmed is read back, so
        // the cache takes it after the write.
        writeRaw: (store, data) => {
            storeTransport().writeHeadlessKey(store.prefKey, data, false);
            caches.set(store.prefKey, data);
        },
        // The import write through the keyed compare-and-write (headlessUpdate): the value is saved only while
        // nothing is stored, and the other context's text means it saved the import first (`exists`, with what
        // is stored). There is no queued write to land, so the answer is final.
        writeIfAbsent: (store, data) => {
            const result = storeTransport().headlessUpdate(store.prefKey, (current) =>
                current === null ? data : null,
            );
            if (result === 'saved') {
                caches.set(store.prefKey, data);
                return { outcome: 'saved' };
            }
            if (result === 'aborted') {
                return { outcome: 'exists', current: storeTransport().readHeadlessKey(store.prefKey, null, false) };
            }
            return { outcome: 'failed' };
        },
        location: (store) => store.prefKey,
        // The service cannot see a backup key (hasQuarantinedMethod's headless branch).
        hasQuarantined: () => false,
        // The service cannot set an unusable settings value aside
        // (quarantineRawMethod's headless branch, its own answer): the caller refuses to save.
        quarantineRaw: () => ({
            ok: false,
            error: 'the background service cannot set an unusable settings value aside',
        }),
        // A read is the bridge read itself (peekStored answers readRaw here): no separate re-read, and no plugin.
        storedKey: null,
        preferences: null,
        headlessStore: () => storeTransport().headlessStore(),
        cas: null,
        sharedUpdate: (key, update) => storeTransport().headlessUpdate(key, update),
        readFailed: (key) => storeTransport().headlessReadFailed(key),
        loaded: (key) => storeTransport().storeLoaded(key),
        // The writes go through the bridge synchronously: nothing queued to wait for.
        flushed: async () => undefined,
        // No settings file lock: the native compare-and-write of each key decides.
        lockPolicy: 'none',
    };
};

export { createHeadlessStorage };
