/**
 * The window.api channel manifest — single source of truth for the surface
 * both platform shells expose to the renderer:
 *
 *   - Electron: preload.ts generates contextBridge methods from this list.
 *   - Capacitor: bridge/capacitor.ts derives its in-process bridge from the
 *     same names (it implements a subset of channels plus its own update
 *     stubs, but aliases/sends/events come from here).
 *
 * Drift protection is enforced by tests/ipc/manifest.test.ts, which asserts
 * set-equality between this manifest's invoke surface and the union of every
 * ipc/*.handlers.ts buildHandlers() key plus index.ts's direct ipcMain.on
 * registrations — a channel added on either side without the other fails CI.
 * NOTE: that test is name-level only. Signatures are carried by the
 * `WindowApi` type (src/ts/types/ipc.ts), derived from these lists and the
 * handlers' buildHandlers(): a renderer call in a type-checked file is
 * checked against the handler it reaches.
 *
 * This module must stay DEPENDENCY-FREE (no logger/settings/electron
 * requires): preload.ts runs it in the sandboxed preload context, and the
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
    'get-deadline-actions',
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
    'get-title-profile',
    'get-challenge-overrides',
    'replace-challenge-overrides',
    'get-challenge-profiles',
    'save-challenge-profile',
    'delete-challenge-profile',
    'apply-challenge-profile',
    'cleanup-stale-challenge-setting',
    'cleanup-stale-metadata',
    'cleanup-obsolete-settings',
    'get-settings-schema',
    'get-validation-error',
    'clear-chosen-photos',
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
    'get-bankroll',
    'get-member-challenges',
    'get-open-chosen-annotations',
    'confirm-account',
    'join-challenge',
    'get-library-photos',
    'get-auto-join-active',
    'get-auto-claim-status',
    // Bankroll-currency spends (key / swap / exposure fill)
    'key-unlock-boost',
    'preview-swap-photo',
    'swap-entry-photo',
    'get-swap-backs',
    'swap-back-entry-photo',
    'fill-exposure',
    // User-defined scenarios
    'get-scenarios',
    'check-scenario',
    'save-scenario',
    'rename-scenario',
    'delete-scenario',
    'preview-scenario-import',
    'import-scenario',
    'export-scenario',
    'get-scenario-status',
    'reset-scenario-state',
    'dry-run-scenario',
    'simulate-scenario',
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
] as const;

// Friendlier method names layered over invoke channels. applyTurbo is
// alias-ONLY: 'apply-turbo-to-entry' is deliberately not in invokeChannels,
// so no applyTurboToEntry method is generated.
const aliases = {
    applyBoost: 'apply-boost-to-entry',
    applyTurbo: 'apply-turbo-to-entry',
} as const;

// Send-style methods (fire-and-forget window-control hints on Electron;
// local event emissions on Capacitor). Method name → channel.
const sendMethods = {
    login: 'login-success',
    logout: 'logout',
} as const;

// Event-listener methods. Each `api[method](callback)` subscribes to the
// channel and returns an unsubscribe. Method name → channel (names are
// not all mechanically derivable — onDownloadProgress).
const eventMethods = {
    onUpdateChecking: 'update-checking',
    onUpdateAvailable: 'update-available',
    onUpdateNotAvailable: 'update-not-available',
    onDownloadProgress: 'update-download-progress',
    onUpdateDownloaded: 'update-downloaded',
    onUpdateError: 'update-error',
    onLogMessage: 'log-message',
    onSettingsChanged: 'settings-changed',
} as const;

// Shared kebab-case → camelCase (both shells must agree on this mapping).
const kebabToCamel = (channel: string): string =>
    channel.replace(/-([a-z0-9])/g, (_: string, c: string) => c.toUpperCase());

// The full invoke-channel set including alias targets — what the main
// process must actually register handlers for.
const allInvokeChannels = () => [...new Set([...invokeChannels, ...Object.values(aliases)])];

export { invokeChannels, aliases, sendMethods, eventMethods, kebabToCamel, allInvokeChannels };
