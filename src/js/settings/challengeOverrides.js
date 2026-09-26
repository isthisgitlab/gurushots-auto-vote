/**
 * Schema-based challenge settings: global defaults, id-keyed per-challenge
 * overrides (single-key and batch writes, profile-mode suppression), effective
 * value resolution (scenario phase -> override -> matching rules -> global
 * default), and pruning
 * of overrides for challenges that no longer exist.
 */

import * as logger from '../logger';
import { schemaEntry, schemaDefault, getValidationError } from './schema';
import { loadSettings, saveSettings } from './persistence';
import { valuesEqual, globalChallengeValues, challengeValueSetIsValid } from './defaults';
import { ruleValuesForChallengeId, isTitleProfileSuppressed } from './ruleResolution';
import { scenarioPhaseSettings } from './scenarioOverlay';

/**
 * @import { AppSettings, ChallengeIdInput, ChallengeSettings, ChallengeValues, SettingValueOf } from '../types/settings'
 */

/**
 * Trimmed string form of a caller-supplied challenge id ('' when absent).
 *
 * @param {string | number | null | undefined} challengeId
 * @returns {string}
 */
const trimmedChallengeId = (challengeId) =>
    challengeId === null || challengeId === undefined ? '' : String(challengeId).trim();

/**
 * Get global default value for a setting
 *
 * @template {string} K
 * @param {K} settingKey
 * @returns {SettingValueOf<K>}
 */
const getGlobalDefault = (settingKey) => {
    const entry = schemaEntry(settingKey);
    // A challengeOnly key has no global value: the schema default is all there is.
    if (entry?.challengeOnly) return schemaDefault(settingKey);
    const { globalDefaults } = loadSettings().challengeSettings;
    if (Object.prototype.hasOwnProperty.call(globalDefaults, settingKey)) {
        // Stored values are validated against the schema on load.
        return /** @type {SettingValueOf<K>} */ (globalDefaults[settingKey]);
    }

    // Fallback to schema default if not found in settings
    return schemaDefault(settingKey);
};

/**
 * Set global default value for a setting
 *
 * @param {string} settingKey
 * @param {unknown} value
 * @returns {boolean}
 */
const setGlobalDefault = (settingKey, value) => {
    const entry = schemaEntry(settingKey);
    if (!entry) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    if (entry.challengeOnly) {
        logger
            .withCategory('settings')
            .error(`Setting ${settingKey} can only be set on a challenge or a profile, not globally`, null);
        return false;
    }

    // Get current global defaults for context validation
    const settings = loadSettings();
    const currentGlobalDefaults = settings.challengeSettings.globalDefaults;
    const contextSettings = { ...currentGlobalDefaults, [settingKey]: value };

    // Get detailed validation error information
    const validationError = getValidationError(settingKey, value, contextSettings);
    if (validationError) {
        logger.withCategory('settings').error(`Invalid value for setting ${settingKey}:`, value);
        logger.withCategory('settings').error(validationError, null);
        return false;
    }

    settings.challengeSettings.globalDefaults[settingKey] = value;
    return saveSettings(settings);
};

/**
 * Get per-challenge override value for a setting
 *
 * @template {string} K
 * @param {K} settingKey
 * @param {string|number} challengeId
 * @returns {SettingValueOf<K>|null}
 */
const getChallengeOverride = (settingKey, challengeId) => {
    const { perChallenge } = loadSettings().challengeSettings;
    const overrides = perChallenge[challengeId];
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, settingKey)) {
        // Stored values are validated against the schema on load.
        return /** @type {SettingValueOf<K>} */ (overrides[settingKey]);
    }

    return null;
};

/**
 * Ensures the challengeSettings.perChallenge[challengeId] container
 * exists on the given settings object and returns it.
 *
 * @param {AppSettings} settings
 * @param {string|number} challengeId
 * @returns {ChallengeValues}
 */
const _ensureChallengeContainer = (settings, challengeId) => {
    const challengeSettings = settings.challengeSettings;
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
 *
 * @param {AppSettings} settings
 * @param {string} settingKey
 * @param {string|number} challengeId
 * @param {unknown} value
 * @returns {'invalid'|'set'|'cleared'}
 */
const _applyChallengeOverride = (settings, settingKey, challengeId, value) => {
    const entry = schemaEntry(settingKey);
    if (!entry) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return 'invalid';
    }
    if (!entry.perChallenge) {
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
 *
 * @param {string} settingKey
 * @param {string|number} challengeId
 * @param {unknown} value
 * @returns {boolean}
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

/**
 * @param {unknown} overrides
 * @returns {Array<[string, unknown]>|null}
 */
const _challengeOverrideEntries = (overrides) => {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
    const entries = Object.entries(overrides);
    return entries.some(([key]) => !schemaEntry(key)?.perChallenge) ? null : entries;
};

/**
 * @param {ChallengeSettings} challengeSettings
 * @param {string} challengeId
 * @param {boolean} suppressed
 */
const _writeTitleProfileSuppression = (challengeSettings, challengeId, suppressed) => {
    const next = { ...challengeSettings.titleProfileSuppressions };
    if (suppressed) next[challengeId] = true;
    else delete next[challengeId];
    challengeSettings.titleProfileSuppressions = next;
};

/**
 * Validate and write a challenge's whole override container (only values that
 * differ from the inherited global/rule baseline are kept) plus its profile
 * suppression flag onto the in-memory settings. Returns false when rejected.
 * Expects `settings.challengeSettings` to exist.
 *
 * @param {AppSettings} settings
 * @param {string} challengeId
 * @param {unknown} overrides
 * @param {boolean} suppressTitleProfile
 * @returns {boolean}
 */
const replaceChallengeOverridesInSettings = (settings, challengeId, overrides, suppressTitleProfile) => {
    const entries = _challengeOverrideEntries(overrides);
    if (entries === null) return false;

    const globalValues = globalChallengeValues(settings);
    const ruleValues = ruleValuesForChallengeId(settings, challengeId, suppressTitleProfile);
    const inherited = { ...globalValues, ...ruleValues };
    // Non-null plain object: _challengeOverrideEntries returned entries.
    const overrideValues = /** @type {ChallengeValues} */ (overrides);
    const effective = { ...inherited, ...overrideValues };
    if (!challengeValueSetIsValid(effective, { ...ruleValues, ...overrideValues }, challengeId)) {
        return false;
    }

    /** @type {ChallengeValues} */
    const container = {};
    for (const [key, value] of entries) {
        if (!valuesEqual(value, inherited[key])) container[key] = value;
    }
    const challengeSettings = settings.challengeSettings;
    if (Object.keys(container).length) challengeSettings.perChallenge[challengeId] = container;
    else delete challengeSettings.perChallenge[challengeId];

    _writeTitleProfileSuppression(challengeSettings, challengeId, suppressTitleProfile);
    return true;
};

/**
 * Atomically merge multiple per-challenge overrides, saving only values that
 * differ from the inherited global/title-profile baseline.
 *
 * @param {ChallengeIdInput} challengeId
 * @param {unknown} overrides
 * @returns {boolean}
 */
const setChallengeOverrides = (challengeId, overrides) => {
    const id = trimmedChallengeId(challengeId);
    if (!id || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return false;
    const settings = loadSettings();
    const current = settings.challengeSettings.perChallenge?.[id] || {};
    const next = { ...current, ...overrides };
    if (!replaceChallengeOverridesInSettings(settings, id, next, isTitleProfileSuppressed(settings, id))) {
        return false;
    }
    return saveSettings(settings);
};

/**
 * Remove per-challenge override for a setting
 *
 * @param {string} settingKey
 * @param {string} challengeId
 * @returns {boolean}
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
 *
 * @param {string|number} challengeId
 * @returns {ChallengeValues}
 */
const getChallengeOverrides = (challengeId) => {
    const { perChallenge } = loadSettings().challengeSettings;
    /** @type {ChallengeValues} */
    const overrides = {};
    if (Object.prototype.hasOwnProperty.call(perChallenge, challengeId)) {
        const stored = perChallenge[challengeId];
        for (const key of Object.keys(stored)) {
            if (schemaEntry(key)?.perChallenge) {
                overrides[key] = stored[key];
            }
        }
    }
    return overrides;
};

/**
 * Atomically replace a challenge form's manual settings and profile mode.
 *
 * @param {ChallengeIdInput} challengeId
 * @param {unknown} overrides
 * @param {unknown} [suppressTitleProfile]
 * @returns {boolean}
 */
const replaceChallengeOverrides = (challengeId, overrides, suppressTitleProfile = false) => {
    const id = trimmedChallengeId(challengeId);
    if (!id || typeof suppressTitleProfile !== 'boolean') return false;
    const settings = loadSettings();
    settings.challengeSettings;
    if (!replaceChallengeOverridesInSettings(settings, id, overrides, suppressTitleProfile)) return false;
    return saveSettings(settings);
};

/**
 * Get the effective value for a setting: the active scenario phase's value,
 * then the per-challenge override, matching rules, and the global default.
 *
 * @template {string} K
 * @param {K} settingKey
 * @param {ChallengeIdInput} [challengeId]
 * @returns {SettingValueOf<K>}
 */
const getEffectiveSetting = (settingKey, challengeId = null) => {
    const entry = schemaEntry(settingKey);
    if (!entry) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return /** @type {SettingValueOf<K>} */ (undefined);
    }

    const settings = loadSettings();

    // A scenario phase's settings sit above every other layer while the
    // challenge is in that phase (settings/scenarioOverlay.js). The
    // assignment itself is never overlaid.
    if (challengeId && settingKey !== 'scenario' && entry.perChallenge) {
        const phaseSettings = scenarioPhaseSettings(
            settings,
            String(challengeId),
            () => /** @type {string} */ (_resolveEffectiveSetting(settings, 'scenario', challengeId)),
        );
        if (phaseSettings && Object.prototype.hasOwnProperty.call(phaseSettings, settingKey)) {
            return /** @type {SettingValueOf<K>} */ (phaseSettings[settingKey]);
        }
    }
    return /** @type {SettingValueOf<K>} */ (_resolveEffectiveSetting(settings, settingKey, challengeId));
};

/**
 * The stored layers of getEffectiveSetting, over an already loaded settings
 * blob: per-challenge override -> matching rules -> global default.
 *
 * @param {AppSettings} settings
 * @param {string} settingKey - a known schema key
 * @param {ChallengeIdInput} challengeId
 * @returns {unknown}
 */
const _resolveEffectiveSetting = (settings, settingKey, challengeId) => {
    const { challengeSettings } = settings;
    const entry = /** @type {import('./schema').SettingsSchemaEntry} */ (schemaEntry(settingKey));

    // Explicit id-keyed settings remain the highest-precedence layer.
    if (challengeId && entry.perChallenge) {
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
    if (entry.challengeOnly) return entry.default;

    return Object.prototype.hasOwnProperty.call(challengeSettings.globalDefaults, settingKey)
        ? challengeSettings.globalDefaults[settingKey]
        : entry.default;
};

/**
 * Cleanup stale challenge settings for challenges that no longer exist
 *
 * @param {Iterable<string>} activeChallengeIds
 * @returns {boolean}
 */
const cleanupStaleChallengeSetting = (activeChallengeIds) => {
    const settings = loadSettings();
    const activeIds = new Set(activeChallengeIds);
    const { perChallenge, titleProfileSuppressions: suppressions } = settings.challengeSettings;
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

export {
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
    cleanupStaleChallengeSetting,
    trimmedChallengeId,
};
