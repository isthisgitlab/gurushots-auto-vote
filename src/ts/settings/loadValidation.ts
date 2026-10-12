/**
 * What a load accepts of the stored settings: the merge over the defaults, and the removal of the values whose type
 * or range a read would otherwise misreport.
 */

import { schemaEntry, validateSetting } from './schema';
import { API_MAX_RETRIES_MAX, API_TIMEOUT_MAX_SEC, API_TIMEOUT_MIN_SEC } from './limits';
import { getDefaultSettings } from './defaults';
import { isPlainObject } from '../plainObject';
import { oneLine } from '../format/logSafe';
import { isUnsafeChallengeKey } from '../metadata/validation';

import type { AppSettings } from '../types/settings';

/**
 * Merge parsed persisted settings over the defaults so all properties
 * exist, and resolve the environment-aware mock default.
 *
 * @param settings - the parsed persisted blob
 */
const mergeWithDefaults = (settings: unknown): AppSettings => {
    const defaults = getDefaultSettings();
    // Defaults carry the environment-aware mock value, so a persisted blob
    // without `mock` (JSON never holds `undefined`) inherits it here.
    const merged: AppSettings = { ...defaults, ...(settings as Partial<AppSettings>) };
    // A stored challengeSettings block that predates one of its containers gets
    // the default container here, on every read: dropInvalidValues is skipped
    // for unchanged file text, so it cannot be the one to fill it.
    if (isPlainObject(merged.challengeSettings)) {
        merged.challengeSettings = { ...defaults.challengeSettings, ...merged.challengeSettings };
    }
    return merged;
};

/**
 * Whether a stored top-level value has its default's type. The only list
 * default is customTimezones, a list of zone names.
 */
const hasDefaultsType = (value: unknown, fallback: unknown) =>
    Array.isArray(fallback)
        ? Array.isArray(value) && value.every((item) => typeof item === 'string')
        : typeof value === typeof fallback;

// The top-level numbers with a range narrower than their type: the API client and the cadence trust them. The
// retry delay and the check frequency have the range the settings form offers.
const NUMERIC_BOUNDS: Record<string, { min: number; max: number; integer: boolean }> = {
    apiTimeout: { min: API_TIMEOUT_MIN_SEC, max: API_TIMEOUT_MAX_SEC, integer: false },
    apiMaxRetries: { min: 0, max: API_MAX_RETRIES_MAX, integer: true },
    apiRetryBaseDelayMs: { min: 100, max: 10_000, integer: true },
    checkFrequencyMin: { min: 1, max: 60, integer: false },
    checkFrequencyMax: { min: 1, max: 60, integer: false },
};

/**
 * Whether a top-level setting's value is inside its range (a key without one always is).
 */
const withinNumericBounds = (key: string, value: unknown): boolean => {
    if (!Object.hasOwn(NUMERIC_BOUNDS, key)) return true;
    const { min, max, integer } = NUMERIC_BOUNDS[key];
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max &&
        (!integer || Number.isInteger(value))
    );
};

/**
 * Whether a top-level value is one its key allows: a top-level setting with a schema entry (the app-state flags such
 * as autovoteRunning or noticeAcknowledgedVersion) must pass the entry's validation, and a number with a range stays
 * inside it. Keys the schema does not know are the facade's to keep as they are.
 */
const topLevelValueAllowed = (key: string, value: unknown): boolean =>
    withinNumericBounds(key, value) && validateSetting(key, value);

/**
 * Whether a key addresses an Object.prototype member (`constructor`, `toString`, `__proto__`, ...) rather than a
 * setting: stored under such a name it would shadow the member for every plain-object lookup.
 */
const isPrototypeKey = (key: string): boolean => key in Object.prototype;

/**
 * Remove the values of `values` (a globalDefaults or per-challenge map) that
 * their key's schema validation rejects. Keys the schema does not know are
 * left to pruneObsoleteSettings.
 */
const dropInvalidSchemaValues = (values: Record<string, unknown>, path: string, dropped: string[]) => {
    for (const [key, value] of Object.entries(values)) {
        const entry = schemaEntry(key);
        if (entry?.validation && !entry.validation.safeParse(value).success) {
            delete values[key];
            dropped.push(`${path}.${key}`);
        }
    }
};

/**
 * Drop the stored values whose type a read would otherwise misreport: a
 * top-level value of the wrong type goes back to its default, and a schema
 * value its validation rejects is removed, so the schema default applies.
 * The nested maps other modules own (window bounds, title rules, profiles,
 * scenarios, pins) are checked by their readers.
 * Mutates `settings`; returns the paths it dropped.
 */
const dropInvalidValues = (settings: AppSettings): string[] => {
    const dropped: string[] = [];
    for (const [key, fallback] of Object.entries(getDefaultSettings())) {
        if (!isPlainObject(fallback) && !hasDefaultsType(settings[key], fallback)) {
            settings[key] = fallback;
            dropped.push(key);
        }
    }
    for (const key of Object.keys(settings).filter(isPrototypeKey)) {
        delete settings[key];
        dropped.push(oneLine(key));
    }
    for (const key of Object.keys(NUMERIC_BOUNDS)) {
        if (!withinNumericBounds(key, settings[key])) {
            settings[key] = getDefaultSettings()[key];
            dropped.push(key);
        }
    }
    // A top-level app-state flag that its schema entry rejects is removed; readers treat it as never set.
    for (const key of Object.keys(settings)) {
        if (schemaEntry(key) && !validateSetting(key, settings[key])) {
            delete settings[key];
            dropped.push(key);
        }
    }
    const challengeSettings = settings.challengeSettings as unknown;
    if (!isPlainObject(challengeSettings)) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
        dropped.push('challengeSettings');
        return dropped;
    }
    // The containers every challengeSettings block carries, by kind; the modules
    // that own them validate their contents.
    for (const [key, fallback] of Object.entries(getDefaultSettings().challengeSettings)) {
        const value = challengeSettings[key];
        if (Array.isArray(fallback) ? !Array.isArray(value) : !isPlainObject(value)) {
            dropped.push(`challengeSettings.${key}`);
            challengeSettings[key] = fallback;
        }
    }
    const { globalDefaults, perChallenge } = settings.challengeSettings;
    dropInvalidSchemaValues(globalDefaults, 'challengeSettings.globalDefaults', dropped);
    for (const [challengeId, values] of Object.entries(perChallenge)) {
        if (isPlainObject(values) && !isUnsafeChallengeKey(challengeId)) {
            dropInvalidSchemaValues(values, `challengeSettings.perChallenge.${challengeId}`, dropped);
        } else {
            delete perChallenge[challengeId];
            dropped.push(`challengeSettings.perChallenge.${challengeId}`);
        }
    }
    return dropped;
};

export { dropInvalidValues, isPrototypeKey, mergeWithDefaults, topLevelValueAllowed };
