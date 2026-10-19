/**
 * What the app writes to settings.json, the importer reads back whole: for configurations generated from the LIVE
 * settings schema (every key, valid values; tests/helpers/liveConfig.ts), `import(toFormatOne(config))` equals the
 * configuration; and for every equivalence fixture and seeded file, importing, mirroring and importing again changes
 * nothing. A setting added to the schema that the importer would drop, or a validator the frozen copy would reject a
 * value of, fails here.
 */

jest.mock('electron', () => ({}));

import { z } from 'zod';
import { V1_KEY_RENAMES, importV1Settings } from '../../../src/ts/settings/importV1';
import { V1_MIGRATION_FLAGS } from '../../../src/ts/settings/importV1/migrations';
import { attachCloseTimeRules, takeCloseTimeRules } from '../../../src/ts/settings/closeTimeRules';
import { getDefaultSettings } from '../../../src/ts/settings/defaults';
import { getV1Defaults } from '../../../src/ts/settings/importV1/defaults';
import { dropInvalidV1Values } from '../../../src/ts/settings/importV1/loadValidation';
import { API_MAX_RETRIES_MAX, API_TIMEOUT_MAX_SEC, API_TIMEOUT_MIN_SEC } from '../../../src/ts/settings/limits';
import { appValueAllowed } from '../../../src/ts/settings/loadValidation';
import { effectiveTimezone, getUiDefaultSettings } from '../../../src/ts/settings/uiDefaults';
import { withImportedTimezone } from '../../../src/ts/settings/formatOneTimezone';
import { SETTINGS_SCHEMA, schemaEntry } from '../../../src/ts/settings/schema';
import { dropInvalidValues, mergeWithDefaults } from '../../../src/ts/settings/loadValidation';
import { mirrorTextOf, toFormatOne } from '../../../src/ts/settings/formatOneMirror';
import { FIXTURES } from '../v2/fixtures';
import { parseSeeds, randomCase } from '../v2/random';
import {
    SCHEMA_KEYS,
    UI_KEYS,
    appValuesFor,
    configWithAppKey,
    configWithKey,
    configWithWindowBounds,
    randomLiveConfig,
    validInSet,
    valueSetsOf,
} from '../../helpers/liveConfig';
import { parseJsonObject } from '../../helpers/parseJson';

import type { ConfigV2, StoredConfigV2 } from '../../../src/ts/types/config';

const keptKey = (key: string): boolean => schemaEntry(key) !== undefined;
const SEEDS = parseSeeds(
    process.env.V2_SEEDS,
    Array.from({ length: 40 }, (_, index) => index + 1),
);

/** A configuration as a load reads it, without the import record, in the plain JSON form it is stored in. */
const loaded = (config: ConfigV2 | StoredConfigV2): unknown => {
    const read = mergeWithDefaults(JSON.parse(JSON.stringify(config)));
    dropInvalidValues(read);
    delete read.imported;
    return JSON.parse(JSON.stringify(read));
};

/**
 * `loaded`, with the timezone read through `effectiveTimezone`: the mirror writes a blank timezone as UTC on purpose (what
 * the configuration means by it), so a configuration → mirror → configuration round trip keeps the zone's meaning, not
 * its spelling.
 */
const loadedByMeaning = (config: ConfigV2 | StoredConfigV2): unknown => {
    const read = loaded(config) as { app: { timezone?: string } };
    return { ...read, app: { ...read.app, timezone: effectiveTimezone(read.app.timezone) } };
};

/**
 * The generator's own check, before anything is compared: the live load keeps the configuration as it is generated, and
 * every value is valid in the set it sits in. A value the load or the cross-field checks refuse would pass the
 * comparison below vacuously (both sides would lose it).
 */
const generatedIsValid = (config: ConfigV2): void => {
    expect(loaded(config)).toEqual(JSON.parse(JSON.stringify(config)));
    for (const [path, set] of valueSetsOf(config)) {
        for (const [key, value] of Object.entries(set)) {
            if (SCHEMA_KEYS.includes(key) && !validInSet(key, value, set)) {
                throw new Error(`the generator made ${path}.${key} = ${JSON.stringify(value)}, which its set refuses`);
            }
        }
    }
};

// What a restore does with the text of a mirror: the rules it carries beside `titleRules` are taken out before the frozen
// importer sees the text, and put back where they stood (legacyImport.ts).
const importMirrorText = (text: string) => {
    const { raw, carried } = takeCloseTimeRules(text);
    const converted = importV1Settings(raw, { keptKey });
    if (!converted.ok) throw new Error(`the importer refused the mirror: ${converted.code}: ${converted.detail}`);
    const result = { ...converted, config: withImportedTimezone(converted.config) };
    if (carried.length > 0) result.config.rules = attachCloseTimeRules(result.config.rules, carried);
    return result;
};

const importMirror = (config: ConfigV2, titlePins: Record<string, string>) =>
    importMirrorText(JSON.stringify(toFormatOne(config, titlePins), null, 2));

describe('the live schema the generator reads', () => {
    test('is not empty, and the generator reaches every key with a value other than its default', () => {
        expect(SCHEMA_KEYS.length).toBeGreaterThan(80);
        for (const key of SCHEMA_KEYS) expect(() => configWithKey(key)).not.toThrow();
    });
});

describe('the limits of the app settings', () => {
    // Recovery imports settings.json back through the frozen importer, so a number the live load keeps and the frozen one
    // drops (or the reverse) would be lost or altered in a restore: the two must accept the same values, at every edge.
    const NUMERIC_KEYS = UI_KEYS.filter(
        (key) => typeof getUiDefaultSettings()[key as keyof ReturnType<typeof getUiDefaultSettings>] === 'number',
    );
    const PROBES = [
        -1,
        0,
        0.5,
        1,
        1.5,
        2,
        3,
        10,
        11,
        59,
        59.5,
        60,
        61,
        99,
        100,
        101,
        299,
        300,
        301,
        9999,
        10_000,
        10_001,
        100_000,
        API_TIMEOUT_MIN_SEC,
        API_TIMEOUT_MAX_SEC,
        API_TIMEOUT_MAX_SEC + 1,
        API_MAX_RETRIES_MAX,
        API_MAX_RETRIES_MAX + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
    ];

    const frozenKeeps = (key: string, value: number): boolean =>
        !dropInvalidV1Values({ ...getV1Defaults(), [key]: value }).includes(key);

    test('the preferences with a range are the ones the generator can reach', () => {
        expect(NUMERIC_KEYS).toEqual(
            expect.arrayContaining([
                'apiTimeout',
                'apiMaxRetries',
                'apiRetryBaseDelayMs',
                'checkFrequencyMin',
                'checkFrequencyMax',
            ]),
        );
        for (const key of NUMERIC_KEYS) expect(appValuesFor(key).length).toBeGreaterThan(0);
    });

    test.each(NUMERIC_KEYS.map((key) => [key]))(
        'the live load and the frozen importer accept the same values of %s',
        (key) => {
            const differing = PROBES.filter((value) => appValueAllowed(key, value) !== frozenKeeps(key, value));

            expect(differing).toEqual([]);
            // (Probes on both sides of the range: the comparison is not vacuous.)
            expect(PROBES.some((value) => appValueAllowed(key, value))).toBe(true);
            expect(PROBES.some((value) => !appValueAllowed(key, value))).toBe(true);
        },
    );
});

describe('the generator check', () => {
    test('refuses a value the live load drops, and a value its set refuses, instead of letting the comparison pass vacuously', () => {
        const dropped = configWithKey('exposure');
        dropped.defaults.exposure = 500;
        expect(() => generatedIsValid(dropped)).toThrow();

        const refused = configWithKey('exposure');
        // A target below its trigger passes its own validation and not the set it sits in.
        refused.defaults = { exposure: 80, exposureTarget: 20 };
        expect(() => generatedIsValid(refused)).toThrow('which its set refuses');
    });
});

describe('import(toFormatOne(config)) equals the configuration', () => {
    test.each(SCHEMA_KEYS.map((key) => [key]))('a configuration holding %s, wherever the key may sit', (key) => {
        const config = configWithKey(key);
        generatedIsValid(config);

        const result = importMirror(config, {});

        expect(loadedByMeaning(result.config)).toEqual(loadedByMeaning(config));
    });

    test.each(SEEDS.map((seed) => [seed]))('seed %i: every container filled, every key somewhere', (seed) => {
        const { config, titlePins } = randomLiveConfig(seed);
        generatedIsValid(config);

        const result = importMirror(config, titlePins);

        expect(loadedByMeaning(result.config)).toEqual(loadedByMeaning(config));
        expect(result.titlePins).toEqual(titlePins);
    });

    test.each(UI_KEYS.map((key) => [key]))(
        'a configuration with %s other than its default (a preference of the form)',
        (key) => {
            const config = configWithAppKey(key);
            generatedIsValid(config);
            expect(config.app[key]).not.toEqual(
                getUiDefaultSettings()[key as keyof ReturnType<typeof getUiDefaultSettings>],
            );

            const result = importMirror(config, {});

            expect(loadedByMeaning(result.config)).toEqual(loadedByMeaning(config));
        },
    );

    test('a configuration whose windows were moved and resized', () => {
        const config = configWithWindowBounds();
        generatedIsValid(config);

        const result = importMirror(config, {});

        expect(loadedByMeaning(result.config)).toEqual(loadedByMeaning(config));
        expect(result.config.app.windowBounds).toEqual(config.app.windowBounds);
        expect(config.app.windowBounds).not.toEqual(getDefaultSettings().app.windowBounds);
    });

    test('every seeded configuration holds every preference of the form at a non-default value, and moved windows', () => {
        const defaults = getUiDefaultSettings();
        for (const seed of SEEDS) {
            const { config } = randomLiveConfig(seed);
            for (const key of UI_KEYS) {
                expect(config.app[key]).not.toEqual(defaults[key as keyof typeof defaults]);
            }
            expect(config.app.windowBounds.main).toMatchObject({ x: expect.any(Number), width: expect.any(Number) });
        }
    });

    test('the generated configurations hold every schema key, so the cases above cannot pass without it', () => {
        const seen = new Set<string>();
        const visit = (value: unknown) => {
            if (typeof value !== 'object' || value === null) return;
            for (const [key, item] of Object.entries(value)) {
                if (SCHEMA_KEYS.includes(key)) seen.add(key);
                visit(item);
            }
        };
        for (const seed of SEEDS) visit(randomLiveConfig(seed).config);
        for (const key of SCHEMA_KEYS) visit(configWithKey(key));

        expect(SCHEMA_KEYS.filter((key) => !seen.has(key))).toEqual([]);
    });

    test('a setting added to the live schema is generated, and survives the import only because the importer follows the live schema', () => {
        const schema: Record<string, unknown> = SETTINGS_SCHEMA;
        schema.aSettingAddedLater = { type: 'boolean', default: false, perChallenge: true, validation: z.boolean() };
        try {
            const config = configWithKey('aSettingAddedLater');
            const text = JSON.stringify(toFormatOne(config, {}));

            // The frozen pipeline alone prunes a key it never defined, which is what this test exists to catch...
            const frozenOnly = importV1Settings(text);
            if (!frozenOnly.ok) throw new Error('the importer refused the file');
            expect(loaded(frozenOnly.config)).not.toEqual(loaded(config));
            // ... and with the live schema's keys it comes back whole, in every place it sat.
            expect(loaded(importMirror(config, {}).config)).toEqual(loaded(config));
        } finally {
            delete schema.aSettingAddedLater;
        }
    });
});

describe('the mirror in format 1', () => {
    test('has every format-1 name back, the sign-in state at the top level, and every migration marked done', () => {
        const { config, titlePins } = randomLiveConfig(3);
        config.defaults = { autoSubmit: true, emergencySubmit: 600, exposure: 80 };
        config.auth = { token: 't', apiHeaders: { h: 'v' }, lastUsername: 'u', chosenPhotosMemberId: 'm' };

        const mirror = parseJsonObject(JSON.stringify(toFormatOne(config, titlePins)));

        expect(mirror).toMatchObject({
            token: 't',
            apiHeaders: { h: 'v' },
            lastUsername: 'u',
            chosenPhotosMemberId: 'm',
        });
        for (const flag of V1_MIGRATION_FLAGS) expect(mirror[flag]).toBe(true);
        expect(mirror).not.toHaveProperty('version');
        expect(mirror).not.toHaveProperty('imported');
        const challengeSettings = parseJsonObject(JSON.stringify(mirror.challengeSettings));
        expect(challengeSettings.globalDefaults).toEqual({ autoFill: true, emergencyFill: 600, exposure: 80 });
        expect(challengeSettings.titlePins).toEqual(titlePins);
        for (const renamed of Object.values(V1_KEY_RENAMES))
            expect(JSON.stringify(mirror)).not.toContain(`"${renamed}"`);
    });

    test('leaves a rule with a close-time condition out of titleRules, which an older build would ignore and so match more widely, and carries it beside', () => {
        const { config } = randomLiveConfig(4);
        config.rules = [
            { title: 'Plain', match: 'exact', autoJoin: true },
            { title: 'Closes', match: 'exact', autoJoin: true, closesAt: '18:00' },
            {
                title: 'Closes twice',
                match: 'exact',
                autoJoin: true,
                closesAt: '06:30',
                closesAtTimes: ['06:30', '18:00'],
            },
            { title: 'Closes list', match: 'exact', closesAtTimes: ['06:30', '18:00'] },
            { title: 'Last', match: 'exact' },
        ];

        const mirror = toFormatOne(config, {});
        const { titleRules } = mirror.challengeSettings as { titleRules: Array<{ title: string }> };

        expect(titleRules.map((rule) => rule.title)).toEqual(['Plain', 'Last']);
        expect(mirror.closeTimeRules).toEqual([
            { index: 1, rule: config.rules[1] },
            { index: 2, rule: config.rules[2] },
            { index: 3, rule: config.rules[3] },
        ]);
        expect(config.rules).toHaveLength(5);
    });

    test('carries no key when no rule has a close-time condition', () => {
        const { config } = randomLiveConfig(4);
        config.rules = [{ title: 'Plain', match: 'exact' }];

        expect(toFormatOne(config, {})).not.toHaveProperty('closeTimeRules');
    });

    test('a restore puts the carried rules back where they stood, and the frozen importer never sees the key', () => {
        const { config } = randomLiveConfig(4);
        config.rules = [
            { title: 'Plain', match: 'exact', autoJoin: true },
            { title: 'Closes', match: 'exact', autoJoin: false, closesAt: '18:00' },
            { title: 'Closes list', match: 'exact', closesAtTimes: ['06:30', '18:00'] },
            { title: 'Last', match: 'exact' },
        ];
        const text = JSON.stringify(toFormatOne(config, {}));

        const result = importMirrorText(text);

        expect(loaded(result.config)).toEqual(loaded(config));
        // The sidecar is no setting of the app: it is in neither the preferences nor the report.
        expect(JSON.stringify(result.config.app)).not.toContain('closeTimeRules');
        expect(result.report.refsBlocked).toEqual([]);
        // A format-1 reader (the frozen importer without the restore's step) sees only the rules it can match correctly.
        const readOlder = importV1Settings(text, { keptKey });
        if (!readOlder.ok) throw new Error('the importer refused the mirror');
        expect(readOlder.config.rules).toHaveLength(2);
    });

    test('the carried entries are the file a user can edit: entries that are no rule are ignored, a position past the end is the end', () => {
        const text = JSON.stringify({
            closeTimeRules: [
                { index: 9, rule: { title: 'Far', closesAt: '10:00' } },
                { index: -1, rule: { title: 'Negative' } },
                { index: 0, rule: 'text' },
                'nonsense',
            ],
            challengeSettings: { titleRules: [{ title: 'A', match: 'exact' }] },
        });

        const { raw, carried } = takeCloseTimeRules(text);

        expect(carried).toEqual([{ index: 9, rule: { title: 'Far', closesAt: '10:00' } }]);
        expect(raw).not.toContain('closeTimeRules');
        expect(attachCloseTimeRules(['a'], carried)).toEqual(['a', { title: 'Far', closesAt: '10:00' }]);
        expect(takeCloseTimeRules(JSON.stringify({ closeTimeRules: 5 })).carried).toEqual([]);
        expect(takeCloseTimeRules('{broken')).toEqual({ raw: '{broken', carried: [] });
        expect(takeCloseTimeRules('[1]').carried).toEqual([]);
    });

    test('where a key sits under both names, the current one wins, whatever the order', () => {
        const base = randomLiveConfig(5).config;
        const a = { ...base, defaults: { autoFill: false, autoSubmit: true } };
        const b = { ...base, defaults: { autoSubmit: true, autoFill: false } };

        const globalDefaults = (config: ConfigV2) =>
            (toFormatOne(config, {}).challengeSettings as { globalDefaults: unknown }).globalDefaults;

        expect(globalDefaults(a)).toEqual({ autoFill: true });
        expect(globalDefaults(b)).toEqual({ autoFill: true });
    });

    test('the schema renames only keys the live schema has under the new name', () => {
        for (const renamed of Object.values(V1_KEY_RENAMES)) expect(Object.keys(SETTINGS_SCHEMA)).toContain(renamed);
    });

    test('is made from a stored configuration text as a load reads it, and is null for what is no configuration', () => {
        const { config } = randomLiveConfig(9);
        config.app.apiTimeout = -5;

        const text = mirrorTextOf(JSON.stringify(config), {});

        // A value the load rejects is the default in the mirror, as it is for the app.
        expect(parseJsonObject(text ?? 'null').apiTimeout).toBe(30);
        expect(mirrorTextOf(null)).toBeNull();
        expect(mirrorTextOf('')).toBeNull();
        expect(mirrorTextOf('{broken')).toBeNull();
        expect(mirrorTextOf('[1]')).toBeNull();
    });
});

describe('importing, mirroring and importing again changes nothing', () => {
    const files = [
        ...FIXTURES.map(
            (fixture) =>
                [fixture.name, typeof fixture.blob === 'string' ? fixture.blob : JSON.stringify(fixture.blob)] as const,
        ),
        ...SEEDS.map((seed) => {
            const c = randomCase(seed);
            return [c.name, c.raw] as const;
        }),
    ];

    test.each(files)('%s', (_name, raw) => {
        const imported = importV1Settings(raw, { keptKey });
        if (!imported.ok) throw new Error(`the importer refused the file: ${imported.code}: ${imported.detail}`);
        // An empty timezone is Riga after the import (it was in format 1), so the second import keeps the first's zone.
        const first = { ...imported, config: withImportedTimezone(imported.config) };

        const text = mirrorTextOf(JSON.stringify(first.config), first.titlePins);
        const second = importMirrorText(text ?? 'null');

        expect(loaded(second.config)).toEqual(loaded(first.config));
        expect(second.titlePins).toEqual(first.titlePins);
    });
});
