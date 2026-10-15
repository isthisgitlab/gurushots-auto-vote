/**
 * What a load accepts of the stored configuration: the fill of what a file lacks, and the removal of the values whose
 * type or range a read would otherwise misreport.
 */

import { schemaEntry, validateSetting } from './schema';
import { API_MAX_RETRIES_MAX, API_TIMEOUT_MAX_SEC, API_TIMEOUT_MIN_SEC } from './limits';
import { getDefaultSettings } from './defaults';
import { isPlainObject } from '../plainObject';
import { oneLine } from '../format/logSafe';
import { isUnsafeChallengeKey } from '../metadata/validation';

import type { ConfigV2, ImportedV2 } from '../types/config';
import type { AuthKey } from '../types/settings';

/** The keys of `auth`: the sign-in state, addressed by name through getSetting / setSetting. */
const AUTH_KEYS: readonly AuthKey[] = ['token', 'apiHeaders', 'lastUsername', 'chosenPhotosMemberId'];

const isAuthKey = (key: string): key is AuthKey => (AUTH_KEYS as readonly string[]).includes(key);

/**
 * Fill a parsed configuration over the defaults so every container and every `app` key exists, and resolve the
 * environment-aware mock default. A container of the wrong kind is left for dropInvalidValues to replace.
 *
 * @param stored - the parsed persisted configuration
 */
const mergeWithDefaults = (stored: unknown): ConfigV2 => {
    const defaults = getDefaultSettings();
    // Defaults carry the environment-aware mock value, so a persisted `app` without `mock` (JSON never holds
    // `undefined`) inherits it here.
    const merged: ConfigV2 = { ...defaults, ...(stored as Partial<ConfigV2>), version: 2 };
    if (isPlainObject(merged.app)) merged.app = { ...defaults.app, ...merged.app };
    if (isPlainObject(merged.auth)) merged.auth = { ...defaults.auth, ...merged.auth };
    return merged;
};

/**
 * Whether a stored app value has its default's type. The only list default is customTimezones, a list of zone
 * names.
 */
const hasDefaultsType = (value: unknown, fallback: unknown) =>
    Array.isArray(fallback)
        ? Array.isArray(value) && value.every((item) => typeof item === 'string')
        : typeof value === typeof fallback;

// The app numbers with a range narrower than their type: the API client and the cadence trust them. The
// retry delay and the check frequency have the range the settings form offers.
const NUMERIC_BOUNDS: Record<string, { min: number; max: number; integer: boolean }> = {
    apiTimeout: { min: API_TIMEOUT_MIN_SEC, max: API_TIMEOUT_MAX_SEC, integer: false },
    apiMaxRetries: { min: 0, max: API_MAX_RETRIES_MAX, integer: true },
    apiRetryBaseDelayMs: { min: 100, max: 10_000, integer: true },
    checkFrequencyMin: { min: 1, max: 60, integer: false },
    checkFrequencyMax: { min: 1, max: 60, integer: false },
};

/**
 * Whether an app setting's value is inside its range (a key without one always is).
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
 * Whether an app value is one its key allows: an app setting with a schema entry (the app-state flags such as
 * autovoteRunning or noticeAcknowledgedVersion) must pass the entry's validation, and a number with a range stays
 * inside it. Keys the schema does not know are the facade's to keep as they are.
 */
const appValueAllowed = (key: string, value: unknown): boolean =>
    withinNumericBounds(key, value) && validateSetting(key, value);

/**
 * Whether a value is one an `auth` key holds: the token, the last user name and the chosen-photos account are
 * strings, the API headers an object of strings.
 */
const authValueAllowed = (key: AuthKey, value: unknown): boolean =>
    key === 'apiHeaders'
        ? isPlainObject(value) && Object.values(value).every((header) => typeof header === 'string')
        : typeof value === 'string' && validateSetting(key, value);

/**
 * Whether a key addresses an Object.prototype member (`constructor`, `toString`, `__proto__`, ...) rather than a
 * setting: stored under such a name it would shadow the member for every plain-object lookup.
 */
const isPrototypeKey = (key: string): boolean => key in Object.prototype;

/**
 * Remove the values of `values` (the defaults or one challenge's values) that their key's schema validation rejects.
 * Keys the schema does not know are left as they are.
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

const dropInvalidApp = (config: ConfigV2, dropped: string[]) => {
    const defaults = getDefaultSettings();
    if (!isPlainObject(config.app)) {
        config.app = defaults.app;
        dropped.push('app');
        return;
    }
    const { app } = config;
    for (const [key, fallback] of Object.entries(defaults.app)) {
        if (!isPlainObject(fallback) && !hasDefaultsType(app[key], fallback)) {
            app[key] = fallback;
            dropped.push(`app.${key}`);
        }
    }
    for (const key of Object.keys(app).filter(isPrototypeKey)) {
        delete app[key];
        dropped.push(`app.${oneLine(key)}`);
    }
    for (const key of Object.keys(NUMERIC_BOUNDS)) {
        if (!withinNumericBounds(key, app[key])) {
            app[key] = defaults.app[key];
            dropped.push(`app.${key}`);
        }
    }
    // An app-state flag that its schema entry rejects is removed; readers treat it as never set.
    for (const key of Object.keys(app)) {
        if (schemaEntry(key) && !validateSetting(key, app[key])) {
            delete app[key];
            dropped.push(`app.${key}`);
        }
    }
};

const dropInvalidAuth = (config: ConfigV2, dropped: string[]) => {
    const defaults = getDefaultSettings();
    if (!isPlainObject(config.auth)) {
        config.auth = defaults.auth;
        dropped.push('auth');
        return;
    }
    const { auth } = config;
    for (const key of AUTH_KEYS) {
        if (!authValueAllowed(key, auth[key])) {
            Object.assign(auth, { [key]: defaults.auth[key] });
            dropped.push(`auth.${key}`);
        }
    }
};

/**
 * Whether a stored `imported` record has the shape the importer writes.
 */
const isImportedRecord = (value: unknown): value is ImportedV2 =>
    isPlainObject(value) &&
    typeof value.at === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.acknowledged === 'boolean' &&
    isPlainObject(value.report) &&
    Array.isArray(value.report.refsBlocked) &&
    value.report.refsBlocked.every((ref) => typeof ref === 'string');

const dropInvalidContainers = (config: ConfigV2, dropped: string[]) => {
    const defaults = getDefaultSettings();
    for (const key of ['defaults', 'profiles', 'scenarios', 'challenges'] as const) {
        if (!isPlainObject(config[key])) {
            Object.assign(config, { [key]: defaults[key] });
            dropped.push(key);
        }
    }
    for (const key of ['seededProfiles', 'rules'] as const) {
        if (!Array.isArray(config[key])) {
            Object.assign(config, { [key]: defaults[key] });
            dropped.push(key);
        }
    }
    if (config.imported !== undefined && !isImportedRecord(config.imported)) {
        delete config.imported;
        dropped.push('imported');
    }
};

const dropInvalidChallenges = (config: ConfigV2, dropped: string[]) => {
    for (const [challengeId, record] of Object.entries(config.challenges)) {
        const path = `challenges.${oneLine(challengeId)}`;
        if (!isPlainObject(record) || isUnsafeChallengeKey(challengeId)) {
            delete config.challenges[challengeId];
            dropped.push(path);
            continue;
        }
        if (Object.hasOwn(record, 'values')) {
            if (isPlainObject(record.values)) dropInvalidSchemaValues(record.values, `${path}.values`, dropped);
            else {
                delete record.values;
                dropped.push(`${path}.values`);
            }
        }
        if (Object.hasOwn(record, 'suppressRuleProfile') && record.suppressRuleProfile !== true) {
            delete record.suppressRuleProfile;
            dropped.push(`${path}.suppressRuleProfile`);
        }
        if (Object.hasOwn(record, 'pins') && !isPlainObject(record.pins)) {
            delete record.pins;
            dropped.push(`${path}.pins`);
        }
    }
};

/**
 * Drop the stored values whose type a read would otherwise misreport: an `app` or `auth` value of the wrong type goes
 * back to its default, a container of the wrong kind is replaced by an empty one, and a schema value its validation
 * rejects is removed, so the schema default applies. The nested maps other modules own (window bounds, rules,
 * profiles, scenarios, pins) are checked by their readers.
 * Mutates `config`; returns the paths it dropped.
 */
const dropInvalidValues = (config: ConfigV2): string[] => {
    const dropped: string[] = [];
    dropInvalidApp(config, dropped);
    dropInvalidAuth(config, dropped);
    dropInvalidContainers(config, dropped);
    dropInvalidSchemaValues(config.defaults, 'defaults', dropped);
    dropInvalidChallenges(config, dropped);
    return dropped;
};

export {
    AUTH_KEYS,
    appValueAllowed,
    authValueAllowed,
    dropInvalidValues,
    isAuthKey,
    isPrototypeKey,
    mergeWithDefaults,
};
