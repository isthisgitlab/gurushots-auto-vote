import type { z } from 'zod';
// Bounds live in the dependency-free limits.ts so renderer-reachable modules
// can read them without pulling zod in through this file. Re-exported below to
// keep this module's public surface unchanged.
import { MAX_SCHEDULED_FILL_ENTRIES } from './limits';
import { autoFillSettings, sanitizeFillSchedule } from './schema/autoFill';
import { autoJoinSettings } from './schema/autoJoin';
import { boostSettings } from './schema/boost';
import { currencyAutoSettings } from './schema/currencyAuto';
import type { SettingsSchemaEntry } from './schema/entry';
import { finalWindowSettings } from './schema/finalWindow';
import { generalSettings } from './schema/general';
import { internalSettings } from './schema/internal';
import { lastMinuteSettings } from './schema/lastMinute';
import { notificationsSettings } from './schema/notifications';
import { rewardsSettings } from './schema/rewards';
import { sanitizeBeforeEndList, sanitizeTimeOfDayList, scheduledFillSettings } from './schema/scheduledFill';
import { turboSettings } from './schema/turbo';
import { votingPauseSettings } from './schema/votingPause';

import type { SettingValueOf } from '../types/settings';

/**
 * Centralized Settings Schema
 *
 * Single source of truth for all configurable settings. Each entry
 * declares its type, default, validation, and whether it supports
 * per-challenge overrides. Pure module — no fs, logger, or runtime
 * imports — so the schema can be unit-tested directly and the
 * settings facade re-exports the public surface.
 */

export type { SettingsSchemaEntry };

/**
 * A key's schema default, untyped. Outside this module use the typed
 * `schemaDefault`.
 */
const getSchemaDefault = (key: string): unknown => schemaEntry(key)?.default;

// The group modules spread in the order the settings modals render the groups.
// Key order is user-visible: react/utils/groupSettings.ts lists a section's
// settings in it, as does the CLI schema dump, and
// tests/settings/schema-shape.test.ts pins it. validationOrder/dependsOn drive
// validation ordering independently of it.
const SETTINGS_SCHEMA = {
    ...generalSettings,
    ...boostSettings,
    ...turboSettings,
    ...currencyAutoSettings,
    ...finalWindowSettings,
    ...lastMinuteSettings,
    ...scheduledFillSettings,
    ...votingPauseSettings,
    ...autoJoinSettings,
    ...autoFillSettings,
    ...rewardsSettings,
    ...notificationsSettings,
    ...internalSettings,
} satisfies Record<string, SettingsSchemaEntry>;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;

/**
 * The value type of each setting, read off its zod validator.
 */
export type SettingValues = {
    [K in SettingKey]: z.infer<(typeof SETTINGS_SCHEMA)[K]['validation']>;
};

/**
 * The schema entry for a key that is only known at runtime, or undefined for
 * an unknown key.
 */
const schemaEntry = (key: string): SettingsSchemaEntry | undefined =>
    (SETTINGS_SCHEMA as Record<string, SettingsSchemaEntry | undefined>)[key];

/**
 * A key's schema default, typed as that key's value: every default passes its
 * own validation (tests/settings/schema-defaults.test.ts).
 */
const schemaDefault = <K extends string>(key: K): SettingValueOf<K> => getSchemaDefault(key) as SettingValueOf<K>;

/**
 * Ordered tiers the groups below are rendered under. A tier is presentation
 * only — the one place that branches on it is the global Settings modal, which
 * renders the `app` tier with its Application Settings instead of as a
 * challenge-defaults band — and the order encodes the rule the section list
 * follows: settings a user always touches come before ones that only matter
 * once a specific feature is switched on.
 *
 * - `core`      — on by default, or the value everyone edits first.
 * - `entries`   — what gets submitted into a challenge (photos, joins).
 * - `overrides` — timing rules that replace the normal exposure decision.
 *                 Every enable flag in this tier defaults to false.
 * - `app`       — application-level preferences, not voting behaviour.
 */
const SETTINGS_TIERS: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'core', label: 'app.tierCore' },
    { id: 'entries', label: 'app.tierEntries' },
    { id: 'overrides', label: 'app.tierOverrides' },
    { id: 'app', label: 'app.tierApp' },
];

/**
 * Ordered UI grouping for the settings modals. Each schema entry's `group`
 * field matches an `id` here; the modals render one static section per group
 * in this order, banded under its `tier` (see SETTINGS_TIERS). Entries with no
 * `group` (e.g. autovoteRunning) are intentionally excluded from every section.
 *
 * Group ids are persisted-adjacent — `getGroupApplicability` switches on them
 * and tests assert on them — so ordering and labels change here freely, but an
 * id does not. In particular `scheduledFill` keeps its id while its labels
 * read "Scheduled Voting": it is an exposure-voting rule (it returns a
 * `decided('scheduled', ...)` from `_runVotingRules`), not an entry fill like
 * autoFill/emergencyFill, and sharing the word "fill" with them would read as if
 * the three were siblings. `autoFill`/`emergencyFill` are labelled "Auto-Submit" /
 * "Emergency Submit": in GuruShots "fill" is the currency that tops exposure up
 * to 100% (`autoExposureFill`, `fills`), so user-facing text reserves the word.
 */
const SETTINGS_GROUPS = [
    { id: 'general', label: 'app.groupGeneral', tier: 'core' },
    { id: 'boost', label: 'app.groupBoost', tier: 'core' },
    { id: 'turbo', label: 'app.groupTurbo', tier: 'core' },
    { id: 'currencyAuto', label: 'app.groupCurrencyAuto', tier: 'core' },
    { id: 'autoFill', label: 'app.groupAutoFill', tier: 'entries' },
    { id: 'autoJoin', label: 'app.groupAutoJoin', tier: 'entries' },
    { id: 'finalWindow', label: 'app.groupFinalWindow', tier: 'overrides' },
    { id: 'lastMinute', label: 'app.groupLastMinute', tier: 'overrides' },
    { id: 'scheduledFill', label: 'app.groupScheduledFill', tier: 'overrides' },
    { id: 'votingPause', label: 'app.groupVotingPause', tier: 'overrides' },
    { id: 'rewards', label: 'app.groupRewards', tier: 'app' },
    { id: 'missions', label: 'app.groupMissions', tier: 'app' },
    { id: 'notifications', label: 'app.groupNotifications', tier: 'app' },
    { id: 'display', label: 'app.groupDisplay', tier: 'app' },
];

/**
 * Validate a single setting value against SETTINGS_SCHEMA. Keys that are
 * not in the schema are treated as valid because the schema is the only
 * source of validation rules for per-challenge tunables.
 */
const validateSetting = (
    key: string,
    value: unknown,
    allSettings: Record<string, unknown> | null = null,
    challengeId: string | number | null = null,
): boolean => {
    const schemaConfig = schemaEntry(key);
    if (!schemaConfig) return true;
    if (schemaConfig.validation && !schemaConfig.validation.safeParse(value).success) return false;
    if (schemaConfig.contextValidation && allSettings) {
        if (!schemaConfig.contextValidation(value, allSettings, challengeId)) return false;
    }
    return true;
};

/**
 * Get detailed validation error information for a setting. Returns null
 * when the value is valid. Mirrors `validateSetting`'s call signature
 * (challengeId is forwarded to contextValidation) so a future schema
 * entry that depends on per-challenge context behaves identically
 * across both validation paths.
 */
const getValidationError = (
    settingKey: string,
    value: unknown,
    allSettings: Record<string, unknown> | null = null,
    challengeId: string | number | null = null,
): string | null => {
    const schemaConfig = schemaEntry(settingKey);
    if (!schemaConfig) {
        return null; // No schema config, assume valid
    }

    if (schemaConfig.validation) {
        const parsed = schemaConfig.validation.safeParse(value);
        if (!parsed.success) {
            // Prefer zod's own issue message when it carries real information
            // (custom refine messages, "expected number" type mismatches);
            // zod's generic refine fallback "Invalid input" adds nothing, so
            // return the 'Invalid value' constant there.
            const issueMessage = parsed.error?.issues?.[0]?.message;
            return issueMessage && issueMessage !== 'Invalid input' ? issueMessage : 'Invalid value';
        }
    }

    if (schemaConfig.contextValidation && allSettings) {
        if (!schemaConfig.contextValidation(value, allSettings, challengeId)) {
            if (schemaConfig.getContextError) {
                return schemaConfig.getContextError(value, allSettings, challengeId);
            }
            return 'Invalid value in current context';
        }
    }

    return null; // Valid
};

/**
 * Async getter exposed via IPC; returns the schema as-is. Async signature
 * preserved so existing renderer call sites don't need to change.
 */
const getSettingsSchema = async () => SETTINGS_SCHEMA;

export {
    SETTINGS_SCHEMA,
    schemaEntry,
    SETTINGS_GROUPS,
    SETTINGS_TIERS,
    getSchemaDefault,
    schemaDefault,
    validateSetting,
    getValidationError,
    getSettingsSchema,
    sanitizeFillSchedule,
    sanitizeTimeOfDayList,
    sanitizeBeforeEndList,
    // Shared cap for the scheduled-fill lists: the write path enforces it via
    // zod, the load-time bounds migration heals older data, and the hot-path
    // consumers (VotingLogic, scheduledFill.ts, the settings modal) slice
    // defensively with it so a post-migration hand-edited array can't inflate
    // per-cycle Intl work.
    MAX_SCHEDULED_FILL_ENTRIES,
};
