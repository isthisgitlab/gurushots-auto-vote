/**
 * Load-time migrations of the persisted settings blob, plus the prune of
 * keys the schema no longer knows. Every function here mutates the merged
 * settings object in place and reports whether it changed anything; the
 * caller (persistence.ts) owns reading and writing the blob.
 */

import { migrateAutoFillSchedule, migrateAutoFillScheduleBounds } from './migrations/autoFillSchedule';
import { migrateCategoryRulesIntoChallengeRules } from './migrations/categoryRules';
import { migrateFinalWindowExposureRename } from './migrations/finalWindowRename';
import { pruneObsoleteSettings } from './migrations/prune';
import { migrateScheduledFillListBounds, migrateScheduledFillLists } from './migrations/scheduledFill';
import { migrateEmergencyFillTime, migrateTimeUnits } from './migrations/timeUnits';

import type { AppSettings } from '../types/settings';

/**
 * Run every flag-gated migration over the merged settings (mutating them
 * in place). Returns true when anything changed, so the caller persists the
 * result. Order matters: the interval→schedule migration must precede the
 * schedule-bounds pass, whose output always conforms already; likewise the
 * scheduled-fill scalar→list migration precedes its bounds pass.
 */
const runMigrations = (mergedSettings: AppSettings): boolean => {
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

export { runMigrations, pruneObsoleteSettings };
