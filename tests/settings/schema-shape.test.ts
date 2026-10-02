/**
 * Guards for the settings schema's public shape: the key order is user-visible
 * (settings groups and the CLI listing follow it) and SettingKey must stay a
 * literal union so a setting read is typed per key.
 */

import type { SettingKey } from '../../src/ts/settings/schema';
import type * as schemaModule from '../../src/ts/settings/schema';

const { SETTINGS_SCHEMA } = require('../../src/ts/settings/schema') as typeof schemaModule;

type IsLiteralUnion<K> = string extends K ? false : true;
const settingKeyIsLiteralUnion: IsLiteralUnion<SettingKey> = true;

describe('settings schema shape', () => {
    test('SettingKey is a literal union, not string', () => {
        expect(settingKeyIsLiteralUnion).toBe(true);
    });

    test('SETTINGS_SCHEMA keys keep their order', () => {
        expect(Object.keys(SETTINGS_SCHEMA)).toEqual([
            'scenario',
            'exposure',
            'exposureTarget',
            'onlyBoost',
            'voteOnNewEntry',
            'compactCards',
            'compactCardActions',
            'autoBoost',
            'boostTime',
            'voteBeforeBoost',
            'voteBeforeBoostLeadMin',
            'keyUnlockedBoostTime',
            'boostFreshEntryWait',
            'boostImageIndex',
            'boostFillNew',
            'boostFillNewOnConflict',
            'useTurbo',
            'autoTurbo',
            'turboTime',
            'turboImageIndex',
            'turboFillNew',
            'turboFillNewOnConflict',
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
            'autoJoinWithinHoursOfEnd',
            'autoJoinAfterPercentElapsed',
            'autoJoinMaxCoins',
            'autoJoinCycleCoinBudget',
            'autoFill',
            'protectUncertainAutoFills',
            'autoFillSchedule',
            'fillWithoutTagMatch',
            'emergencyFill',
            'mustIncludeTags',
            'shouldIncludeTags',
            'ignoreTitleWords',
            'autoClaimPrizes',
            'missionSaveTurbos',
            'missionJoinEarly',
            'missionUseFills',
            'missionVote',
            'notifyOnScenario',
            'notifyOnBoost',
            'notifyOnTurbo',
            'notifyOnAutoFill',
            'notifyOnEmergencyFill',
            'notifyLeadTime',
            'autovoteRunning',
            'skipUpdateVersion',
        ]);
    });
});
