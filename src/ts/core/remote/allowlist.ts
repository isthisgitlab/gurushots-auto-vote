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
    'clear-scenario-assignment',
    'clear-skip-version',
    'delete-challenge-profile',
    'delete-photo-pool',
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
    'get-effective-entry-pins',
    'get-effective-installation-settings',
    'get-effective-presentation',
    'get-effective-setting',
    'get-entry-pins',
    'get-environment-info',
    'get-global-default',
    'get-import-report',
    'get-installation-scenario',
    'get-library-photos',
    'get-log-backlog',
    'get-member-challenges',
    'get-open-chosen-annotations',
    'get-photo-pools',
    'get-photo-stats',
    'get-releases-url',
    'get-scenario-capabilities',
    'get-scenario-request-status',
    'get-scenario-snapshot',
    'get-scenario-status',
    'get-scenarios',
    'get-setting',
    'get-settings',
    'get-settings-recovery',
    'get-settings-schema',
    'get-stop-status',
    'get-swap-backs',
    'get-third-party-notices',
    'get-title-profile',
    'get-title-rules',
    'get-validation-error',
    'gui-vote',
    'handoff-scenario',
    'is-global-default-modified',
    'is-setting-modified',
    'join-challenge',
    'key-unlock-boost',
    'list-simulation-subjects',
    'pause-scenario',
    'play-auto-turbo',
    'preview-scenario-import',
    'preview-swap-photo',
    'refresh-api',
    'remove-challenge-override',
    'rename-photo-pool',
    'rename-scenario',
    'replace-challenge-overrides',
    'reset-global-default',
    'reset-scenario-state',
    'reset-setting',
    'resume-scenario',
    'run-voting-cycle-for-challenge',
    'save-challenge-profile',
    'save-scenario',
    'save-settings',
    'search-photo-tags',
    'set-challenge-override',
    'set-challenge-overrides',
    'set-entry-pin',
    'set-global-default',
    'set-installation-scenario',
    'set-photo-pool',
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
    // The installation scenario's owner: a paired phone chooses a scenario on its current computer, it never moves the
    // installation to another one.
    'transfer-installation-scenario-owner': 'Owner transfer is done on the selected computer.',
    // The controller's own routes (fence, arming, withdrawal, wake) and the control inbox's host routes: the phone's Start and
    // Stop go through autovote-command, and the host records a phone's scenario change in its inbox itself.
    'scenario-stop-fence': 'This is done on the computer.',
    'record-full-stop': 'This is done on the computer.',
    'arm-autovote': 'This is done on the computer.',
    'arm-if-allowed': 'This is done on the computer.',
    'withdraw-installation': 'This is done on the computer.',
    'rearm-installation': 'This is done on the computer.',
    'get-account-wake': 'This is done on the computer.',
    'begin-scenario-request': 'This is done on the computer.',
    'finish-scenario-request': 'This is done on the computer.',
    // The host's effective projections reach a phone as events only.
    'effective-settings-changed': 'Events flow from the computer to the phone only.',
    'effective-presentation-changed': 'Events flow from the computer to the phone only.',
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
 * The channels that only read: the host changes nothing for them, so a lost one is only a failed read, and it may be asked
 * again. These (and the host-answered channels, which change nothing on the account) may wait in the initial read queue before
 * the host says hello. Every other channel is an effect, a spend, or refused.
 */
export const READ_REMOTE_CHANNELS: ReadonlySet<string> = new Set([
    'can-auto-update',
    'check-for-updates',
    'check-scenario',
    'cleanup-stale-metadata',
    'dry-run-scenario',
    'export-scenario',
    'get-active-challenges',
    'get-auto-claim-status',
    'get-auto-join-active',
    'get-bankroll',
    'get-challenge-override',
    'get-challenge-overrides',
    'get-challenge-profiles',
    'get-deadline-actions',
    'get-effective-entry-pins',
    'get-effective-installation-settings',
    'get-effective-presentation',
    'get-effective-setting',
    'get-entry-pins',
    'get-environment-info',
    'get-global-default',
    'get-import-report',
    'get-installation-scenario',
    'get-library-photos',
    'get-log-backlog',
    'get-member-challenges',
    'get-open-chosen-annotations',
    'get-photo-pools',
    'get-photo-stats',
    'get-releases-url',
    'get-scenario-capabilities',
    'get-scenario-request-status',
    'get-scenario-snapshot',
    'get-scenario-status',
    'get-scenarios',
    'get-setting',
    'get-settings',
    'get-settings-recovery',
    'get-settings-schema',
    'get-stop-status',
    'get-swap-backs',
    'get-third-party-notices',
    'get-title-profile',
    'get-title-rules',
    'get-validation-error',
    'is-global-default-modified',
    'is-setting-modified',
    'list-simulation-subjects',
    'preview-scenario-import',
    'preview-swap-photo',
    'refresh-api',
    'search-photo-tags',
    'should-cancel-voting',
    'simulate-scenario',
    'start-log-stream',
    'stop-log-stream',
    'suggest-photos',
]);

/**
 * How a remote operation behaves when the connection drops, one classification for every current-version client:
 *   - `read`: may wait for the host's hello and may be asked again; a failed read is a failure, never an empty answer;
 *   - `effect`: changes the host's data or controller (every allowed channel that is not a read or a spend): refused before
 *     the host's hello, never queued, never sent again; a loss after the send is reported as unclear;
 *   - `spend`: an effect that can spend account currency (SPEND_REMOTE_CHANNELS): the same, by the `postOnce` rule;
 *   - `priority-stop`: a full Stop, answered ahead of any other work and never through the control inbox; a lost reply never
 *     reads as stopped.
 * A refused or unknown channel is an effect: it is not worth waiting for, and nothing about it is repeated.
 */
export type RemoteOperationClass = 'read' | 'effect' | 'spend' | 'priority-stop';

export const classifyRemoteOperation = (channel: string): RemoteOperationClass => {
    if (SPEND_REMOTE_CHANNELS.has(channel)) return 'spend';
    return READ_REMOTE_CHANNELS.has(channel) ? 'read' : 'effect';
};

/** The class of an `autovote-command`: a Stop is the priority operation; a Start and a re-arm are effects. */
export const classifyRemoteCommand = (command: 'start' | 'stop' | 'rearm'): 'effect' | 'priority-stop' =>
    command === 'stop' ? 'priority-stop' : 'effect';

/** The setting key that assigns a scenario: a write that carries it changes which scenario runs. */
const SCENARIO_KEY = 'scenario';

/** The deepest an argument is searched for the scenario key; anything deeper is treated as carrying it. */
const MAX_SEARCH_DEPTH = 8;

const mentionsScenarioKey = (value: unknown, depth = 0): boolean => {
    if (value === null || typeof value !== 'object') return false;
    if (depth >= MAX_SEARCH_DEPTH) return true;
    if (Array.isArray(value)) return value.some((item) => mentionsScenarioKey(item, depth + 1));
    return Object.entries(value).some(([key, item]) => key === SCENARIO_KEY || mentionsScenarioKey(item, depth + 1));
};

/** A subject argument as a target name: its text when it is a challenge id or the installation, else a name no subject has. */
const subjectTarget = (value: unknown): string => {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return /^[A-Za-z0-9@:._-]{1,64}$/.test(text) ? text : 'subject';
};

/** The lifecycle channels whose target is the subject they name (their first argument). */
const SUBJECT_CONTROL_CHANNELS: ReadonlySet<string> = new Set([
    'pause-scenario',
    'resume-scenario',
    'handoff-scenario',
    'clear-scenario-assignment',
    'reset-scenario-state',
]);

/** The generic writes that carry a setting key first: they change an assignment only for the scenario key. */
const KEYED_SCENARIO_WRITES: ReadonlySet<string> = new Set([
    'set-setting',
    'reset-setting',
    'set-global-default',
    'reset-global-default',
    'set-challenge-override',
    'remove-challenge-override',
]);

/** The bulk writes that may carry a scenario assignment inside their arguments (found by searching them). */
const BULK_SCENARIO_WRITES: ReadonlySet<string> = new Set([
    'save-settings',
    'set-challenge-overrides',
    'replace-challenge-overrides',
]);

/** The writes whose reach (profiles and title rules hold settings) is not told by their arguments: always a scenario change. */
const ALWAYS_SCENARIO_WRITES: ReadonlySet<string> = new Set([
    'apply-challenge-profile',
    'save-challenge-profile',
    'delete-challenge-profile',
    'set-title-rules',
]);

/**
 * Whether this call changes a scenario (an assignment, a definition, a pool, a pin or a pause), and the target of the change:
 * a call that does needs a request identity and is recorded in the host's control inbox; null for every other call. The
 * decision reads the arguments, so a generic or bulk write that carries the scenario key cannot pass as an ordinary one.
 */
export const scenarioControlTarget = (channel: string, args: unknown[]): string | null => {
    if (channel === 'set-installation-scenario') return '@installation';
    if (SUBJECT_CONTROL_CHANNELS.has(channel)) return subjectTarget(args[0]);
    if (channel === 'save-scenario' || channel === 'rename-scenario' || channel === 'delete-scenario') {
        return 'definitions';
    }
    if (channel === 'set-photo-pool' || channel === 'delete-photo-pool' || channel === 'rename-photo-pool') {
        return 'pools';
    }
    if (channel === 'set-entry-pin') return 'pins';
    if (KEYED_SCENARIO_WRITES.has(channel)) return args[0] === SCENARIO_KEY ? 'assignments' : null;
    if (BULK_SCENARIO_WRITES.has(channel)) return mentionsScenarioKey(args) ? 'assignments' : null;
    return ALWAYS_SCENARIO_WRITES.has(channel) ? 'assignments' : null;
};

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
