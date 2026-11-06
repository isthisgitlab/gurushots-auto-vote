/**
 * The link version 1 contract (src/ts/core/remote/contract/v1/): the living types and registries are held inside
 * what was frozen when link version 1 was cut, so an older page and a newer desktop (or the reverse) still
 * understand each other. Everything here applies only while LINK_VERSION is 1; a bump comes with a new
 * `contract/v<N>/` and its own test.
 *
 * Compile-time checks run under `pnpm typecheck`:
 *   - arguments: the frozen arguments of every channel are assignable to the current handler's parameters, so the
 *     desktop still accepts what an older page sends;
 *   - results, event payloads and the auto-vote state: the current type is assignable to the frozen one, so the
 *     old fields are still there;
 *   - the message envelopes: assignable both ways, with each closed union (role, reasons, command names, status)
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
    AutovoteCommandMessageV1,
    AutovoteStateMessageV1,
    AutovoteStateV1,
    ByeMessageV1,
    ChannelsV1,
    EventMessageV1,
    EventPayloadsV1,
    HelloMessageV1,
    InvokeMessageV1,
    PeerMessageV1,
    ResultMessageV1,
    SettingValuesV1,
} from '../../src/ts/core/remote/contract/v1';
import type { GuiLogEntry } from '../../src/ts/core/logger/types';
import type { SettingValues } from '../../src/ts/core/settings/schema';
import type { ConfigV2 } from '../../src/ts/core/types/config';
import type { WindowApi } from '../../src/ts/core/types/ipc';
import type { DownloadProgress } from '../../src/ts/react/contexts/UpdateContext';
import type { UpdateSummary } from '../../src/ts/shells/electron/AutoUpdater';

// ---------------------------------------------------------------- type helpers

/** Exactly the same type, not merely mutually assignable (`any` and `unknown` are not equal to anything else). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Whether a value of type `From` can be used where `To` is expected. */
type IsAssignable<From, To> = [From] extends [To] ? true : false;
/** Fails to compile unless `T` is `true`. */
type Holds<T extends true> = T;
/** The checks apply only while the link version is 1 (a bump brings its own contract and test). */
type WhileV1<T> = typeof LINK_VERSION extends 1 ? T : true;

type KebabToCamel<S extends string> = S extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<KebabToCamel<Tail>>}`
    : S;
/** The window.api method of a channel: `apply-turbo-to-entry` is alias-only. */
type MethodOf<C extends string> = C extends 'apply-turbo-to-entry' ? 'applyTurbo' : KebabToCamel<C>;
type CurrentMethod<C extends keyof ChannelsV1> = WindowApi[MethodOf<C> & keyof WindowApi];
type CurrentArgs<C extends keyof ChannelsV1> = Parameters<CurrentMethod<C>>;
type CurrentResult<C extends keyof ChannelsV1> = Awaited<ReturnType<CurrentMethod<C>>>;

/** Every member of a map of checks is `true`. */
type AllTrue<M> = Equal<M[keyof M], true>;

// ---------------------------------------------------------------- the channels

type ArgsKept = { [C in keyof ChannelsV1]: IsAssignable<ChannelsV1[C]['args'], CurrentArgs<C>> };
type ResultsKept = { [C in keyof ChannelsV1]: IsAssignable<CurrentResult<C>, ChannelsV1[C]['result']> };
/** Each frozen channel is still a method of window.api (a removed or renamed one has no entry). */
type MethodsKept = { [C in keyof ChannelsV1]: MethodOf<C> extends keyof WindowApi ? true : false };

// ---------------------------------------------------------------- events, state, envelopes, settings

/** The producer side: the payload types the app has now must still fit the frozen ones. */
type EventsKept = {
    settingsChanged: IsAssignable<ConfigV2, EventPayloadsV1['settings-changed']>;
    updateAvailable: IsAssignable<UpdateSummary, EventPayloadsV1['update-available']>;
    updateDownloaded: IsAssignable<UpdateSummary, EventPayloadsV1['update-downloaded']>;
    downloadProgress: IsAssignable<DownloadProgress, EventPayloadsV1['update-download-progress']>;
    logMessage: IsAssignable<GuiLogEntry, EventPayloadsV1['log-message']>;
};

type StateKept = {
    state: IsAssignable<AutovoteState, AutovoteStateV1>;
    status: Equal<AutovoteState['status'], AutovoteStateV1['status']>;
    statusClass: Equal<AutovoteState['statusClass'], AutovoteStateV1['statusClass']>;
    message: IsAssignable<AutovoteStateMessage, AutovoteStateMessageV1>;
    messageBack: IsAssignable<AutovoteStateMessageV1, AutovoteStateMessage>;
};

type FailedResult = Extract<ResultMessage, { ok: false }>;
type FailedResultV1 = Extract<ResultMessageV1, { ok: false }>;
type EnvelopesKept = {
    hello: IsAssignable<HelloMessage, HelloMessageV1>;
    helloBack: IsAssignable<HelloMessageV1, HelloMessage>;
    invoke: IsAssignable<InvokeMessage, InvokeMessageV1>;
    invokeBack: IsAssignable<InvokeMessageV1, InvokeMessage>;
    result: IsAssignable<ResultMessage, ResultMessageV1>;
    resultBack: IsAssignable<ResultMessageV1, ResultMessage>;
    event: IsAssignable<EventMessage, EventMessageV1>;
    eventBack: IsAssignable<EventMessageV1, EventMessage>;
    command: IsAssignable<AutovoteCommandMessage, AutovoteCommandMessageV1>;
    commandBack: IsAssignable<AutovoteCommandMessageV1, AutovoteCommandMessage>;
    bye: IsAssignable<ByeMessage, ByeMessageV1>;
    byeBack: IsAssignable<ByeMessageV1, ByeMessage>;
    peer: IsAssignable<PeerMessage, PeerMessageV1>;
    peerBack: IsAssignable<PeerMessageV1, PeerMessage>;
    // The closed unions: a new value would reach an older peer that does not know it.
    helloRole: Equal<HelloMessage['role'], HelloMessageV1['role']>;
    resultReason: Equal<FailedResult['reason'], FailedResultV1['reason']>;
    byeReason: Equal<ByeMessage['reason'], ByeMessageV1['reason']>;
    commandName: Equal<AutovoteCommandMessage['command'], AutovoteCommandMessageV1['command']>;
    commandNameType: Equal<AutovoteCommandName, AutovoteCommandMessageV1['command']>;
};

type SettingsKept = {
    [K in keyof SettingValuesV1]: K extends keyof SettingValues ? Equal<SettingValues[K], SettingValuesV1[K]> : false;
};

// ---------------------------------------------------------------- the broken fixtures (each must read false)

type Broken = { __broken: true };
type BrokenKinds = {
    // An argument the handler does not take, and too few arguments for it.
    argumentOfAnotherType: IsAssignable<[challengeId: boolean], CurrentArgs<'vote-on-challenge'>>;
    tooFewArguments: IsAssignable<[], CurrentArgs<'vote-on-challenge'>>;
    // A result that lost a field the frozen one has, and a frozen result nothing can satisfy.
    resultMissingAField: IsAssignable<CurrentResult<'get-bankroll'>, Broken>;
    frozenResultIsNotVacuous: IsAssignable<Broken, ChannelsV1['get-bankroll']['result']>;
    frozenArgumentsAreNotVacuous: IsAssignable<[Broken], ChannelsV1['vote-on-challenge']['args']>;
    eventLostAField: IsAssignable<ConfigV2, Broken>;
    frozenEventIsNotVacuous: IsAssignable<Broken, EventPayloadsV1['update-available']>;
    stateLostAField: IsAssignable<AutovoteState, Broken>;
    frozenStateIsNotVacuous: IsAssignable<Broken, AutovoteStateV1>;
    // A closed union that grew, and one that shrank.
    unionGrew: Equal<'start' | 'stop' | 'rearm' | 'pause', AutovoteCommandMessageV1['command']>;
    unionShrank: Equal<'start' | 'stop', AutovoteCommandMessageV1['command']>;
    // A setting whose enum gained a member, and a vacuous one.
    settingGrew: Equal<'a' | 'b', 'a' | 'b' | 'c'>;
    settingIsNotVacuous: Equal<unknown, SettingValuesV1['exposure']>;
    // The living side gone vacuous would let anything through: fixtures read it back.
    currentArgsNotVacuous: Equal<CurrentArgs<'vote-on-challenge'>, unknown[]>;
    currentResultNotVacuous: Equal<CurrentResult<'get-bankroll'>, unknown>;
};

export type Checks = [
    Holds<WhileV1<AllTrue<MethodsKept>>>,
    Holds<WhileV1<AllTrue<ArgsKept>>>,
    Holds<WhileV1<AllTrue<ResultsKept>>>,
    Holds<WhileV1<AllTrue<EventsKept>>>,
    Holds<WhileV1<AllTrue<StateKept>>>,
    Holds<WhileV1<AllTrue<EnvelopesKept>>>,
    Holds<WhileV1<AllTrue<SettingsKept>>>,
    // Every broken fixture reads false.
    Holds<WhileV1<Equal<BrokenKinds[keyof BrokenKinds], false>>>,
];

// ---------------------------------------------------------------- the runtime registries

/** Every channel the contract freezes (the keys of ChannelsV1). */
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
type ChannelListIsComplete = Holds<Equal<(typeof FROZEN_CHANNELS)[number], keyof ChannelsV1>>;

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
] as const satisfies readonly (keyof ChannelsV1)[];

/** Every setting key the contract freezes (the keys of SettingValuesV1). */
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
type SettingListIsComplete = Holds<Equal<(typeof FROZEN_SETTING_KEYS)[number], keyof SettingValuesV1>>;

export type RegistryChecks = [ChannelListIsComplete, SettingListIsComplete];

/** The frozen channels the manifest no longer has (a renamed or removed one breaks every older page that calls it). */
export const channelsMissingFromManifest = (channels: readonly string[], manifest: readonly string[]): string[] =>
    channels.filter((channel) => !manifest.includes(channel));

/** The frozen channels a desktop no longer serves a phone (refused outright). */
export const channelsNoLongerServed = (channels: readonly string[]): string[] =>
    channels.filter((channel) => classifyRemoteChannel(channel).kind === 'refused');

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
const whileLinkVersion1 = linkVersion === 1 ? describe : describe.skip;

whileLinkVersion1('the link version 1 contract', () => {
    test('every frozen channel is still in the manifest', () => {
        expect(channelsMissingFromManifest(FROZEN_CHANNELS, allInvokeChannels())).toEqual([]);
    });

    test('every frozen channel is still served to a phone (allowed or answered by the host)', () => {
        expect(channelsNoLongerServed(FROZEN_CHANNELS)).toEqual([]);
    });

    test('the spend class of every frozen channel is unchanged', () => {
        expect(channelsWithSpendDrift(FROZEN_CHANNELS, FROZEN_SPEND_CHANNELS, SPEND_REMOTE_CHANNELS)).toEqual([]);
    });

    test('the settings schema still has every frozen key', () => {
        expect(settingKeysMissingFromSchema(FROZEN_SETTING_KEYS, SETTINGS_SCHEMA)).toEqual([]);
    });

    test('the parser drops a result with a reason it does not know, which is why a new reason needs a bump', () => {
        const failed = { t: 'result', id: 1, ok: false, error: 'x' };
        expect(parsePeerMessage({ ...failed, reason: 'too-large' })).not.toBeNull();
        expect(parsePeerMessage({ ...failed, reason: 'unsendable' })).not.toBeNull();
        expect(parsePeerMessage({ ...failed, reason: 'a-new-reason' })).toBeNull();
    });

    describe('a broken fixture fails each runtime check', () => {
        test('a channel the manifest lacks is reported', () => {
            expect(channelsMissingFromManifest([...FROZEN_CHANNELS, 'a-renamed-channel'], allInvokeChannels())).toEqual(
                ['a-renamed-channel'],
            );
        });

        test('a refused channel and an unknown one are reported as no longer served', () => {
            expect(channelsNoLongerServed([...FROZEN_CHANNELS, 'authenticate', 'a-renamed-channel'])).toEqual([
                'authenticate',
                'a-renamed-channel',
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
    });
});
