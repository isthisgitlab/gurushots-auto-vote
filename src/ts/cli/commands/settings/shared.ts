// Helpers shared by the CLI settings commands: schema lookup, value formatting, key checks.

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import { formatDuration } from '../../../format/duration';
import { stripTerminalControl } from '../../../format/logSafe';
import { PRIVATE_SETTING_KEYS, maskSettingValue, photoCount } from '../../../format/settingsLogMask';
import { REDACTED } from '../../../logger/sanitize';

import type { SettingsSchemaEntry } from '../../../settings/schema';

export type SchemaByKey = Record<string, SettingsSchemaEntry | undefined>;

/**
 * The facade's schema entry for a key only known at runtime (argv), or
 * undefined for an unknown key.
 */
export const schemaEntry = (key: string): SettingsSchemaEntry | undefined =>
    (settings.SETTINGS_SCHEMA as SchemaByKey)[key];

/**
 * Format a settings value for log output, redacting sensitive keys via
 * the same regex the on-disk sanitizer uses. Keys like `token` would
 * otherwise reach the log file embedded in the message string (which
 * the sanitizer does not see), defeating the Tier 1 protection.
 */
export const formatSettingForLog = (key: string, value: unknown): string => {
    if (PRIVATE_SETTING_KEYS.has(key))
        return value === undefined || value === null || value === '' ? '(not set)' : REDACTED;

    const config = schemaEntry(key);
    // A photo list is a handful of account-owned ids: print how many, never which.
    if (config?.type === 'photos' && Array.isArray(value)) return photoCount(value);

    const masked = maskSettingValue({ [key]: value })[key];
    if (masked === REDACTED) return REDACTED;
    // Stored values are user-authored: a control or format character in one must not reach the terminal.
    const raw = stripTerminalControl(JSON.stringify(masked));

    // Time-typed settings are stored in seconds but read as durations everywhere else —
    // the GUI enters them as hours+minutes, and their own descriptions talk in minutes.
    // Printing the bare number invited the wrong comparison: `emergencySubmit` 300 next to
    // `lastMinuteThreshold` 10 looks like 300 > 10 when it is really 5 minutes vs 10.
    // Annotate rather than convert, so the printed value still matches what set-setting
    // expects back.
    if (config?.type === 'time' && typeof value === 'number' && Number.isFinite(value)) {
        return value === 0 ? `${raw} (off)` : `${raw} (${formatDuration(value)})`;
    }

    return raw;
};

// One consistent recovery message for a mistyped schema key, shared by every
// command that validates against SETTINGS_SCHEMA. Self-contained (lists the
// keys inline) so it stays correct for both hosts — the main CLI and the
// pnpm settings:* scripts wire different command names for the schema dump.
// `valid`: the names the command that failed accepts, when they are not the schema's (the command then says "setting",
// not "schema setting").
export const logUnknownSchemaKey = (key: string, valid?: readonly string[]) => {
    logger
        .withCategory('settings')
        .error(valid === undefined ? `Unknown schema setting '${key}'` : `Unknown setting '${key}'`);
    logger
        .withCategory('settings')
        .info(`Available settings: ${[...(valid ?? Object.keys(settings.SETTINGS_SCHEMA))].sort().join(', ')}`);
};

// Guard for the per-challenge variants: a key must be in the schema and declare
// perChallenge before it can carry an override. Logs and returns false on miss: a
// name that is no setting is said to be unknown, not to lack a feature.
export const requirePerChallenge = (key: string) => {
    const entry = schemaEntry(key);
    if (!entry) {
        logUnknownSchemaKey(
            key,
            Object.keys(settings.SETTINGS_SCHEMA).filter((name) => schemaEntry(name)?.perChallenge),
        );
        return false;
    }
    if (!entry.perChallenge) {
        logger.withCategory('settings').error(`Setting '${key}' does not support per-challenge overrides`);
        return false;
    }
    return true;
};
