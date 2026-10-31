/**
 * The webview family's storage member, as a placeholder: the real transport —
 * the Preferences write-behind cache family of settings/capacitorPreferences.ts,
 * settings/settingsFileCapacitor.ts and settings/storeTransport.ts, with the
 * per-file write protocol the store factories keep — moves behind the port in
 * Phase 3 step 7. Until then every function member throws, so nothing can
 * quietly depend on a half-delegation that differs from the branches; only
 * lockPolicy is answered, the fact the branches select on the app WebView
 * (the native compare-and-write of each key decides, not a settings file
 * lock).
 */

import type { PlatformStorage } from '../../platform/port';

const NOT_MOVED = 'webview storage moves behind the port in Phase 3 step 7';

const movedLater = (): never => {
    throw new Error(NOT_MOVED);
};

const createWebviewStorage = (): PlatformStorage => ({
    readRaw: movedLater,
    writeRaw: movedLater,
    writeIfAbsent: movedLater,
    location: movedLater,
    hasQuarantined: movedLater,
    quarantineRaw: movedLater,
    storedKey: movedLater,
    preferences: movedLater,
    headlessStore: movedLater,
    cas: movedLater,
    sharedUpdate: movedLater,
    readFailed: movedLater,
    loaded: movedLater,
    flushed: movedLater,
    lockPolicy: 'none',
});

export { createWebviewStorage };
