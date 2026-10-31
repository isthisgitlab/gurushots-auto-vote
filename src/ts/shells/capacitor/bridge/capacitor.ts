/**
 * Capacitor bridge — populates window.api with the same surface preload.ts
 * exposes on Electron, calling the IPC handler modules directly: Capacitor
 * runs in one JavaScript context, so there is no main↔renderer split.
 * Event listeners are fed by an in-process pub/sub instead of
 * webContents.send. Loaded only by the Capacitor renderer entry.
 */

// Bridge consumes only the IPC handler modules whose impls are
// platform-agnostic. misc.handlers (uses Electron shell/BrowserWindow)
// and update.handlers (uses electron-updater) supply Electron-specific
// behavior that this bridge replaces with Capacitor-native equivalents
// further down (openExternalUrl via Capacitor.Browser, update channels
// stubbed pending the AndroidUpdateInstaller).
import * as settingsHandlers from '../../../core/ipc/settings.handlers';
import * as votingHandlers from '../../../core/ipc/voting.handlers';
import * as logHandlers from '../../../core/ipc/log.handlers';
import * as actionsHandlers from '../../../core/ipc/actions.handlers';
import * as computationsHandlers from '../../../core/ipc/computations.handlers';
import * as currencyHandlers from '../../../core/ipc/currency.handlers';
import * as scenariosHandlers from '../../../core/ipc/scenarios.handlers';

import * as settings from '../../../core/settings';
import * as logger from '../../../core/logger';
import { isSafeExternalUrl } from '../../../core/format/urlSafe';
import { logout, LogoutNotSavedError } from '../../../core/services/auth';
import * as updateChecker from '../../../core/services/UpdateChecker';
import * as androidUpdateInstaller from '../AndroidUpdateInstaller';
import { hasBundledModel } from '../../../core/services/visionVerifier';
import { buildReleaseUpdateHandlers } from '../../../core/ipc/releaseUpdates';
// kebab-case channel name → camelCase renderer method name — shared with
// preload.ts via the channel manifest so both shells derive identically.
import { kebabToCamel, aliases, sendMethods, eventMethods } from '../../../core/ipc/manifest';
import { markPlatformKind } from '../../../core/platform/kind';
import { isCapacitorNative as sharedIsCapacitorNative } from './capacitorPresence';

import { invokeHandler } from '../../../core/ipc/invokeHandler';
import type { IpcHandler } from '../../../core/ipc/invokeHandler';
import type { CapacitorGlobals } from '../../../core/types/capacitor';
import type { GuiLogSink } from '../../../core/logger';
import type { ShellUpdateHandlers } from '../../../core/ipc/releaseUpdates';
import type { WindowApi } from '../../../core/types/ipc';

export type BridgeListener = (payload: unknown) => void;

// Tiny in-process pub/sub. Replaces webContents.send broadcasts.
const listeners: Map<string, Set<BridgeListener>> = new Map();
/**
 * @returns unsubscribe
 */
const subscribe = (channel: string, fn: BridgeListener): (() => boolean | undefined) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    (listeners.get(channel) as Set<BridgeListener>).add(fn);
    return () => listeners.get(channel)?.delete(fn);
};
const emit = (channel: string, payload?: unknown) => {
    const set = listeners.get(channel);
    if (!set) return;
    for (const fn of set) {
        try {
            fn(payload);
        } catch (err) {
            logger.withCategory('general').error(`Capacitor bridge listener for ${channel} threw`, err);
        }
    }
};

// Wrap a handler whose signature is (event, ...args) so the
// renderer can call it as (...args). The first parameter (event) is
// passed as null since there is no IPC event on Capacitor.
const wrap =
    (impl: IpcHandler) =>
    (...args: unknown[]) =>
        Promise.resolve(invokeHandler(impl, null, args));

const buildAllHandlers = () => {
    // Every successful settings write (save-settings, set-setting and the
    // mutating passthroughs) broadcasts through the installed platform's
    // windows (capacitorPlatform), which emits on the local pub/sub here so
    // React's onSettingsChanged subscribers fire.

    // Update channels: check / skip / releases URL are the shared
    // GitHub-Releases channels (ipc/releaseUpdates). Download hands the APK
    // to the AndroidUpdateInstaller; the user confirms the install in the
    // system installer.
    const releaseUpdates = buildReleaseUpdateHandlers({
        emit,
        assetSuffix: async () => ((await hasBundledModel()) ? '.apk' : '-lite.apk'),
    });
    const updateStubs = {
        ...releaseUpdates.handlers,
        'download-update': async () => {
            const lastUpdateInfo = releaseUpdates.getLastUpdateInfo();
            if (!lastUpdateInfo?.downloadUrl) {
                return {
                    success: false,
                    error: 'No update info — run check-for-updates first',
                    fallbackUrl: updateChecker.getReleasesUrl(),
                };
            }
            const result = await androidUpdateInstaller.downloadAndInstall({
                downloadUrl: lastUpdateInfo.downloadUrl,
                version: lastUpdateInfo.latestVersion,
                onProgress: (progress: { percent?: number }) => emit('update-download-progress', progress),
            });
            if (result.success) {
                // The browser is now downloading. The user finishes
                // install via the system "tap APK -> install" flow.
                // We surface a downloaded event so any progress-bar UI
                // settles to a "see system notification" state.
                emit('update-downloaded', lastUpdateInfo);
            } else {
                emit('update-error', { message: result.error, code: result.code });
            }
            return { ...result, fallbackUrl: updateChecker.getReleasesUrl() };
        },
        // With the native ApkInstaller the system installer launches
        // automatically once the download finishes; via the browser
        // fallback the user taps the downloaded APK. Either way the bridge
        // has nothing left to drive here.
        'install-update': async () => ({
            success: true,
            info: 'The system installer will prompt you to confirm. If it does not appear, tap the downloaded APK in your notifications.',
        }),
        'can-auto-update': async () => ({ success: true, canAutoUpdate: true }),
    } satisfies ShellUpdateHandlers;

    return {
        ...settingsHandlers.buildHandlers(),
        ...votingHandlers.buildHandlers(),
        ...logHandlers.buildHandlers(),
        ...actionsHandlers.buildHandlers(),
        ...computationsHandlers.buildHandlers(),
        ...currencyHandlers.buildHandlers(),
        ...scenariosHandlers.buildHandlers(),
        ...updateStubs,
    };
};

type BridgeApi = Record<string, (...args: never[]) => unknown>;

/**
 * Map every handler to a window.api method using kebab → camel, plus the
 * friendlier aliases preload exposes — mirrored from the shared manifest so the
 * two shells can't drift.
 */
const addHandlerMethods = (api: BridgeApi) => {
    for (const [channel, impl] of Object.entries(buildAllHandlers())) {
        api[kebabToCamel(channel)] = wrap(impl);
    }
    for (const [method, channel] of Object.entries(aliases)) {
        api[method] = api[kebabToCamel(channel)];
    }
};

/**
 * Send-style methods (login-success / logout) are window-control hints in
 * Electron's main process. On Capacitor they just toggle local React state; the
 * bridge emits an event the app can listen to (or just no-ops, since the React
 * app already drives navigation off the token in settings).
 */
const addSendMethods = (api: BridgeApi) => {
    api.login = () => emit(sendMethods.login);
    api.logout = async () => {
        try {
            // logout awaits the write-behind flush so the cleared
            // token reaches @capacitor/preferences before we navigate away —
            // otherwise an OS kill right after logout could leave the old
            // token persisted and silently restore the session on next launch.
            await logout();
        } catch (err) {
            logger.withCategory('authentication').error('Logout failed to clear token', err);
            // A logout the settings refused did not log anyone out: the screen stays, and the caller tells the user.
            if (err instanceof LogoutNotSavedError) throw err;
        }
        emit(sendMethods.logout);
    };
};

/**
 * Event listeners, generated from the shared manifest. Each returns
 * subscribe()'s unsubscribe, matching the Electron preload contract so
 * React code does not branch per platform.
 */
const addEventMethods = (api: BridgeApi) => {
    for (const [method, channel] of Object.entries(eventMethods)) {
        api[method] = (cb: BridgeListener) => subscribe(channel, cb);
    }
};

/**
 * On mobile, reload-window is the WebView reloading itself.
 */
const reloadWindow = () => {
    if (typeof globalThis.location?.reload === 'function') {
        globalThis.location.reload();
    }
    return Promise.resolve({ success: true });
};

/**
 * The Capacitor runtime's presence, shared with the other shell modules —
 * the renderer pages take it through the bridge: react/ carries no
 * Capacitor-global reads of its own.
 */
const isCapacitorNative = sharedIsCapacitorNative;

const openExternalUrl = (url: unknown) => {
    // Same https-only scheme gate as the Electron handler (shared via
    // format/urlSafe) — the two platforms must not diverge on this
    // security control. Without it the Android path would open any
    // scheme (intent:, file:, javascript:, app handlers).
    if (!isSafeExternalUrl(url)) {
        logger.withCategory('api').warning(`Refused openExternalUrl for non-https URL: ${url}`, null);
        return Promise.resolve({ success: false, error: 'Only https:// URLs can be opened' });
    }
    // Use the native browser via Capacitor when present; fall back
    // to window.open. Loaded lazily so non-Capacitor paths never
    // resolve @capacitor/browser.
    try {
        const Cap = (globalThis as CapacitorGlobals).Capacitor;
        if (Cap?.Plugins?.Browser?.open) {
            // isSafeExternalUrl only passes a string.
            return Cap.Plugins.Browser.open({ url: url as string });
        }
    } catch {
        // fall through
    }
    if (typeof globalThis.open === 'function') {
        globalThis.open(url as string, '_blank');
    }
    return Promise.resolve({ success: true });
};

/**
 * Seed the curated intent presets once (idempotent; never fatal). Mobile has no main-process startup, so the window's
 * boot calls this once the stored settings are hydrated: before that a read finds defaults and a save is refused.
 */
const seedBridgeProfiles = (): void => {
    try {
        settings.seedIntentProfiles();
    } catch (err) {
        logger.withCategory('settings').warning('Intent profile seeding failed (non-fatal):', err);
    }
};

const installBridge = (): WindowApi => {
    // The renderer reads its platform from platform/kind, so the bridge marks it
    // here, where the Capacitor runtime's probe lives, as the first statement:
    // if a later install step throws, the `.catch` fallback in the renderer
    // still mounts the app against a kind that reads capacitor. Calling the
    // probe — not just checking it exists — keeps a Capacitor web target
    // unmarked, so it reads the default kind (electron) and gets the desktop
    // capabilities.
    if ((globalThis as CapacitorGlobals).Capacitor?.isNativePlatform?.() === true) {
        markPlatformKind('capacitor');
    }
    const api: BridgeApi = {};
    addHandlerMethods(api);
    addSendMethods(api);

    // Route logger fan-out into the in-process emitter so the Logs page
    // (useLogStream → onLogMessage) receives live entries. Electron does
    // the equivalent in log.handlers.register() by setting
    // global.sendLogToGUI; the WebView has no `global`, so use globalThis.
    (globalThis as typeof globalThis & { sendLogToGUI?: GuiLogSink }).sendLogToGUI = (entry) =>
        emit('log-message', entry);

    addEventMethods(api);

    // Window controls the React app sometimes asks for: refresh-menu and
    // openExternalUrl get reasonable Capacitor-native fallbacks.
    api.reloadWindow = reloadWindow;
    api.refreshMenu = () => Promise.resolve({ success: true }); // no menu on mobile
    api.openExternalUrl = openExternalUrl;

    // Expose. The object is assembled by channel name from the shared
    // manifest, so the checker cannot follow it to WindowApi; the handlers it
    // maps are the same modules WindowApi is derived from.
    (globalThis as typeof globalThis & { api?: object }).api = api;
    return api as WindowApi;
};

export { installBridge, seedBridgeProfiles, subscribe, emit, reloadWindow, isCapacitorNative };
