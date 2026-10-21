/**
 * The frozen format 1 settings schema: every key's default, zod validator and the flags the format 1 resolver reads
 * (`perChallenge`, `challengeOnly`, `dependsOn`), in the format 1 key order. Frozen as the last build that wrote settings format 1 had it, holding
 * only data; it never follows the live schema.
 */

import type { z } from 'zod';
import {
    DEFAULT_STARTUP_DELAY_SECONDS,
    autoSpendCount,
    beforeEndList,
    coinAmount,
    currencyReserve,
    currencyRuleSec,
    discoverUpcomingHours,
    entrySlotIndex,
    fillSchedule,
    finalWindowDurationSec,
    joinPercentElapsed,
    joinWindowHours,
    minute1to59,
    nonNegInt,
    nonNegNumber,
    notifyLeadMinutes,
    pauseDurationMinutes,
    percentage,
    percentageOrZero,
    photoIdList,
    scenarioName,
    startupDelaySeconds,
    swapVoteCeiling,
    tagsList,
    timeOfDayList,
    windowMinutes,
    zBool,
    zString,
} from './validators';

type V1SchemaEntry = {
    default: unknown;
    validation: z.ZodType;
    /** A value may sit in a profile, a rule, a scenario phase or a challenge's own values. */
    perChallenge: boolean;
    /** Only a challenge, a profile or a rule can turn it on: a stored global value is ignored. */
    challengeOnly?: true;
    /** The keys whose value its cross-field check reads. */
    dependsOn?: readonly string[];
};

const IGNORE_TITLE_WORDS = [
    'epic',
    'dramatic',
    'captivating',
    'fascinating',
    'powerful',
    'beautiful',
    'amazing',
    'stunning',
    'incredible',
    'breathtaking',
    'gorgeous',
    'glorious',
    'spectacular',
    'magical',
    'majestic',
    'striking',
    'wonderful',
    'awesome',
    'lovely',
    'perfect',
    'ultimate',
    'extreme',
    'favorite',
    'favourite',
    'melodic',
    'little',
    'creative',
    'creatively',
];

const V1_SETTINGS_SCHEMA = {
    // general
    scenario: { default: '', validation: scenarioName, perChallenge: true, challengeOnly: true },
    exposure: { default: 100, validation: percentage, perChallenge: true },
    exposureTarget: { default: 0, validation: percentageOrZero, perChallenge: true, dependsOn: ['exposure'] },
    onlyBoost: { default: false, validation: zBool, perChallenge: true },
    voteOnNewEntry: { default: false, validation: zBool, perChallenge: true },
    manualPhotosOnly: { default: false, validation: zBool, perChallenge: true, challengeOnly: true },
    discoverUpcomingHours: { default: 24, validation: discoverUpcomingHours, perChallenge: false },
    autovoteStartupDelay: {
        default: DEFAULT_STARTUP_DELAY_SECONDS,
        validation: startupDelaySeconds,
        perChallenge: false,
    },
    compactCards: { default: false, validation: zBool, perChallenge: true },
    compactCardActions: { default: false, validation: zBool, perChallenge: false },
    // boost
    autoBoost: { default: true, validation: zBool, perChallenge: true },
    boostTime: { default: 3600, validation: nonNegNumber, perChallenge: true },
    voteBeforeBoost: { default: false, validation: zBool, perChallenge: true },
    voteBeforeBoostLeadMin: { default: 15, validation: minute1to59, perChallenge: true },
    keyUnlockedBoostTime: { default: 900, validation: nonNegNumber, perChallenge: true },
    boostFreshEntryWait: { default: 180, validation: nonNegNumber, perChallenge: true },
    boostOnSleep: { default: true, validation: zBool, perChallenge: true },
    boostImageIndex: { default: 1, validation: entrySlotIndex, perChallenge: true },
    boostFillNew: { default: false, validation: zBool, perChallenge: true },
    boostFillNewOnConflict: { default: false, validation: zBool, perChallenge: true },
    // turbo
    useTurbo: { default: false, validation: zBool, perChallenge: true },
    autoTurbo: { default: true, validation: zBool, perChallenge: true },
    turboTime: { default: 7200, validation: nonNegNumber, perChallenge: true },
    turboImageIndex: { default: 1, validation: entrySlotIndex, perChallenge: true },
    turboFillNew: { default: false, validation: zBool, perChallenge: true },
    turboFillNewOnConflict: { default: false, validation: zBool, perChallenge: true },
    // currencyAuto
    autoKeyUnlock: { default: false, validation: zBool, perChallenge: true },
    autoKeyAfterStart: { default: 0, validation: currencyRuleSec, perChallenge: true },
    autoKeyBeforeEnd: { default: 0, validation: currencyRuleSec, perChallenge: true },
    autoKeyAfterPercent: { default: 0, validation: joinPercentElapsed, perChallenge: true },
    autoSwap: { default: false, validation: zBool, perChallenge: true },
    autoSwapAfterStart: { default: 0, validation: currencyRuleSec, perChallenge: true },
    autoSwapBeforeEnd: { default: 0, validation: currencyRuleSec, perChallenge: true },
    autoSwapAfterPercent: { default: 0, validation: joinPercentElapsed, perChallenge: true },
    autoSwapImageIndex: { default: 0, validation: entrySlotIndex, perChallenge: true },
    autoSwapLowestVotes: { default: false, validation: zBool, perChallenge: true },
    autoSwapAllowBoosted: { default: false, validation: zBool, perChallenge: true },
    autoSwapMaxVotes: { default: 0, validation: swapVoteCeiling, perChallenge: true },
    autoSwapMax: { default: 1, validation: autoSpendCount, perChallenge: true },
    autoExposureFill: { default: false, validation: zBool, perChallenge: true },
    autoExposureFillBelow: { default: 50, validation: percentage, perChallenge: true },
    autoExposureFillAfterStart: { default: 0, validation: currencyRuleSec, perChallenge: true },
    autoExposureFillBeforeEnd: { default: 0, validation: currencyRuleSec, perChallenge: true },
    autoExposureFillAfterPercent: { default: 0, validation: joinPercentElapsed, perChallenge: true },
    autoExposureFillMax: { default: 1, validation: autoSpendCount, perChallenge: true },
    currencyReserveKeys: { default: 0, validation: currencyReserve, perChallenge: false },
    currencyReserveSwaps: { default: 0, validation: currencyReserve, perChallenge: false },
    currencyReserveFills: { default: 0, validation: currencyReserve, perChallenge: false },
    // finalWindow
    finalWindowDuration: { default: 3600, validation: finalWindowDurationSec, perChallenge: true },
    useFinalWindowExposure: { default: false, validation: zBool, perChallenge: true },
    finalWindowExposure: { default: 100, validation: percentage, perChallenge: true, dependsOn: ['exposure'] },
    finalWindowExposureTarget: {
        default: 0,
        validation: percentageOrZero,
        perChallenge: true,
        dependsOn: ['finalWindowExposure'],
    },
    voteBeforeFinalWindow: { default: false, validation: zBool, perChallenge: true },
    voteBeforeFinalWindowLeadMin: { default: 15, validation: minute1to59, perChallenge: true },
    // lastMinute
    voteOnlyInLastMinute: { default: false, validation: zBool, perChallenge: true },
    lastMinuteThreshold: { default: 10, validation: minute1to59, perChallenge: true },
    lastMinuteCheckFrequency: { default: 1, validation: minute1to59, perChallenge: false },
    // scheduledFill
    useScheduledFill: { default: false, validation: zBool, perChallenge: true },
    scheduledFillTime: { default: [], validation: timeOfDayList, perChallenge: true },
    scheduledFillBeforeEnd: { default: [], validation: beforeEndList, perChallenge: true },
    scheduledFillWindowMinutes: { default: 60, validation: windowMinutes, perChallenge: true },
    scheduledFillReplaces: { default: false, validation: zBool, perChallenge: true },
    // votingPause
    useVotingPause: { default: false, validation: zBool, perChallenge: true },
    votingPauseTime: { default: [], validation: timeOfDayList, perChallenge: true },
    votingPauseBeforeEnd: { default: [], validation: beforeEndList, perChallenge: true },
    votingPauseDurationMinutes: { default: 240, validation: pauseDurationMinutes, perChallenge: true },
    // autoJoin
    autoJoin: { default: false, validation: zBool, perChallenge: true },
    autoJoinTypes: { default: '', validation: zString, perChallenge: true },
    autoJoinExcludeTypes: { default: '', validation: zString, perChallenge: true },
    autoJoinChallengeTags: { default: '', validation: zString, perChallenge: true },
    autoJoinExcludeChallengeTags: { default: '', validation: zString, perChallenge: true },
    autoJoinWithinHoursOfEnd: { default: 0, validation: joinWindowHours, perChallenge: true },
    autoJoinAfterPercentElapsed: { default: 0, validation: joinPercentElapsed, perChallenge: true },
    autoJoinMaxCoins: { default: 0, validation: coinAmount, perChallenge: true },
    autoJoinCycleCoinBudget: { default: 0, validation: coinAmount, perChallenge: false },
    // autoFill
    autoFill: { default: false, validation: zBool, perChallenge: true },
    protectUncertainAutoFills: { default: true, validation: zBool, perChallenge: true },
    autoFillSchedule: {
        default: [
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 600 },
        ],
        validation: fillSchedule,
        perChallenge: true,
    },
    fillWithoutTagMatch: { default: true, validation: zBool, perChallenge: true },
    emergencyFill: { default: 300, validation: nonNegNumber, perChallenge: true },
    mustIncludeTags: { default: [], validation: tagsList, perChallenge: true },
    shouldIncludeTags: { default: [], validation: tagsList, perChallenge: true },
    chosenPhotos: { default: [], validation: photoIdList, perChallenge: true },
    chosenPhotosOnly: { default: false, validation: zBool, perChallenge: true },
    chosenPhotosInOrder: { default: false, validation: zBool, perChallenge: true },
    ignoreTitleWords: { default: IGNORE_TITLE_WORDS, validation: tagsList, perChallenge: true },
    // rewards and missions
    autoClaimPrizes: { default: false, validation: zBool, perChallenge: false },
    missionSaveTurbos: { default: false, validation: zBool, perChallenge: false },
    missionJoinEarly: { default: false, validation: zBool, perChallenge: false },
    missionUseFills: { default: false, validation: zBool, perChallenge: false },
    missionUseBoosts: { default: false, validation: zBool, perChallenge: false },
    missionVote: { default: false, validation: zBool, perChallenge: false },
    // notifications
    notifyOnScenario: { default: true, validation: zBool, perChallenge: false },
    notifyOnBoost: { default: false, validation: zBool, perChallenge: false },
    notifyOnTurbo: { default: false, validation: zBool, perChallenge: false },
    notifyOnAutoFill: { default: false, validation: zBool, perChallenge: false },
    notifyOnEmergencyFill: { default: false, validation: zBool, perChallenge: false },
    notifyLeadTime: { default: 5, validation: notifyLeadMinutes, perChallenge: false },
    // app state with no settings section
    autovoteRunning: { default: false, validation: zBool, perChallenge: false },
    autovoteStartedLaunch: { default: 0, validation: nonNegInt, perChallenge: false },
    skipUpdateVersion: { default: '', validation: zString, perChallenge: false },
    noticeAcknowledgedVersion: { default: 0, validation: nonNegInt, perChallenge: false },
} satisfies Record<string, V1SchemaEntry>;

/**
 * The frozen schema entry for a key only known at runtime, or undefined for an unknown key.
 */
const v1SchemaEntry = (key: string): V1SchemaEntry | undefined =>
    Object.hasOwn(V1_SETTINGS_SCHEMA, key) ? (V1_SETTINGS_SCHEMA as Record<string, V1SchemaEntry>)[key] : undefined;

/**
 * Whether a value passes its key's validator (a key the frozen schema does not know is valid).
 */
const validateV1Setting = (key: string, value: unknown): boolean =>
    v1SchemaEntry(key)?.validation.safeParse(value).success ?? true;

export { V1_SETTINGS_SCHEMA, v1SchemaEntry, validateV1Setting };
