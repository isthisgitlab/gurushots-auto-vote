/**
 * Default settings blob and the small value helpers every settings submodule
 * shares: the environment-aware default blob, the challengeSettings container
 * guard, the effective global challenge values, JSON value equality, and the
 * cross-field validation of a challenge value set.
 */

const { SETTINGS_SCHEMA, validateSetting } = require('./schema');
const { getUiDefaultSettings } = require('./uiDefaults');
const { getDefaultMockSetting } = require('./storage');

// Default settings with environment-aware mock setting
const getDefaultSettings = () => {
    // Generate global defaults from schema
    const globalDefaults = {};
    Object.keys(SETTINGS_SCHEMA).forEach((key) => {
        globalDefaults[key] = SETTINGS_SCHEMA[key].default;
    });

    return {
        // UI-form settings (theme/language/timezone/timing/retry) come from
        // the shared uiDefaults module — single source of truth with the
        // renderer's settings form.
        ...getUiDefaultSettings(),
        lastUsername: '',
        mock: getDefaultMockSetting(),
        token: '',
        onboardingCompleted: false, // First-run welcome dismissed? (app-level flag, same class as apiTimeout)
        // Window position and size settings
        windowBounds: {
            login: { x: undefined, y: undefined, width: 800, height: 960 },
            main: { x: undefined, y: undefined, width: 800, height: 960 },
        },
        // Schema-based challenge settings
        challengeSettings: {
            globalDefaults: globalDefaults,
            perChallenge: {}, // Challenge ID -> setting overrides mapping
            // Challenge rules. Challenges rotate with a fresh id each time, so
            // id-keyed perChallenge overrides are lost on every rotation; these
            // rules match on what survives a rotation — title, challenge tag,
            // type, photo count, runtime — and list order is precedence (see
            // settings/challengeRules.js). A rule may assign one named settings
            // profile, override a few join settings inline, and add
            // must/should-include tags; all of it is an inherited baseline
            // below any id-keyed manual override.
            titleRules: [],
            // Challenge ids where a manually applied named profile replaces,
            // rather than layers over, an automatic title profile.
            titleProfileSuppressions: {},
        },
        // API headers for randomization (random per user installation)
        apiHeaders: {},
    };
};

/**
 * Ensure a loaded settings object carries a challengeSettings container
 * (a hand-edited or legacy blob may lack one) and return it.
 */
const ensureChallengeSettings = (settings) => {
    if (!settings.challengeSettings) {
        settings.challengeSettings = getDefaultSettings().challengeSettings;
    }
    return settings.challengeSettings;
};

/**
 * Value equality for settings comparisons. JSON-based so reference types
 * (arrays like mustIncludeTags, plain objects) compare by content — a bare
 * !== would treat every array override as "differs from default" forever.
 */
const valuesEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Every schema key's effective global value: the stored global default when
 * present, else the schema default. challengeOnly keys always inherit the
 * schema default, never a stored global value (same rule as getEffectiveSetting).
 */
const globalChallengeValues = (settings) => {
    const values = {
        ...getDefaultSettings().challengeSettings.globalDefaults,
        ...(settings.challengeSettings?.globalDefaults || {}),
    };
    for (const key of Object.keys(SETTINGS_SCHEMA)) {
        if (SETTINGS_SCHEMA[key].challengeOnly) values[key] = SETTINGS_SCHEMA[key].default;
    }
    return values;
};

/**
 * Validate the candidate keys of a challenge value set, plus every perChallenge
 * key that (transitively) depends on one of them, against the full effective
 * `values` as cross-field context.
 */
const challengeValueSetIsValid = (values, candidates, challengeId = null) => {
    const affected = new Set(Object.keys(candidates));
    let changed = true;
    while (changed) {
        changed = false;
        for (const [key, config] of Object.entries(SETTINGS_SCHEMA)) {
            if (affected.has(key) || !config.perChallenge || !config.dependsOn?.some((dep) => affected.has(dep))) {
                continue;
            }
            affected.add(key);
            changed = true;
        }
    }

    // Enabling the final-window feature activates its inherited trigger and
    // target even when the sparse candidate does not explicitly contain them.
    if (values.useFinalWindowExposure === true) {
        affected.add('finalWindowExposure');
        affected.add('finalWindowExposureTarget');
    }

    return Array.from(affected).every((key) => {
        const config = SETTINGS_SCHEMA[key];
        if (!config?.perChallenge) return true;
        // A disabled inherited final-window setting is dormant. Explicitly
        // supplied final-window values still validate before being stored.
        const inheritedFinalWindowValue =
            !Object.prototype.hasOwnProperty.call(candidates, key) &&
            (key === 'finalWindowExposure' || key === 'finalWindowExposureTarget');
        if (inheritedFinalWindowValue && values.useFinalWindowExposure !== true) return true;
        return validateSetting(key, values[key], values, challengeId);
    });
};

module.exports = {
    getDefaultSettings,
    ensureChallengeSettings,
    valuesEqual,
    globalChallengeValues,
    challengeValueSetIsValid,
};
