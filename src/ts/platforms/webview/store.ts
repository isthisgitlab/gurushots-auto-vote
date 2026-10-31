/**
 * The webview family's storage member: the Preferences write-behind the app
 * WebView's stores persist through. The Capacitor branch of the store
 * factories (jsonStore.ts, settingsFileMethods.ts) answers a per-store cache
 * synchronously and saves through the ordered write-behind of
 * settings/storeTransport.ts (createWriteBehind), over the plugin
 * settings/capacitorPreferences.ts reaches; this member composes the same
 * pieces per key. The per-file write protocol's own state (the staged cache,
 * the dropped-save reporting) stays with the factories until Phase 3 moves
 * the bodies, so the members that need it answer the branch's neutral value.
 *
 * The native compare-and-write (`cas`) is not built here: the bridge it calls
 * is shell code (services/NativeAutovoteBridge.ts), so the shell module that
 * builds the webview platform passes it in (createWebviewPlatform's parts).
 *
 * The wrapped modules are reached at call time: the node project's setup file
 * loads the test helpers that import this family, so a module graph loaded at
 * import time would land in the setup's registry before a test file
 * registers its own mocks, and the test's factory would lose to the cached
 * module (platforms/node/index.ts states the reason in full).
 */

import type { QueuedWriteOutcome } from '../../settings/storageTypes';
import type { PlatformCas, PlatformStorage } from '../../platform/port';

type CapacitorPreferencesModule = typeof import('../../settings/capacitorPreferences');
type StoreTransportModule = typeof import('../../settings/storeTransport');
type SettingsFileCapacitorModule = typeof import('../../settings/settingsFileCapacitor');

// See the header for the mock-ordering reason the modules are reached at call time.
const capacitorPreferences = (): CapacitorPreferencesModule =>
    require('../../settings/capacitorPreferences') as CapacitorPreferencesModule;
const storeTransport = (): StoreTransportModule => require('../../settings/storeTransport') as StoreTransportModule;
const settingsFileCapacitor = (): SettingsFileCapacitorModule =>
    require('../../settings/settingsFileCapacitor') as SettingsFileCapacitorModule;

type WriteBehind = ReturnType<StoreTransportModule['createWriteBehind']>;

// The time a value was set aside, as part of the name it is kept under
// (settingsFileMethods setAsideStamp).
const setAsideStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

const createWebviewStorage = (cas: PlatformCas | null): PlatformStorage => {
    // The per-key cache the synchronous reads answer, and the per-key
    // write-behind that saves it (the Capacitor branch keeps both per store;
    // here the key is the store's Preferences key).
    const caches = new Map<string, string | null>();
    const writes = new Map<string, WriteBehind>();
    const writeBehindOf = (key: string): WriteBehind => {
        let write = writes.get(key);
        if (!write) {
            write = storeTransport().createWriteBehind(
                key,
                // A strict store's flush rejection is the factory's (it owns the flag); the transport only waits.
                false,
                () => capacitorPreferences().getCapacitorPreferences(),
                {
                    get: () => caches.get(key) ?? null,
                    set: (value) => {
                        caches.set(key, value);
                    },
                },
                // The write-behind's compare-and-write is the key's own (jsonStore builds it the same way
                // from the shell's bridge): the shell's cas names the key.
                cas ? (expected, data) => cas(key, expected, data) : undefined,
            );
            writes.set(key, write);
        }
        return write;
    };
    return {
        // The Capacitor branch answers the cache: a synchronous read never waits on the plugin.
        readRaw: (store) => caches.get(store.prefKey) ?? null,
        // `atomic` has no file to sweep on the WebView: the write is the cache plus a queued one.
        writeRaw: (store, data) => {
            caches.set(store.prefKey, data);
            writeBehindOf(store.prefKey).queue(data);
        },
        // The import write (writeIfAbsentMethod's Capacitor branch): saved through the write-behind only while
        // nothing is stored — the compare-and-write (`cas`, the shell's) decides which of the two Android contexts
        // was first. The branch shows the import in the cache at once and answers `saved` with a `landed`; here the
        // cache takes the text when the write lands (updateThrough sets it), and `landed` says how it ended.
        writeIfAbsent: (store, data) => {
            const landed = writeBehindOf(store.prefKey)
                .updateThrough((stored) => (stored === null ? data : null))
                .then(
                    (result): QueuedWriteOutcome =>
                        result === 'saved' ? 'written' : result === 'aborted' ? 'declined' : 'failed',
                );
            return { outcome: 'saved', landed };
        },
        location: (store) => store.prefKey,
        // Learned at hydrate from the backup keys that exist (hasQuarantinedMethod reads the per-file state);
        // until Phase 3 moves that body the answer is the pre-hydration one.
        hasQuarantined: () => false,
        // The move of an unusable value aside (quarantineRawMethod's Capacitor branch): the queued writes are given
        // up, and the value is copied under the backup key and removed from its own. The per-file protocol around
        // the move stays with the factories until Phase 3 moves the bodies; `moved` says whether the copy landed.
        quarantineRaw: (store, raw) => {
            const backupKey = `${store.prefKey}${settingsFileCapacitor().CORRUPT_SUFFIX}-${setAsideStamp()}`;
            writeBehindOf(store.prefKey).discard();
            const preferences = capacitorPreferences().getCapacitorPreferences();
            const moved = (async () => {
                await preferences.set({ key: backupKey, value: raw });
                await preferences.remove({ key: store.prefKey });
                return true;
            })();
            return { ok: true, path: backupKey, moved: moved.catch(() => false) };
        },
        // What initializeAsync hydrates from, refreshAsync re-reads and peekStored answers: the key read through
        // the plugin again, the cache left as it is.
        storedKey: async (key) => (await capacitorPreferences().getCapacitorPreferences().get({ key })).value,
        preferences: () => capacitorPreferences().getCapacitorPreferences(),
        headlessStore: () => undefined,
        cas,
        // A shared key's change is the write-through above with the compare-and-write; the app WebView has no
        // one-step native change of its own (jsonStore updateNow answers null here).
        sharedUpdate: null,
        readFailed: () => false,
        // What is stored is what the write-behind knows (storeLoaded's Capacitor branch, isCacheKnown).
        loaded: (key) => storeTransport().isCacheKnown(key),
        flushed: async () => {
            await Promise.all([...writes.values()].map((write) => write.flush()));
        },
        // No settings file lock: the native compare-and-write of each key decides.
        lockPolicy: 'none',
    };
};

export { createWebviewStorage };
