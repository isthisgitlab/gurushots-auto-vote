import * as logger from '../../logger';
import { sanitizeTimeOfDayList, sanitizeBeforeEndList } from '../schema';
import { _eachScheduledFillScope } from './scopes';

import type { AppSettings, ChallengeValues } from '../../types/settings';

// Migrate the scheduled-fill triggers from scalars to lists (issue #26:
// multiple fill windows per challenge). Off-sentinel handling is
// SCOPE-DEPENDENT and load-bearing:
//   - globalDefaults: '' / 0 / corrupt → delete the key. Safe there only,
//     because getGlobalDefault falls back to the schema default, which is
//     also [].
//   - perChallenge / profiles: an off-sentinel '' / 0 migrates to [] IN
//     PLACE — never delete. getChallengeOverride distinguishes "no override"
//     (null → falls through to the global default) from "override present"
//     via hasOwnProperty: deleting an explicit '' opt-out on a challenge
//     whose GLOBAL default has a time would silently re-enable daily filling
//     there, and applyChallengeProfile builds overrides purely from the
//     profile's present keys, so a deleted profile key stops enforcing the
//     off. Corrupt (non-sentinel, unparseable) scalars never expressed a
//     working intent and are deleted in every scope.
export const migrateScheduledFillLists = (mergedSettings: AppSettings): boolean => {
    if (mergedSettings._scheduledFillListsMigratedV1) return false;

    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

    const migrateKey = (
        scope: ChallengeValues | undefined,
        key: string,
        label: string,
        isGlobalScope: boolean,
        toList: (value: unknown) => unknown[] | null,
    ) => {
        if (!scope || !Object.prototype.hasOwnProperty.call(scope, key)) return;
        const value = scope[key];
        if (Array.isArray(value)) return; // already migrated / new-shape write
        const list = toList(value);
        if (list) {
            scope[key] = list;
        } else if (isGlobalScope || !isOffSentinel(key, value)) {
            delete scope[key];
        } else {
            scope[key] = []; // explicit opt-out preserved as an explicit empty list
        }
        logger
            .withCategory('settings')
            .info(`Migrated scalar ${key} ${label} to ${JSON.stringify(scope[key] ?? '(removed)')}`, null);
    };

    const isOffSentinel = (key: string, value: unknown) => (key === 'scheduledFillTime' ? value === '' : value === 0);

    _eachScheduledFillScope(mergedSettings, (scope, label, isGlobalScope) => {
        migrateKey(scope, 'scheduledFillTime', label, isGlobalScope, (v) =>
            typeof v === 'string' && TIME_RE.test(v) ? [v] : null,
        );
        migrateKey(scope, 'scheduledFillBeforeEnd', label, isGlobalScope, (v) =>
            Number.isInteger(v) && (v as number) >= 1 ? [v] : null,
        );
    });

    mergedSettings._scheduledFillListsMigratedV1 = true;
    return true;
};

// One-time bounds pass over the scheduled-fill lists (dedupe, canonical sort,
// entry cap), same rationale as migrateAutoFillScheduleBounds: the Settings
// modal resubmits every persisted key on save, so one out-of-bounds array
// would block saving ANY setting, and sanitizeProfileValues would drop a
// profile's whole key instead of keeping its valid entries. Unlike
// autoFillSchedule (structurally capped at 3 rows by count-dedupe) these
// lists have no structural ceiling, so the hot-path consumers additionally
// slice to MAX_SCHEDULED_FILL_ENTRIES defensively — a post-flag hand edit
// can't inflate per-cycle Intl work.
export const migrateScheduledFillListBounds = (mergedSettings: AppSettings): boolean => {
    if (mergedSettings._scheduledFillListBoundsV1) return false;

    _eachScheduledFillScope(mergedSettings, (scope, label) => {
        if (!scope) return;
        const cleanedTimes = sanitizeTimeOfDayList(scope.scheduledFillTime);
        if (cleanedTimes !== null) {
            logger
                .withCategory('settings')
                .info(`Sanitized scheduledFillTime ${label} to current bounds: ${JSON.stringify(cleanedTimes)}`, null);
            scope.scheduledFillTime = cleanedTimes;
        }
        const cleanedBefores = sanitizeBeforeEndList(scope.scheduledFillBeforeEnd);
        if (cleanedBefores !== null) {
            logger
                .withCategory('settings')
                .info(
                    `Sanitized scheduledFillBeforeEnd ${label} to current bounds: ${JSON.stringify(cleanedBefores)}`,
                    null,
                );
            scope.scheduledFillBeforeEnd = cleanedBefores;
        }
    });

    mergedSettings._scheduledFillListBoundsV1 = true;
    return true;
};
