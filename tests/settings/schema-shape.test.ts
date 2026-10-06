/**
 * Guards for the settings schema's public shape: the key order is user-visible
 * (settings groups and the CLI listing follow it) and SettingKey must stay a
 * literal union so a setting read is typed per key.
 */

import type { SettingKey, SettingValues } from '../../src/ts/settings/schema';
import type * as schemaModule from '../../src/ts/settings/schema';

const { SETTINGS_SCHEMA } = require('../../src/ts/settings/schema') as typeof schemaModule;

type IsLiteralUnion<K> = string extends K ? false : true;
const settingKeyIsLiteralUnion: IsLiteralUnion<SettingKey> = true;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// SettingValues is read off each entry's validator, so a shared entry shape
// that widened `validation` would turn these into unknown.
const exposureValueIsNumber: IsExactly<SettingValues['exposure'], number> = true;
const onlyBoostValueIsBoolean: IsExactly<SettingValues['onlyBoost'], boolean> = true;

describe('settings schema shape', () => {
    test('SettingKey is a literal union, not string', () => {
        expect(settingKeyIsLiteralUnion).toBe(true);
    });

    test('SettingValues stays precise per key', () => {
        expect(exposureValueIsNumber).toBe(true);
        expect(onlyBoostValueIsBoolean).toBe(true);
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
            'boostOnSleep',
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
            'chosenPhotos',
            'chosenPhotosOnly',
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
            'chosenPhotosMemberId',
            'chosenPhotosClearedAt',
        ]);
    });

    test('Boost Before Sleep is on by default and settable per challenge', () => {
        expect(SETTINGS_SCHEMA.boostOnSleep.default).toBe(true);
        expect(SETTINGS_SCHEMA.boostOnSleep.perChallenge).toBe(true);
    });
});
