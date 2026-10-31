/**
 * The Platform port: the one seam between the shared core and the platform
 * families under src/ts/platforms/. An entry point installs its family's
 * object before any core module loads; core asks `platform()` for what it
 * would otherwise branch on (runtime.isCapacitor() / isHeadlessService(),
 * the fs / Preferences transport switch, the shell globals).
 *
 * This module imports nothing at runtime from the platform families, the
 * shells or the platform packages — the families and the shells import it.
 * Every reference to a shell-only module is a type-only import, erased at
 * build, so the port carries the call shapes without loading the modules.
 * A shell platform module's own import chain is only this port and its
 * family builder (plus node builtins), and no module in that chain reads
 * platform() at load — so every entry's install runs before the logger and
 * the rest of core load, and Phase 3 can move the logger's load-time reads
 * behind the port.
 */

import type { AxiosAdapter } from 'axios';
import type { PreferencesPlugin } from '@capacitor/preferences';
import type { BroadcastSettingsChange } from '../ipc/settingsThinHandlers';
import type { CasAnswer } from '../settings/storeTransport';
import type { QuarantineResult, WriteIfAbsentResult } from '../settings/storageTypes';
import type { AndroidHeadlessStore } from '../types/settings';
import type { ThroughResult } from '../types/stores';

/**
 * The two names one store's data is kept under: the Preferences / native-bridge
 * key (the Capacitor and Android headless transports), and the file's full
 * path, read at call time (the fs transport). `sweep` is when the store's
 * file is swept for the temp files an earlier crash left beside it, once per
 * file path: `read-write` is the createJsonStore rule — before the first read
 * or write; `write` is the settings-file rule — before the first write only,
 * never on a read; `none` never sweeps.
 */
export type SettingsStoreRef = {
    prefKey: string;
    filePath: () => string;
    sweep: 'none' | 'read-write' | 'write';
};

/**
 * How concurrent writers of the stores are kept apart: the settings file lock
 * (`file` — two processes share the user-data directory, so a change is made
 * under it), or `none` (the native compare-and-write of each key decides).
 */
export type LockPolicy = 'file' | 'none';

/**
 * The native compare-and-write of one key (NativeAutovoteBridge
 * compareAndWrite): the value is saved only while the key still holds
 * `expected`; null where the platform has no bridge, so the caller is the
 * only writer.
 */
export type PlatformCas = (key: string, expected: string | null, data: string) => Promise<CasAnswer> | null;

/**
 * The storage transport the store factories (createJsonStore,
 * createSettingsFile) build on. Every member is the body one branch of
 * jsonStore.ts / settingsFileMethods.ts / storeTransport.ts selects today;
 * a member is null where the platform's transport has no such step.
 */
export type PlatformStorage = {
    /**
     * The stored text of one store (readRaw / readHere), or null when nothing is stored. Includes the stale-temp
     * sweep of the store's file, once per file path before the read, for a `read-write` sweep store.
     */
    readRaw: (store: SettingsStoreRef) => string | null;
    /**
     * Saves the text of one store; `atomic` replaces the file by temp file and rename (createJsonStore `atomic`).
     * Includes the stale-temp sweep of the store's file, once per file path before the write, for a `read-write`
     * or `write` sweep store.
     */
    writeRaw: (store: SettingsStoreRef, data: string, atomic: boolean) => void;
    /** Saves only if nothing is stored yet (the import write); answers the text that is already there (`exists`). */
    writeIfAbsent: (store: SettingsStoreRef, data: string) => WriteIfAbsentResult;
    /** Where the store's data lives, for a message: the file, or the key where there is no file. */
    location: (store: SettingsStoreRef) => string;
    /** Whether an unusable copy of the store was set aside earlier. */
    hasQuarantined: (store: SettingsStoreRef) => boolean;
    /** Moves an unusable value aside under the backup name the transport keeps (`<file>.corrupt-<time>`). */
    quarantineRaw: (store: SettingsStoreRef, raw: string) => QuarantineResult;
    /**
     * The stored text of one key read through the plugin again, any cache left
     * as it is — what initializeAsync hydrates from, refreshAsync re-reads and
     * peekStored answers. Null where a read is the file itself.
     */
    storedKey: ((key: string) => Promise<string | null>) | null;
    /** The Preferences plugin the stores persist through; null where there is none. */
    preferences: (() => PreferencesPlugin) | null;
    /** The native keyed store of the Android headless service; undefined where there is none. */
    headlessStore: () => AndroidHeadlessStore | undefined;
    /** The native compare-and-write; null where the platform has none. */
    cas: PlatformCas | null;
    /** A change of a shared key made in one step through the native compare-and-write; null elsewhere. */
    sharedUpdate: ((key: string, update: (current: string | null) => string | null) => ThroughResult) | null;
    /** Whether the latest read of a key through the bridge failed; false where reads cannot fail. */
    readFailed: (key: string) => boolean;
    /** Whether what a read answers is what is stored (storeLoaded); true where the store is the file itself. */
    loaded: (key: string) => boolean;
    /** Waits until the transport's queued writes are done (flushPendingWrites). */
    flushed: () => Promise<void>;
    lockPolicy: LockPolicy;
};

/** The OS paths the app resolves its own state and resources against. */
export type PlatformPaths = {
    /** The app's user-data directory, created when missing. */
    userData: () => string;
    /** The platform-native user-data directory of one app name. */
    getUserDataDir: (appName: string) => string;
    /** Whether this is a packaged build (packaged Electron, a native runtime). */
    isPackaged: () => boolean;
    /** Whether the app runs from source rather than a packaged build. */
    isSourceCode: () => boolean;
    /** The directory read-only resources (the Electron resources path, the app root from source) live in. */
    resourcesPath: () => string;
    /** A path below the app root. */
    appPath: (...segments: string[]) => string;
};

/** The runtime assets the app reads (the lexicon, the notices, the vision model). */
export type PlatformAssets = {
    /** The asset's text; rejects when it cannot be read. */
    readText: (relativePath: string) => Promise<string>;
    /** The asset's parsed JSON — its reader validates (buildTable), the caller awaits and narrows the `unknown`. */
    readJson: (relativePath: string) => Promise<unknown>;
    /** The local vision model: where it lives, and the device inference runs on. */
    visionModel: { location: () => string; device: 'wasm' | 'cpu' };
};

/** What deleting all local data reaches on this platform. */
export type PlatformWipe = {
    /** Clears the windows' cookies, storage and cache; null where the platform has no session (required on ElectronPlatform). */
    clearSession: (() => Promise<void>) | null;
    /** The native plugin's wipe (AutoVoteBackground wipeLocalData); null where there is no plugin. */
    nativeWipe: () => Promise<{ ok: boolean } | null>;
    /** Whether the caller must reload after the wipe: the caches were emptied. */
    reloadAfterWipe: boolean;
    /** The Preferences keys that exist, so the ones named with a time can be found; null where the stores are files. */
    listPreferenceKeys: (() => Promise<string[]>) | null;
    /** Removes the Preferences keys the stores persisted under; null where the stores are files. */
    removePreferenceKeys: ((keys: readonly string[]) => Promise<void>) | null;
};

/**
 * The native services of the platform, with the call shapes their controllers
 * have today. Each is null where the platform has none. There is deliberately
 * no openExternal member.
 */
export type PlatformNative = {
    autovote: typeof import('../services/NativeAutovoteBridge') | null;
    foregroundService: typeof import('../services/ForegroundServiceController') | null;
    apkInstaller: typeof import('../services/AndroidUpdateInstaller') | null;
};

/**
 * What the platform can do to the app's windows: the settings broadcast and
 * the post-wipe relaunch. Every shell supplies them — a family takes them as
 * an input and invents none.
 */
export type PlatformWindows = {
    /** Sends the new settings to every window. */
    broadcastSettingsChanged: BroadcastSettingsChange;
    /** Relaunches the app after a wipe (or exits). */
    afterWipe: () => void;
};

/**
 * The facts about the platform the rules read. A member whose answer depends
 * on state that changes at runtime is a function; the rest are constants.
 */
export type PlatformCapabilities = {
    /** Whether the pass builds the mission-needs refresh resolver (the headless cycle has no pass-scoped fetch). */
    refreshMissionNeeds: boolean;
    /** Whether Snap turbo may be played from here. */
    snapAllowed: boolean;
    /** Whether the native background service is running its own scenarios. */
    backgroundServiceOwnsScenarios: () => boolean;
    /** What the user can do about an untrustable ledger: the file's name, or a retry next cycle. */
    recoveryWording: 'file' | 'store';
    /**
     * The log context line: CLI or GUI. The default rule only — the
     * setContext('GUI') override stays inside logger/context, and no member
     * calls getContext: Phase 3 points getContext at this member, so a member
     * that called it would recurse.
     */
    logContext: () => 'CLI' | 'GUI';
    /** Whether the hourly log cleanup interval is armed. */
    logCleanup: boolean;
};

/** The platform a shell provides. Every member group is present; a group's members are null where the platform has none. */
export interface Platform {
    /** The axios adapter; null means the axios default. */
    http: { adapter: AxiosAdapter | null };
    storage: PlatformStorage;
    paths: PlatformPaths;
    assets: PlatformAssets;
    wipe: PlatformWipe;
    native: PlatformNative;
    /** The windows the shell drives; every shell supplies them, and a family takes them as an input. */
    windows: PlatformWindows;
    capabilities: PlatformCapabilities;
}

/** The Electron platform: it has a session, so the wipe's clearSession is required. */
export interface ElectronPlatform extends Platform {
    wipe: Omit<PlatformWipe, 'clearSession'> & { clearSession: () => Promise<void> };
}

/** The globalThis slot the installed platform lives in; a Symbol.for key survives jest.resetModules / isolateModules. */
const PLATFORM_SLOT: unique symbol = Symbol.for('gurushots.platform');

type PlatformGlobals = typeof globalThis & { [PLATFORM_SLOT]?: Platform };

/**
 * Installs the platform of the entry point's shell. Installing the object
 * that is already installed does nothing; a second, different install is a
 * boundary error — an entry forgot its install, or two entries installed.
 */
const installPlatform = (p: Platform): void => {
    const globals = globalThis as PlatformGlobals;
    const current = globals[PLATFORM_SLOT];
    if (current === p) return;
    if (current !== undefined) throw new Error('A different platform is already installed');
    globals[PLATFORM_SLOT] = p;
};

/**
 * The installed platform. Throws when none is: a core module ran before the
 * entry point installed its platform, which is a real boundary, not a default
 * to fall back on.
 */
const platform = (): Platform => {
    const current = (globalThis as PlatformGlobals)[PLATFORM_SLOT];
    if (current === undefined) {
        throw new Error('No platform is installed: the entry point must import its platform module first');
    }
    return current;
};

/**
 * Clears the slot. Only tests/helpers/platform.ts calls this — the tests swap
 * platforms through its installers, never by installing over one another.
 */
const resetPlatformForTests = (): void => {
    delete (globalThis as PlatformGlobals)[PLATFORM_SLOT];
};

export { installPlatform, platform, resetPlatformForTests };
