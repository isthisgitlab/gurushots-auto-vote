/**
 * Everything the app keeps on this device, and the wipe that deletes it ("Delete all local data").
 *
 * LOCAL_DATA_STORES lists every createJsonStore file and Preferences key plus the configuration and settings.json: a store that is not
 * listed would survive a wipe, so tests/settings/localData.test.ts fails for any createJsonStore call site that is
 * missing here. Directories and marker files live beside them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '../logger';
import * as runtime from '../runtime';
import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import * as cancellation from '../voting/cancellation';
import { APP_PARTITION } from '../index/session';
import { isVotingPassRunning } from '../voting/passActivity';
import {
    CONFIG_KEY,
    CORRUPT_SUFFIX,
    LEGACY_SETTINGS_KEY,
    UNIMPORTABLE_SUFFIX,
    discardPendingWrites,
    getUserDataPath,
    listPreferenceKeys,
    removePreferenceKeys,
    resumeWrites,
} from './storage';
import {
    MARKER_NAME_RE,
    APP_LOCK_FILE_NAME,
    isCliSessionActive,
    isDesktopAppActive,
    isWebServerActive,
} from './cliSessionLock';

import type { CapacitorGlobals } from '../types/capacitor';

type LocalDataStore = { fileName: string; prefKey: string };

// The Preferences key of the copy of the settings.json blob that older builds kept (what `settings.json.original` is
// on a desktop): existing installs have it, and the wipe removes it.
const ORIGINAL_SETTINGS_KEY = 'gurushots-settings_original';

const LOCAL_DATA_STORES: readonly LocalDataStore[] = [
    { fileName: 'config.json', prefKey: CONFIG_KEY },
    // The settings.json blob of the one-time import, the copy of it older builds kept, and the import marker.
    { fileName: 'settings.json', prefKey: LEGACY_SETTINGS_KEY },
    { fileName: 'settings.json.original', prefKey: ORIGINAL_SETTINGS_KEY },
    { fileName: 'v2-import.json', prefKey: 'gs_v2_import' },
    { fileName: 'titlePins.json', prefKey: 'gs_title_pins' },
    { fileName: 'autoSpends.json', prefKey: 'gs_auto_spends' },
    { fileName: 'entryAges.json', prefKey: 'gs_entry_ages' },
    { fileName: 'joinState.json', prefKey: 'gs_join_state' },
    { fileName: 'metadata.json', prefKey: 'gurushots-metadata' },
    { fileName: 'scenarioState.json', prefKey: 'gs_scenario_state' },
    { fileName: 'scenarioResets.json', prefKey: 'gs_scenario_resets' },
    { fileName: 'photo-stats.json', prefKey: 'gurushots-photo-stats' },
    { fileName: 'lexicon-diagnostics.json', prefKey: 'gs_lexicon_diagnostics' },
    { fileName: 'swapBacks.json', prefKey: 'gs_swap_backs' },
];

// The directories (under the user-data directory) the app fills: its logs, and the CLI's extracted vision runtime.
const LOCAL_DATA_DIRECTORIES = ['logs', 'vision'] as const;

// The vision runtime of the CLI binary lives under this app name whatever the build (services/visionCliAssets.ts).
const VISION_APP_NAME = 'gurushots-auto-vote';

// Files that are not stores but sit beside them: the CLI session, web-server and desktop-app markers, and the lock files
// of the join and scenario state and of the settings import; a lock file may have a ".stale-<token>" copy a takeover
// left (a crash mid-way).
const LOCK_FILE_RE = /^(?:statelock|joinlock)-.+\.lock(?:\.stale-.+)?$/;
const isLockFile = (name: string) =>
    LOCK_FILE_RE.test(name) || MARKER_NAME_RE.test(name) || name === APP_LOCK_FILE_NAME;

// The legacy settings files existing installs still have (the one-time import's source and the copies older builds
// kept): deleted before config.json, so a file that cannot be removed never brings a lost configuration's import back.
const LEGACY_SETTINGS_FILES = ['settings.json', 'settings.json.original', 'v2-import.json'] as const;
const CONFIG_FILE = 'config.json';

// A Windows file that antivirus or an indexer holds for a moment is retried rather than left behind.
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } as const;

/**
 * The electron session the app's windows use, for the wipe to clear its cookies, local storage and cache.
 */
const appSession = () => (require('electron') as typeof import('electron')).session.fromPartition(APP_PARTITION);

/** Why a wipe was refused: a live CLI process, the running desktop app or web server, or a voting pass in this process. */
type WipeBusyCode = 'busy-pass' | 'busy-cli' | 'busy-app' | 'busy-web';

/**
 * `error` is a WipeBusyCode when nothing was touched; otherwise what could not be deleted, with what was `removed` and,
 * on Capacitor, `reload`: the window's caches were emptied, so the caller reloads it once the user has been told.
 */
type WipeResult =
    | { success: true; removed: string[] }
    | { success: false; error: string; removed?: string[]; reload?: true };

type WipeDeps = {
    /** What the app is doing that a wipe would pull the files out from under (live activity only), or null. */
    busyReason: () => WipeBusyCode | null | Promise<WipeBusyCode | null>;
    /** Stops a voting pass that is under way. */
    stopScheduler: () => void;
    /** Android: stops the background service and clears its native stores (resolves ok: whether it all went). */
    wipeNative: () => Promise<{ ok: boolean } | null>;
    /** Electron: clears the cookies, local storage and cache of the app's windows and of Electron's default session. */
    clearSession: () => Promise<void>;
};

/**
 * The native plugin's wipe (AutoVoteBackground.wipeLocalData), or null where the build has none. Asked on Capacitor only.
 */
const nativeWipe = async (): Promise<{ ok: boolean } | null> => {
    const plugin = (globalThis as CapacitorGlobals).Capacitor?.Plugins?.AutoVoteBackground;
    if (typeof plugin?.wipeLocalData !== 'function') return null;
    const answer: unknown = await plugin.wipeLocalData();
    return isPlainObject(answer) ? { ok: answer.ok === true } : { ok: false };
};

// A saved "auto-vote running" flag is only a wish to resume at next start: it is no activity, and does not block. The
// markers can take a few seconds to read, so the pass is asked last, synchronously, right before the files go: a pass
// that began during the wait is refused too.
const liveBusyReason = async (): Promise<WipeBusyCode | null> => {
    // Together, so two old markers cost one wait, not two.
    const [cli, app, web] = await Promise.all([isCliSessionActive(), isDesktopAppActive(), isWebServerActive()]);
    if (cli) return 'busy-cli';
    if (app) return 'busy-app';
    if (web) return 'busy-web';
    return isVotingPassRunning() ? 'busy-pass' : null;
};

const defaultDeps = (): WipeDeps => ({
    busyReason: liveBusyReason,
    stopScheduler: () => cancellation.setCancelled(true),
    wipeNative: nativeWipe,
    clearSession: async () => {
        if (!runtime.isElectron()) return;
        // The default session writes its cookies, storage and caches at the user-data root, beside the app's files.
        const { session } = require('electron') as typeof import('electron');
        for (const target of [appSession(), session.defaultSession]) {
            await target.clearStorageData();
            await target.clearCache();
        }
    },
});

const vision = (dir: string) => path.join(dir, 'vision');

/**
 * Every path the app keeps on a file system, existing or not: the stores' files, what sits beside them (the temp files
 * and backups of a settings write, lock files), and the directories.
 */
const localDataPaths = (userData: string): string[] => {
    const storeFiles = LOCAL_DATA_STORES.map((store) => store.fileName);
    const beside = (() => {
        try {
            return fs
                .readdirSync(userData)
                .filter((name) => isLockFile(name) || storeFiles.some((file) => name.startsWith(`${file}.`)));
        } catch {
            return [];
        }
    })();
    const directories = LOCAL_DATA_DIRECTORIES.map((dir) =>
        dir === 'vision' ? vision(runtime.getUserDataDir(VISION_APP_NAME)) : path.join(userData, dir),
    );
    const all = [
        ...new Set([
            ...storeFiles.map((file) => path.join(userData, file)),
            ...beside.map((name) => path.join(userData, name)),
            ...directories,
            vision(userData),
        ]),
    ];
    // The legacy settings files go first and config.json last: one that cannot be deleted leaves the configuration
    // in place, so the next load does not import it once more.
    const first = LEGACY_SETTINGS_FILES.map((file) => path.join(userData, file));
    const last = path.join(userData, CONFIG_FILE);
    return [...first, ...all.filter((target) => !first.includes(target) && target !== last), last];
};

/**
 * Deletes everything the app keeps on this device (see the header): settings and token, every store, logs, the
 * extracted vision runtime, the Android service's native stores, the windows' browser storage. Pending writes are
 * given up first and stores refuse writes from then on, so nothing re-creates a file. The caller relaunches (or exits)
 * afterwards; the app is not usable until it does. A failure partway leaves what is left and says what; on Capacitor
 * the result then asks for a reload (`reload`), because the caches were emptied and what is stored is only partly gone.
 *
 * @returns the paths and keys removed; a WipeBusyCode as `error` when the app is working and nothing was touched
 */
const wipeLocalData = async (overrides: Partial<WipeDeps> = {}): Promise<WipeResult> => {
    const deps = { ...defaultDeps(), ...overrides };
    const busy = await deps.busyReason();
    if (busy !== null) return { success: false, error: busy };

    const log = logger.withCategory('settings');
    log.warning('Deleting all local data');
    const removed: string[] = [];
    const failures: string[] = [];
    try {
        deps.stopScheduler();
        if (runtime.isCapacitor()) {
            const native = await deps.wipeNative();
            if (native !== null && !native.ok) failures.push('the background service data');
        }
        await discardPendingWrites();

        if (runtime.isCapacitor()) {
            // The set-aside and kept copies carry the time they were made: found by what exists, not by a fixed name.
            const kept = await listPreferenceKeys();
            const copySuffixes = [CORRUPT_SUFFIX, UNIMPORTABLE_SUFFIX];
            const keys = [
                ...new Set([
                    ...LOCAL_DATA_STORES.flatMap((store) => [store.prefKey, `${store.prefKey}${CORRUPT_SUFFIX}`]),
                    ...kept.filter((key) =>
                        LOCAL_DATA_STORES.some((store) =>
                            copySuffixes.some((suffix) => key.startsWith(`${store.prefKey}${suffix}`)),
                        ),
                    ),
                ]),
            ];
            await removePreferenceKeys(keys);
            removed.push(...keys);
        } else {
            const userData = getUserDataPath();
            const legacySettingsFiles = new Set<string>(LEGACY_SETTINGS_FILES.map((file) => path.join(userData, file)));
            let legacySettingsFileFailed = false;
            for (const target of localDataPaths(userData)) {
                if (!fs.existsSync(target)) continue;
                // Without config.json the next load imports a settings.json left behind once more.
                if (legacySettingsFileFailed && target === path.join(userData, CONFIG_FILE)) continue;
                try {
                    fs.rmSync(target, RM_OPTIONS);
                    removed.push(target);
                } catch (err) {
                    legacySettingsFileFailed ||= legacySettingsFiles.has(target);
                    failures.push(`${target} (${errorMessage(err) ?? 'unknown error'})`);
                }
            }
        }
        await deps.clearSession();
    } catch (err) {
        failures.push(errorMessage(err) ?? 'unknown error');
    }

    if (failures.length > 0) {
        resumeWrites();
        // Never keep running on caches the wipe emptied: the caller reloads once the failure has been shown.
        return {
            success: false,
            error: failures.join('; '),
            removed,
            ...(runtime.isCapacitor() ? { reload: true as const } : {}),
        };
    }
    return { success: true, removed };
};

export { LOCAL_DATA_STORES, LOCAL_DATA_DIRECTORIES, appSession, wipeLocalData };
export type { LocalDataStore, WipeBusyCode, WipeResult, WipeDeps };
