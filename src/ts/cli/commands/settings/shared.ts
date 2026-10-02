// Helpers shared by the CLI settings commands: schema lookup, value formatting, key checks.

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import { formatDuration } from '../../../format/duration';

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
    const masked = logger.sanitizeForLog({ [key]: value });
    if (masked[key] === '[REDACTED]') return '[REDACTED]';

    const raw = JSON.stringify(value);

    // Time-typed settings are stored in seconds but read as durations everywhere else —
    // the GUI enters them as hours+minutes, and their own descriptions talk in minutes.
    // Printing the bare number invited the wrong comparison: `emergencyFill` 300 next to
    // `lastMinuteThreshold` 10 looks like 300 > 10 when it is really 5 minutes vs 10.
    // Annotate rather than convert, so the printed value still matches what set-setting
    // expects back.
    const config = schemaEntry(key);
    if (config?.type === 'time' && typeof value === 'number' && Number.isFinite(value)) {
        return value === 0 ? `${raw} (off)` : `${raw} (${formatDuration(value)})`;
    }

    return raw;
};

// One consistent recovery message for a mistyped schema key, shared by every
// command that validates against SETTINGS_SCHEMA. Self-contained (lists the
// keys inline) so it stays correct for both hosts — the main CLI and the
// pnpm settings:* scripts wire different command names for the schema dump.
export const logUnknownSchemaKey = (key: string) => {
    logger.withCategory('settings').error(`Unknown schema setting '${key}'`);
    logger
        .withCategory('settings')
        .info(`Available settings: ${Object.keys(settings.SETTINGS_SCHEMA).sort().join(', ')}`);
};

// Guard for the per-challenge variants: a key must declare perChallenge in
// the schema before it can carry an override. Logs and returns false on miss.
export const requirePerChallenge = (key: string) => {
    if (!schemaEntry(key)?.perChallenge) {
        logger.withCategory('settings').error(`Setting '${key}' does not support per-challenge overrides`);
        return false;
    }
    return true;
};
