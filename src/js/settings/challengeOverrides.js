/**
 * Schema-based challenge settings: global defaults, id-keyed per-challenge
 * overrides (single-key and batch writes, profile-mode suppression), effective
 * value resolution (override -> matching rules -> global default), and pruning
 * of overrides for challenges that no longer exist.
 */

const logger = require('../logger');
const { SETTINGS_SCHEMA, getValidationError } = require('./schema');
const { loadSettings, saveSettings } = require('./persistence');
const {
    getDefaultSettings,
    ensureChallengeSettings,
    valuesEqual,
    globalChallengeValues,
    challengeValueSetIsValid,
} = require('./defaults');
const { ruleValuesForChallengeId, isTitleProfileSuppressed } = require('./ruleResolution');

// Trimmed string form of a caller-supplied challenge id ('' when absent).
const trimmedChallengeId = (challengeId) =>
    challengeId === null || challengeId === undefined ? '' : String(challengeId).trim();

/**
 * Get global default value for a setting
 */
const getGlobalDefault = (settingKey) => {
    // A challengeOnly key has no global value: the schema default is all there is.
    if (SETTINGS_SCHEMA[settingKey]?.challengeOnly) return SETTINGS_SCHEMA[settingKey].default;
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    if (
        challengeSettings.globalDefaults &&
        Object.prototype.hasOwnProperty.call(challengeSettings.globalDefaults, settingKey)
    ) {
        return challengeSettings.globalDefaults[settingKey];
    }

    // Fallback to schema default if not found in settings
    return SETTINGS_SCHEMA[settingKey]?.default;
};

/**
 * Set global default value for a setting
 */
const setGlobalDefault = (settingKey, value) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    if (SETTINGS_SCHEMA[settingKey].challengeOnly) {
        logger
            .withCategory('settings')
            .error(`Setting ${settingKey} can only be set on a challenge or a profile, not globally`, null);
        return false;
    }

    // Get current global defaults for context validation
    const settings = loadSettings();
    const currentGlobalDefaults = settings.challengeSettings?.globalDefaults || {};
    const contextSettings = { ...currentGlobalDefaults, [settingKey]: value };

    // Get detailed validation error information
    const validationError = getValidationError(settingKey, value, contextSettings);
    if (validationError) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        logger.withCategory('settings').error(validationError, null);
        return false;
    }

    const challengeSettings = ensureChallengeSettings(settings);
    if (!challengeSettings.globalDefaults) {
        challengeSettings.globalDefaults = {};
    }

    challengeSettings.globalDefaults[settingKey] = value;
    return saveSettings(settings);
};

/**
 * Get per-challenge override value for a setting
 */
const getChallengeOverride = (settingKey, challengeId) => {
    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    if (
        challengeSettings.perChallenge &&
        challengeSettings.perChallenge[challengeId] &&
        Object.prototype.hasOwnProperty.call(challengeSettings.perChallenge[challengeId], settingKey)
    ) {
        return challengeSettings.perChallenge[challengeId][settingKey];
    }

    return null;
};

/**
 * Ensures the challengeSettings.perChallenge[challengeId] container
 * exists on the given settings object and returns it.
 */
const _ensureChallengeContainer = (settings, challengeId) => {
    const challengeSettings = ensureChallengeSettings(settings);
    if (!challengeSettings.perChallenge) {
        challengeSettings.perChallenge = {};
    }
    if (!challengeSettings.perChallenge[challengeId]) {
        challengeSettings.perChallenge[challengeId] = {};
    }
    return challengeSettings.perChallenge[challengeId];
};

/**
 * Validates a per-challenge override and writes it onto the in-memory
 * settings object. Returns one of: 'invalid' (rejected),
 * 'set' (override stored), 'cleared' (override removed because it
 * matched the global default).
 */
const _applyChallengeOverride = (settings, settingKey, challengeId, value) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return 'invalid';
    }
    if (!SETTINGS_SCHEMA[settingKey].perChallenge) {
        logger.withCategory('settings').error(`Setting ${settingKey} does not support per-challenge overrides`, null);
        return 'invalid';
    }

    const globalDefaults = globalChallengeValues(settings);
    const inheritedDefaults = { ...globalDefaults, ...ruleValuesForChallengeId(settings, challengeId) };
    const existingOverrides = settings.challengeSettings?.perChallenge?.[challengeId] || {};
    const contextSettings = { ...inheritedDefaults, ...existingOverrides, [settingKey]: value };

    if (!challengeValueSetIsValid(contextSettings, { [settingKey]: value }, challengeId)) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        return 'invalid';
    }

    const container = _ensureChallengeContainer(settings, challengeId);
    // inheritedDefaults always holds every schema key (globalChallengeValues
    // starts from the full schema defaults), and settingKey is schema-checked above.
    if (!valuesEqual(value, inheritedDefaults[settingKey])) {
        container[settingKey] = value;
        return 'set';
    }
    delete container[settingKey];
    return 'cleared';
};

/**
 * Set per-challenge override value for a setting.
 */
const setChallengeOverride = (settingKey, challengeId, value) => {
    const settings = loadSettings();
    const result = _applyChallengeOverride(settings, settingKey, challengeId, value);
    if (result === 'invalid') return false;

    // If the cleared override left the challenge container empty, drop it.
    const container = settings.challengeSettings?.perChallenge?.[challengeId];
    if (container && Object.keys(container).length === 0) {
        delete settings.challengeSettings.perChallenge[challengeId];
    }
    return saveSettings(settings);
};

const _challengeOverrideEntries = (overrides) => {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
    const entries = Object.entries(overrides);
    return entries.some(([key]) => !SETTINGS_SCHEMA[key]?.perChallenge) ? null : entries;
};

const _writeTitleProfileSuppression = (challengeSettings, challengeId, suppressed) => {
    const prior = challengeSettings.titleProfileSuppressions;
    const next = prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior } : {};
    if (suppressed) next[challengeId] = true;
    else delete next[challengeId];
    challengeSettings.titleProfileSuppressions = next;
};

/**
 * Validate and write a challenge's whole override container (only values that
 * differ from the inherited global/rule baseline are kept) plus its profile
 * suppression flag onto the in-memory settings. Returns false when rejected.
 * Expects `settings.challengeSettings` to exist.
 */
const replaceChallengeOverridesInSettings = (settings, challengeId, overrides, suppressTitleProfile) => {
    const entries = _challengeOverrideEntries(overrides);
    if (entries === null) return false;

    const globalValues = globalChallengeValues(settings);
    const ruleValues = ruleValuesForChallengeId(settings, challengeId, suppressTitleProfile);
    const inherited = { ...globalValues, ...ruleValues };
    const effective = { ...inherited, ...overrides };
    if (!challengeValueSetIsValid(effective, { ...ruleValues, ...overrides }, challengeId)) {
        return false;
    }

    const container = {};
    for (const [key, value] of entries) {
        if (!valuesEqual(value, inherited[key])) container[key] = value;
    }
    const challengeSettings = settings.challengeSettings;
    if (!challengeSettings.perChallenge) challengeSettings.perChallenge = {};
    if (Object.keys(container).length) challengeSettings.perChallenge[challengeId] = container;
    else delete challengeSettings.perChallenge[challengeId];

    _writeTitleProfileSuppression(challengeSettings, challengeId, suppressTitleProfile);
    return true;
};

/**
 * Atomically merge multiple per-challenge overrides, saving only values that
 * differ from the inherited global/title-profile baseline.
 */
const setChallengeOverrides = (challengeId, overrides) => {
    const id = trimmedChallengeId(challengeId);
    if (!id || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return false;
    const settings = loadSettings();
    const current = ensureChallengeSettings(settings).perChallenge?.[id] || {};
    const next = { ...current, ...overrides };
    if (!replaceChallengeOverridesInSettings(settings, id, next, isTitleProfileSuppressed(settings, id))) {
        return false;
    }
    return saveSettings(settings);
};

/**
 * Remove per-challenge override for a setting
 */
const removeChallengeOverride = (settingKey, challengeId) => {
    const settings = loadSettings();
    if (
        !settings.challengeSettings ||
        !settings.challengeSettings.perChallenge ||
        !settings.challengeSettings.perChallenge[challengeId]
    ) {
        return true; // Nothing to remove
    }

    const current = settings.challengeSettings.perChallenge[challengeId];
    if (!Object.prototype.hasOwnProperty.call(current, settingKey)) return true;
    const next = { ...current };
    delete next[settingKey];
    if (
        !replaceChallengeOverridesInSettings(
            settings,
            challengeId,
            next,
            isTitleProfileSuppressed(settings, challengeId),
        )
    ) {
        return false;
    }

    return saveSettings(settings);
};

/**
 * Batch reader for one challenge's sparse override map. Own-property-safe
 * copy filtered to schema-known perChallenge keys — shared by the GUI modal
 * load and the CLI save-profile snapshot.
 */
const getChallengeOverrides = (challengeId) => {
    const settings = loadSettings();
    const perChallenge = settings.challengeSettings?.perChallenge;
    const overrides = {};
    if (
        perChallenge &&
        typeof perChallenge === 'object' &&
        Object.prototype.hasOwnProperty.call(perChallenge, challengeId)
    ) {
        const stored = perChallenge[challengeId];
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            for (const key of Object.keys(stored)) {
                if (SETTINGS_SCHEMA[key]?.perChallenge) {
                    overrides[key] = stored[key];
                }
            }
        }
    }
    return overrides;
};

/** Atomically replace a challenge form's manual settings and profile mode. */
const replaceChallengeOverrides = (challengeId, overrides, suppressTitleProfile = false) => {
    const id = trimmedChallengeId(challengeId);
    if (!id || typeof suppressTitleProfile !== 'boolean') return false;
    const settings = loadSettings();
    ensureChallengeSettings(settings);
    if (!replaceChallengeOverridesInSettings(settings, id, overrides, suppressTitleProfile)) return false;
    return saveSettings(settings);
};

/**
 * Get the effective value for a setting (per-challenge override or global default)
 */
const getEffectiveSetting = (settingKey, challengeId = null) => {
    if (!SETTINGS_SCHEMA[settingKey]) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return SETTINGS_SCHEMA[settingKey]?.default;
    }

    const settings = loadSettings();
    const challengeSettings = settings.challengeSettings || getDefaultSettings().challengeSettings;

    // Explicit id-keyed settings remain the highest-precedence layer.
    if (challengeId && SETTINGS_SCHEMA[settingKey].perChallenge) {
        const overrides = challengeSettings.perChallenge?.[challengeId];
        if (overrides && Object.prototype.hasOwnProperty.call(overrides, settingKey)) {
            return overrides[settingKey];
        }

        // Rule values are an inherited baseline, not copied per-challenge
        // overrides. That makes them survive rotating challenge ids while still
        // allowing a one-off manual override to win above them.
        const ruleValues = ruleValuesForChallengeId(settings, challengeId);
        if (Object.prototype.hasOwnProperty.call(ruleValues, settingKey)) {
            return ruleValues[settingKey];
        }
    }

    // A challengeOnly key ignores any stored global value (hand-edited or left by
    // an older build): only a challenge override or a profile can turn it on.
    if (SETTINGS_SCHEMA[settingKey].challengeOnly) return SETTINGS_SCHEMA[settingKey].default;

    return Object.prototype.hasOwnProperty.call(challengeSettings.globalDefaults || {}, settingKey)
        ? challengeSettings.globalDefaults[settingKey]
        : SETTINGS_SCHEMA[settingKey].default;
};

/**
 * Returns a per-challenge exposure-threshold resolver. Falls back to the
 * schema default if a corrupt override would otherwise stall the cycle.
 * Single source so the IPC handlers and middleware agree.
 */
const getExposureResolver = () => (challengeId) => {
    try {
        return getEffectiveSetting('exposure', challengeId);
    } catch (error) {
        logger.withCategory('settings').warning(`Error getting exposure setting for challenge ${challengeId}:`, error);
        return SETTINGS_SCHEMA.exposure.default;
    }
};

/**
 * Cleanup stale challenge settings for challenges that no longer exist
 */
const cleanupStaleChallengeSetting = (activeChallengeIds) => {
    const settings = loadSettings();
    if (!settings.challengeSettings) {
        return true; // Nothing to cleanup
    }

    const activeIds = new Set(activeChallengeIds);
    const perChallenge = settings.challengeSettings.perChallenge || {};
    const suppressions = settings.challengeSettings.titleProfileSuppressions || {};
    const staleChallengeIds = Object.keys(perChallenge).filter((id) => !activeIds.has(id));
    const staleSuppressionIds = Object.keys(suppressions).filter((id) => !activeIds.has(id));

    if (staleChallengeIds.length === 0 && staleSuppressionIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger
        .withCategory('settings')
        .debug(`Cleaning up settings for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);

    staleChallengeIds.forEach((challengeId) => {
        delete perChallenge[challengeId];
    });
    staleSuppressionIds.forEach((challengeId) => {
        delete suppressions[challengeId];
    });

    return saveSettings(settings);
};

module.exports = {
    getGlobalDefault,
    setGlobalDefault,
    getChallengeOverride,
    setChallengeOverride,
    setChallengeOverrides,
    removeChallengeOverride,
    getChallengeOverrides,
    replaceChallengeOverrides,
    replaceChallengeOverridesInSettings,
    getEffectiveSetting,
    getExposureResolver,
    cleanupStaleChallengeSetting,
    trimmedChallengeId,
};
