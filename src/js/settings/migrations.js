/**
 * Load-time migrations of the persisted settings blob, plus the prune of
 * keys the schema no longer knows. Every function here mutates the merged
 * settings object in place and reports whether it changed anything; the
 * caller (persistence.js) owns reading and writing the blob.
 */

const logger = require('../logger');
const { SETTINGS_SCHEMA, sanitizeFillSchedule, sanitizeTimeOfDayList, sanitizeBeforeEndList } = require('./schema');
const { ruleConditions, sortRulesByDefaultOrder } = require('./challengeRules');
const { RESERVED_PROFILE_NAMES, normalizeProfileName, readProfilesMap } = require('./profileStore');
const { ruleLogLabel } = require('./titleRuleSanitize');

// Migrate buggy-GUI-encoded time values. Pre-fix (versions
// v0.7.0 through v0.8.2), SettingInput stored boostTime /
// turboTime as minutes (h*60+m) while the runtime treated
// them as seconds. The buggy GUI could only write values in
// [0, 1439] (max was 23h*60+59); schema defaults (3600, 7200)
// are above that band, so untouched defaults pass through
// unchanged.
const migrateTimeUnits = (mergedSettings) => {
    if (mergedSettings._timeUnitMigratedV1) return false;

    const TIME_KEYS = ['boostTime', 'turboTime'];
    const looksMinuteEncoded = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1440;

    const globalDefaults = mergedSettings.challengeSettings?.globalDefaults || {};
    for (const key of TIME_KEYS) {
        if (looksMinuteEncoded(globalDefaults[key])) {
            const before = globalDefaults[key];
            globalDefaults[key] = before * 60;
            logger
                .withCategory('settings')
                .info(`Migrated ${key} global default from minute-encoded ${before} to ${globalDefaults[key]}s`, null);
        }
    }

    const perChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(perChallenge)) {
        for (const key of TIME_KEYS) {
            if (looksMinuteEncoded(overrides[key])) {
                const before = overrides[key];
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

// Migrate emergencyFill from minutes to seconds. It used to be a
// plain `number` of minutes-before-close (1-59); it's now a `time`
// setting stored in seconds (mirrors boostTime/turboTime). The old
// GUI/CLI could only write 1-59, so a value in (0, 60) is a stale
// minute encoding; 0 is the off sentinel and stays 0; legitimate new
// seconds values from the time input start at 60, so the band
// cleanly separates old-minutes from new-seconds. This is a separate
// flag because _timeUnitMigratedV1 is already set for current users.
const migrateEmergencyFillTime = (mergedSettings) => {
    if (mergedSettings._emergencyFillTimeMigratedV1) return false;

    const looksMinuteEncoded = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 60;

    const globalDefaults = mergedSettings.challengeSettings?.globalDefaults || {};
    if (looksMinuteEncoded(globalDefaults.emergencyFill)) {
        const before = globalDefaults.emergencyFill;
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
        if (looksMinuteEncoded(overrides.emergencyFill)) {
            const before = overrides.emergencyFill;
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

// Migrate autoFillIntervalMinutes into autoFillSchedule. The single
// interval M is replaced by an explicit per-image schedule; the old
// trigger (`secondsRemaining <= slotsRemaining * M*60`) maps, for the
// common 4-slot challenge, to targets 2 @ 3M, 3 @ 2M, 4 @ 1M minutes
// before close. Always derived from the USER'S persisted M (a 15m
// user gets 45/30/15), never from the schema default; each scope is
// migrated independently. Runs before cleanupObsoleteSettings, which
// would otherwise just delete the now-schemaless legacy key.
const migrateAutoFillSchedule = (mergedSettings) => {
    if (mergedSettings._autoFillScheduleMigratedV1) return false;

    const LEGACY_KEY = 'autoFillIntervalMinutes';
    // Clamp to the old validator's 60-minute ceiling and round: a
    // hand-edited non-integer or oversized legacy value must not
    // migrate into a schedule the new int()/max() schema rejects.
    const toSchedule = (minutes) => {
        const m = Math.min(minutes, 60);
        return [
            { count: 2, seconds: Math.round(3 * m * 60) },
            { count: 3, seconds: Math.round(2 * m * 60) },
            { count: 4, seconds: Math.round(m * 60) },
        ];
    };
    const migrateScope = (scope, label) => {
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
// (counts 2-4, ≤3 rows, unique counts, seconds within cap). The
// wide pre-tightening editor could store counts up to 20; because
// the Settings modal resubmits every persisted key on save, such a
// value would fail the tightened validator and block saving ANY
// setting. Runs after the interval→schedule migration above, whose
// output always conforms already. Note this is a ONE-TIME pass
// (flag-gated like the migrations), not a standing invariant:
// every write path is zod-validated afterwards, so only an
// out-of-band file edit made after the flag is set could
// reintroduce bad rows — the same accepted risk as hand-editing
// any other setting, and the read path still clamps defensively.
const migrateAutoFillScheduleBounds = (mergedSettings) => {
    if (mergedSettings._autoFillScheduleBoundsV1) return false;

    const sanitizeScope = (scope, label) => {
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

// The three scope families every scheduled-fill migration must walk:
// globalDefaults, every perChallenge override map, and every profile's values
// map. Profiles matter because sanitizeProfileValues(failClosed=false)
// silently drops schema-invalid values on the read path — an unmigrated
// scalar inside a profile would vanish from the profile view and be lost on
// the next save. Prototype-shaped profile names are skipped, mirroring
// getChallengeProfiles' own-property iteration.
const _eachScheduledFillScope = (mergedSettings, visit) => {
    visit(mergedSettings.challengeSettings?.globalDefaults, 'global default', true);
    const perChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(perChallenge)) {
        visit(overrides, `override on challenge ${challengeId}`, false);
    }
    const profiles = mergedSettings.challengeSettings?.profiles;
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
        for (const name of Object.keys(profiles)) {
            if (RESERVED_PROFILE_NAMES.has(normalizeProfileName(name))) continue;
            const values = profiles[name];
            if (values && typeof values === 'object' && !Array.isArray(values)) {
                visit(values, `profile "${name}"`, false);
            }
        }
    }
};

// Migrate the scheduled-fill triggers from scalars to lists (issue #26
// follow-up: multiple fill windows per challenge). Off-sentinel handling is
// SCOPE-DEPENDENT and load-bearing:
//   - globalDefaults: '' / 0 / corrupt → delete the key. Safe there only,
//     because getGlobalDefault falls back to the schema default, which is
//     also [] after this change.
//   - perChallenge / profiles: an off-sentinel '' / 0 migrates to [] IN
//     PLACE — never delete. getChallengeOverride distinguishes "no override"
//     (null → falls through to the global default) from "override present"
//     via hasOwnProperty: deleting an explicit '' opt-out on a challenge
//     whose GLOBAL default has a time would silently re-enable daily filling
//     there, and applyChallengeProfile builds overrides purely from the
//     profile's present keys, so a deleted profile key stops enforcing the
//     off. Corrupt (non-sentinel, unparseable) scalars never expressed a
//     working intent and are deleted in every scope.
const migrateScheduledFillLists = (mergedSettings) => {
    if (mergedSettings._scheduledFillListsMigratedV1) return false;

    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const migrateKey = (scope, key, label, isGlobalScope, toList) => {
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
    const isOffSentinel = (key, value) => (key === 'scheduledFillTime' ? value === '' : value === 0);

    _eachScheduledFillScope(mergedSettings, (scope, label, isGlobalScope) => {
        migrateKey(scope, 'scheduledFillTime', label, isGlobalScope, (v) =>
            typeof v === 'string' && TIME_RE.test(v) ? [v] : null,
        );
        migrateKey(scope, 'scheduledFillBeforeEnd', label, isGlobalScope, (v) =>
            Number.isInteger(v) && v >= 1 ? [v] : null,
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
const migrateScheduledFillListBounds = (mergedSettings) => {
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

// Rename the "last hour exposure" feature keys to their "final window"
// equivalents (the fixed 1h window became the configurable finalWindowDuration
// setting). A pure key rename that must run BEFORE cleanupObsoleteSettings,
// which would otherwise delete the now-schemaless old keys and lose the user's
// persisted values. Walks all three scopes via _eachScheduledFillScope
// (globalDefaults, every perChallenge map, every non-reserved profile). The new
// finalWindowDuration setting needs no migration: absent → schema default 3600,
// which reproduces the legacy fixed one-hour behaviour.
const migrateFinalWindowExposureRename = (mergedSettings) => {
    if (mergedSettings._finalWindowExposureRenamedV1) return false;

    const RENAMES = {
        useLastHourExposure: 'useFinalWindowExposure',
        lastHourExposure: 'finalWindowExposure',
        lastHourExposureTarget: 'finalWindowExposureTarget',
        voteBeforeLastHour: 'voteBeforeFinalWindow',
        voteBeforeLastHourLeadMin: 'voteBeforeFinalWindowLeadMin',
    };

    _eachScheduledFillScope(mergedSettings, (scope, label) => {
        if (!scope) return;
        for (const [oldKey, newKey] of Object.entries(RENAMES)) {
            if (!Object.prototype.hasOwnProperty.call(scope, oldKey)) continue;
            // Preserve an existing new-key value (already migrated / new write)
            // over the legacy one; still drop the stale old key either way.
            if (!Object.prototype.hasOwnProperty.call(scope, newKey)) {
                scope[newKey] = scope[oldKey];
                logger
                    .withCategory('settings')
                    .info(`Renamed ${oldKey} ${label} to ${newKey} (value ${JSON.stringify(scope[oldKey])})`, null);
            }
            delete scope[oldKey];
        }
    });

    mergedSettings._finalWindowExposureRenamedV1 = true;
    return true;
};

// Rules are evaluated in list order, and category rules (keyed on challenge
// type / photo count, join timing only) live in that same list. This one-time
// pass puts the saved title rules into the default order — which reproduces
// the outcome of the specificity ranking they were written against — and
// appends each category rule as a title-less rule, most conditions first,
// below every title rule, keeping the precedence they already had.
const CATEGORY_RULE_KEYS = ['type', 'pics', 'autoJoinWithinHoursOfEnd', 'autoJoinAfterPercentElapsed'];

// Keys whose fall-through from a lower rule could newly spend coins or photos.
const SPENDING_RULE_KEYS = ['autoJoin', 'autoFill'];

// A stored profile's raw values by exact name, or {} when absent/corrupt.
const _ownValues = (map, name) => (Object.prototype.hasOwnProperty.call(map, name) && map[name]) || {};

// False only when two rules provably never match the same challenge: disjoint
// exact titles, or different types / photo counts. Anything else may overlap.
const _rulesMayOverlap = (a, b) => {
    const x = ruleConditions(a);
    const y = ruleConditions(b);
    const bothExact = x.mode === 'exact' && y.mode === 'exact' && x.patterns.length > 0 && y.patterns.length > 0;
    if (bothExact && !x.patterns.some((pattern) => y.patterns.includes(pattern))) return false;
    if (x.type && y.type && x.type !== y.type) return false;
    return x.pics === null || y.pics === null || x.pics === y.pics;
};

/**
 * Title rules used to apply one at a time (the most specific won outright);
 * now a key the higher rule leaves unset falls through to the next matching
 * rule. Warn about every pair where that fall-through could newly switch
 * auto-join or auto-submit ON, so the user can review the order.
 */
const _warnAboutSpendingFallThrough = (titleRules, profiles) => {
    const log = logger.withCategory('settings');
    titleRules.forEach((higher, index) => {
        const higherProfile = _ownValues(profiles, higher.profile);
        for (const lower of titleRules.slice(index + 1)) {
            if (!_rulesMayOverlap(higher, lower)) continue;
            // Only the first profile along the matches applies, so a lower
            // rule's profile is reachable only when the higher one names none.
            const lowerProfile = higher.profile ? {} : _ownValues(profiles, lower.profile);
            const keys = SPENDING_RULE_KEYS.filter(
                (key) =>
                    !Object.prototype.hasOwnProperty.call(higher, key) &&
                    !Object.prototype.hasOwnProperty.call(higherProfile, key) &&
                    (lower[key] === true ||
                        (!Object.prototype.hasOwnProperty.call(lower, key) && lowerProfile[key] === true)),
            );
            if (keys.length === 0) continue;
            log.warning(
                `Challenge rules: "${ruleLogLabel(lower, lower.title)}" may now also turn ${keys.join('/')} on for challenges matched by "${ruleLogLabel(higher, higher.title)}" — review the rule order`,
                null,
            );
        }
    });
};

// Category rules as title-less challenge rules, most conditions first.
const _categoryRulesAsChallengeRules = (categoryRules) =>
    categoryRules
        .filter((rule) => rule && typeof rule === 'object')
        .map((rule) => {
            const next = { title: '', mustIncludeTags: [], shouldIncludeTags: [] };
            for (const key of CATEGORY_RULE_KEYS) {
                if (Object.prototype.hasOwnProperty.call(rule, key)) next[key] = rule[key];
            }
            return next;
        })
        .sort((a, b) => ('pics' in b) + ('type' in b) - (('pics' in a) + ('type' in a)));

const migrateCategoryRulesIntoChallengeRules = (mergedSettings) => {
    if (mergedSettings._challengeRulesOrderedV1) return false;
    const challengeSettings = mergedSettings.challengeSettings;
    if (challengeSettings && typeof challengeSettings === 'object') {
        const titleRules = Array.isArray(challengeSettings.titleRules) ? challengeSettings.titleRules : [];
        const categoryRules = Array.isArray(challengeSettings.categoryRules) ? challengeSettings.categoryRules : [];
        const converted = _categoryRulesAsChallengeRules(categoryRules);
        const ordered = sortRulesByDefaultOrder(titleRules).filter((rule) => rule && typeof rule === 'object');
        _warnAboutSpendingFallThrough(ordered, readProfilesMap(mergedSettings));
        challengeSettings.titleRules = [...ordered, ...converted];
        delete challengeSettings.categoryRules;
        if (converted.length > 0) {
            logger
                .withCategory('settings')
                .info(`Moved ${converted.length} category rule(s) into the challenge rules list`, null);
        }
    }
    mergedSettings._challengeRulesOrderedV1 = true;
    return true;
};

/**
 * Run every flag-gated migration over the merged settings (mutating them
 * in place). Returns true when anything changed, so the caller persists the
 * result. Order matters: the interval→schedule migration must precede the
 * schedule-bounds pass, whose output always conforms already; likewise the
 * scheduled-fill scalar→list migration precedes its bounds pass.
 */
const runMigrations = (mergedSettings) => {
    let migrationChanges = false;

    migrationChanges = migrateTimeUnits(mergedSettings) || migrationChanges;
    migrationChanges = migrateEmergencyFillTime(mergedSettings) || migrationChanges;
    migrationChanges = migrateAutoFillSchedule(mergedSettings) || migrationChanges;
    migrationChanges = migrateAutoFillScheduleBounds(mergedSettings) || migrationChanges;
    migrationChanges = migrateScheduledFillLists(mergedSettings) || migrationChanges;
    migrationChanges = migrateScheduledFillListBounds(mergedSettings) || migrationChanges;
    migrationChanges = migrateFinalWindowExposureRename(mergedSettings) || migrationChanges;
    migrationChanges = migrateCategoryRulesIntoChallengeRules(mergedSettings) || migrationChanges;

    return migrationChanges;
};

// Delete globalDefaults keys the schema no longer defines. Returns true on change.
const _pruneGlobalDefaultKeys = (globalDefaults, validSchemaKeys) => {
    const invalidGlobalKeys = Object.keys(globalDefaults).filter((key) => !validSchemaKeys.includes(key));
    if (invalidGlobalKeys.length === 0) return false;
    logger.withCategory('settings').debug(`Removing invalid global default keys: ${invalidGlobalKeys.join(', ')}`);
    invalidGlobalKeys.forEach((key) => {
        delete globalDefaults[key];
    });
    return true;
};

// Delete per-challenge override keys the schema no longer defines, then any
// container left empty. Returns true on change.
const _prunePerChallengeKeys = (perChallenge, validSchemaKeys) => {
    let hasChanges = false;
    for (const challengeId of Object.keys(perChallenge)) {
        const challengeOverrides = perChallenge[challengeId];
        const invalidKeys = Object.keys(challengeOverrides).filter((key) => !validSchemaKeys.includes(key));

        if (invalidKeys.length > 0) {
            logger
                .withCategory('settings')
                .debug(`Removing invalid override keys for challenge ${challengeId}:`, invalidKeys);
            invalidKeys.forEach((key) => {
                delete challengeOverrides[key];
            });
            hasChanges = true;
        }

        if (Object.keys(challengeOverrides).length === 0) {
            delete perChallenge[challengeId];
            hasChanges = true;
        }
    }
    return hasChanges;
};

/**
 * Remove settings that are no longer used: the legacy top-level boostConfig,
 * and globalDefaults / perChallenge keys outside the schema. Mutates
 * `settings` in place; returns true when anything was removed.
 */
const pruneObsoleteSettings = (settings) => {
    let hasChanges = false;

    if (settings.boostConfig) {
        logger.withCategory('settings').debug('Removing legacy boostConfig', null);
        delete settings.boostConfig;
        hasChanges = true;
    }

    const challengeSettings = settings.challengeSettings;
    if (challengeSettings) {
        const validSchemaKeys = Object.keys(SETTINGS_SCHEMA);
        if (challengeSettings.globalDefaults) {
            hasChanges = _pruneGlobalDefaultKeys(challengeSettings.globalDefaults, validSchemaKeys) || hasChanges;
        }
        if (challengeSettings.perChallenge) {
            hasChanges = _prunePerChallengeKeys(challengeSettings.perChallenge, validSchemaKeys) || hasChanges;
        }
    }

    return hasChanges;
};

module.exports = {
    runMigrations,
    pruneObsoleteSettings,
};
