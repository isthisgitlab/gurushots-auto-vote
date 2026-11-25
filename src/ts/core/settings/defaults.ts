/**
 * Default configuration and the small value helpers every settings submodule
 * shares: the environment-aware default configuration, the effective global
 * challenge values, and JSON value equality.
 */

import { SETTINGS_SCHEMA, schemaEntry } from './schema';
import { getUiDefaultSettings } from './uiDefaults';
import { getDefaultMockSetting } from './userDataPaths';

import type { ConfigV2 } from '../types/config';
import type { ChallengeValues } from '../types/settings';

/**
 * The default configuration, with the environment-aware mock setting. The containers are empty: a global default that
 * is absent is the schema's own default (see schemaDefaults).
 */
const getDefaultSettings = (): ConfigV2 => ({
    version: 2,
    app: {
        // UI-form settings (theme/language/timezone/timing/retry) come from
        // the shared uiDefaults module — single source of truth with the
        // renderer's settings form.
        ...getUiDefaultSettings(),
        mock: getDefaultMockSetting(),
        onboardingCompleted: false, // First-run welcome dismissed? (app-level flag, same class as apiTimeout)
        // Window position and size settings
        windowBounds: {
            login: { x: undefined, y: undefined, width: 800, height: 960 },
            main: { x: undefined, y: undefined, width: 800, height: 960 },
        },
    },
    // The sign-in state: the token, the API headers for randomization (random per user installation) and the
    // account name the login form is prefilled with.
    auth: { token: '', apiHeaders: {}, lastUsername: '' },
    // Global defaults of the schema-based challenge settings; a key left out is the schema default.
    defaults: {},
    profiles: {},
    seededProfiles: [],
    scenarios: {},
    // Challenge rules. Challenges rotate with a fresh id each time, so id-keyed `challenges[id].values` are lost on
    // every rotation; these rules match on what survives a rotation — title, challenge tag, type, photo count,
    // runtime — and list order is precedence (see settings/challengeRules.ts). A rule may assign one named settings
    // profile, override a few join settings inline, and add must/should-include tags; all of it is an inherited
    // baseline below any id-keyed manual override.
    rules: [],
    // Per challenge: its own values, a manual profile override and its pinned Boost and Turbo entries.
    challenges: {},
});

/**
 * Every schema key with its schema default: the value a global default that is not stored has.
 */
const schemaDefaults = (): ChallengeValues => {
    const values: ChallengeValues = {};
    Object.keys(SETTINGS_SCHEMA).forEach((key) => {
        values[key] = schemaEntry(key)?.default;
    });
    return values;
};

/**
 * Value equality for settings comparisons. JSON-based so reference types
 * (arrays like mustIncludeTags, plain objects) compare by content — a bare
 * !== would treat every array override as "differs from default" forever.
 */
const valuesEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Every schema key's effective global value: the stored global default when
 * present, else the schema default. challengeOnly keys always inherit the
 * schema default, never a stored global value (same rule as getEffectiveSetting).
 */
const globalChallengeValues = (settings: ConfigV2): ChallengeValues => {
    const values: ChallengeValues = { ...schemaDefaults(), ...settings.defaults };
    for (const key of Object.keys(SETTINGS_SCHEMA)) {
        const entry = schemaEntry(key);
        if (entry?.challengeOnly) values[key] = entry.default;
    }
    return values;
};

export { getDefaultSettings, schemaDefaults, valuesEqual, globalChallengeValues };
