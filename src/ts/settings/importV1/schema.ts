/**
 * The frozen 1.x settings schema: every key's default and zod validator, in the 1.x key order. A copy as of the last
 * 1.x release, holding only what loading a 1.x settings file reads (a value check and a default); it never follows
 * the live schema.
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

type V1SchemaEntry = { default: unknown; validation: z.ZodType };

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
    scenario: { default: '', validation: scenarioName },
    exposure: { default: 100, validation: percentage },
    exposureTarget: { default: 0, validation: percentageOrZero },
    onlyBoost: { default: false, validation: zBool },
    voteOnNewEntry: { default: false, validation: zBool },
    manualPhotosOnly: { default: false, validation: zBool },
    discoverUpcomingHours: { default: 24, validation: discoverUpcomingHours },
    autovoteStartupDelay: { default: DEFAULT_STARTUP_DELAY_SECONDS, validation: startupDelaySeconds },
    compactCards: { default: false, validation: zBool },
    compactCardActions: { default: false, validation: zBool },
    // boost
    autoBoost: { default: true, validation: zBool },
    boostTime: { default: 3600, validation: nonNegNumber },
    voteBeforeBoost: { default: false, validation: zBool },
    voteBeforeBoostLeadMin: { default: 15, validation: minute1to59 },
    keyUnlockedBoostTime: { default: 900, validation: nonNegNumber },
    boostFreshEntryWait: { default: 180, validation: nonNegNumber },
    boostOnSleep: { default: true, validation: zBool },
    boostImageIndex: { default: 1, validation: entrySlotIndex },
    boostFillNew: { default: false, validation: zBool },
    boostFillNewOnConflict: { default: false, validation: zBool },
    // turbo
    useTurbo: { default: false, validation: zBool },
    autoTurbo: { default: true, validation: zBool },
    turboTime: { default: 7200, validation: nonNegNumber },
    turboImageIndex: { default: 1, validation: entrySlotIndex },
    turboFillNew: { default: false, validation: zBool },
    turboFillNewOnConflict: { default: false, validation: zBool },
    // currencyAuto
    autoKeyUnlock: { default: false, validation: zBool },
    autoKeyAfterStart: { default: 0, validation: currencyRuleSec },
    autoKeyBeforeEnd: { default: 0, validation: currencyRuleSec },
    autoKeyAfterPercent: { default: 0, validation: joinPercentElapsed },
    autoSwap: { default: false, validation: zBool },
    autoSwapAfterStart: { default: 0, validation: currencyRuleSec },
    autoSwapBeforeEnd: { default: 0, validation: currencyRuleSec },
    autoSwapAfterPercent: { default: 0, validation: joinPercentElapsed },
    autoSwapImageIndex: { default: 0, validation: entrySlotIndex },
    autoSwapLowestVotes: { default: false, validation: zBool },
    autoSwapAllowBoosted: { default: false, validation: zBool },
    autoSwapMaxVotes: { default: 0, validation: swapVoteCeiling },
    autoSwapMax: { default: 1, validation: autoSpendCount },
    autoExposureFill: { default: false, validation: zBool },
    autoExposureFillBelow: { default: 50, validation: percentage },
    autoExposureFillAfterStart: { default: 0, validation: currencyRuleSec },
    autoExposureFillBeforeEnd: { default: 0, validation: currencyRuleSec },
    autoExposureFillAfterPercent: { default: 0, validation: joinPercentElapsed },
    autoExposureFillMax: { default: 1, validation: autoSpendCount },
    currencyReserveKeys: { default: 0, validation: currencyReserve },
    currencyReserveSwaps: { default: 0, validation: currencyReserve },
    currencyReserveFills: { default: 0, validation: currencyReserve },
    // finalWindow
    finalWindowDuration: { default: 3600, validation: finalWindowDurationSec },
    useFinalWindowExposure: { default: false, validation: zBool },
    finalWindowExposure: { default: 100, validation: percentage },
    finalWindowExposureTarget: { default: 0, validation: percentageOrZero },
    voteBeforeFinalWindow: { default: false, validation: zBool },
    voteBeforeFinalWindowLeadMin: { default: 15, validation: minute1to59 },
    // lastMinute
    voteOnlyInLastMinute: { default: false, validation: zBool },
    lastMinuteThreshold: { default: 10, validation: minute1to59 },
    lastMinuteCheckFrequency: { default: 1, validation: minute1to59 },
    // scheduledFill
    useScheduledFill: { default: false, validation: zBool },
    scheduledFillTime: { default: [], validation: timeOfDayList },
    scheduledFillBeforeEnd: { default: [], validation: beforeEndList },
    scheduledFillWindowMinutes: { default: 60, validation: windowMinutes },
    scheduledFillReplaces: { default: false, validation: zBool },
    // votingPause
    useVotingPause: { default: false, validation: zBool },
    votingPauseTime: { default: [], validation: timeOfDayList },
    votingPauseBeforeEnd: { default: [], validation: beforeEndList },
    votingPauseDurationMinutes: { default: 240, validation: pauseDurationMinutes },
    // autoJoin
    autoJoin: { default: false, validation: zBool },
    autoJoinTypes: { default: '', validation: zString },
    autoJoinExcludeTypes: { default: '', validation: zString },
    autoJoinChallengeTags: { default: '', validation: zString },
    autoJoinExcludeChallengeTags: { default: '', validation: zString },
    autoJoinWithinHoursOfEnd: { default: 0, validation: joinWindowHours },
    autoJoinAfterPercentElapsed: { default: 0, validation: joinPercentElapsed },
    autoJoinMaxCoins: { default: 0, validation: coinAmount },
    autoJoinCycleCoinBudget: { default: 0, validation: coinAmount },
    // autoFill
    autoFill: { default: false, validation: zBool },
    protectUncertainAutoFills: { default: true, validation: zBool },
    autoFillSchedule: {
        default: [
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 600 },
        ],
        validation: fillSchedule,
    },
    fillWithoutTagMatch: { default: true, validation: zBool },
    emergencyFill: { default: 300, validation: nonNegNumber },
    mustIncludeTags: { default: [], validation: tagsList },
    shouldIncludeTags: { default: [], validation: tagsList },
    chosenPhotos: { default: [], validation: photoIdList },
    chosenPhotosOnly: { default: false, validation: zBool },
    chosenPhotosInOrder: { default: false, validation: zBool },
    ignoreTitleWords: { default: IGNORE_TITLE_WORDS, validation: tagsList },
    // rewards and missions
    autoClaimPrizes: { default: false, validation: zBool },
    missionSaveTurbos: { default: false, validation: zBool },
    missionJoinEarly: { default: false, validation: zBool },
    missionUseFills: { default: false, validation: zBool },
    missionUseBoosts: { default: false, validation: zBool },
    missionVote: { default: false, validation: zBool },
    // notifications
    notifyOnScenario: { default: true, validation: zBool },
    notifyOnBoost: { default: false, validation: zBool },
    notifyOnTurbo: { default: false, validation: zBool },
    notifyOnAutoFill: { default: false, validation: zBool },
    notifyOnEmergencyFill: { default: false, validation: zBool },
    notifyLeadTime: { default: 5, validation: notifyLeadMinutes },
    // app state with no settings section
    autovoteRunning: { default: false, validation: zBool },
    autovoteStartedLaunch: { default: 0, validation: nonNegInt },
    skipUpdateVersion: { default: '', validation: zString },
    chosenPhotosMemberId: { default: '', validation: zString },
    chosenPhotosClearedAt: { default: '', validation: zString },
    noticeAcknowledgedVersion: { default: 0, validation: nonNegInt },
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
