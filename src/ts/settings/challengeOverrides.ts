/**
 * Schema-based challenge settings: global defaults, id-keyed per-challenge
 * overrides (single-key and batch writes, profile-mode suppression), effective
 * value resolution (scenario phase -> override -> matching rules -> global
 * default), and pruning
 * of overrides for challenges that no longer exist.
 */

import * as logger from '../logger';
import { schemaEntry, schemaDefault, getValidationError } from './schema';
import type { SettingsSchemaEntry } from './schema';
import { loadSettings, saveSettings } from './persistence';
import { valuesEqual, globalChallengeValues, challengeValueSetIsValid } from './defaults';
import { ruleValuesForChallengeId, isTitleProfileSuppressed } from './ruleResolution';
import { scenarioPhaseSettings } from './scenarioOverlay';
import { JOIN_KEPT_KEYS } from './staleChallengeCleanup';
import { isActiveChallengeId, challengeTargetForId } from './challengeFacts';
import { loggableSettingValue } from './logValue';
import { isUnsafeChallengeKey } from '../metadata/validation';

import type { ConfigV2 } from '../types/config';
import type { ChallengeIdInput, ChallengeValues, SettingValueOf } from '../types/settings';

/**
 * Whether an override equal to the inherited value is still stored. The join keys
 * are, for a challenge that is not joined yet: a rule cannot be resolved by id for
 * it, so an entry that merely equals what the global default or a rule gives today
 * would silently stop applying to it. A joined challenge resolves rules by id, so
 * it keeps the normal "equal to inherited means no override".
 */
const keepsEqualValue = (settingKey: string, challengeId: string | number): boolean =>
    JOIN_KEPT_KEYS.includes(settingKey) && !isActiveChallengeId(challengeId);

/**
 * Trimmed string form of a caller-supplied challenge id ('' when absent, or when it names an
 * Object.prototype member rather than a challenge).
 */
const trimmedChallengeId = (challengeId: string | number | null | undefined): string => {
    if (challengeId === null || challengeId === undefined) return '';
    const id = String(challengeId).trim();
    return isUnsafeChallengeKey(id) ? '' : id;
};

/**
 * Whether a caller-supplied challenge id names an Object.prototype member, which no write may use as a key.
 */
const isUnsafeId = (challengeId: string | number): boolean => isUnsafeChallengeKey(String(challengeId).trim());

/**
 * A challenge's stored values, or undefined when it has none of its own: an id that names an
 * Object.prototype member is never a challenge.
 */
const ownChallengeValues = (settings: ConfigV2, challengeId: string | number): ChallengeValues | undefined =>
    Object.hasOwn(settings.challenges, challengeId) ? settings.challenges[challengeId].values : undefined;

/**
 * Removes the stored record of a challenge that holds nothing any more: no values of its own, no suppression and no
 * pins.
 */
const dropEmptyChallengeRecord = (settings: ConfigV2, challengeId: string | number): void => {
    if (!Object.hasOwn(settings.challenges, challengeId)) return;
    const record = settings.challenges[challengeId];
    if (record.values && Object.keys(record.values).length === 0) delete record.values;
    if (Object.keys(record).length === 0) delete settings.challenges[challengeId];
};

/**
 * Get global default value for a setting
 */
const getGlobalDefault = <K extends string>(settingKey: K): SettingValueOf<K> => {
    const entry = schemaEntry(settingKey);
    // A challengeOnly key has no global value: the schema default is all there is.
    if (entry?.challengeOnly) return schemaDefault(settingKey);
    const { defaults } = loadSettings();
    if (Object.prototype.hasOwnProperty.call(defaults, settingKey)) {
        // Stored values are validated against the schema on load.
        return defaults[settingKey] as SettingValueOf<K>;
    }

    // Fallback to schema default if not found in settings
    return schemaDefault(settingKey);
};

/**
 * Set global default value for a setting
 */
const setGlobalDefault = (settingKey: string, value: unknown): boolean => {
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
    const contextSettings = { ...settings.defaults, [settingKey]: value };

    // Get detailed validation error information
    const validationError = getValidationError(settingKey, value, contextSettings);
    if (validationError) {
        logger
            .withCategory('settings')
            .error(`Invalid value for setting ${settingKey}:`, loggableSettingValue(settingKey, value));
        logger.withCategory('settings').error(validationError, null);
        return false;
    }

    settings.defaults[settingKey] = value;
    return saveSettings(settings);
};

/**
 * Get per-challenge override value for a setting
 */
const getChallengeOverride = <K extends string>(
    settingKey: K,
    challengeId: string | number,
): SettingValueOf<K> | null => {
    const overrides = ownChallengeValues(loadSettings(), challengeId);
    if (overrides && Object.hasOwn(overrides, settingKey)) {
        // Stored values are validated against the schema on load.
        return overrides[settingKey] as SettingValueOf<K>;
    }

    return null;
};

/**
 * Ensures the `challenges[challengeId].values` container
 * exists on the given configuration and returns it.
 */
const _ensureChallengeContainer = (settings: ConfigV2, challengeId: string | number): ChallengeValues => {
    if (!Object.hasOwn(settings.challenges, challengeId)) {
        settings.challenges[challengeId] = {};
    }
    const record = settings.challenges[challengeId];
    return (record.values ??= {});
};

/**
 * Validates a per-challenge override and writes it onto the in-memory
 * settings object. Returns one of: 'invalid' (rejected),
 * 'set' (override stored), 'cleared' (override removed because it
 * matched the inherited value, except the chosen-photos keys).
 */
const _applyChallengeOverride = (
    settings: ConfigV2,
    settingKey: string,
    challengeId: string | number,
    value: unknown,
): 'invalid' | 'set' | 'cleared' => {
    const entry = schemaEntry(settingKey);
    if (!entry) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return 'invalid';
    }
    if (isUnsafeId(challengeId)) {
        logger.withCategory('settings').error(`Invalid challenge id: ${String(challengeId)}`, null);
        return 'invalid';
    }
    if (!entry.perChallenge) {
        logger.withCategory('settings').error(`Setting ${settingKey} does not support per-challenge overrides`, null);
        return 'invalid';
    }

    const globalDefaults = globalChallengeValues(settings);
    const inheritedDefaults = { ...globalDefaults, ...ruleValuesForChallengeId(settings, challengeId) };
    const existingOverrides = ownChallengeValues(settings, challengeId) || {};
    const contextSettings = { ...inheritedDefaults, ...existingOverrides, [settingKey]: value };

    if (!challengeValueSetIsValid(contextSettings, { [settingKey]: value }, challengeId)) {
        logger
            .withCategory('settings')
            .error(`Invalid value for setting ${settingKey}:`, loggableSettingValue(settingKey, value));
        return 'invalid';
    }

    const container = _ensureChallengeContainer(settings, challengeId);
    // inheritedDefaults always holds every schema key (globalChallengeValues
    // starts from the full schema defaults), and settingKey is schema-checked above.
    if (keepsEqualValue(settingKey, challengeId) || !valuesEqual(value, inheritedDefaults[settingKey])) {
        container[settingKey] = value;
        return 'set';
    }
    delete container[settingKey];
    return 'cleared';
};

/**
 * Set per-challenge override value for a setting.
 */
const setChallengeOverride = (settingKey: string, challengeId: string | number, value: unknown): boolean => {
    const settings = loadSettings();
    const result = _applyChallengeOverride(settings, settingKey, challengeId, value);
    if (result === 'invalid') return false;

    // If the cleared override left the challenge container empty, drop it.
    dropEmptyChallengeRecord(settings, challengeId);
    return saveSettings(settings);
};

const _challengeOverrideEntries = (overrides: unknown): Array<[string, unknown]> | null => {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
    const entries = Object.entries(overrides);
    return entries.some(([key]) => !schemaEntry(key)?.perChallenge) ? null : entries;
};

const _writeTitleProfileSuppression = (settings: ConfigV2, challengeId: string, suppressed: boolean) => {
    if (suppressed) {
        if (!Object.hasOwn(settings.challenges, challengeId)) settings.challenges[challengeId] = {};
        settings.challenges[challengeId].suppressRuleProfile = true;
    } else if (Object.hasOwn(settings.challenges, challengeId)) {
        delete settings.challenges[challengeId].suppressRuleProfile;
    }
};

/**
 * Validate and write a challenge's whole override container (only values that
 * differ from the inherited global/rule baseline are kept, except the join keys
 * — see JOIN_KEPT_KEYS) plus its profile
 * suppression flag onto the in-memory settings. Returns false when rejected.
 */
const replaceChallengeOverridesInSettings = (
    settings: ConfigV2,
    challengeId: string,
    overrides: unknown,
    suppressTitleProfile: boolean,
): boolean => {
    const entries = _challengeOverrideEntries(overrides);
    if (entries === null || isUnsafeId(challengeId)) return false;

    const globalValues = globalChallengeValues(settings);
    const ruleValues = ruleValuesForChallengeId(settings, challengeId, suppressTitleProfile);
    const inherited = { ...globalValues, ...ruleValues };
    // Non-null plain object: _challengeOverrideEntries returned entries.
    const overrideValues = overrides as ChallengeValues;
    const effective = { ...inherited, ...overrideValues };
    if (!challengeValueSetIsValid(effective, { ...ruleValues, ...overrideValues }, challengeId)) {
        return false;
    }

    const container: ChallengeValues = {};
    for (const [key, value] of entries) {
        if (keepsEqualValue(key, challengeId) || !valuesEqual(value, inherited[key])) container[key] = value;
    }
    if (Object.keys(container).length) {
        if (!Object.hasOwn(settings.challenges, challengeId)) settings.challenges[challengeId] = {};
        settings.challenges[challengeId].values = container;
    } else if (Object.hasOwn(settings.challenges, challengeId)) {
        delete settings.challenges[challengeId].values;
    }

    _writeTitleProfileSuppression(settings, challengeId, suppressTitleProfile);
    dropEmptyChallengeRecord(settings, challengeId);
    return true;
};

/**
 * Atomically merge multiple per-challenge overrides, saving only values that
 * differ from the inherited global/title-profile baseline.
 */
const setChallengeOverrides = (challengeId: ChallengeIdInput, overrides: unknown): boolean => {
    const id = trimmedChallengeId(challengeId);
    if (!id || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return false;
    const settings = loadSettings();
    const current = ownChallengeValues(settings, id) || {};
    const next = { ...current, ...overrides };
    if (!replaceChallengeOverridesInSettings(settings, id, next, isTitleProfileSuppressed(settings, id))) {
        return false;
    }
    return saveSettings(settings);
};

/**
 * Remove per-challenge override for a setting
 */
const removeChallengeOverride = (settingKey: string, challengeId: string): boolean => {
    if (isUnsafeId(challengeId)) return false;
    const settings = loadSettings();
    const current = ownChallengeValues(settings, challengeId);
    if (!current || !Object.hasOwn(current, settingKey)) return true; // Nothing to remove

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
const getChallengeOverrides = (challengeId: string | number): ChallengeValues => {
    const stored = ownChallengeValues(loadSettings(), challengeId);
    const overrides: ChallengeValues = {};
    if (stored) {
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
 */
const replaceChallengeOverrides = (
    challengeId: ChallengeIdInput,
    overrides: unknown,
    suppressTitleProfile: unknown = false,
): boolean => {
    const id = trimmedChallengeId(challengeId);
    if (!id || typeof suppressTitleProfile !== 'boolean') return false;
    const settings = loadSettings();
    if (!replaceChallengeOverridesInSettings(settings, id, overrides, suppressTitleProfile)) return false;
    return saveSettings(settings);
};

/**
 * Get the effective value for a setting: the active scenario phase's value,
 * then the per-challenge override, matching rules, and the global default.
 */
const getEffectiveSetting = <K extends string>(
    settingKey: K,
    challengeId: ChallengeIdInput = null,
): SettingValueOf<K> => {
    const entry = schemaEntry(settingKey);
    if (!entry) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return undefined as SettingValueOf<K>;
    }

    const settings = loadSettings();

    // A scenario phase's settings sit above every other layer while the
    // challenge is in that phase (settings/scenarioOverlay.ts). The
    // assignment itself is never overlaid.
    if (challengeId && settingKey !== 'scenario' && entry.perChallenge) {
        const phaseSettings = scenarioPhaseSettings(
            settings,
            String(challengeId),
            () => _resolveEffectiveSetting(settings, 'scenario', challengeId) as string,
        );
        if (phaseSettings && Object.prototype.hasOwnProperty.call(phaseSettings, settingKey)) {
            return phaseSettings[settingKey] as SettingValueOf<K>;
        }
    }
    return _resolveEffectiveSetting(settings, settingKey, challengeId) as SettingValueOf<K>;
};

/**
 * The stored layers of getEffectiveSetting, over an already loaded settings
 * blob: per-challenge override -> matching rules -> global default.
 *
 * @param settingKey - a known schema key
 */
const _resolveEffectiveSetting = (settings: ConfigV2, settingKey: string, challengeId: ChallengeIdInput): unknown => {
    const entry = schemaEntry(settingKey) as SettingsSchemaEntry;

    // Explicit id-keyed settings remain the highest-precedence layer.
    if (challengeId && entry.perChallenge) {
        const overrides = ownChallengeValues(settings, challengeId);
        if (overrides && Object.hasOwn(overrides, settingKey)) {
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

    return Object.prototype.hasOwnProperty.call(settings.defaults, settingKey)
        ? settings.defaults[settingKey]
        : entry.default;
};

// The one wording for the chosen-photos consume lines — the log catalog's
// English templates match against exactly this text, so the two drift together.
const formatChosenConsumedMessage = (tag: string, removed: string[], overrideRemoved: boolean): string =>
    overrideRemoved
        ? `${tag}: chosen photos entered — removed from the list: ${removed.join(', ')}; the override was removed`
        : `${tag}: chosen photos entered — removed from the list: ${removed.join(', ')}`;

/**
 * Consumes a challenge's own chosen photos once they are entered in it: every
 * entered id leaves the stored list, a non-empty remainder is stored through
 * the normal override write (so a remainder equal to the inherited value
 * auto-clears the override early), and an emptied list deletes the key —
 * never stores `[]`.
 *
 * Nothing is consumed in two cases. (a) Submit Only Chosen Photos effectively
 * on, resolved over the full layer stack (an active scenario phase above the
 * override, then rules, then the global default): the Submit Only skip needs
 * the ids stored — an emptied list reads as "no preference" and would resume
 * general filling. (b) The facts cache has not seen the challenge as active:
 * at the join-time call site the id is minutes old and rules resolve through
 * the title/facts cache, so a rule-layer Only would be invisible there — an
 * unknown id must hold, and the voting pass's lazy net consumes on the first
 * pass after the cache knows the challenge.
 *
 * Only the challenge's own key is ever consumed: an inherited rule or global
 * list keeps feeding its challenges, and Only set at any layer keeps holding.
 * The Only gate and the list read/write resolve over ONE settings snapshot —
 * a cross-process Only flip between two loads could otherwise consume under a
 * now-on Only, irreversibly. The record is only reached through
 * `ownChallengeValues`' `Object.hasOwn` gate; nothing is created and
 * `_ensureChallengeContainer` is never routed through.
 *
 * @returns whether anything was removed (and saved)
 */
const consumeChosenPhotos = (challengeId: string | number, enteredIds: readonly string[]): boolean => {
    if (isUnsafeId(challengeId)) return false;
    const settings = loadSettings();
    if (!isActiveChallengeId(challengeId)) return false;

    // Submit Only Chosen Photos over the same layer stack getEffectiveSetting
    // reads, resolved over this snapshot.
    const phaseSettings = scenarioPhaseSettings(
        settings,
        String(challengeId),
        () => _resolveEffectiveSetting(settings, 'scenario', challengeId) as string,
    );
    if (phaseSettings && Object.prototype.hasOwnProperty.call(phaseSettings, 'chosenPhotosOnly')) {
        if (phaseSettings.chosenPhotosOnly) return false;
    } else if (_resolveEffectiveSetting(settings, 'chosenPhotosOnly', challengeId)) {
        return false;
    }

    const record = ownChallengeValues(settings, challengeId);
    const stored = record?.chosenPhotos;
    if (!record || !Array.isArray(stored)) return false;
    const entered = new Set(enteredIds.map(String));
    const remainder = stored.filter((id) => !entered.has(String(id)));
    if (remainder.length === stored.length) return false;

    let overrideRemoved: boolean;
    if (remainder.length === 0) {
        // Delete-only: the emptied list never stores [].
        delete record.chosenPhotos;
        overrideRemoved = true;
    } else {
        const outcome = _applyChallengeOverride(settings, 'chosenPhotos', challengeId, remainder);
        // The remainder re-validates like any stored list (its ids passed the
        // schema's CHOSEN_PHOTO_ID_RE at load), so this write cannot come back
        // 'invalid' under Jest.
        /* istanbul ignore if */
        if (outcome === 'invalid') return false;
        // A remainder equal to the inherited rule/global value cleared the
        // override early, so the badge can drop before the list empties.
        overrideRemoved = outcome === 'cleared';
    }
    dropEmptyChallengeRecord(settings, challengeId);
    if (!saveSettings(settings)) return false;
    const removed = stored.filter((id) => entered.has(String(id))).map(String);
    // The id is API-derived: it reaches the line only through the tag, with the
    // title the facts cache holds (settings-layer callers carry no challenge).
    const knownTitle = challengeTargetForId(challengeId).title;
    const tag = logger.challengeTag(challengeId, typeof knownTitle === 'string' && knownTitle ? knownTitle : null);
    logger.withCategory('settings').info(formatChosenConsumedMessage(tag, removed, overrideRemoved), null);
    return true;
};

export {
    getGlobalDefault,
    setGlobalDefault,
    getChallengeOverride,
    setChallengeOverride,
    setChallengeOverrides,
    removeChallengeOverride,
    consumeChosenPhotos,
    getChallengeOverrides,
    replaceChallengeOverrides,
    replaceChallengeOverridesInSettings,
    getEffectiveSetting,
    trimmedChallengeId,
    ownChallengeValues,
    dropEmptyChallengeRecord,
};
