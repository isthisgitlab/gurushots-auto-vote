/**
 * The link version 3 contract (src/ts/core/remote/contract/v3/): the living types and registries are held inside
 * what was frozen when link version 3 was cut, so an older page and a newer desktop (or the reverse) still
 * understand each other. Everything here applies only while LINK_VERSION is 2; a bump comes with a new
 * `contract/v<N>/` and its own test.
 *
 * Compile-time checks run under `pnpm typecheck`:
 *   - arguments: the frozen arguments of every channel are assignable to the current handler's parameters, so the
 *     desktop still accepts what an older page sends;
 *   - results, event payloads and the auto-vote state: the current type is assignable to the frozen one, so the
 *     old fields are still there;
 *   - the message envelopes: assignable both ways, with each closed union (reasons, command names, status)
 *     equal to its frozen copy, so a new value fails;
 *   - settings: the current value type of every frozen key equals its frozen type, so a new enum member fails.
 * Each kind has a broken fixture that must fail (`Equal<IsAssignable<Broken, Current>, false>`), so a check that
 * went vacuous (`unknown`, `never`) fails too. `@ts-expect-error` stays banned.
 *
 * Runtime checks cover what types cannot: the manifest, the allowlist, the spend class, the settings schema and the
 * parser's closed `reason`, each with a broken fixture that must fail.
 */

import { LINK_VERSION, parsePeerMessage } from '../../src/ts/core/remote/protocol';
import {
    READ_REMOTE_CHANNELS,
    SPEND_REMOTE_CHANNELS,
    classifyRemoteChannel,
    classifyRemoteCommand,
    classifyRemoteOperation,
} from '../../src/ts/core/remote/allowlist';
import { allInvokeChannels } from '../../src/ts/core/ipc/manifest';
import { SETTINGS_SCHEMA } from '../../src/ts/core/settings/schema';

import type { AutovoteState } from '../../src/ts/core/autovote/state';
import type {
    AutovoteCommandMessage,
    AutovoteCommandName,
    AutovoteStateMessage,
    ByeMessage,
    EventMessage,
    CommandAck,
    ControlReport,
    HelloMessage,
    InvokeMessage,
    PeerMessage,
    ResultMessage,
} from '../../src/ts/core/remote/protocol';
import type {
    AutovoteCommandMessageV3,
    AutovoteStateMessageV3,
    CommandAckV3,
    ControlReportV3,
    AutovoteStateV3,
    ByeMessageV3,
    ChannelsV3,
    EventMessageV3,
    EventPayloadsV3,
    HelloMessageV3,
    InvokeMessageV3,
    PeerMessageV3,
    ResultMessageV3,
    SettingValuesV3,
} from '../../src/ts/core/remote/contract/v3';
import type { GuiLogEntry } from '../../src/ts/core/logger/types';
import type { EffectivePresentation, EffectiveSettings } from '../../src/ts/core/services/effectiveEvents';
import type { RemoteChannelClass } from '../../src/ts/core/remote/allowlist';
import type { SettingValues } from '../../src/ts/core/settings/schema';
import type { ConfigV2 } from '../../src/ts/core/types/config';
import type { WindowApi } from '../../src/ts/core/types/ipc';
import type { DownloadProgress } from '../../src/ts/react/contexts/UpdateContext';
import type { UpdateSummary } from '../../src/ts/shells/electron/AutoUpdater';
import type * as AutoUpdaterModule from '../../src/ts/shells/electron/AutoUpdater';
import type * as CapacitorBridgeModule from '../../src/ts/shells/capacitor/bridge/capacitor';
import { invalid } from '../helpers/invalid';

const mockDesktopAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: false,
    on: jest.fn<void, [string, (...args: unknown[]) => void]>(),
    checkForUpdates: jest.fn(),
    downloadUpdate: jest.fn(),
    quitAndInstall: jest.fn(),
};
const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debugLogEnabled: jest.fn(() => false),
    writeDebug: jest.fn(),
};
const mockMetadata = {
    getUpdateCheckData: jest.fn(() => ({ lastCheck: null, skipVersion: null })),
    setLastUpdateCheck: jest.fn(),
    getLegacySkipVersion: jest.fn(() => null),
    clearLegacySkipVersion: jest.fn(() => true),
};
const mockSettings = {
    getSetting: jest.fn(),
    setSetting: jest.fn(() => true),
    seedIntentProfiles: jest.fn(),
};
const mockCheckForUpdates = jest.fn();
const mockDownloadAndInstall = jest.fn();

jest.mock('electron', () => ({
    app: { getVersion: jest.fn(() => '0.0.0'), isPackaged: false },
}));
jest.mock('electron-updater', () => ({ autoUpdater: mockDesktopAutoUpdater }));
jest.mock('../../src/ts/core/logger', () => ({ ...mockLogger, withCategory: jest.fn(() => mockLogger) }));
jest.mock('../../src/ts/core/metadata', () => mockMetadata);
jest.mock('../../src/ts/core/settings', () => mockSettings);
jest.mock('../../src/ts/core/services/visionVerifier', () => ({ hasBundledModel: jest.fn(async () => true) }));
jest.mock('../../src/ts/shells/electron/windows/quitGuard', () => ({ bypassQuitGuard: jest.fn() }));
jest.mock('../../src/ts/core/services/UpdateChecker', () => ({
    checkForUpdates: mockCheckForUpdates,
    getReleasesUrl: jest.fn(() => 'https://example.invalid/releases'),
}));
jest.mock('../../src/ts/shells/capacitor/AndroidUpdateInstaller', () => ({
    downloadAndInstall: mockDownloadAndInstall,
}));
jest.mock('../../src/ts/core/ipc/settings.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/ipc/voting.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/ipc/log.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/ipc/actions.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/ipc/computations.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/ipc/currency.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/ipc/scenarios.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/core/services/auth', () => {
    class LogoutNotSavedError extends Error {}
    return { logout: jest.fn(async () => true), LogoutNotSavedError };
});

// ---------------------------------------------------------------- type helpers

/** Exactly the same type, not merely mutually assignable (`any` and `unknown` are not equal to anything else). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Whether a value of type `From` can be used where `To` is expected. */
type IsAssignable<From, To> = [From] extends [To] ? true : false;
/** Fails to compile unless `T` is `true`. */
type Holds<T extends true> = T;
/** The checks apply only while the link version is 2 (a bump brings its own contract and test). */
type WhileV3<T> = typeof LINK_VERSION extends 3 ? T : true;

type KebabToCamel<S extends string> = S extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<KebabToCamel<Tail>>}`
    : S;
/** The window.api method of a channel: `apply-turbo-to-entry` is alias-only. */
type MethodOf<C extends string> = C extends 'apply-turbo-to-entry' ? 'applyTurbo' : KebabToCamel<C>;
type CurrentMethod<C extends keyof ChannelsV3> = WindowApi[MethodOf<C> & keyof WindowApi];
type CurrentArgs<C extends keyof ChannelsV3> = Parameters<CurrentMethod<C>>;
type CurrentResult<C extends keyof ChannelsV3> = Awaited<ReturnType<CurrentMethod<C>>>;

/** Every member of a map of checks is `true`. */
type AllTrue<M> = Equal<M[keyof M], true>;

// ---------------------------------------------------------------- the channels

type ArgsKept = { [C in keyof ChannelsV3]: IsAssignable<ChannelsV3[C]['args'], CurrentArgs<C>> };
type ResultsKept = { [C in keyof ChannelsV3]: IsAssignable<CurrentResult<C>, ChannelsV3[C]['result']> };
/** Each frozen channel is still a method of window.api (a removed or renamed one has no entry). */
type MethodsKept = { [C in keyof ChannelsV3]: MethodOf<C> extends keyof WindowApi ? true : false };

// ---------------------------------------------------------------- events, state, envelopes, settings

/** The named live producer payloads must still fit each frozen event. */
type EventsKept = {
    settingsChanged: IsAssignable<ConfigV2, EventPayloadsV3['settings-changed']>;
    updateAvailable: IsAssignable<UpdateSummary, EventPayloadsV3['update-available']>;
    updateDownloaded: IsAssignable<UpdateSummary, EventPayloadsV3['update-downloaded']>;
    downloadProgress: IsAssignable<DownloadProgress, EventPayloadsV3['update-download-progress']>;
    logMessage: IsAssignable<GuiLogEntry, EventPayloadsV3['log-message']>;
    effectiveSettings: IsAssignable<EffectiveSettings, EventPayloadsV3['effective-settings-changed']>;
    effectivePresentation: IsAssignable<EffectivePresentation, EventPayloadsV3['effective-presentation-changed']>;
};

type StateKept = {
    state: IsAssignable<AutovoteState, AutovoteStateV3>;
    status: Equal<AutovoteState['status'], AutovoteStateV3['status']>;
    statusClass: Equal<AutovoteState['statusClass'], AutovoteStateV3['statusClass']>;
    // The fields version 3 added: the mode and the refusal are closed unions, the Stop result is the controller's own.
    executionMode: Equal<AutovoteState['executionMode'], AutovoteStateV3['executionMode']>;
    startRefusal: Equal<AutovoteState['startRefusal'], AutovoteStateV3['startRefusal']>;
    lastStop: IsAssignable<AutovoteState['lastStop'], AutovoteStateV3['lastStop']>;
    lastStopBack: IsAssignable<AutovoteStateV3['lastStop'], AutovoteState['lastStop']>;
    stopEpoch: Equal<AutovoteState['stopEpoch'], AutovoteStateV3['stopEpoch']>;
    message: IsAssignable<AutovoteStateMessage, AutovoteStateMessageV3>;
    messageBack: IsAssignable<AutovoteStateMessageV3, AutovoteStateMessage>;
};

type FailedResult = Extract<ResultMessage, { ok: false }>;
type FailedResultV3 = Extract<ResultMessageV3, { ok: false }>;
type EnvelopesKept = {
    hello: IsAssignable<HelloMessage, HelloMessageV3>;
    helloBack: IsAssignable<HelloMessageV3, HelloMessage>;
    invoke: IsAssignable<InvokeMessage, InvokeMessageV3>;
    invokeBack: IsAssignable<InvokeMessageV3, InvokeMessage>;
    result: IsAssignable<ResultMessage, ResultMessageV3>;
    resultBack: IsAssignable<ResultMessageV3, ResultMessage>;
    event: IsAssignable<EventMessage, EventMessageV3>;
    eventBack: IsAssignable<EventMessageV3, EventMessage>;
    command: IsAssignable<AutovoteCommandMessage, AutovoteCommandMessageV3>;
    commandBack: IsAssignable<AutovoteCommandMessageV3, AutovoteCommandMessage>;
    bye: IsAssignable<ByeMessage, ByeMessageV3>;
    byeBack: IsAssignable<ByeMessageV3, ByeMessage>;
    peer: IsAssignable<PeerMessage, PeerMessageV3>;
    peerBack: IsAssignable<PeerMessageV3, PeerMessage>;
    // The closed unions: a new value would reach an older peer that does not know it.
    resultReason: Equal<FailedResult['reason'], FailedResultV3['reason']>;
    byeReason: Equal<ByeMessage['reason'], ByeMessageV3['reason']>;
    commandName: Equal<AutovoteCommandMessage['command'], AutovoteCommandMessageV3['command']>;
    commandNameType: Equal<AutovoteCommandName, AutovoteCommandMessageV3['command']>;
    ack: IsAssignable<CommandAck, CommandAckV3>;
    ackBack: IsAssignable<CommandAckV3, CommandAck>;
    ackOutcome: Equal<CommandAck['outcome'], CommandAckV3['outcome']>;
    control: IsAssignable<ControlReport, ControlReportV3>;
    controlBack: IsAssignable<ControlReportV3, ControlReport>;
};

type SettingsKept = {
    [K in keyof SettingValuesV3]: K extends keyof SettingValues ? Equal<SettingValues[K], SettingValuesV3[K]> : false;
};
type SettingRegistryIsComplete = Equal<keyof SettingValuesV3, keyof SettingValues>;

// ---------------------------------------------------------------- the broken fixtures (each must read false)

type Broken = { __broken: true };
type BrokenKinds = {
    // An argument the handler does not take, and too few arguments for it.
    argumentOfAnotherType: IsAssignable<[challengeId: boolean], CurrentArgs<'vote-on-challenge'>>;
    tooFewArguments: IsAssignable<[], CurrentArgs<'vote-on-challenge'>>;
    // A result that lost a field the frozen one has, and a frozen result nothing can satisfy.
    resultMissingAField: IsAssignable<CurrentResult<'get-bankroll'>, Broken>;
    frozenResultIsNotVacuous: IsAssignable<Broken, ChannelsV3['get-bankroll']['result']>;
    frozenArgumentsAreNotVacuous: IsAssignable<[Broken], ChannelsV3['vote-on-challenge']['args']>;
    eventLostAField: IsAssignable<ConfigV2, Broken>;
    frozenEventIsNotVacuous: IsAssignable<Broken, EventPayloadsV3['update-available']>;
    stateLostAField: IsAssignable<AutovoteState, Broken>;
    frozenStateIsNotVacuous: IsAssignable<Broken, AutovoteStateV3>;
    // A closed union that grew, and one that shrank.
    unionGrew: Equal<'start' | 'stop' | 'rearm' | 'pause', AutovoteCommandMessageV3['command']>;
    unionShrank: Equal<'start' | 'stop', AutovoteCommandMessageV3['command']>;
    ackGrew: Equal<'ran' | 'failed' | 'duplicate' | 'stop-epoch-moved' | 'lost', CommandAckV3['outcome']>;
    modeGrew: Equal<'stopped' | 'armed' | 'voting' | 'paused', AutovoteStateV3['executionMode']>;
    lifecycleResultNotVacuous: IsAssignable<Broken, ChannelsV3['get-stop-status']['result']>;
    lifecycleArgumentsNotVacuous: IsAssignable<[Broken], ChannelsV3['handoff-scenario']['args']>;
    simulateArgumentsNotVacuous: IsAssignable<[Broken], ChannelsV3['simulate-scenario']['args']>;
    effectiveEventNotVacuous: IsAssignable<Broken, EventPayloadsV3['effective-settings-changed']>;
    currentLifecycleNotVacuous: Equal<CurrentResult<'get-stop-status'>, unknown>;
    // A setting whose enum gained a member, and a vacuous one.
    settingGrew: Equal<'a' | 'b', 'a' | 'b' | 'c'>;
    settingIsNotVacuous: Equal<unknown, SettingValuesV3['exposure']>;
    // The living side gone vacuous would let anything through: fixtures read it back.
    currentArgsNotVacuous: Equal<CurrentArgs<'vote-on-challenge'>, unknown[]>;
    currentResultNotVacuous: Equal<CurrentResult<'get-bankroll'>, unknown>;
};

export type Checks = [
    Holds<WhileV3<AllTrue<MethodsKept>>>,
    Holds<WhileV3<AllTrue<ArgsKept>>>,
    Holds<WhileV3<AllTrue<ResultsKept>>>,
    Holds<WhileV3<AllTrue<EventsKept>>>,
    Holds<WhileV3<AllTrue<StateKept>>>,
    Holds<WhileV3<AllTrue<EnvelopesKept>>>,
    Holds<WhileV3<AllTrue<SettingsKept>>>,
    Holds<WhileV3<ChannelListIsComplete>>,
    Holds<WhileV3<SettingListIsComplete>>,
    Holds<WhileV3<SettingRegistryIsComplete>>,
    // Every broken fixture reads false.
    Holds<WhileV3<Equal<BrokenKinds[keyof BrokenKinds], false>>>,
];

// ---------------------------------------------------------------- the runtime registries

/** Every channel the contract freezes (the keys of ChannelsV3). */
const FROZEN_CHANNELS = [
    'acknowledge-import-report',
    'apply-boost-to-entry',
    'apply-challenge-profile',
    'apply-turbo-to-entry',
    'can-auto-update',
    'check-for-updates',
    'check-scenario',
    'cleanup-stale-challenge-setting',
    'cleanup-stale-metadata',
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
    'start-log-stream',
    'stop-log-stream',
    'submit-picked-photos',
    'suggest-photos',
    'swap-back-entry-photo',
    'swap-entry-photo',
    'vote-all-challenges-manual',
    'vote-on-challenge',
    'vote-on-challenge-manual',
] as const;
type ChannelListIsComplete = Equal<(typeof FROZEN_CHANNELS)[number], keyof ChannelsV3>;

/** The frozen channels that spend account currency (the postOnce rule: the phone answers "unclear" on a lost connection). */
const FROZEN_SPEND_CHANNELS = [
    'apply-turbo-to-entry',
    'fill-exposure',
    'join-challenge',
    'key-unlock-boost',
    'play-auto-turbo',
    'run-voting-cycle-for-challenge',
    'swap-back-entry-photo',
    'swap-entry-photo',
    'vote-all-challenges-manual',
] as const satisfies readonly (keyof ChannelsV3)[];

/** The frozen channels the host answers itself instead of forwarding to window.api. */
const FROZEN_HOST_ANSWERED_CHANNELS = [
    'cleanup-stale-metadata',
    'start-log-stream',
    'stop-log-stream',
] as const satisfies readonly (keyof ChannelsV3)[];

/** The channels version 3 added that only read: they may wait for the host's hello and be asked again. */
const FROZEN_READ_CHANNELS = [
    'get-scenario-capabilities',
    'get-scenario-snapshot',
    'get-effective-installation-settings',
    'get-effective-presentation',
    'list-simulation-subjects',
    'get-installation-scenario',
    'get-stop-status',
    'get-photo-pools',
    'get-effective-entry-pins',
    'get-scenario-request-status',
] as const satisfies readonly (keyof ChannelsV3)[];

/** The channels version 3 served that are effects: never queued before the host's hello, never sent again. */
const FROZEN_EFFECT_CHANNELS = [
    'set-installation-scenario',
    'pause-scenario',
    'resume-scenario',
    'handoff-scenario',
    'clear-scenario-assignment',
    'set-photo-pool',
    'delete-photo-pool',
    'rename-photo-pool',
] as const satisfies readonly (keyof ChannelsV3)[];

/** The channels of the manifest a paired phone is refused, version 3's controller and inbox routes among them. */
const FROZEN_LOCAL_ONLY_CHANNELS = [
    'transfer-installation-scenario-owner',
    'scenario-stop-fence',
    'record-full-stop',
    'arm-autovote',
    'arm-if-allowed',
    'withdraw-installation',
    'rearm-installation',
    'get-account-wake',
    'begin-scenario-request',
    'finish-scenario-request',
];

/** The events a host sends; a peer sending one is refused. */
const FROZEN_EVENT_PAYLOAD_CHANNELS: { [K in keyof EventPayloadsV3]: true } = {
    'settings-changed': true,
    'update-checking': true,
    'update-available': true,
    'update-not-available': true,
    'update-download-progress': true,
    'update-downloaded': true,
    'update-error': true,
    'log-message': true,
    'effective-settings-changed': true,
    'effective-presentation-changed': true,
};

/** The class a frozen channel had when version 3 was cut: a read, a spend, or an effect. */
const frozenClass = (channel: string): 'read' | 'spend' | 'effect' => {
    if ((FROZEN_SPEND_CHANNELS as readonly string[]).includes(channel)) return 'spend';
    if ((FROZEN_READ_CHANNELS as readonly string[]).includes(channel)) return 'read';
    const readsOfVersion2 = FROZEN_CHANNELS.filter(
        (name) =>
            name.startsWith('get-') ||
            [
                'check-scenario',
                'dry-run-scenario',
                'simulate-scenario',
                'preview-scenario-import',
                'export-scenario',
                'is-global-default-modified',
                'is-setting-modified',
                'preview-swap-photo',
                'search-photo-tags',
                'should-cancel-voting',
                'suggest-photos',
                'can-auto-update',
                'check-for-updates',
                'cleanup-stale-metadata',
                'refresh-api',
                'start-log-stream',
                'stop-log-stream',
            ].includes(name),
    );
    return (readsOfVersion2 as readonly string[]).includes(channel) ? 'read' : 'effect';
};

/** Every setting key the contract freezes (the keys of SettingValuesV3). */
const FROZEN_SETTING_KEYS = [
    'autoTurbo',
    'exposure',
    'scenario',
    'skipUpdateVersion',
    'exposureTarget',
    'onlyBoost',
    'voteOnNewEntry',
    'manualPhotosOnly',
    'discoverUpcomingHours',
    'autovoteStartupDelay',
    'compactCards',
    'compactCardActions',
    'autoBoost',
    'boostTime',
    'voteBeforeBoost',
    'voteBeforeBoostLeadMin',
    'keyUnlockedBoostTime',
    'boostFreshEntryWait',
    'boostOnSleep',
    'boostImageIndex',
    'boostNewSubmit',
    'boostNewSubmitOnConflict',
    'boostPinnedSubmit',
    'useTurbo',
    'turboTime',
    'turboImageIndex',
    'turboNewSubmit',
    'turboNewSubmitOnConflict',
    'snapYesWithoutModel',
    'autoKeyUnlock',
    'autoKeyAfterStart',
    'autoKeyBeforeEnd',
    'autoKeyAfterPercent',
    'autoSwap',
    'autoSwapAfterStart',
    'autoSwapBeforeEnd',
    'autoSwapAfterPercent',
    'autoSwapImageIndex',
    'autoSwapLowestVotes',
    'autoSwapAllowBoosted',
    'autoSwapMaxVotes',
    'autoSwapMax',
    'autoExposureFill',
    'autoExposureFillBelow',
    'autoExposureFillAfterStart',
    'autoExposureFillBeforeEnd',
    'autoExposureFillAfterPercent',
    'autoExposureFillMax',
    'currencyReserveKeys',
    'currencyReserveSwaps',
    'currencyReserveFills',
    'finalWindowDuration',
    'useFinalWindowExposure',
    'finalWindowExposure',
    'finalWindowExposureTarget',
    'voteBeforeFinalWindow',
    'voteBeforeFinalWindowLeadMin',
    'voteOnlyInLastMinute',
    'lastMinuteThreshold',
    'lastMinuteCheckFrequency',
    'useScheduledFill',
    'scheduledFillTime',
    'scheduledFillBeforeEnd',
    'scheduledFillWindowMinutes',
    'scheduledFillReplaces',
    'useVotingPause',
    'votingPauseTime',
    'votingPauseBeforeEnd',
    'votingPauseDurationMinutes',
    'autoJoin',
    'autoJoinShortChallengesImmediately',
    'autoJoinTypes',
    'autoJoinExcludeTypes',
    'autoJoinChallengeTags',
    'autoJoinExcludeChallengeTags',
    'autoJoinAfterHoursFromStart',
    'autoJoinAfterPercentElapsed',
    'autoJoinWithinHoursOfEnd',
    'autoJoinMaxCoins',
    'autoJoinCycleCoinBudget',
    'autoSubmit',
    'protectUncertainAutoSubmits',
    'autoSubmitSchedule',
    'autoSubmitTime',
    'autoSubmitWindowMinutes',
    'submitWithoutTagMatch',
    'emergencySubmit',
    'mustIncludeTags',
    'shouldIncludeTags',
    'chosenPhotos',
    'chosenPhotosOnly',
    'chosenPhotosInOrder',
    'ignoreTitleWords',
    'autoClaimPrizes',
    'missionSaveTurbos',
    'missionJoinEarly',
    'missionUseFills',
    'missionUseBoosts',
    'missionVote',
    'notifyOnScenario',
    'notifyOnBoost',
    'notifyOnTurbo',
    'notifyOnAutoSubmit',
    'notifyOnEmergencySubmit',
    'notifyLeadTime',
    'autovoteRunning',
    'autovoteStartedLaunch',
    'noticeAcknowledgedVersion',
] as const;
type SettingListIsComplete = Equal<(typeof FROZEN_SETTING_KEYS)[number], keyof SettingValuesV3>;

/** The frozen channels the manifest no longer has (a renamed or removed one breaks every older page that calls it). */
export const channelsMissingFromManifest = (channels: readonly string[], manifest: readonly string[]): string[] =>
    channels.filter((channel) => !manifest.includes(channel));

/** The frozen channels a desktop no longer serves a phone (refused outright). */
export const channelsNoLongerServed = (channels: readonly string[]): string[] =>
    channels.filter((channel) => classifyRemoteChannel(channel).kind === 'refused');

/** The frozen channels whose host-answered class changed in either direction. */
const channelsWithHostClassDrift = (
    channels: readonly string[],
    frozenHostAnswered: readonly string[],
    classify: (channel: string) => RemoteChannelClass,
): string[] =>
    channels.filter((channel) => (classify(channel).kind === 'host') !== frozenHostAnswered.includes(channel));

/** The frozen channels whose spend class moved either way. */
export const channelsWithSpendDrift = (
    channels: readonly string[],
    frozenSpend: readonly string[],
    currentSpend: ReadonlySet<string>,
): string[] => channels.filter((channel) => currentSpend.has(channel) !== frozenSpend.includes(channel));

/** The frozen setting keys the schema no longer has. */
export const settingKeysMissingFromSchema = (keys: readonly string[], schema: object): string[] =>
    keys.filter((key) => !(key in schema));

const linkVersion: number = LINK_VERSION;
const whileLinkVersion3 = linkVersion === 3 ? describe : describe.skip;

whileLinkVersion3('the link version 3 contract', () => {
    test('Auto-Submit clock settings are part of the frozen V3 setting registry', () => {
        expect(SETTINGS_SCHEMA).toHaveProperty('autoSubmitTime');
        expect(SETTINGS_SCHEMA).toHaveProperty('autoSubmitWindowMinutes');
        expect(FROZEN_SETTING_KEYS).toContain('autoSubmitTime');
        expect(FROZEN_SETTING_KEYS).toContain('autoSubmitWindowMinutes');
    });

    test('every frozen channel is still in the manifest', () => {
        expect(channelsMissingFromManifest(FROZEN_CHANNELS, allInvokeChannels())).toEqual([]);
    });

    test('every frozen channel is still served to a phone (allowed or answered by the host)', () => {
        expect(channelsNoLongerServed(FROZEN_CHANNELS)).toEqual([]);
    });

    test('the host-answered class of every frozen channel is unchanged', () => {
        expect(
            channelsWithHostClassDrift(FROZEN_CHANNELS, FROZEN_HOST_ANSWERED_CHANNELS, classifyRemoteChannel),
        ).toEqual([]);
    });

    test('the frozen channels are the complete current served channel registry', () => {
        const served = allInvokeChannels().filter((channel) => classifyRemoteChannel(channel).kind !== 'refused');
        expect(channelsMissingFromManifest(served, FROZEN_CHANNELS)).toEqual([]);
    });

    test('the spend class of every frozen channel is unchanged', () => {
        expect(channelsWithSpendDrift(FROZEN_CHANNELS, FROZEN_SPEND_CHANNELS, SPEND_REMOTE_CHANNELS)).toEqual([]);
    });

    test('the settings schema still has every frozen key', () => {
        expect(settingKeysMissingFromSchema(FROZEN_SETTING_KEYS, SETTINGS_SCHEMA)).toEqual([]);
    });

    test('the frozen settings are the complete current schema registry', () => {
        const frozenSchema = Object.fromEntries(FROZEN_SETTING_KEYS.map((key) => [key, true]));
        expect(settingKeysMissingFromSchema(Object.keys(SETTINGS_SCHEMA), frozenSchema)).toEqual([]);
    });

    test('the parser drops a result with a reason it does not know, which is why a new reason needs a bump', () => {
        const failed = { t: 'result', id: 1, ok: false, error: 'x' };
        expect(parsePeerMessage({ ...failed, reason: 'too-large' })).not.toBeNull();
        expect(parsePeerMessage({ ...failed, reason: 'unsendable' })).not.toBeNull();
        expect(parsePeerMessage({ ...failed, reason: 'a-new-reason' })).toBeNull();
    });

    test('the live update producers forward the frozen checking, version, message, and code bodies', async () => {
        mockDesktopAutoUpdater.on.mockClear();
        const send = jest.fn<void, [string, unknown]>();
        const { AutoUpdater } = require('../../src/ts/shells/electron/AutoUpdater') as typeof AutoUpdaterModule;
        new AutoUpdater(invalid({ isDestroyed: () => false, webContents: { send } }));

        mockDesktopAutoUpdater.on.mock.calls.find(([event]) => event === 'checking-for-update')?.[1]();
        expect(send).toHaveBeenLastCalledWith('update-checking', null);

        mockDesktopAutoUpdater.on.mock.calls.find(([event]) => event === 'update-not-available')?.[1]({
            version: '2.0.0',
        });
        expect(send).toHaveBeenLastCalledWith('update-not-available', { version: '2.0.0' });

        mockDesktopAutoUpdater.on.mock.calls.find(([event]) => event === 'error')?.[1](new Error('Update failed'));
        expect(send).toHaveBeenLastCalledWith('update-error', { message: 'Update failed' });

        mockSettings.getSetting.mockReturnValue('');
        const bridge = require('../../src/ts/shells/capacitor/bridge/capacitor') as typeof CapacitorBridgeModule;
        const api = bridge.installBridge();
        const onNotAvailable = jest.fn<void, never[]>();
        const onError = jest.fn<void, never[]>();
        api.onUpdateNotAvailable(onNotAvailable);
        api.onUpdateError(onError);

        mockCheckForUpdates.mockResolvedValueOnce({
            updateAvailable: false,
            version: '2.0.0',
        });
        await api.checkForUpdates();
        expect(onNotAvailable).toHaveBeenLastCalledWith({ version: '2.0.0' });

        mockCheckForUpdates.mockResolvedValueOnce({
            updateAvailable: true,
            version: '2.0.1',
            releaseNotes: 'notes',
            releaseDate: '2026-01-01',
            isPrerelease: false,
            downloadUrl: 'https://example.invalid/update.apk',
        });
        await api.checkForUpdates();
        mockDownloadAndInstall.mockResolvedValueOnce({ success: false, error: 'Digest mismatch', code: 'digest' });
        await api.downloadUpdate();
        expect(onError).toHaveBeenLastCalledWith({ message: 'Digest mismatch', code: 'digest' });
    });

    test('the channels version 3 serves are classified read, effect or spend, one class each, and nothing refused is among them', () => {
        const classes = FROZEN_CHANNELS.map((channel) => [channel, classifyRemoteOperation(channel)] as const);
        for (const [channel, kind] of classes) {
            expect(kind).toBe(frozenClass(channel));
        }
        expect(FROZEN_READ_CHANNELS.filter((channel) => !READ_REMOTE_CHANNELS.has(channel))).toEqual([]);
        expect(FROZEN_EFFECT_CHANNELS.filter((channel) => classifyRemoteOperation(channel) !== 'effect')).toEqual([]);
        expect(channelsNoLongerServed(FROZEN_CHANNELS)).toEqual([]);
    });

    test('the channels version 3 refuses a paired phone stay refused, each with a reason', () => {
        for (const channel of FROZEN_LOCAL_ONLY_CHANNELS) {
            const classified = classifyRemoteChannel(channel);
            expect(classified.kind).toBe('refused');
            expect(classified.kind === 'refused' && classified.reason.length > 0).toBe(true);
        }
        expect(channelsMissingFromManifest(FROZEN_LOCAL_ONLY_CHANNELS, allInvokeChannels())).toEqual([]);
    });

    test('the events flow from the computer to the phone only: a peer sending one is refused', () => {
        for (const channel of Object.keys(FROZEN_EVENT_PAYLOAD_CHANNELS)) {
            expect(classifyRemoteChannel(channel).kind).toBe('refused');
        }
    });

    test('a Stop is the priority operation; a Start and a re-arm are effects', () => {
        expect(classifyRemoteCommand('stop')).toBe('priority-stop');
        expect(classifyRemoteCommand('start')).toBe('effect');
        expect(classifyRemoteCommand('rearm')).toBe('effect');
    });

    test('the parser keeps the identities of version 3 and drops what is not one of its shapes', () => {
        const invoke = { t: 'invoke', id: 1, channel: 'pause-scenario', args: ['7'] };
        expect(parsePeerMessage({ ...invoke, requestId: 'r1', expectedRevision: 2 })).toEqual({
            ...invoke,
            requestId: 'r1',
            expectedRevision: 2,
        });
        expect(parsePeerMessage({ ...invoke, requestId: '' })).toBeNull();
        expect(parsePeerMessage({ ...invoke, expectedRevision: -1 })).toBeNull();
        const control = { requestId: 'r1', target: '7', revision: 3 };
        expect(parsePeerMessage({ t: 'result', id: 1, ok: true, result: {}, control })).toMatchObject({ control });
        expect(parsePeerMessage({ t: 'result', id: 1, ok: false, error: 'x', control })).toMatchObject({ control });
        expect(parsePeerMessage({ t: 'result', id: 1, ok: true, control: { requestId: 'r1' } })).toBeNull();
        expect(parsePeerMessage({ t: 'autovote-command', command: 'stop' })).toBeNull();
        expect(parsePeerMessage({ t: 'autovote-command', command: 'stop', requestId: 'r1' })).toEqual({
            t: 'autovote-command',
            command: 'stop',
            requestId: 'r1',
        });
        expect(
            parsePeerMessage({ t: 'autovote-command', command: 'start', requestId: 'r', expectedStopEpoch: 1.5 }),
        ).toBeNull();
    });

    test('the parser drops a state or an acknowledgment of a shape version 3 does not know', () => {
        const state = {
            running: false,
            executionMode: 'stopped',
            stopEpoch: 1,
            lastStop: { outcome: 'requested', durable: false },
            startRefusal: null,
            cycles: 0,
            lastRun: null,
            nextRunAt: null,
            pendingStartAt: null,
            status: 'Stopped',
            statusClass: 'badge-neutral',
            error: null,
        };
        const message = { t: 'autovote-state', state, hostRun: 'run', n: 0 };
        expect(parsePeerMessage(message)).not.toBeNull();
        expect(parsePeerMessage({ ...message, state: { ...state, executionMode: 'paused' } })).toBeNull();
        expect(parsePeerMessage({ ...message, state: { ...state, lastStop: { outcome: 'stopped' } } })).toBeNull();
        expect(parsePeerMessage({ ...message, state: { ...state, lastStop: 'stopped' } })).toBeNull();
        expect(parsePeerMessage({ ...message, state: { ...state, startRefusal: 'made-up' } })).toBeNull();
        const ack = { requestId: 'r1', command: 'stop', outcome: 'ran' };
        expect(parsePeerMessage({ ...message, ack })).toMatchObject({ ack });
        expect(parsePeerMessage({ ...message, ack: { ...ack, outcome: 'lost' } })).toBeNull();
        const older: Record<string, unknown> = { ...state };
        delete older.executionMode;
        expect(parsePeerMessage({ ...message, state: older })).toBeNull();
    });

    describe('a broken fixture fails each runtime check', () => {
        test('a channel the manifest lacks is reported', () => {
            expect(channelsMissingFromManifest([...FROZEN_CHANNELS, 'a-renamed-channel'], allInvokeChannels())).toEqual(
                ['a-renamed-channel'],
            );
        });

        test('a current served channel omitted from the frozen registry is reported', () => {
            expect(channelsMissingFromManifest(['get-bankroll'], [])).toEqual(['get-bankroll']);
        });

        test('a refused channel and an unknown one are reported as no longer served', () => {
            expect(channelsNoLongerServed([...FROZEN_CHANNELS, 'authenticate', 'a-renamed-channel'])).toEqual([
                'authenticate',
                'a-renamed-channel',
            ]);
        });

        test('host-to-allowed and allowed-to-host transitions are reported', () => {
            const hostToAllowed = (channel: string): RemoteChannelClass =>
                channel === 'start-log-stream' ? { kind: 'allowed' } : classifyRemoteChannel(channel);
            expect(channelsWithHostClassDrift(FROZEN_CHANNELS, FROZEN_HOST_ANSWERED_CHANNELS, hostToAllowed)).toEqual([
                'start-log-stream',
            ]);
            const allowedToHost = (channel: string): RemoteChannelClass =>
                channel === 'get-bankroll' ? { kind: 'host' } : classifyRemoteChannel(channel);
            expect(channelsWithHostClassDrift(FROZEN_CHANNELS, FROZEN_HOST_ANSWERED_CHANNELS, allowedToHost)).toEqual([
                'get-bankroll',
            ]);
        });

        test('a channel that became a spend, and one that stopped being one, are both reported', () => {
            const widened = new Set([...SPEND_REMOTE_CHANNELS, 'get-bankroll']);
            expect(channelsWithSpendDrift(FROZEN_CHANNELS, FROZEN_SPEND_CHANNELS, widened)).toEqual(['get-bankroll']);
            const narrowed = new Set([...SPEND_REMOTE_CHANNELS].filter((channel) => channel !== 'join-challenge'));
            expect(channelsWithSpendDrift(FROZEN_CHANNELS, FROZEN_SPEND_CHANNELS, narrowed)).toEqual([
                'join-challenge',
            ]);
        });

        test('a setting key the schema lacks is reported', () => {
            expect(settingKeysMissingFromSchema([...FROZEN_SETTING_KEYS, 'aRemovedSetting'], SETTINGS_SCHEMA)).toEqual([
                'aRemovedSetting',
            ]);
        });

        test('a current schema key omitted from the frozen registry is reported', () => {
            expect(settingKeysMissingFromSchema(['autoSubmitTime'], {})).toEqual(['autoSubmitTime']);
        });
    });
});
