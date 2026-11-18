/**
 * What a scenario may do with each named configuration key: one row per schema key and per app key outside the
 * schema, classified once. The phase-overlay gate (scenarioSchema/semantics.ts) and the renderer's projection both
 * read it, so a key a phase may write is decided in one place.
 *
 * Private to settings/: callers use the facade. Type-only imports, so nothing here pulls zod or storage in.
 */

import type { SettingKey } from './schema';
import type {
    AppExtraKey,
    CapabilityKey,
    ScenarioCapabilityProjection,
    ScenarioCapabilityRow,
    ScenarioSettingCapability,
} from '../types/settings';

/** Writable by a challenge phase overlay (an exposure target of zero and a boost time of zero keep their meanings). */
const challengePolicy: ScenarioSettingCapability = Object.freeze({
    disposition: 'challengePolicy',
    read: 'value',
    phaseWrite: Object.freeze(['challenge'] as const),
    owner: 'challenge',
});

/** Account behaviour: read anywhere, written only by the selected installation phase overlay. */
const accountPolicy: ScenarioSettingCapability = Object.freeze({
    disposition: 'accountPolicy',
    read: 'value',
    phaseWrite: Object.freeze(['installation'] as const),
    owner: 'installation',
});

/** An application preference: read anywhere, written only by the selected installation phase overlay. */
const appPreference: ScenarioSettingCapability = Object.freeze({
    disposition: 'appPreference',
    read: 'value',
    phaseWrite: Object.freeze(['installation'] as const),
    owner: 'installation',
});

/** A preference of the host device's presentation. */
const devicePreference: ScenarioSettingCapability = Object.freeze({
    disposition: 'devicePreference',
    read: 'value',
    phaseWrite: Object.freeze(['installation'] as const),
    owner: 'device',
});

/** A user-only control of the lifecycle: observable, and changed only by the owner's own operation. */
const lifecycleControl = (owner: ScenarioSettingCapability['owner'], restriction: string): ScenarioSettingCapability =>
    Object.freeze({
        disposition: 'lifecycleControl',
        read: 'value',
        phaseWrite: Object.freeze([]),
        owner,
        restriction,
    });

/** State a subsystem owns: observed through a restricted projection, never written by a scenario. */
const internalState = (owner: ScenarioSettingCapability['owner'], restriction: string): ScenarioSettingCapability =>
    Object.freeze({
        disposition: 'internalState',
        read: 'projection',
        phaseWrite: Object.freeze([]),
        owner,
        restriction,
    });

/**
 * The class of every key. `satisfies` over the full key union makes a schema key or app key without an entry, and an
 * entry for a key that does not exist, a type error.
 */
const CAPABILITIES = {
    // Challenge policy (79)
    exposure: challengePolicy,
    exposureTarget: challengePolicy,
    onlyBoost: challengePolicy,
    voteOnNewEntry: challengePolicy,

    autoBoost: challengePolicy,
    boostTime: challengePolicy,
    voteBeforeBoost: challengePolicy,
    voteBeforeBoostLeadMin: challengePolicy,
    keyUnlockedBoostTime: challengePolicy,
    boostFreshEntryWait: challengePolicy,
    boostOnSleep: challengePolicy,
    boostImageIndex: challengePolicy,
    boostNewSubmit: challengePolicy,
    boostNewSubmitOnConflict: challengePolicy,
    boostPinnedSubmit: challengePolicy,

    useTurbo: challengePolicy,
    autoTurbo: challengePolicy,
    turboTime: challengePolicy,
    turboImageIndex: challengePolicy,
    turboNewSubmit: challengePolicy,
    turboNewSubmitOnConflict: challengePolicy,

    autoKeyUnlock: challengePolicy,
    autoKeyAfterStart: challengePolicy,
    autoKeyBeforeEnd: challengePolicy,
    autoKeyAfterPercent: challengePolicy,
    autoSwap: challengePolicy,
    autoSwapAfterStart: challengePolicy,
    autoSwapBeforeEnd: challengePolicy,
    autoSwapAfterPercent: challengePolicy,
    autoSwapImageIndex: challengePolicy,
    autoSwapLowestVotes: challengePolicy,
    autoSwapAllowBoosted: challengePolicy,
    autoSwapMaxVotes: challengePolicy,
    autoSwapMax: challengePolicy,
    autoExposureFill: challengePolicy,
    autoExposureFillBelow: challengePolicy,
    autoExposureFillAfterStart: challengePolicy,
    autoExposureFillBeforeEnd: challengePolicy,
    autoExposureFillAfterPercent: challengePolicy,
    autoExposureFillMax: challengePolicy,

    finalWindowDuration: challengePolicy,
    useFinalWindowExposure: challengePolicy,
    finalWindowExposure: challengePolicy,
    finalWindowExposureTarget: challengePolicy,
    voteBeforeFinalWindow: challengePolicy,
    voteBeforeFinalWindowLeadMin: challengePolicy,

    voteOnlyInLastMinute: challengePolicy,
    lastMinuteThreshold: challengePolicy,

    useScheduledFill: challengePolicy,
    scheduledFillTime: challengePolicy,
    scheduledFillBeforeEnd: challengePolicy,
    scheduledFillWindowMinutes: challengePolicy,
    scheduledFillReplaces: challengePolicy,

    useVotingPause: challengePolicy,
    votingPauseTime: challengePolicy,
    votingPauseBeforeEnd: challengePolicy,
    votingPauseDurationMinutes: challengePolicy,

    autoJoin: challengePolicy,
    autoJoinTypes: challengePolicy,
    autoJoinExcludeTypes: challengePolicy,
    autoJoinChallengeTags: challengePolicy,
    autoJoinExcludeChallengeTags: challengePolicy,
    autoJoinAfterHoursFromStart: challengePolicy,
    autoJoinAfterPercentElapsed: challengePolicy,
    autoJoinWithinHoursOfEnd: challengePolicy,
    autoJoinMaxCoins: challengePolicy,

    autoSubmit: challengePolicy,
    protectUncertainAutoSubmits: challengePolicy,
    autoSubmitSchedule: challengePolicy,
    autoSubmitTime: challengePolicy,
    autoSubmitWindowMinutes: challengePolicy,
    submitWithoutTagMatch: challengePolicy,
    emergencySubmit: challengePolicy,
    mustIncludeTags: challengePolicy,
    shouldIncludeTags: challengePolicy,
    chosenPhotos: challengePolicy,
    chosenPhotosOnly: challengePolicy,
    chosenPhotosInOrder: challengePolicy,
    ignoreTitleWords: challengePolicy,

    // Account policy (12)
    currencyReserveKeys: accountPolicy,
    currencyReserveSwaps: accountPolicy,
    currencyReserveFills: accountPolicy,
    autoJoinShortChallengesImmediately: accountPolicy,
    autoJoinCycleCoinBudget: accountPolicy,
    snapYesWithoutModel: accountPolicy,
    autoClaimPrizes: accountPolicy,
    missionSaveTurbos: accountPolicy,
    missionJoinEarly: accountPolicy,
    missionUseFills: accountPolicy,
    missionUseBoosts: accountPolicy,
    missionVote: accountPolicy,

    // App preference (14)
    discoverUpcomingHours: appPreference,
    lastMinuteCheckFrequency: appPreference,
    notifyOnScenario: appPreference,
    notifyOnBoost: appPreference,
    notifyOnTurbo: appPreference,
    notifyOnAutoSubmit: appPreference,
    notifyOnEmergencySubmit: appPreference,
    notifyLeadTime: appPreference,
    timezone: appPreference,
    checkFrequencyMin: appPreference,
    checkFrequencyMax: appPreference,
    apiTimeout: appPreference,
    apiMaxRetries: appPreference,
    apiRetryBaseDelayMs: appPreference,

    // Device preference (6): a card's compact view is also a per-challenge setting
    compactCards: Object.freeze({
        disposition: 'devicePreference',
        read: 'value',
        phaseWrite: Object.freeze(['challenge', 'installation'] as const),
        owner: 'device',
    }),
    compactCardActions: devicePreference,
    theme: devicePreference,
    language: devicePreference,
    customTimezones: devicePreference,
    windowBounds: Object.freeze({
        disposition: 'devicePreference',
        read: 'projection',
        phaseWrite: Object.freeze([]),
        owner: 'window',
        restriction: 'Only the window manager writes window geometry',
    }),

    // Lifecycle control (5)
    scenario: lifecycleControl('controller', 'A phase cannot change the scenario assignment itself'),
    manualPhotosOnly: lifecycleControl('controller', 'A phase cannot change Manual Only'),
    autovoteStartupDelay: lifecycleControl('controller', 'Only the user changes the resume delay for the next launch'),
    stayLoggedIn: lifecycleControl('authentication', 'Only the user changes sign-in retention'),
    mock: lifecycleControl('controller', 'Only the user switches between real and mock mode'),

    // Internal state (5)
    autovoteRunning: internalState('controller', 'Only the voting controller starts or stops voting'),
    autovoteStartedLaunch: internalState(
        'controller',
        'Only the voting controller records which launch started voting',
    ),
    skipUpdateVersion: internalState('updates', 'Only the user skips an update version'),
    noticeAcknowledgedVersion: internalState('updates', 'Only the user acknowledges a notice'),
    onboardingCompleted: internalState('onboarding', 'Only the welcome screen marks onboarding as done'),
} as const satisfies Record<SettingKey | AppExtraKey, ScenarioSettingCapability>;

/**
 * The remote-access switch: a lifecycle control, but not a configuration key. Only a sanitized status is ever
 * projected for it, never its key material.
 */
const REMOTE_ENABLED_CAPABILITY: ScenarioSettingCapability = Object.freeze({
    disposition: 'lifecycleControl',
    read: 'projection',
    phaseWrite: Object.freeze([]),
    owner: 'controller',
    restriction: 'Only the user enables remote access or rotates its key',
});

const isCapabilityKey = (key: string): key is CapabilityKey => Object.hasOwn(CAPABILITIES, key);

/**
 * The capability of a key known only at runtime, or undefined for a name that is no configuration key (an
 * Object.prototype member included).
 */
const scenarioCapability = (key: string): ScenarioSettingCapability | undefined =>
    isCapabilityKey(key) ? CAPABILITIES[key] : undefined;

const copyCapability = (capability: ScenarioSettingCapability): ScenarioSettingCapability => ({
    disposition: capability.disposition,
    read: capability.read,
    phaseWrite: [...capability.phaseWrite],
    owner: capability.owner,
    ...(capability.restriction === undefined ? {} : { restriction: capability.restriction }),
});

/**
 * The catalogue as plain JSON (rows sorted by key, the remote switch apart), freshly built so a caller cannot change
 * the catalogue through it.
 */
const getScenarioCapabilities = (): ScenarioCapabilityProjection => ({
    settings: (Object.keys(CAPABILITIES) as CapabilityKey[])
        .sort()
        .map((key): ScenarioCapabilityRow => ({ key, ...copyCapability(CAPABILITIES[key]) })),
    remoteEnabled: copyCapability(REMOTE_ENABLED_CAPABILITY),
});

export { getScenarioCapabilities, scenarioCapability };
