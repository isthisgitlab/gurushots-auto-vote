/**
 * The link version 2 contract (src/ts/core/remote/contract/v2/): the living types and registries are held inside
 * what was frozen when link version 2 was cut, so an older page and a newer desktop (or the reverse) still
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
import { SPEND_REMOTE_CHANNELS, classifyRemoteChannel } from '../../src/ts/core/remote/allowlist';
import { allInvokeChannels } from '../../src/ts/core/ipc/manifest';
import { SETTINGS_SCHEMA } from '../../src/ts/core/settings/schema';

import type { AutovoteState } from '../../src/ts/core/autovote/state';
import type {
    AutovoteCommandMessage,
    AutovoteCommandName,
    AutovoteStateMessage,
    ByeMessage,
    EventMessage,
    HelloMessage,
    InvokeMessage,
    PeerMessage,
    ResultMessage,
} from '../../src/ts/core/remote/protocol';
import type {
    AutovoteCommandMessageV2,
    AutovoteStateMessageV2,
    AutovoteStateV2,
    ByeMessageV2,
    ChannelsV2,
    EventMessageV2,
    EventPayloadsV2,
    HelloMessageV2,
    InvokeMessageV2,
    PeerMessageV2,
    ResultMessageV2,
    SettingValuesV2,
} from '../../src/ts/core/remote/contract/v2';
import type { GuiLogEntry } from '../../src/ts/core/logger/types';
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
type WhileV2<T> = typeof LINK_VERSION extends 2 ? T : true;

type KebabToCamel<S extends string> = S extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<KebabToCamel<Tail>>}`
    : S;
/** The window.api method of a channel: `apply-turbo-to-entry` is alias-only. */
type MethodOf<C extends string> = C extends 'apply-turbo-to-entry' ? 'applyTurbo' : KebabToCamel<C>;
type CurrentMethod<C extends keyof ChannelsV2> = WindowApi[MethodOf<C> & keyof WindowApi];
type CurrentArgs<C extends keyof ChannelsV2> = Parameters<CurrentMethod<C>>;
type CurrentResult<C extends keyof ChannelsV2> = Awaited<ReturnType<CurrentMethod<C>>>;

/** Every member of a map of checks is `true`. */
type AllTrue<M> = Equal<M[keyof M], true>;

// ---------------------------------------------------------------- the channels

type ArgsKept = { [C in keyof ChannelsV2]: IsAssignable<ChannelsV2[C]['args'], CurrentArgs<C>> };
type ResultsKept = { [C in keyof ChannelsV2]: IsAssignable<CurrentResult<C>, ChannelsV2[C]['result']> };
/** Each frozen channel is still a method of window.api (a removed or renamed one has no entry). */
type MethodsKept = { [C in keyof ChannelsV2]: MethodOf<C> extends keyof WindowApi ? true : false };

// ---------------------------------------------------------------- events, state, envelopes, settings

/** The named live producer payloads must still fit each frozen event. */
type EventsKept = {
    settingsChanged: IsAssignable<ConfigV2, EventPayloadsV2['settings-changed']>;
    updateAvailable: IsAssignable<UpdateSummary, EventPayloadsV2['update-available']>;
    updateDownloaded: IsAssignable<UpdateSummary, EventPayloadsV2['update-downloaded']>;
    downloadProgress: IsAssignable<DownloadProgress, EventPayloadsV2['update-download-progress']>;
    logMessage: IsAssignable<GuiLogEntry, EventPayloadsV2['log-message']>;
};

type StateKept = {
    state: IsAssignable<AutovoteState, AutovoteStateV2>;
    status: Equal<AutovoteState['status'], AutovoteStateV2['status']>;
    statusClass: Equal<AutovoteState['statusClass'], AutovoteStateV2['statusClass']>;
    message: IsAssignable<AutovoteStateMessage, AutovoteStateMessageV2>;
    messageBack: IsAssignable<AutovoteStateMessageV2, AutovoteStateMessage>;
};

type FailedResult = Extract<ResultMessage, { ok: false }>;
type FailedResultV2 = Extract<ResultMessageV2, { ok: false }>;
type EnvelopesKept = {
    hello: IsAssignable<HelloMessage, HelloMessageV2>;
    helloBack: IsAssignable<HelloMessageV2, HelloMessage>;
    invoke: IsAssignable<InvokeMessage, InvokeMessageV2>;
    invokeBack: IsAssignable<InvokeMessageV2, InvokeMessage>;
    result: IsAssignable<ResultMessage, ResultMessageV2>;
    resultBack: IsAssignable<ResultMessageV2, ResultMessage>;
    event: IsAssignable<EventMessage, EventMessageV2>;
    eventBack: IsAssignable<EventMessageV2, EventMessage>;
    command: IsAssignable<AutovoteCommandMessage, AutovoteCommandMessageV2>;
    commandBack: IsAssignable<AutovoteCommandMessageV2, AutovoteCommandMessage>;
    bye: IsAssignable<ByeMessage, ByeMessageV2>;
    byeBack: IsAssignable<ByeMessageV2, ByeMessage>;
    peer: IsAssignable<PeerMessage, PeerMessageV2>;
    peerBack: IsAssignable<PeerMessageV2, PeerMessage>;
    // The closed unions: a new value would reach an older peer that does not know it.
    resultReason: Equal<FailedResult['reason'], FailedResultV2['reason']>;
    byeReason: Equal<ByeMessage['reason'], ByeMessageV2['reason']>;
    commandName: Equal<AutovoteCommandMessage['command'], AutovoteCommandMessageV2['command']>;
    commandNameType: Equal<AutovoteCommandName, AutovoteCommandMessageV2['command']>;
};

type SettingsKept = {
    [K in keyof SettingValuesV2]: K extends keyof SettingValues ? Equal<SettingValues[K], SettingValuesV2[K]> : false;
};
type SettingRegistryIsComplete = Equal<keyof SettingValuesV2, keyof SettingValues>;

// ---------------------------------------------------------------- the broken fixtures (each must read false)

type Broken = { __broken: true };
type BrokenKinds = {
    // An argument the handler does not take, and too few arguments for it.
    argumentOfAnotherType: IsAssignable<[challengeId: boolean], CurrentArgs<'vote-on-challenge'>>;
    tooFewArguments: IsAssignable<[], CurrentArgs<'vote-on-challenge'>>;
    // A result that lost a field the frozen one has, and a frozen result nothing can satisfy.
    resultMissingAField: IsAssignable<CurrentResult<'get-bankroll'>, Broken>;
    frozenResultIsNotVacuous: IsAssignable<Broken, ChannelsV2['get-bankroll']['result']>;
    frozenArgumentsAreNotVacuous: IsAssignable<[Broken], ChannelsV2['vote-on-challenge']['args']>;
    eventLostAField: IsAssignable<ConfigV2, Broken>;
    frozenEventIsNotVacuous: IsAssignable<Broken, EventPayloadsV2['update-available']>;
    stateLostAField: IsAssignable<AutovoteState, Broken>;
    frozenStateIsNotVacuous: IsAssignable<Broken, AutovoteStateV2>;
    // A closed union that grew, and one that shrank.
    unionGrew: Equal<'start' | 'stop' | 'rearm' | 'pause', AutovoteCommandMessageV2['command']>;
    unionShrank: Equal<'start' | 'stop', AutovoteCommandMessageV2['command']>;
    // A setting whose enum gained a member, and a vacuous one.
    settingGrew: Equal<'a' | 'b', 'a' | 'b' | 'c'>;
    settingIsNotVacuous: Equal<unknown, SettingValuesV2['exposure']>;
    // The living side gone vacuous would let anything through: fixtures read it back.
    currentArgsNotVacuous: Equal<CurrentArgs<'vote-on-challenge'>, unknown[]>;
    currentResultNotVacuous: Equal<CurrentResult<'get-bankroll'>, unknown>;
};

export type Checks = [
    Holds<WhileV2<AllTrue<MethodsKept>>>,
    Holds<WhileV2<AllTrue<ArgsKept>>>,
    Holds<WhileV2<AllTrue<ResultsKept>>>,
    Holds<WhileV2<AllTrue<EventsKept>>>,
    Holds<WhileV2<AllTrue<StateKept>>>,
    Holds<WhileV2<AllTrue<EnvelopesKept>>>,
    Holds<WhileV2<AllTrue<SettingsKept>>>,
    Holds<WhileV2<ChannelListIsComplete>>,
    Holds<WhileV2<SettingListIsComplete>>,
    Holds<WhileV2<SettingRegistryIsComplete>>,
    // Every broken fixture reads false.
    Holds<WhileV2<Equal<BrokenKinds[keyof BrokenKinds], false>>>,
];

// ---------------------------------------------------------------- the runtime registries

/** Every channel the contract freezes (the keys of ChannelsV2). */
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
type ChannelListIsComplete = Equal<(typeof FROZEN_CHANNELS)[number], keyof ChannelsV2>;

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
] as const satisfies readonly (keyof ChannelsV2)[];

/** The frozen channels the host answers itself instead of forwarding to window.api. */
const FROZEN_HOST_ANSWERED_CHANNELS = [
    'cleanup-stale-metadata',
    'start-log-stream',
    'stop-log-stream',
] as const satisfies readonly (keyof ChannelsV2)[];

/** Every setting key the contract freezes (the keys of SettingValuesV2). */
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
type SettingListIsComplete = Equal<(typeof FROZEN_SETTING_KEYS)[number], keyof SettingValuesV2>;

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
const whileLinkVersion2 = linkVersion === 2 ? describe : describe.skip;

whileLinkVersion2('the link version 2 contract', () => {
    test('Auto-Submit clock settings are part of the frozen V2 setting registry', () => {
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
