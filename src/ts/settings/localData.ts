/**
 * Everything the app keeps on this device, and the wipe that deletes it ("Delete all local data").
 *
 * LOCAL_DATA_STORES lists every createJsonStore file and Preferences key plus the settings file: a store that is not
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
    CORRUPT_SUFFIX,
    SETTINGS_KEY,
    discardPendingWrites,
    getUserDataPath,
    removePreferenceKeys,
    resumeWrites,
} from './storage';
import { isCliSessionActive, isDesktopAppActive } from './cliSessionLock';

import type { CapacitorGlobals } from '../types/capacitor';

type LocalDataStore = { fileName: string; prefKey: string };

const LOCAL_DATA_STORES: readonly LocalDataStore[] = [
    { fileName: 'settings.json', prefKey: SETTINGS_KEY },
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

// Files that are not stores but sit beside them: the CLI session and desktop-app markers, and the lock files of the
// join and scenario state; each may have a ".stale-<token>" copy a takeover or a marker removal left (a crash mid-way).
const LOCK_FILE_RE = /^(?:(?:statelock|joinlock)-.+\.lock|cli-session\.lock|desktop-app\.lock)(?:\.stale-.+)?$/;

/**
 * The electron session the app's windows use, for the wipe to clear its cookies, local storage and cache.
 */
const appSession = () => (require('electron') as typeof import('electron')).session.fromPartition(APP_PARTITION);

/** Why a wipe was refused: a live CLI session, the running desktop app, or a voting pass in this process. */
type WipeBusyCode = 'busy-pass' | 'busy-cli' | 'busy-app';

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
    /** Electron: clears the windows' cookies, local storage and cache. */
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
    const [cli, app] = await Promise.all([isCliSessionActive(), isDesktopAppActive()]);
    if (cli) return 'busy-cli';
    if (app) return 'busy-app';
    return isVotingPassRunning() ? 'busy-pass' : null;
};

const defaultDeps = (): WipeDeps => ({
    busyReason: liveBusyReason,
    stopScheduler: () => cancellation.setCancelled(true),
    wipeNative: nativeWipe,
    clearSession: async () => {
        if (!runtime.isElectron()) return;
        const session = appSession();
        await session.clearStorageData();
        await session.clearCache();
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
                .filter((name) => LOCK_FILE_RE.test(name) || storeFiles.some((file) => name.startsWith(`${file}.`)));
        } catch {
            return [];
        }
    })();
    const directories = LOCAL_DATA_DIRECTORIES.map((dir) =>
        dir === 'vision' ? vision(runtime.getUserDataDir(VISION_APP_NAME)) : path.join(userData, dir),
    );
    return [
        ...new Set([
            ...storeFiles.map((file) => path.join(userData, file)),
            ...beside.map((name) => path.join(userData, name)),
            ...directories,
            vision(userData),
        ]),
    ];
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
            const keys = LOCAL_DATA_STORES.flatMap((store) => [store.prefKey, `${store.prefKey}${CORRUPT_SUFFIX}`]);
            await removePreferenceKeys(keys);
            removed.push(...keys);
        } else {
            for (const target of localDataPaths(getUserDataPath())) {
                if (!fs.existsSync(target)) continue;
                try {
                    fs.rmSync(target, { recursive: true, force: true });
                    removed.push(target);
                } catch (err) {
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
