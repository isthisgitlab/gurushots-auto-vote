/**
 * The eight load-time migrations of a format 1 settings blob, frozen, in the format 1 order. Each one is gated by a one-time
 * flag in the blob, mutates the merged blob in place and reports whether it changed anything. Frozen as the
 * last build that wrote settings format 1 ran them; the importer runs them in memory and never writes the result back. Written as they ran in format 1 — a
 * hand-edited blob a pass cannot handle throws, which the importer reports as a failed migration.
 */

import { V1_RESERVED_PROFILE_NAMES, normalizeV1ProfileName } from './profiles';
import { sortRulesByDefaultOrder } from './rules';
import { sanitizeBeforeEndList, sanitizeFillSchedule, sanitizeTimeOfDayList } from './validators';

import type { V1Blob, V1Values } from './types';

// The one-time flags the passes set. They are format 1 bookkeeping: the converted config carries none of them.
const V1_MIGRATION_FLAGS = [
    '_timeUnitMigratedV1',
    '_emergencyFillTimeMigratedV1',
    '_autoFillScheduleMigratedV1',
    '_autoFillScheduleBoundsV1',
    '_scheduledFillListsMigratedV1',
    '_scheduledFillListBoundsV1',
    '_finalWindowExposureRenamedV1',
    '_challengeRulesOrderedV1',
] as const;

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

// The scope families the scheduled-fill passes walk: globalDefaults, every perChallenge map, every non-reserved
// profile's values map.
const eachScope = (blob: V1Blob, visit: (scope: V1Values | undefined, isGlobalScope: boolean) => void) => {
    visit(blob.challengeSettings?.globalDefaults, true);
    for (const overrides of Object.values(blob.challengeSettings?.perChallenge || {})) {
        visit(overrides, false);
    }
    const profiles = blob.challengeSettings?.profiles;
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
        for (const [name, values] of Object.entries(profiles)) {
            if (V1_RESERVED_PROFILE_NAMES.has(normalizeV1ProfileName(name))) continue;
            if (values && typeof values === 'object' && !Array.isArray(values)) visit(values as V1Values, false);
        }
    }
};

// boostTime / turboTime written as minutes (h*60+m) by v0.7.0 through v0.8.2 become seconds.
const migrateTimeUnits = (blob: V1Blob): boolean => {
    if (blob._timeUnitMigratedV1) return false;
    const looksMinuteEncoded = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1440;
    const TIME_KEYS = ['boostTime', 'turboTime'];
    const globalDefaults = blob.challengeSettings?.globalDefaults || {};
    for (const key of TIME_KEYS) {
        const before = globalDefaults[key];
        if (looksMinuteEncoded(before)) globalDefaults[key] = before * 60;
    }
    for (const overrides of Object.values(blob.challengeSettings?.perChallenge || {})) {
        for (const key of TIME_KEYS) {
            const before = overrides[key];
            if (looksMinuteEncoded(before)) overrides[key] = before * 60;
        }
    }
    blob._timeUnitMigratedV1 = true;
    return true;
};

// emergencyFill stored as minutes-before-close (1-59) becomes seconds; 0 stays the off sentinel.
const migrateEmergencyFillTime = (blob: V1Blob): boolean => {
    if (blob._emergencyFillTimeMigratedV1) return false;
    const looksMinuteEncoded = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 60;
    const globalDefaults = blob.challengeSettings?.globalDefaults || {};
    const globalBefore = globalDefaults.emergencyFill;
    if (looksMinuteEncoded(globalBefore)) globalDefaults.emergencyFill = globalBefore * 60;
    for (const overrides of Object.values(blob.challengeSettings?.perChallenge || {})) {
        const overrideBefore = overrides.emergencyFill;
        if (looksMinuteEncoded(overrideBefore)) overrides.emergencyFill = overrideBefore * 60;
    }
    blob._emergencyFillTimeMigratedV1 = true;
    return true;
};

// The legacy autoFillIntervalMinutes becomes an autoFillSchedule derived from the user's own interval.
const migrateAutoFillSchedule = (blob: V1Blob): boolean => {
    if (blob._autoFillScheduleMigratedV1) return false;
    const LEGACY_KEY = 'autoFillIntervalMinutes';
    const toSchedule = (minutes: number) => {
        const m = Math.min(minutes, 60);
        return [
            { count: 2, seconds: Math.round(3 * m * 60) },
            { count: 3, seconds: Math.round(2 * m * 60) },
            { count: 4, seconds: Math.round(m * 60) },
        ];
    };
    const migrateScope = (scope: V1Values | undefined) => {
        if (!scope) return;
        const legacy = scope[LEGACY_KEY];
        if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 1) {
            if (scope.autoFillSchedule === undefined) scope.autoFillSchedule = toSchedule(legacy);
        }
        if (hasOwn(scope, LEGACY_KEY)) delete scope[LEGACY_KEY];
    };
    migrateScope(blob.challengeSettings?.globalDefaults);
    for (const overrides of Object.values(blob.challengeSettings?.perChallenge || {})) migrateScope(overrides);
    blob._autoFillScheduleMigratedV1 = true;
    return true;
};

// A stored autoFillSchedule is clamped to the bounds (counts 2-4, at most 3 rows, unique counts, capped seconds).
const migrateAutoFillScheduleBounds = (blob: V1Blob): boolean => {
    if (blob._autoFillScheduleBoundsV1) return false;
    const sanitizeScope = (scope: V1Values | undefined) => {
        if (!scope) return;
        const cleaned = sanitizeFillSchedule(scope.autoFillSchedule);
        if (cleaned !== null) scope.autoFillSchedule = cleaned;
    };
    sanitizeScope(blob.challengeSettings?.globalDefaults);
    for (const overrides of Object.values(blob.challengeSettings?.perChallenge || {})) sanitizeScope(overrides);
    blob._autoFillScheduleBoundsV1 = true;
    return true;
};

// The scheduled-fill triggers become lists. An off sentinel ('' / 0) is deleted in globalDefaults, where the schema
// default is the same empty list, and kept as an explicit [] elsewhere, where an explicit opt-out must survive.
// A corrupt scalar never expressed an intent and is deleted in every scope.
const migrateScheduledFillLists = (blob: V1Blob): boolean => {
    if (blob._scheduledFillListsMigratedV1) return false;
    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const isOffSentinel = (key: string, value: unknown) => (key === 'scheduledFillTime' ? value === '' : value === 0);
    const migrateKey = (
        scope: V1Values | undefined,
        key: string,
        isGlobalScope: boolean,
        toList: (value: unknown) => unknown[] | null,
    ) => {
        if (!scope || !hasOwn(scope, key)) return;
        const value = scope[key];
        if (Array.isArray(value)) return;
        const list = toList(value);
        if (list) {
            scope[key] = list;
        } else if (isGlobalScope || !isOffSentinel(key, value)) {
            delete scope[key];
        } else {
            scope[key] = [];
        }
    };
    eachScope(blob, (scope, isGlobalScope) => {
        migrateKey(scope, 'scheduledFillTime', isGlobalScope, (v) =>
            typeof v === 'string' && TIME_RE.test(v) ? [v] : null,
        );
        migrateKey(scope, 'scheduledFillBeforeEnd', isGlobalScope, (v) =>
            Number.isInteger(v) && (v as number) >= 1 ? [v] : null,
        );
    });
    blob._scheduledFillListsMigratedV1 = true;
    return true;
};

// The scheduled-fill lists are deduped, sorted and capped.
const migrateScheduledFillListBounds = (blob: V1Blob): boolean => {
    if (blob._scheduledFillListBoundsV1) return false;
    eachScope(blob, (scope) => {
        if (!scope) return;
        const cleanedTimes = sanitizeTimeOfDayList(scope.scheduledFillTime);
        if (cleanedTimes !== null) scope.scheduledFillTime = cleanedTimes;
        const cleanedBefores = sanitizeBeforeEndList(scope.scheduledFillBeforeEnd);
        if (cleanedBefores !== null) scope.scheduledFillBeforeEnd = cleanedBefores;
    });
    blob._scheduledFillListBoundsV1 = true;
    return true;
};

// The "last hour exposure" keys become their "final window" equivalents; an existing new-key value wins.
const migrateFinalWindowExposureRename = (blob: V1Blob): boolean => {
    if (blob._finalWindowExposureRenamedV1) return false;
    const RENAMES = {
        useLastHourExposure: 'useFinalWindowExposure',
        lastHourExposure: 'finalWindowExposure',
        lastHourExposureTarget: 'finalWindowExposureTarget',
        voteBeforeLastHour: 'voteBeforeFinalWindow',
        voteBeforeLastHourLeadMin: 'voteBeforeFinalWindowLeadMin',
    };
    eachScope(blob, (scope) => {
        if (!scope) return;
        for (const [oldKey, newKey] of Object.entries(RENAMES)) {
            if (!hasOwn(scope, oldKey)) continue;
            if (!hasOwn(scope, newKey)) scope[newKey] = scope[oldKey];
            delete scope[oldKey];
        }
    });
    blob._finalWindowExposureRenamedV1 = true;
    return true;
};

// Category rules (a type / photo-count rule) move into the title rules, which are put in the format 1 default order;
// each category rule is appended as a title-less rule, most conditions first, below every title rule.
const CATEGORY_RULE_KEYS = ['type', 'pics', 'autoJoinWithinHoursOfEnd', 'autoJoinAfterPercentElapsed'];

const categoryRulesAsChallengeRules = (categoryRules: unknown[]): Array<Record<string, unknown>> =>
    categoryRules
        .filter((rule): rule is Record<string, unknown> => Boolean(rule) && typeof rule === 'object')
        .map((rule) => {
            const next: Record<string, unknown> = { title: '', mustIncludeTags: [], shouldIncludeTags: [] };
            for (const key of CATEGORY_RULE_KEYS) {
                if (hasOwn(rule, key)) next[key] = rule[key];
            }
            return next;
        })
        .sort((a, b) => Number('pics' in b) + Number('type' in b) - (Number('pics' in a) + Number('type' in a)));

const migrateCategoryRulesIntoChallengeRules = (blob: V1Blob): boolean => {
    if (blob._challengeRulesOrderedV1) return false;
    const challengeSettings = blob.challengeSettings;
    if (challengeSettings && typeof challengeSettings === 'object') {
        const titleRules = Array.isArray(challengeSettings.titleRules) ? challengeSettings.titleRules : [];
        const categoryRules = Array.isArray(challengeSettings.categoryRules) ? challengeSettings.categoryRules : [];
        const converted = categoryRulesAsChallengeRules(categoryRules);
        const ordered = sortRulesByDefaultOrder(titleRules).filter((rule) => rule && typeof rule === 'object');
        challengeSettings.titleRules = [...ordered, ...converted];
        delete challengeSettings.categoryRules;
    }
    blob._challengeRulesOrderedV1 = true;
    return true;
};

/**
 * Run every migration over the merged blob, in place, in the format 1 order. The order matters: the interval-to-schedule
 * pass precedes the schedule-bounds pass, the scalar-to-list pass its bounds pass.
 */
const runV1Migrations = (blob: V1Blob): void => {
    migrateTimeUnits(blob);
    migrateEmergencyFillTime(blob);
    migrateAutoFillSchedule(blob);
    migrateAutoFillScheduleBounds(blob);
    migrateScheduledFillLists(blob);
    migrateScheduledFillListBounds(blob);
    migrateFinalWindowExposureRename(blob);
    migrateCategoryRulesIntoChallengeRules(blob);
};

export { V1_MIGRATION_FLAGS, runV1Migrations };
