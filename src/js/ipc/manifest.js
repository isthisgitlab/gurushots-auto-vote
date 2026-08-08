/**
 * The window.api channel manifest — single source of truth for the surface
 * both platform shells expose to the renderer:
 *
 *   - Electron: preload.js generates contextBridge methods from this list.
 *   - Capacitor: bridge/capacitor.js derives its in-process bridge from the
 *     same names (it implements a subset of channels plus its own update
 *     stubs, but aliases/sends/events come from here).
 *
 * Drift protection is enforced by tests/ipc/manifest.test.js, which asserts
 * set-equality between this manifest's invoke surface and the union of every
 * ipc/*.handlers.js buildHandlers() key plus index.js's direct ipcMain.on
 * registrations — a channel added on either side without the other fails CI.
 * NOTE: that coverage is name-level only; a signature change on a channel
 * kept on both sides is not caught here.
 *
 * This module must stay DEPENDENCY-FREE (no logger/settings/electron
 * requires): preload.js runs it in the sandboxed preload context, and the
 * Capacitor bundle ships it to the WebView.
 */

// Channels exposed as `api[kebabToCamel(channel)] = (...args) => invoke(channel, ...args)`.
const invokeChannels = [
    // Settings
    'get-settings',
    'get-setting',
    'set-setting',
    'save-settings',
    'get-environment-info',
    // Voting / strategy
    'gui-vote',
    'get-active-challenges',
    'authenticate',
    'run-voting-cycle',
    'run-voting-cycle-for-challenge',
    'vote-on-challenge',
    'vote-on-challenge-manual',
    'vote-all-challenges-manual',
    'refresh-api',
    // Logger
    'log-debug',
    'log-error',
    'log-warning',
    'log-api',
    'get-log-file',
    'get-error-log-file',
    'get-api-log-file',
    'get-log-backlog',
    // Boost thresholds
    'get-boost-threshold',
    'set-boost-threshold',
    'set-default-boost-threshold',
    // Schema-based settings
    'get-global-default',
    'set-global-default',
    'get-challenge-override',
    'set-challenge-override',
    'set-challenge-overrides',
    'remove-challenge-override',
    'get-effective-setting',
    'get-title-rules',
    'set-title-rules',
    'get-challenge-overrides',
    'get-challenge-profiles',
    'save-challenge-profile',
    'delete-challenge-profile',
    'apply-challenge-profile',
    'cleanup-stale-challenge-setting',
    'cleanup-stale-metadata',
    'cleanup-obsolete-settings',
    'get-settings-schema',
    'get-validation-error',
    // Resets
    'reset-setting',
    'reset-global-default',
    'reset-all-global-defaults',
    'reset-all-settings',
    'is-setting-modified',
    'is-global-default-modified',
    // Misc
    'open-external-url',
    'should-cancel-voting',
    'set-cancel-voting',
    'apply-boost-to-entry',
    'play-auto-turbo',
    'fill-challenge-now',
    'reload-window',
    'refresh-menu',
    // AutoUpdater
    'check-for-updates',
    'download-update',
    'install-update',
    'skip-update-version',
    'clear-skip-version',
    'get-releases-url',
    'can-auto-update',
    // Log streaming
    'start-log-stream',
    'stop-log-stream',
];

// Friendlier method names layered over invoke channels. applyTurbo is
// alias-ONLY: 'apply-turbo-to-entry' is deliberately not in invokeChannels,
// so no applyTurboToEntry method is generated (matches the historical
// hand-written surface).
const aliases = {
    applyBoost: 'apply-boost-to-entry',
    applyTurbo: 'apply-turbo-to-entry',
};

// Send-style methods (fire-and-forget window-control hints on Electron;
// local event emissions on Capacitor). Method name → channel.
const sendMethods = {
    login: 'login-success',
    logout: 'logout',
};

// Event-listener methods. Each `api[method](callback)` subscribes to the
// channel and returns an unsubscribe. Method name → channel (names are
// historical and not all mechanically derivable — onDownloadProgress).
const eventMethods = {
    onUpdateChecking: 'update-checking',
    onUpdateAvailable: 'update-available',
    onUpdateNotAvailable: 'update-not-available',
    onDownloadProgress: 'update-download-progress',
    onUpdateDownloaded: 'update-downloaded',
    onUpdateError: 'update-error',
    onLogMessage: 'log-message',
    onSettingsChanged: 'settings-changed',
};

// Shared kebab-case → camelCase (both shells must agree on this mapping).
const kebabToCamel = (channel) => channel.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

// The full invoke-channel set including alias targets — what the main
// process must actually register handlers for.
const allInvokeChannels = () => [...new Set([...invokeChannels, ...Object.values(aliases)])];

module.exports = { invokeChannels, aliases, sendMethods, eventMethods, kebabToCamel, allInvokeChannels };
