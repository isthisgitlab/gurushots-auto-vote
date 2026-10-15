/**
 * What a 1.x load accepts of the stored settings, frozen: the merge over the defaults, the removal of values whose
 * type or range a read would misreport, and the prune of keys the 1.x schema does not define.
 */

import { isPlainObject } from '../../plainObject';
import { oneLine } from '../../format/logSafe';
import { getV1Defaults } from './defaults';
import { V1_SETTINGS_SCHEMA, v1SchemaEntry, validateV1Setting } from './schema';
import { API_MAX_RETRIES_MAX, API_TIMEOUT_MAX_SEC, API_TIMEOUT_MIN_SEC } from './validators';

import type { V1Blob, V1Values } from './types';

/**
 * Whether a challenge id names an Object.prototype member, which is never a challenge.
 */
const isReservedChallengeId = (challengeId: string): boolean =>
    challengeId === '__proto__' || challengeId === 'constructor' || challengeId === 'prototype';

/**
 * Whether a key addresses an Object.prototype member rather than a setting.
 */
const isPrototypeKey = (key: string): boolean => key in Object.prototype;

/**
 * Merge parsed settings over the defaults so every property exists.
 */
const mergeV1WithDefaults = (parsed: object): V1Blob => {
    const defaults = getV1Defaults();
    const merged: V1Blob = { ...defaults, ...parsed };
    if (isPlainObject(merged.challengeSettings)) {
        merged.challengeSettings = { ...defaults.challengeSettings, ...merged.challengeSettings };
    }
    return merged;
};

/**
 * Whether a stored top-level value has its default's type. The only list default is customTimezones, a list of zone
 * names.
 */
const hasDefaultsType = (value: unknown, fallback: unknown) =>
    Array.isArray(fallback)
        ? Array.isArray(value) && value.every((item) => typeof item === 'string')
        : typeof value === typeof fallback;

// The top-level numbers with a range narrower than their type.
const NUMERIC_BOUNDS: Record<string, { min: number; max: number; integer: boolean }> = {
    apiTimeout: { min: API_TIMEOUT_MIN_SEC, max: API_TIMEOUT_MAX_SEC, integer: false },
    apiMaxRetries: { min: 0, max: API_MAX_RETRIES_MAX, integer: true },
    apiRetryBaseDelayMs: { min: 100, max: 10_000, integer: true },
    checkFrequencyMin: { min: 1, max: 60, integer: false },
    checkFrequencyMax: { min: 1, max: 60, integer: false },
};

const withinNumericBounds = (key: string, value: unknown): boolean => {
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
 * Remove the values of a globalDefaults or per-challenge map that their key's validator rejects.
 */
const dropInvalidSchemaValues = (values: V1Values, path: string, dropped: string[]) => {
    for (const [key, value] of Object.entries(values)) {
        const entry = v1SchemaEntry(key);
        if (entry && !entry.validation.safeParse(value).success) {
            delete values[key];
            dropped.push(`${path}.${key}`);
        }
    }
};

/**
 * Drop the stored values whose type a read would misreport: a top-level value of the wrong type goes back to its
 * default, a schema value its validator rejects is removed. Mutates `settings`; returns the paths it dropped.
 */
const dropInvalidV1Values = (settings: V1Blob): string[] => {
    const dropped: string[] = [];
    const defaults = getV1Defaults();
    for (const [key, fallback] of Object.entries(defaults)) {
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
            settings[key] = defaults[key];
            dropped.push(key);
        }
    }
    for (const key of Object.keys(settings)) {
        if (v1SchemaEntry(key) && !validateV1Setting(key, settings[key])) {
            delete settings[key];
            dropped.push(key);
        }
    }
    const challengeSettings = settings.challengeSettings as unknown;
    if (!isPlainObject(challengeSettings)) {
        settings.challengeSettings = defaults.challengeSettings;
        dropped.push('challengeSettings');
        return dropped;
    }
    for (const [key, fallback] of Object.entries(defaults.challengeSettings)) {
        const value = challengeSettings[key];
        if (Array.isArray(fallback) ? !Array.isArray(value) : !isPlainObject(value)) {
            dropped.push(`challengeSettings.${key}`);
            challengeSettings[key] = fallback;
        }
    }
    const { globalDefaults, perChallenge } = settings.challengeSettings;
    dropInvalidSchemaValues(globalDefaults, 'challengeSettings.globalDefaults', dropped);
    for (const [challengeId, values] of Object.entries(perChallenge)) {
        if (isPlainObject(values) && !isReservedChallengeId(challengeId)) {
            dropInvalidSchemaValues(values, `challengeSettings.perChallenge.${challengeId}`, dropped);
        } else {
            delete perChallenge[challengeId];
            dropped.push(`challengeSettings.perChallenge.${challengeId}`);
        }
    }
    return dropped;
};

/**
 * Delete the legacy top-level boostConfig key and every globalDefaults / perChallenge key the 1.x schema does not
 * define, then any per-challenge map left empty. Mutates `settings`; true when anything was removed.
 */
const pruneV1Obsolete = (settings: V1Blob): boolean => {
    let hasChanges = false;
    if (settings.boostConfig) {
        delete settings.boostConfig;
        hasChanges = true;
    }
    const { globalDefaults, perChallenge } = settings.challengeSettings;
    const unknownKeys = (values: V1Values) =>
        Object.keys(values).filter((key) => !Object.hasOwn(V1_SETTINGS_SCHEMA, key));
    for (const key of unknownKeys(globalDefaults)) {
        delete globalDefaults[key];
        hasChanges = true;
    }
    for (const [challengeId, values] of Object.entries(perChallenge)) {
        for (const key of unknownKeys(values)) {
            delete values[key];
            hasChanges = true;
        }
        if (Object.keys(values).length === 0) {
            delete perChallenge[challengeId];
            hasChanges = true;
        }
    }
    return hasChanges;
};

export { dropInvalidV1Values, isReservedChallengeId, mergeV1WithDefaults, pruneV1Obsolete };
