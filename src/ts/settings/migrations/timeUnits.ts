import * as logger from '../../logger';

import type { AppSettings } from '../../types/settings';

// Migrate buggy-GUI-encoded time values. Blobs written by
// v0.7.0 through v0.8.2 hold boostTime / turboTime as
// minutes (h*60+m), which the runtime reads as seconds.
// That GUI could only write values in [0, 1439]
// (max 23h*60+59); schema defaults (3600, 7200) are above
// that band, so untouched defaults pass through unchanged.
export const migrateTimeUnits = (mergedSettings: AppSettings): boolean => {
    if (mergedSettings._timeUnitMigratedV1) return false;

    const TIME_KEYS = ['boostTime', 'turboTime'];

    const looksMinuteEncoded = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1440;

    const globalDefaults = mergedSettings.challengeSettings?.globalDefaults || {};
    for (const key of TIME_KEYS) {
        const before = globalDefaults[key];
        if (looksMinuteEncoded(before)) {
            globalDefaults[key] = before * 60;
            logger
                .withCategory('settings')
                .info(`Migrated ${key} global default from minute-encoded ${before} to ${globalDefaults[key]}s`, null);
        }
    }

    const perChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(perChallenge)) {
        for (const key of TIME_KEYS) {
            const before = overrides[key];
            if (looksMinuteEncoded(before)) {
                overrides[key] = before * 60;
                logger
                    .withCategory('settings')
                    .info(
                        `Migrated ${key} override on challenge ${challengeId} from ${before} to ${overrides[key]}s`,
                        null,
                    );
            }
        }
    }

    mergedSettings._timeUnitMigratedV1 = true;
    return true;
};

// Migrate emergencyFill from minutes to seconds. The stored legacy
// form is a plain `number` of minutes-before-close (1-59); the setting
// is a `time` stored in seconds (mirrors boostTime/turboTime). The
// minute form only ever holds 1-59, so a value in (0, 60) is a stale
// minute encoding; 0 is the off sentinel and stays 0; legitimate
// seconds values from the time input start at 60, so the band
// cleanly separates minutes from seconds. This is a separate
// flag because _timeUnitMigratedV1 is already set for current users.
export const migrateEmergencyFillTime = (mergedSettings: AppSettings): boolean => {
    if (mergedSettings._emergencyFillTimeMigratedV1) return false;

    const looksMinuteEncoded = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 60;

    const globalDefaults = mergedSettings.challengeSettings?.globalDefaults || {};
    const globalBefore = globalDefaults.emergencyFill;
    if (looksMinuteEncoded(globalBefore)) {
        const before = globalBefore;
        globalDefaults.emergencyFill = before * 60;
        logger
            .withCategory('settings')
            .info(
                `Migrated emergencyFill global default from minute-encoded ${before} to ${globalDefaults.emergencyFill}s`,
                null,
            );
    }

    const perChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(perChallenge)) {
        const overrideBefore = overrides.emergencyFill;
        if (looksMinuteEncoded(overrideBefore)) {
            const before = overrideBefore;
            overrides.emergencyFill = before * 60;
            logger
                .withCategory('settings')
                .info(
                    `Migrated emergencyFill override on challenge ${challengeId} from ${before} to ${overrides.emergencyFill}s`,
                    null,
                );
        }
    }

    mergedSettings._emergencyFillTimeMigratedV1 = true;
    return true;
};
