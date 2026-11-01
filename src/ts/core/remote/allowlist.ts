/**
 * What a remote peer may ask the desktop host to do: the explicit classification of every
 * manifest channel (invoke channels, alias targets, send and event channels) as allowed,
 * refused (with its reason), or answered in the host without forwarding.
 *
 * The classification is explicit on purpose: a channel added to the manifest without a class
 * here fails `tests/remote/allowlist.test.ts`, so someone has to decide what a paired phone
 * may reach before the channel goes live. A leaked pairing link must not be able to sign out,
 * wipe the configuration with no undo, or reset it — the refusals below are the list of what
 * it cannot do even with the link in hand.
 *
 * Dependency-free: the desktop host and the tests share it.
 */

/** Why a channel is refused to a remote peer. */
export type RemoteRefusal = { kind: 'refused'; reason: string };
/** The host answers the channel itself; it never reaches `window.api`. */
export type RemoteHostAnswered = { kind: 'host' };
/** The channel is forwarded to `window.api` as the caller sent it. */
export type RemoteAllowed = { kind: 'allowed' };

export type RemoteChannelClass = RemoteRefusal | RemoteHostAnswered | RemoteAllowed;

/** The manifest channels a remote peer may invoke, exactly as they are allowed. */
export const ALLOWED = [
    'acknowledge-import-report',
    'apply-boost-to-entry',
    'apply-challenge-profile',
    'apply-turbo-to-entry',
    'can-auto-update',
    'check-for-updates',
    'check-scenario',
    'cleanup-stale-challenge-setting',
    'clear-skip-version',
    'delete-challenge-profile',
    'delete-scenario',
    'dry-run-scenario',
    'export-scenario',
    'fill-challenge-now',
    'fill-exposure',
    'forget-unconfirmed-payment',
    'get-active-challenges',
    'get-auto-claim-status',
    'get-auto-join-active',
    'get-bankroll',
    'get-challenge-override',
    'get-challenge-overrides',
    'get-challenge-profiles',
    'get-deadline-actions',
    'get-effective-setting',
    'get-entry-pins',
    'get-environment-info',
    'get-global-default',
    'get-import-report',
    'get-library-photos',
    'get-log-backlog',
    'get-member-challenges',
    'get-open-chosen-annotations',
    'get-photo-stats',
    'get-releases-url',
    'get-scenario-status',
    'get-scenarios',
    'get-setting',
    'get-settings',
    'get-settings-recovery',
    'get-settings-schema',
    'get-swap-backs',
    'get-third-party-notices',
    'get-title-profile',
    'get-title-rules',
    'get-validation-error',
    'gui-vote',
    'is-global-default-modified',
    'is-setting-modified',
    'join-challenge',
    'key-unlock-boost',
    'play-auto-turbo',
    'preview-scenario-import',
    'preview-swap-photo',
    'refresh-api',
    'remove-challenge-override',
    'rename-scenario',
    'replace-challenge-overrides',
    'reset-global-default',
    'reset-scenario-state',
    'reset-setting',
    'run-voting-cycle-for-challenge',
    'save-challenge-profile',
    'save-scenario',
    'save-settings',
    'search-photo-tags',
    'set-challenge-override',
    'set-challenge-overrides',
    'set-entry-pin',
    'set-global-default',
    'set-setting',
    'set-title-rules',
    'should-cancel-voting',
    'simulate-scenario',
    'skip-update-version',
    'submit-picked-photos',
    'suggest-photos',
    'swap-back-entry-photo',
    'swap-entry-photo',
    'vote-all-challenges-manual',
    'vote-on-challenge',
    'vote-on-challenge-manual',
] as const;

/** The refused channels, each with the reason the refusal names. */
export const REFUSED: Record<string, string> = {
    // Account: the sign-in stays on the desktop.
    authenticate: 'Signing in is done on the computer.',
    logout: 'Logging out is done on the computer.',
    'login-success': 'Signing in is done on the computer.',
    // Events flow host → phone only; a peer never sends them. Each is listed by name, so a new
    // event channel fails tests/remote/allowlist.test.ts until it is classified here.
    'update-checking': 'Events flow from the computer to the phone only.',
    'update-available': 'Events flow from the computer to the phone only.',
    'update-not-available': 'Events flow from the computer to the phone only.',
    'update-download-progress': 'Events flow from the computer to the phone only.',
    'update-downloaded': 'Events flow from the computer to the phone only.',
    'update-error': 'Events flow from the computer to the phone only.',
    'log-message': 'Events flow from the computer to the phone only.',
    'settings-changed': 'Events flow from the computer to the phone only.',
    // Local data and log files: a leaked link must not wipe anything, and the phone writes no
    // lines into the desktop's logs — the host logs remote activity itself.
    'wipe-local-data': 'Local data is deleted on the computer.',
    'log-debug': "The phone writes no lines into the computer's log files.",
    'log-warning': "The phone writes no lines into the computer's log files.",
    'log-error': "The phone writes no lines into the computer's log files.",
    'log-api': "The phone writes no lines into the computer's log files.",
    'get-log-file': 'Log files are read on the computer.',
    'get-error-log-file': 'Log files are read on the computer.',
    'get-api-log-file': 'Log files are read on the computer.',
    // Updates: downloading and installing happen on the computer.
    'download-update': 'Updates are downloaded on the computer.',
    'install-update': 'Updates are installed on the computer.',
    // Window and shell: the phone has no desktop window.
    'open-external-url': "Links open in the phone's own browser.",
    'reload-window': 'The desktop window is not reloaded from the phone.',
    'refresh-menu': 'The desktop menu is not rebuilt from the phone.',
    // Voting runs through autovote-command, never as a bare cycle from the phone.
    'run-voting-cycle': 'Start and stop auto-vote instead of running a bare cycle.',
    'set-cancel-voting': 'Cancelling a running cycle is done on the computer.',
    // Remote access itself: the pairing store is not reachable over the pairing link.
    'get-remote-access': 'The pairing key never travels over the pairing connection.',
    'set-remote-access': 'Remote access is switched on the computer.',
    'reset-remote-pairing': 'The pairing key never travels over the pairing connection.',
    'log-remote-info': "The phone writes no lines into the computer's log files.",
    // Destructive resets and imports: a leaked link must not be able to wipe the configuration
    // with no undo.
    'reset-all-settings': 'Settings are reset on the computer.',
    'start-fresh-settings': 'Settings are reset on the computer.',
    'retry-settings-import': 'The settings import is retried on the computer.',
    'reset-all-global-defaults': 'Global defaults are reset on the computer.',
    'reset-all-scenario-state': 'Scenario state is reset on the computer.',
    'import-scenario': 'Scenarios are imported on the computer.',
};

/**
 * The channels the host answers itself; they are never forwarded to `window.api`. The log stream
 * is the host's own to count. `cleanup-stale-metadata` is answered with success and nothing is
 * done: the phone's challenge list calls it after every refresh, and a refusal would read as a
 * failed refresh, but a phone must never trigger a cleanup on the desktop's metadata.
 */
export const HOST_ANSWERED = ['start-log-stream', 'stop-log-stream', 'cleanup-stale-metadata'] as const;

/** The manifest channels a remote peer may invoke. */
export const ALLOWED_REMOTE_CHANNELS: ReadonlySet<string> = new Set(ALLOWED);

/** The classification of one manifest channel: allowed, refused with its reason, or host-answered.
 * Anything that is none of the three — a channel not in the manifest — is refused: the allowlist
 * fails closed, and a new manifest channel stays refused until it is classified here. */
export const classifyRemoteChannel = (channel: string): RemoteChannelClass => {
    const reason = REFUSED[channel];
    if (reason !== undefined) return { kind: 'refused', reason };
    if ((HOST_ANSWERED as readonly string[]).includes(channel)) return { kind: 'host' };
    if (ALLOWED_REMOTE_CHANNELS.has(channel)) return { kind: 'allowed' };
    return { kind: 'refused', reason: 'The channel is not part of the remote surface.' };
};

/**
 * The invoke channels whose handler can spend account currency (a `postOnce` request in
 * `api/join.ts` — the coins of a join — `api/currency.ts` — key, swap and fill — or
 * `api/turbo.ts` — the snap-vote submission of a turbo game), plus the
 * `apply-turbo-to-entry` alias of the turbo spend. The two voting-pass channels
 * (`run-voting-cycle-for-challenge`, `vote-all-challenges-manual`) are here too: a pass can run
 * auto-spends. When the connection drops while one of these is in flight, the phone answers
 * "unclear — check before retrying" instead of a failure, the same rule the transport's
 * `postOnce` follows.
 */
export const SPEND_REMOTE_CHANNELS: ReadonlySet<string> = new Set([
    'join-challenge',
    'key-unlock-boost',
    'swap-entry-photo',
    'swap-back-entry-photo',
    'fill-exposure',
    'apply-turbo-to-entry',
    'play-auto-turbo',
    'run-voting-cycle-for-challenge',
    'vote-all-challenges-manual',
]);

/**
 * The setting key a remote peer may never write on any write path, whatever the running
 * state: the flag itself. Start and stop go through `autovote-command`, so there is still
 * exactly one timer and a phone can never arm the desktop's auto-resume by hand.
 */
export const AUTOVOTE_RUNNING_KEY = 'autovoteRunning';

/** The write channels that carry a setting key in their arguments, and the position it sits in. */
export const KEYED_WRITE_CHANNELS: Record<string, number> = {
    'set-setting': 0,
    'reset-setting': 0,
    'set-global-default': 0,
    'reset-global-default': 0,
};
