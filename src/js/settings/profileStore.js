/**
 * Pure helpers over the named challenge-settings profiles map
 * (`challengeSettings.profiles`): caps, name normalization and lookup, and
 * schema sanitization of a profile's values. No persistence — the callers in
 * profiles.js / titleRules.js / migrations.js own the load/save.
 *
 * Profiles are stored as `{ [displayName]: { [settingKey]: value } }` —
 * name-keyed, NOT challenge-id-keyed, because ids rotate and id-keyed state
 * gets pruned by cleanupStaleChallengeSetting. A profile holds only the sparse
 * overrides that differ from global defaults, so later global-default tuning
 * flows through every profile.
 */

const logger = require('../logger');
const { SETTINGS_SCHEMA, validateSetting } = require('./schema');
const { challengeValueSetIsValid } = require('./defaults');

const MAX_CHALLENGE_PROFILES = 50;
const MAX_PROFILE_NAME_LENGTH = 60;

// A bare `profiles['__proto__'] = …` assignment reassigns the map's prototype
// instead of storing data (silent data loss + corrupted lookups), so these
// names are rejected on write and skipped on read — same guard family as
// getTitlePins' own-property iteration.
const RESERVED_PROFILE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

// Identity key for a profile name: trimmed + lowercased (the normalizeTitle
// contract) so "Portrait" and "portrait" are one profile, latest casing wins.
const normalizeProfileName = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');

// Bound a user-supplied profile name before it reaches a log line
// (log-injection guard, same treatment as setTitleRules' forLog).
const profileNameForLog = (name) =>
    String(name)
        .replace(/[\r\n\t]/g, ' ')
        .slice(0, 80);

/**
 * Returns the stored profiles map when it is a plain object, else `{}`.
 * Never returns arrays or primitives from a corrupted blob.
 */
const readProfilesMap = (settings) => {
    const stored = settings.challengeSettings?.profiles;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
};

/**
 * Find the stored key of the profile matching a normalized name, skipping
 * reserved/prototype-shaped stored keys. Returns null when absent.
 */
const findProfileKey = (stored, normalizedName) => {
    for (const name of Object.keys(stored)) {
        const key = normalizeProfileName(name);
        if (RESERVED_PROFILE_NAMES.has(key)) continue;
        if (key === normalizedName) return name;
    }
    return null;
};

const _profileSchemaValues = (values) => {
    const whitelisted = {};
    for (const key of Object.keys(values)) {
        // Prototype-shaped keys fall out here too: SETTINGS_SCHEMA['__proto__']
        // resolves to Object.prototype, whose .perChallenge is undefined.
        if (SETTINGS_SCHEMA[key]?.perChallenge) whitelisted[key] = values[key];
    }
    return whitelisted;
};

const _logProfileValidationFailure = (logInvalid, message, value = null) => {
    if (logInvalid) logger.withCategory('settings').error(message, value);
};

const _validatedProfileValues = (whitelisted, contextSettings, failClosed, logInvalid) => {
    const sanitized = {};
    for (const [key, value] of Object.entries(whitelisted)) {
        if (validateSetting(key, value, contextSettings)) {
            sanitized[key] = value;
            continue;
        }
        if (!failClosed) continue;
        _logProfileValidationFailure(logInvalid, `Invalid profile value for setting ${key}:`, value);
        return null;
    }
    return sanitized;
};

/**
 * Sanitize a profile's values map. Keeps only keys that are perChallenge in
 * SETTINGS_SCHEMA (unknown keys validate as true in validateSetting, so the
 * whitelist is mandatory) and validates each value with the full batch as
 * context so cross-field rules (e.g. exposureTarget >= exposure) hold.
 *
 * failClosed=true (save/apply/automatic execution): returns null on any invalid
 * value. Mutation paths log the failing key; repeated automatic reads suppress
 * that diagnostic so one corrupt stored profile cannot amplify logs every
 * voting cycle. failClosed=false (profile-list display) drops invalid values
 * silently because the schema may have evolved.
 */
const sanitizeProfileValues = (values, failClosed, globalDefaults, logInvalid = true) => {
    const rejected = failClosed ? null : {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return rejected;
    }
    const rawKeys = Object.keys(values);
    // Coarse ceiling far above the schema's perChallenge key count — bounds
    // the work an oversized IPC payload can force before per-key validation.
    if (rawKeys.length > 100) {
        return rejected;
    }

    const whitelisted = _profileSchemaValues(values);
    const contextSettings = { ...globalDefaults, ...whitelisted };
    const sanitized = _validatedProfileValues(whitelisted, contextSettings, failClosed, logInvalid);
    if (sanitized === null) return null;
    // A changed trigger can invalidate an inherited dependent field that is
    // not itself present in the sparse profile (for example exposure=90 with
    // a global exposureTarget=80). Validate the complete effective baseline,
    // not only the keys contributed by the profile.
    if (failClosed && !challengeValueSetIsValid(contextSettings, whitelisted)) {
        _logProfileValidationFailure(logInvalid, 'Profile values conflict with inherited challenge settings');
        return null;
    }
    return sanitized;
};

module.exports = {
    MAX_CHALLENGE_PROFILES,
    MAX_PROFILE_NAME_LENGTH,
    RESERVED_PROFILE_NAMES,
    normalizeProfileName,
    profileNameForLog,
    readProfilesMap,
    findProfileKey,
    sanitizeProfileValues,
};
