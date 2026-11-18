/**
 * The window.api channel manifest — single source of truth for the surface
 * both platform shells expose to the renderer:
 *
 *   - Electron: preload.ts generates contextBridge methods from this list; the Logs
 *     window's preloadLogs.ts generates only the logsWindow* subset.
 *   - Capacitor: shells/capacitor/bridge/capacitor.ts derives its in-process bridge from the
 *     same names (it implements a subset of channels plus its own update
 *     stubs, but aliases/sends/events come from here).
 *
 * Drift protection is enforced by tests/ipc/manifest.test.ts, which asserts
 * set-equality between this manifest's invoke surface and the union of every
 * ipc/*.handlers.ts buildHandlers() key plus index.ts's direct ipcMain.on
 * registrations — a channel added on either side without the other fails CI.
 * NOTE: that test is name-level only. Signatures are carried by the
 * `WindowApi` type (src/ts/core/types/ipc.ts), derived from these lists and the
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
    'get-settings-recovery',
    'retry-settings-import',
    'start-fresh-settings',
    'get-import-report',
    'acknowledge-import-report',
    'get-third-party-notices',
    'wipe-local-data',
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
    'get-entry-pins',
    'set-entry-pin',
    'get-challenge-overrides',
    'replace-challenge-overrides',
    'get-challenge-profiles',
    'save-challenge-profile',
    'delete-challenge-profile',
    'apply-challenge-profile',
    'cleanup-stale-challenge-setting',
    'cleanup-stale-metadata',
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
    'submit-picked-photos',
    'suggest-photos',
    'get-bankroll',
    'get-member-challenges',
    'get-open-chosen-annotations',
    'join-challenge',
    'forget-unconfirmed-payment',
    'get-library-photos',
    'search-photo-tags',
    'get-photo-stats',
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
    'reset-all-scenario-state',
    'dry-run-scenario',
    'simulate-scenario',
    // The scenario capability catalogue, the per-subject snapshot, and the installation scenario's reads and lifecycle
    // (settings/scenarioLifecycle.ts): the assignment and its owner, pause and resume, handoff, the photo pools.
    'get-scenario-capabilities',
    'get-scenario-snapshot',
    'get-installation-scenario',
    'list-simulation-subjects',
    'set-installation-scenario',
    // Local only: a paired phone cannot move the installation scenario to another host.
    'transfer-installation-scenario-owner',
    'pause-scenario',
    'resume-scenario',
    'handoff-scenario',
    'clear-scenario-assignment',
    'get-photo-pools',
    'set-photo-pool',
    'delete-photo-pool',
    'rename-photo-pool',
    'get-effective-entry-pins',
    // What applies now, for a client that mounts or missed an event: the installation's effective settings, and the
    // presentation-only projection the Login and Logs windows read.
    'get-effective-installation-settings',
    'get-effective-presentation',
    // The priority Stop fence and the controller's routes to it. `scenario-stop-fence` reads (it may create a fence that was
    // never created); `record-full-stop` is a user's full Stop; `arm-autovote` is the one route that lifts a Stop block,
    // the user's own Run / Resume / re-arm; `arm-if-allowed` is the compare-and-set alone (a startup or a scenario request
    // can never lift a block); the installation's publication is withdrawn on a Stop and lifted on that re-arm.
    'get-stop-status',
    // The ordinary control inbox (settings/scenarioControls.ts). `get-scenario-request-status` answers where a request or a
    // target stands; `begin-scenario-request` persists a request before it is applied and `finish-scenario-request` records its
    // result: the two are the host's own routes (a phone never calls them).
    'get-scenario-request-status',
    'begin-scenario-request',
    'finish-scenario-request',
    'scenario-stop-fence',
    'record-full-stop',
    'arm-autovote',
    'arm-if-allowed',
    'withdraw-installation',
    'rearm-installation',
    'get-account-wake',
    'reload-window',
    'refresh-menu',
    // Remote access pairing (shells/electron/remote/pairing.ts). Answered for the main window
    // only; refused to the Logs window, refused to a remote peer, "not applicable" on the web
    // shell, the CLI and Capacitor.
    'get-remote-access',
    'set-remote-access',
    'reset-remote-pairing',
    // The remote-access host's INFO log line (the renderer's `log-debug` is silent in a packaged build).
    // Electron only; refused to a remote peer, "not applicable" on the web shell, the CLI and Capacitor.
    'log-remote-info',
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
    // Host to client: what applies now. Each carries a monotonic `revision`; a client ignores one older than what it holds.
    onEffectiveSettingsChanged: 'effective-settings-changed',
    onEffectivePresentationChanged: 'effective-presentation-changed',
} as const;

// What the Logs window may use: the log feed, its own diagnostics line, the
// settings reads it makes (the UI language and the theme) and the presentation-only projection. Its preload (preloadLogs.ts)
// exposes only this subset and the main process refuses every other channel from that window
// (registerHandlers.ts), so a compromised Logs renderer reaches no spend, no settings
// write and no other log channel. Every name must exist in the full manifest above
// (tests/ipc/manifest.test.ts).
const logsWindowInvokeChannels = [
    'get-setting',
    'log-error',
    'get-log-backlog',
    'start-log-stream',
    'stop-log-stream',
    'get-effective-presentation',
] as const satisfies readonly (typeof invokeChannels)[number][];

// The settings the Logs window may read or be told about: its get-setting answers only these keys, and the
// settings-changed event it receives carries only these (registerHandlers.ts).
const logsWindowSettingKeys = ['language', 'theme'] as const;

const logsWindowEventMethods = {
    onLogMessage: eventMethods.onLogMessage,
    onSettingsChanged: eventMethods.onSettingsChanged,
    onEffectivePresentationChanged: eventMethods.onEffectivePresentationChanged,
} as const satisfies Partial<typeof eventMethods>;

// Shared kebab-case → camelCase (both shells must agree on this mapping).
const kebabToCamel = (channel: string): string =>
    channel.replace(/-([a-z0-9])/g, (_: string, c: string) => c.toUpperCase());

// The full invoke-channel set including alias targets — what the main
// process must actually register handlers for.
const allInvokeChannels = () => [...new Set([...invokeChannels, ...Object.values(aliases)])];

export {
    invokeChannels,
    aliases,
    sendMethods,
    eventMethods,
    logsWindowInvokeChannels,
    logsWindowEventMethods,
    logsWindowSettingKeys,
    kebabToCamel,
    allInvokeChannels,
};
