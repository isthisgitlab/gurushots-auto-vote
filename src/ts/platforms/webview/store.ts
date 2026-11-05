/**
 * The webview family's storage member: the @capacitor/preferences transport
 * of the app WebView. `jsonStore` and `settingsFile` build one transport
 * object per store, composed from the family modules beside this one — the
 * ordered write-behind and the shared compare-and-write save
 * (./writeBehind), and the settings file's write protocol
 * (./settingsFileTransport) over ./capacitorPreferences and
 * ./settingsFileProtocol. `updateNow` answers null — the window's writes
 * are queued-only; use `updateThrough`.
 *
 * The plugin module is inert at load (it resolves the plugin lazily), and
 * every other wrapped module is reached at call time: the node project's
 * setup file loads the test helpers that import this family, so a module
 * graph loaded at import time would land in the setup's registry before a
 * test file registers its own mocks (platforms/node/index.ts states the
 * reason in full).
 */

import { getCapacitorPreferences } from './capacitorPreferences';
import { createWriteBehind, knownKeys } from './writeBehind';
import { settingsFileTransport } from './settingsFileTransport';

import type { JsonStoreTransport, PlatformCas, PlatformStorage, SettingsStoreRef } from '../../core/platform/port';

type LoggerModule = typeof import('../../core/logger');

// See the header: the wrapped modules, reached at call time.
const logger = (): LoggerModule => require('../../core/logger') as LoggerModule;

// The generic JSON store's Preferences transport. `flags.shared` marks a key
// the background service writes too: its saves go through the shell's `cas`
// part (the native compare-and-write, null where the build has none), so a
// change is saved only while the key still holds what it was made from.
const jsonStoreTransport = (
    ref: SettingsStoreRef,
    flags: { strict: boolean; shared: boolean },
    cas: PlatformCas | null,
): JsonStoreTransport => {
    let cachedJson: string | null = null;
    const cache = {
        get: () => cachedJson,
        set: (value: string | null) => {
            cachedJson = value;
        },
    };
    const writes = createWriteBehind(
        ref.prefKey,
        flags.strict,
        getCapacitorPreferences,
        cache,
        // The native compare-and-write of the key (the shell's part); a build without one saves straight to
        // Preferences, as the bridge's own no-plugin answer did.
        flags.shared ? (expected, data) => cas?.(ref.prefKey, expected, data) ?? null : undefined,
    );
    let initialized = false;
    return {
        readRaw: () => cachedJson,
        writeRaw: (data) => {
            cachedJson = data;
            writes.queue(data);
        },
        hydrate: async () => {
            if (initialized) return;
            try {
                const { value } = await getCapacitorPreferences().get({ key: ref.prefKey });
                cachedJson = value;
                writes.confirm(0);
            } catch (err) {
                logger().withCategory('settings').error(`Capacitor ${ref.prefKey} read failed:`, err);
                cachedJson = null;
            } finally {
                initialized = true;
            }
        },
        reread: async () => {
            // Waits for this context's own queued writes first, so none is lost.
            const { at, done } = writes.drained();
            await done;
            try {
                const { value } = await getCapacitorPreferences().get({ key: ref.prefKey });
                cachedJson = value;
                writes.confirm(at);
                initialized = true;
                return true;
            } catch (err) {
                logger().withCategory('settings').error(`Capacitor ${ref.prefKey} refresh failed:`, err);
                return false;
            }
        },
        // The write is only queued here: `updateThrough` is the way to make a change.
        updateNow: () => null,
        updateThrough: writes.updateThrough,
        // What is stored now, the cache left as it is — it may be behind it (the background service writes the key too).
        peekStored: async () => (await getCapacitorPreferences().get({ key: ref.prefKey })).value,
        flush: () => writes.flush(),
        discard: () => {
            writes.discard();
            cachedJson = null;
        },
    };
};

const createWebviewStorage = (cas: PlatformCas | null): PlatformStorage => ({
    jsonStore: (ref, flags) => jsonStoreTransport(ref, flags, cas),
    settingsFile: (ref, wiring) => settingsFileTransport(ref, wiring, cas),
    // The window's cache is filled by a start-up read that can fail, and a store that could not be filled is empty
    // because of that, not because nothing was saved. Ask after the store was read: a read that failed says so only
    // once it was made.
    loaded: (key) => knownKeys.has(key),
    // The native compare-and-write of each key decides; there is no file lock.
    lockPolicy: 'none',
});

export { createWebviewStorage };
