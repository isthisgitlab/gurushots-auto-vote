/**
 * Seeded configurations generated from the LIVE settings schema: every schema key, with values its own validation
 * accepts. Nothing here names a setting, so a setting added to the schema is in the next configuration generated, and
 * a test that follows what the app writes (the round trip through settings.json) sees it. The values come from pools by
 * kind (booleans, whole numbers, lists of tags, times of day, ...) judged by the key's own validator; a key none of the
 * pools reaches fails `valuesFor`, so a new kind of setting cannot slip through untested.
 */

import { SETTINGS_SCHEMA, validateSetting } from '../../src/ts/settings/schema';
import { TITLE_RULE_INLINE_KEYS } from '../../src/ts/settings/ruleBehaviour';
import { getDefaultSettings, schemaDefaults } from '../../src/ts/settings/defaults';
import { appValueAllowed } from '../../src/ts/settings/loadValidation';
import { getUiDefaultSettings } from '../../src/ts/settings/uiDefaults';
import { makeRng } from '../settings/v2/random';

import type { ConfigV2 } from '../../src/ts/types/config';

type Rng = ReturnType<typeof makeRng>;
type Values = Record<string, unknown>;

// The keys format 1 kept at the top level (app state), not among the global defaults; `chosenPhotosMemberId` is sign-in state.
const APP_STATE_KEYS = [
    'autovoteRunning',
    'autovoteStartedLaunch',
    'skipUpdateVersion',
    'chosenPhotosClearedAt',
    'noticeAcknowledgedVersion',
];

const SCHEMA_KEYS = Object.keys(SETTINGS_SCHEMA);

// The preferences of the settings form (theme, timezone, API timeout, ...): app keys outside the schema.
const UI_KEYS = Object.keys(getUiDefaultSettings());

// Values for the app keys that are not the pools' kind of value (names of themes, languages and zones).
const APP_EXTRA_POOL: readonly unknown[] = ['dark', 'lv', 'Europe/London', ['Europe/Riga', 'Asia/Kolkata']];

// The window geometry an app saves: a position and a size for each window, none of them the default.
const NON_DEFAULT_WINDOW_BOUNDS = {
    login: { x: 40, y: 60, width: 640, height: 720 },
    main: { x: 120, y: 80, width: 1024, height: 768 },
};

const POOL: readonly unknown[] = [
    true,
    false,
    ...[
        0, 1, 2, 3, 4, 5, 7, 10, 15, 20, 25, 30, 45, 50, 59, 60, 75, 90, 99, 100, 120, 180, 300, 600, 900, 1800, 3600,
        7200, 14400, 86400,
    ],
    '',
    'a',
    'Plan A',
    '1.2.3',
    'default, flash',
    'exhibition, comm',
    '2026-01-01',
    [],
    ['sky'],
    ['sky', 'macro', 'night'],
    ['p1'],
    ['p1', 'p2', 'p3'],
    ['09:00'],
    ['06:30', '18:00'],
    [3600],
    [600, 3600, 7200],
    [{ count: 2, seconds: 1800 }],
    [
        { count: 2, seconds: 600 },
        { count: 3, seconds: 1200 },
        { count: 4, seconds: 300 },
    ],
];

/**
 * Every value in the pools that a key's validation accepts (its default is not among them unless a pool holds it).
 */
const acceptedFor = (key: string): unknown[] => {
    const { default: fallback } = SETTINGS_SCHEMA[key as keyof typeof SETTINGS_SCHEMA];
    return POOL.filter((value) => validateSetting(key, value) && JSON.stringify(value) !== JSON.stringify(fallback));
};

/**
 * The values of a key worth storing: the accepted ones that differ from its default. Throws for a key the pools do not
 * reach, so that a setting of a new kind gets a pool before it gets past this test.
 */
const valuesFor = (key: string): unknown[] => {
    const accepted = acceptedFor(key);
    if (accepted.length === 0) throw new Error(`liveConfig has no value pool that ${key} accepts: add one`);
    return accepted;
};

const valueFor = (rng: Rng, key: string): unknown => structuredClone(rng.pick(valuesFor(key)));

/**
 * The values of an app key worth storing: of its default's kind, accepted by the live load (its type and its range), and
 * not its default. Throws for a key no pool reaches, so that a new preference gets a value before it passes this test.
 */
const appValuesFor = (key: string): unknown[] => {
    const fallback: unknown = getUiDefaultSettings()[key as keyof ReturnType<typeof getUiDefaultSettings>];
    const sameKind = (value: unknown): boolean =>
        Array.isArray(fallback)
            ? Array.isArray(value) && value.every((item) => typeof item === 'string')
            : typeof value === typeof fallback;
    const accepted = [...POOL, ...APP_EXTRA_POOL].filter(
        (value) => sameKind(value) && appValueAllowed(key, value) && JSON.stringify(value) !== JSON.stringify(fallback),
    );
    if (accepted.length === 0) throw new Error(`liveConfig has no value pool that the app key ${key} accepts: add one`);
    return accepted;
};

const PER_CHALLENGE_KEYS = SCHEMA_KEYS.filter(
    (key) => SETTINGS_SCHEMA[key as keyof typeof SETTINGS_SCHEMA].perChallenge,
);

const validInSet = (key: string, value: unknown, set: Values): boolean =>
    validateSetting(key, value, { ...schemaDefaults(), ...set, [key]: value }, null);

/**
 * A set holding a value of each of `keys`, each valid by its own validation and in the set it joins; a key that no pool
 * value suits in the set is left out of it.
 */
const valuesAmong = (rng: Rng, keys: readonly string[]): Values => {
    const set: Values = {};
    for (const key of keys) {
        const fits = valuesFor(key).filter((value) => validInSet(key, value, set));
        if (fits.length > 0) set[key] = structuredClone(rng.pick(fits));
    }
    return set;
};

// A set of some of `keys` (at most `count` of them), by the rule of valuesAmong.
const valuesOf = (rng: Rng, keys: readonly string[], count: number): Values => valuesAmong(rng, rng.some(keys, count));

const NAMES = ['Night', 'day', 'Boost it', 'Portrait'];
const TITLES = ['Aurora Borealis', 'Harbor Lights', 'Wild Macro', 'Golden Hour'];

/**
 * One configuration for a seed: every schema key appears somewhere in it (in the global defaults, a profile, a rule, a
 * scenario phase or a challenge's own values), the app state and the sign-in state hold values, and the other containers
 * are filled. It is a configuration as a load returns it (every container and `app` key present).
 */
const randomLiveConfig = (seed: number): { config: ConfigV2; titlePins: Record<string, string> } => {
    const rng = makeRng(seed);
    const config = getDefaultSettings();
    config.app.mock = rng.chance(0.5);
    config.app.onboardingCompleted = rng.chance(0.5);
    // Every preference of the settings form holds a value other than its default.
    for (const key of UI_KEYS) config.app[key] = structuredClone(rng.pick(appValuesFor(key)));
    const { checkFrequencyMin: low, checkFrequencyMax: high } = config.app;
    if (typeof low === 'number' && typeof high === 'number' && low > high) {
        config.app.checkFrequencyMin = high;
        config.app.checkFrequencyMax = low;
    }
    config.app.windowBounds = structuredClone(NON_DEFAULT_WINDOW_BOUNDS);
    for (const key of APP_STATE_KEYS) config.app[key] = valueFor(rng, key);
    config.auth = {
        token: `tok-${seed}`,
        apiHeaders: { 'x-a': `h-${seed}` },
        lastUsername: `user${seed}@example.com`,
        chosenPhotosMemberId: rng.pick(['', 'member-1']),
    };
    // Each key lands in the defaults, and a second place when it can sit per challenge.
    const defaultKeys = SCHEMA_KEYS.filter((key) => !APP_STATE_KEYS.includes(key) && key !== 'chosenPhotosMemberId');
    config.defaults = valuesAmong(
        rng,
        defaultKeys.filter(() => rng.chance(0.7)),
    );
    const perChallengeKeys = PER_CHALLENGE_KEYS.filter((key) => !APP_STATE_KEYS.includes(key));
    const profileNames = rng.some(NAMES, 3);
    config.profiles = Object.fromEntries(profileNames.map((name) => [name, valuesOf(rng, perChallengeKeys, 6)]));
    config.seededProfiles = rng.chance(0.5) ? profileNames.map((name) => name.toLowerCase()) : [];
    config.scenarios = {
        'Plan A': {
            name: 'Plan A',
            version: 1,
            start: 'alpha',
            phases: {
                alpha: { settings: valuesOf(rng, perChallengeKeys, 5) },
                beta: { settings: valuesOf(rng, perChallengeKeys, 3) },
            },
        },
    };
    config.rules = Array.from({ length: rng.int(1, 4) }, () => ({
        title: rng.pick(TITLES),
        match: rng.pick(['exact', 'contains', 'starts']),
        ...(rng.chance(0.6) ? { profile: rng.pick(profileNames) } : {}),
        mustIncludeTags: rng.some(['sky', 'macro'], 2),
        ...valuesOf(
            rng,
            TITLE_RULE_INLINE_KEYS.filter((key) => SCHEMA_KEYS.includes(key)),
            3,
        ),
    }));
    const ids = Array.from({ length: rng.int(2, 5) }, (_, index) => String(100 + index));
    config.challenges = Object.fromEntries(
        ids.map((id) => [
            id,
            {
                ...(rng.chance(0.8) ? { values: valuesOf(rng, perChallengeKeys, 5) } : {}),
                ...(rng.chance(0.4) ? { suppressRuleProfile: true as const } : {}),
                ...(rng.chance(0.4)
                    ? { pins: rng.pick([{ boost: 'e1' }, { turbo: 'e2' }, { boost: 'e1', turbo: 'e3' }]) }
                    : {}),
            },
        ]),
    );
    // A record that holds nothing is not one the app writes.
    for (const [id, record] of Object.entries(config.challenges)) {
        if (Object.keys(record).length === 0) record.suppressRuleProfile = true;
        if (record.values && Object.keys(record.values).length === 0) delete record.values;
        if (Object.keys(config.challenges[id]).length === 0) delete config.challenges[id];
    }
    const titlePins = Object.fromEntries(ids.filter(() => rng.chance(0.6)).map((id) => [id, rng.pick(TITLES)]));
    return { config, titlePins };
};

/**
 * A configuration that holds one schema key, in every place the key may sit: the sign-in state or the app state for the
 * keys that are (`chosenPhotosMemberId`, `autovoteRunning`, ...); the global defaults, a profile, a rule's inline values, a scenario phase and a challenge's own values otherwise.
 */
const configWithKey = (key: string): ConfigV2 => {
    const config = getDefaultSettings();
    const [value] = valuesFor(key).filter((candidate) => validInSet(key, candidate, {}));
    if (value === undefined) throw new Error(`liveConfig has no value of ${key} that is valid on its own: add one`);
    if (key === 'chosenPhotosMemberId') {
        config.auth.chosenPhotosMemberId = String(value);
        return config;
    }
    if (APP_STATE_KEYS.includes(key)) {
        config.app[key] = value;
        return config;
    }
    config.defaults = { [key]: value };
    if (!SETTINGS_SCHEMA[key as keyof typeof SETTINGS_SCHEMA].perChallenge) return config;
    config.profiles = { Night: { [key]: value } };
    config.scenarios = {
        'Plan A': { name: 'Plan A', version: 1, start: 'alpha', phases: { alpha: { settings: { [key]: value } } } },
    };
    config.rules = [
        { title: 'Macro', profile: 'Night', ...(TITLE_RULE_INLINE_KEYS.includes(key) ? { [key]: value } : {}) },
    ];
    config.challenges = { '100': { values: { [key]: value } } };
    return config;
};

/**
 * A configuration that holds one preference of the settings form (`UI_KEYS`) at a value other than its default.
 */
const configWithAppKey = (key: string): ConfigV2 => {
    const config = getDefaultSettings();
    config.app[key] = structuredClone(appValuesFor(key)[0]);
    return config;
};

/** A configuration whose windows have been moved and resized. */
const configWithWindowBounds = (): ConfigV2 => {
    const config = getDefaultSettings();
    config.app.windowBounds = structuredClone(NON_DEFAULT_WINDOW_BOUNDS);
    return config;
};

/**
 * Every set of setting values a configuration holds (the global defaults, a profile, a scenario phase, a rule's inline
 * values, a challenge's own values), each with the path it sits at.
 */
const valueSetsOf = (config: ConfigV2): Array<[string, Values]> => {
    const sets: Array<[string, Values]> = [['defaults', config.defaults]];
    for (const [name, values] of Object.entries(config.profiles)) sets.push([`profiles.${name}`, values as Values]);
    for (const [name, scenario] of Object.entries(config.scenarios)) {
        const { phases } = scenario as { phases: Record<string, { settings: Values }> };
        for (const [phase, { settings }] of Object.entries(phases)) sets.push([`scenarios.${name}.${phase}`, settings]);
    }
    config.rules.forEach((rule, index) => sets.push([`rules[${index}]`, rule]));
    for (const [id, record] of Object.entries(config.challenges)) {
        if (record.values) sets.push([`challenges.${id}`, record.values]);
    }
    return sets;
};

export {
    APP_STATE_KEYS,
    SCHEMA_KEYS,
    UI_KEYS,
    appValuesFor,
    configWithAppKey,
    configWithKey,
    configWithWindowBounds,
    randomLiveConfig,
    valueSetsOf,
    valuesFor,
    validInSet,
};
