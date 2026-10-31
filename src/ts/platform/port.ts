/**
 * The Platform port: the one seam between the shared core and the platform
 * families under src/ts/platforms/. An entry point installs its family's
 * object before any core module loads; core asks `platform()` for what it
 * would otherwise branch on itself (the Capacitor / headless detection, the
 * fs / Preferences transport switch, the shell globals).
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
import type { BroadcastSettingsChange } from '../ipc/settingsThinHandlers';
import type { DroppedSaveOps } from '../settings/saveDropped';
import type { QuarantineResult, WriteIfAbsentResult, WriteResult } from '../settings/storageTypes';
import type { AutoVoteStatus } from '../types/capacitor';
import type { CasAnswer, ThroughResult } from '../types/stores';
import type { TransformersModule } from '../types/vision';

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
 * One generic JSON store's transport (what `createJsonStore` builds one of
 * per store, from `platform().storage.jsonStore`): the read/write/hydrate
 * operations of the platform family the store runs on. The core wrapper
 * keeps the refuse-writes checks, the discard listeners and the public store
 * surface; the family owns the cache, the queue and the native bridge.
 */
export type JsonStoreTransport = {
    /** The stored text, or null when nothing is stored (the cache, the bridge read, or the file). */
    readRaw(): string | null;
    /** Saves the whole text (into the cache and the queue, the bridge, or the file). */
    writeRaw(data: string): void;
    /** Fills the cache from what is stored, once at boot; a no-op except on the app WebView. */
    hydrate(): Promise<void>;
    /** Reads what is stored into the cache again; true except on the app WebView, where false is a failed read. */
    reread(): Promise<boolean>;
    /** Makes and saves a change in one step; null where the write is only queued (the app WebView). */
    updateNow(update: (current: string | null) => string | null): ThroughResult | null;
    /** Writes a value made from the current one that nothing reads before it is saved. */
    updateThrough(update: (current: string | null) => string | null): Promise<ThroughResult>;
    /** What is stored now, any cache left as it is. */
    peekStored(): Promise<string | null>;
    /** Waits until the queued writes are done; the strict store's rejection semantics stay inside. */
    flush(): Promise<void>;
    /** Gives up every write still queued and empties the cache. */
    discard(): void;
};

/**
 * One settings file's transport (what `createSettingsFile` builds one of per
 * file, from `platform().storage.settingsFile`): the operations of the
 * platform family the file lives on. The core wrapper keeps the refuse-writes
 * checks and the public surface; the family owns the per-file state, the
 * write queue and the write protocol.
 */
export type SettingsFileTransport = {
    /** The stored text, or null when nothing is stored. */
    readRaw(): string | null;
    /** Saves the whole text; `ok` false where the native store refused it, and `landed` where the save is queued. */
    write(data: string): WriteResult;
    /** Saves only if nothing is stored yet (the import write); answers the text that is already there (`exists`). */
    writeIfAbsent(data: string): WriteIfAbsentResult;
    /** Where the file lives, for a message: the file, or the key where there is no file. */
    location(): string;
    /** Whether what a read answers is what is stored (a cache that was never filled, or no bridge, says no). */
    isLoaded(): boolean;
    /** Whether what a read answers is stored (the app window's own queued writes say no until they land). */
    isPersisted(): boolean;
    /** Whether an unusable copy of the file was set aside earlier. */
    hasQuarantined(): boolean;
    /** Moves an unusable value aside under the backup name the transport keeps (`<file>.corrupt-<time>`). */
    quarantineRaw(raw: string): QuarantineResult;
    /** Fills the cache from what is stored, once at boot; a no-op except on the app WebView. */
    hydrate(): Promise<void>;
    /** Waits until the queued writes are done. */
    flush(): Promise<void>;
    /** Gives up every write still queued and empties the caches. */
    discard(): Promise<void>;
};

/** The parts of `createSettingsFile`'s wiring a family's settings-file transport needs. */
export type SettingsFileWiring = {
    /** A change made again on the text the other Android context saved meanwhile (a plain overwrite for settings.json). */
    rebase: (base: string | null, ours: string, theirs: string | null) => string;
    /** The Android service reaches the key through the bridge's own read/write pair, not through the keyed calls. */
    dedicatedBridge: boolean;
    /** A given-up write of this file is reported to the window; null for a file whose saves are not reported. */
    droppedSaves: DroppedSaveOps | null;
};

/**
 * The storage transport the store factories (createJsonStore,
 * createSettingsFile) build on: one operation-level transport object per
 * store, built by the platform family. Core calls the same operations on
 * every platform and never tests which family it has.
 */
export type PlatformStorage = {
    /** Builds the transport of one generic JSON store (`createJsonStore`'s). */
    jsonStore(ref: SettingsStoreRef, flags: { strict: boolean; shared: boolean }): JsonStoreTransport;
    /** Builds the transport of one settings file (`createSettingsFile`'s). */
    settingsFile(ref: SettingsStoreRef, wiring: SettingsFileWiring): SettingsFileTransport;
    /** Whether a store that other work trusts holds what is saved (a read that failed says no once it was made). */
    loaded(key: string): boolean;
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
    /** The local vision model: where it lives, the device inference runs on, whether this build ships it, and the
     * library the classifier pipeline is built from (the SEA build's extracted copy, else the package import). */
    visionModel: {
        location: () => string;
        device: 'wasm' | 'cpu';
        bundled: () => Promise<boolean>;
        loadTransformers: () => Promise<TransformersModule>;
    };
};

/**
 * The user-data markers a running desktop process holds (a CLI session, the
 * desktop app, the web server): whether another process holds one, and
 * whether a name beside the stores is one of the marker files.
 */
export type PlatformWipeMarkers = {
    /** Whether another process holds a CLI session marker. */
    isCliSessionActive: () => Promise<boolean>;
    /** Whether another process holds the desktop-app marker. */
    isDesktopAppActive: () => Promise<boolean>;
    /** Whether another process holds a web-server marker. */
    isWebServerActive: () => Promise<boolean>;
    /** Whether a name beside the stores is one of the marker files (the desktop-app lock included). */
    isMarkerFile: (name: string) => boolean;
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
    /** The user-data markers a wipe must respect, and the marker names of the wipe's beside-scan. */
    markers: PlatformWipeMarkers;
};

/**
 * What a native AutoVoteBackground call answers through the bridge (start,
 * stop): the plugin's `running` with `available`, the no-plugin shape, or the
 * failed-call shape.
 */
export type AutoVoteCallResult = { running: boolean; available: boolean; error?: string | undefined };

/**
 * The AutoVoteBackground plugin through its bridge (NativeAutovoteBridge):
 * the call shapes the service's exports have, declared here so the port
 * carries no module of the shell.
 */
export type PlatformAutovote = {
    /** Starts the native cycle (AutoVoteBackground.start). */
    start: () => Promise<AutoVoteCallResult>;
    /** Stops the native cycle (AutoVoteBackground.stop). */
    stop: () => Promise<AutoVoteCallResult>;
    /** The plugin's status (AutoVoteBackground.getStatus), or the no-plugin / failed-call shape. */
    getStatus: () => Promise<AutoVoteStatus>;
    /** Whether the plugin is registered on this build. */
    isAvailable: () => boolean;
    /** The native compare-and-write of one key — the webview family's storage transport saves shared keys through it. */
    compareAndWrite: PlatformCas;
};

/** The Android foreground-service controller (ForegroundServiceController), as core calls it. */
export type PlatformForegroundService = {
    /** Starts the persistent "running" notification; answers whether it started. */
    start: (notification?: { title?: string; body?: string }) => Promise<boolean>;
    /** Updates the notification text; a call without a body updates nothing. */
    update: (notification: { title?: string; body?: string }) => Promise<void>;
    /** Stops the foreground service; safe to call when it is not running. */
    stop: () => Promise<void>;
    /** The notification permission, asked for when it is not granted. */
    requestPermissions: () => Promise<{ display: string }>;
};

/**
 * What an APK install came to: installed, or not and why. `code` is the native refusal's when it gave one; a
 * failure that opened the release page instead carries `release-page-opened`.
 */
export type ApkInstallResult =
    | { success: true; version?: string | null; viaFallback?: boolean }
    | { success: false; version?: string | null; error: string; code?: string };

/** The Android APK installer (AndroidUpdateInstaller). */
export type PlatformApkInstaller = {
    /**
     * Downloads the APK and hands it to the system installer, falling back to the release page in the browser; the
     * native path reports download progress through `onProgress`.
     */
    downloadAndInstall: (call: {
        downloadUrl: string;
        version?: string | null;
        onProgress?: (progress: { percent?: number }) => void;
    }) => Promise<ApkInstallResult>;
};

/**
 * The native services of the platform. Each is null where the platform has
 * none. There is deliberately no openExternal member.
 */
export type PlatformNative = {
    autovote: PlatformAutovote | null;
    foregroundService: PlatformForegroundService | null;
    apkInstaller: PlatformApkInstaller | null;
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
 * The installed platform, or null where none is: a core module that only
 * holds a store (or builds one lazily) asks this where an entry has not
 * installed anything yet — a renderer bundle imports them, and there the port
 * stays empty by design.
 */
const installedPlatform = (): Platform | null => (globalThis as PlatformGlobals)[PLATFORM_SLOT] ?? null;

/**
 * The installed platform. Throws when none is: a core module ran before the
 * entry point installed its platform, which is a real boundary, not a default
 * to fall back on.
 */
const platform = (): Platform => {
    const current = installedPlatform();
    if (current === null) {
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

export { installPlatform, installedPlatform, platform, resetPlatformForTests };
