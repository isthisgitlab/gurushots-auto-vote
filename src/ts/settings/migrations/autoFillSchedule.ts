import * as logger from '../../logger';
import { sanitizeFillSchedule } from '../schema';

import type { AppSettings, ChallengeValues } from '../../types/settings';

// Migrate autoFillIntervalMinutes into autoFillSchedule. The legacy
// single interval M maps to an explicit per-image schedule: its
// trigger (`secondsRemaining <= slotsRemaining * M*60`) maps, for the
// common 4-slot challenge, to targets 2 @ 3M, 3 @ 2M, 4 @ 1M minutes
// before close. Always derived from the USER'S persisted M (a 15m
// user gets 45/30/15), never from the schema default; each scope is
// migrated independently. Runs before cleanupObsoleteSettings, which
// would otherwise just delete the schemaless legacy key.
export const migrateAutoFillSchedule = (mergedSettings: AppSettings): boolean => {
    if (mergedSettings._autoFillScheduleMigratedV1) return false;

    const LEGACY_KEY = 'autoFillIntervalMinutes';
    // Clamp to the legacy key's 60-minute ceiling and round: a
    // hand-edited non-integer or oversized legacy value must not
    // migrate into a schedule the int()/max() schema rejects.
    /** @param minutes */
    const toSchedule = (minutes: number) => {
        const m = Math.min(minutes, 60);
        return [
            { count: 2, seconds: Math.round(3 * m * 60) },
            { count: 3, seconds: Math.round(2 * m * 60) },
            { count: 4, seconds: Math.round(m * 60) },
        ];
    };

    const migrateScope = (scope: ChallengeValues | undefined, label: string) => {
        if (!scope) return;
        const legacy = scope[LEGACY_KEY];
        if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 1) {
            if (scope.autoFillSchedule === undefined) {
                scope.autoFillSchedule = toSchedule(legacy);
                logger
                    .withCategory('settings')
                    .info(
                        `Migrated ${LEGACY_KEY}=${legacy} ${label} to autoFillSchedule ${JSON.stringify(scope.autoFillSchedule)}`,
                        null,
                    );
            }
        }
        if (Object.prototype.hasOwnProperty.call(scope, LEGACY_KEY)) {
            delete scope[LEGACY_KEY];
        }
    };

    migrateScope(mergedSettings.challengeSettings?.globalDefaults, 'global default');
    const autoFillPerChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(autoFillPerChallenge)) {
        migrateScope(overrides, `override on challenge ${challengeId}`);
    }

    mergedSettings._autoFillScheduleMigratedV1 = true;
    return true;
};

// Sanitize persisted autoFillSchedule values to the current bounds
// (counts 2-4, ≤3 rows, unique counts, seconds within cap). A
// persisted blob can hold counts up to 20; because the Settings
// modal resubmits every persisted key on save, such a value
// would fail the validator and block saving ANY
// setting. Runs after the interval→schedule migration above, whose
// output always conforms already. Note this is a ONE-TIME pass
// (flag-gated like the migrations), not a standing invariant:
// every write path is zod-validated afterwards, so only an
// out-of-band file edit made after the flag is set could
// reintroduce bad rows — the same accepted risk as hand-editing
// any other setting, and the read path still clamps defensively.
export const migrateAutoFillScheduleBounds = (mergedSettings: AppSettings): boolean => {
    if (mergedSettings._autoFillScheduleBoundsV1) return false;

    const sanitizeScope = (scope: ChallengeValues | undefined, label: string) => {
        if (!scope) return;
        const cleaned = sanitizeFillSchedule(scope.autoFillSchedule);
        if (cleaned !== null) {
            logger
                .withCategory('settings')
                .info(`Sanitized autoFillSchedule ${label} to current bounds: ${JSON.stringify(cleaned)}`, null);
            scope.autoFillSchedule = cleaned;
        }
    };

    sanitizeScope(mergedSettings.challengeSettings?.globalDefaults, 'global default');
    const schedulePerChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(schedulePerChallenge)) {
        sanitizeScope(overrides, `override on challenge ${challengeId}`);
    }

    mergedSettings._autoFillScheduleBoundsV1 = true;
    return true;
};
