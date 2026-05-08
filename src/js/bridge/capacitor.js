/**
 * Capacitor bridge — populates window.api with the same surface that
 * preload.js exposes on Electron, but consumes the IPC handlers
 * directly instead of going through ipcMain/ipcRenderer.
 *
 * Capacitor runs everything in one JavaScript context (the WebView), so
 * there is no main↔renderer split. The "handlers" are imported
 * functions; we wrap each in a thin shim that adapts the Electron
 * (event, ...args) signature to a (...args) call site.
 *
 * Event listeners (onUpdateChecking, onLogMessage, etc.) on Electron
 * are fed by webContents.send from the main process. On Capacitor
 * there is no main process; the bridge stands up an in-process
 * EventEmitter so the same .on() registration shape works and the
 * React code does not need to branch.
 *
 * This module is loaded only by the Capacitor renderer entry. It is
 * never reached on Electron, where preload.js does the wiring.
 */

const settingsHandlers = require('../ipc/settings.handlers');
const votingHandlers = require('../ipc/voting.handlers');
const logHandlers = require('../ipc/log.handlers');
const actionsHandlers = require('../ipc/actions.handlers');
const miscHandlers = require('../ipc/misc.handlers');
const updateHandlers = require('../ipc/update.handlers');

const settings = require('../settings');

// Tiny in-process pub/sub. Replaces webContents.send broadcasts.
const listeners = new Map();
const subscribe = (channel, fn) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel)?.delete(fn);
};
const emit = (channel, payload) => {
    const set = listeners.get(channel);
    if (!set) return;
    for (const fn of set) {
        try {
            fn(payload);
        } catch (err) {
            console.error(`Capacitor bridge listener for ${channel} threw:`, err);
        }
    }
};

// kebab-case channel name → camelCase renderer method name
const kebabToCamel = (channel) => channel.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// Wrap a handler that originally received (event, ...args) so the
// renderer can call it as (...args). The first parameter (event) is
// passed as null since there is no IPC event on Capacitor.
const wrap = (impl) => (...args) => Promise.resolve(impl(null, ...args));

const buildAllHandlers = () => {
    // Electron-specific deps that the bridge stubs out for Capacitor.
    // - Update lifecycle is handled by AndroidUpdateInstaller (separate module);
    //   we stub the legacy electron-updater accessors so the IPC handlers
    //   that depend on them return safe defaults rather than crashing.
    // - getMainWindow / getLoginWindow are Electron BrowserWindows and
    //   simply do not exist here.
    const updateDeps = {
        getAutoUpdater: () => null,
        setAutoUpdater: () => {},
        getMainWindow: () => null,
    };
    const miscDeps = {
        getMainWindow: () => null,
        getLoginWindow: () => null,
    };
    // The Capacitor save-settings broadcaster routes through the local
    // pub/sub so React's onSettingsChanged subscribers fire.
    const settingsDeps = {
        broadcastSettingsChange: (newSettings) => emit('settings-changed', newSettings),
    };

    return {
        ...settingsHandlers.buildHandlers(settingsDeps),
        ...votingHandlers.buildHandlers(),
        ...logHandlers.buildHandlers(),
        ...actionsHandlers.buildHandlers(),
        ...miscHandlers.buildHandlers(miscDeps),
        ...updateHandlers.buildHandlers(updateDeps),
    };
};

const installBridge = () => {
    const handlers = buildAllHandlers();
    const api = {};

    // Map every handler to a window.api method using kebab → camel
    for (const [channel, impl] of Object.entries(handlers)) {
        api[kebabToCamel(channel)] = wrap(impl);
    }

    // Preload exposes a couple of channels under both their literal
    // camel-case name and a friendlier alias. Mirror those here.
    api.applyBoost = api.applyBoostToEntry;
    api.applyTurbo = api.applyTurboToEntry;
    api.guiVote = api.guiVote || api.runVotingCycle;

    // Send-style methods (login-success / logout) are window-control
    // hints in Electron's main process. On Capacitor they just toggle
    // local React state; the bridge emits an event the app can listen
    // to (or just no-ops, since the React app already drives navigation
    // off the token in settings).
    api.login = () => emit('login-success');
    api.logout = () => {
        try {
            settings.setSetting('token', '');
        } catch (err) {
            console.error('Logout failed to clear token:', err);
        }
        emit('logout');
    };

    // Event listeners. The Electron contract returns nothing (or an
    // unsubscribe for the settings-changed listener); preserve that
    // shape so React code does not branch.
    api.onSettingsChanged = (cb) => subscribe('settings-changed', cb);
    api.onLogMessage = (cb) => subscribe('log-message', cb);
    api.onUpdateChecking = (cb) => subscribe('update-checking', cb);
    api.onUpdateAvailable = (cb) => subscribe('update-available', cb);
    api.onUpdateNotAvailable = (cb) => subscribe('update-not-available', cb);
    api.onDownloadProgress = (cb) => subscribe('update-download-progress', cb);
    api.onUpdateDownloaded = (cb) => subscribe('update-downloaded', cb);
    api.onUpdateError = (cb) => subscribe('update-error', cb);

    // Window controls the React app sometimes asks for. On mobile,
    // reload-window is the WebView reloading itself; refresh-menu and
    // openExternalUrl get reasonable Capacitor-native fallbacks.
    api.reloadWindow = () => {
        if (typeof globalThis.location?.reload === 'function') {
            globalThis.location.reload();
        }
        return Promise.resolve({ success: true });
    };
    api.refreshMenu = () => Promise.resolve({ success: true }); // no menu on mobile
    api.openExternalUrl = (url) => {
        // Use the native browser via Capacitor when present; fall back
        // to window.open. Loaded lazily so non-Capacitor paths never
        // resolve @capacitor/browser.
        try {
            const Cap = globalThis.Capacitor;
            if (Cap?.Plugins?.Browser?.open) {
                return Cap.Plugins.Browser.open({ url });
            }
        } catch {
            // fall through
        }
        if (typeof globalThis.open === 'function') {
            globalThis.open(url, '_blank');
        }
        return Promise.resolve({ success: true });
    };

    // Expose
    globalThis.api = api;
    return api;
};

module.exports = { installBridge, subscribe, emit };
