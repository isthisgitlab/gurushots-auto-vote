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
import { SETTINGS_SCHEMA, schemaEntry } from '../../../src/ts/settings/schema';
import { dropInvalidValues, mergeWithDefaults } from '../../../src/ts/settings/loadValidation';
import { mirrorTextOf, toFormatOne } from '../../../src/ts/settings/formatOneMirror';
import { FIXTURES } from '../v2/fixtures';
import { parseSeeds, randomCase } from '../v2/random';
import { SCHEMA_KEYS, configWithKey, randomLiveConfig, validInSet, valueSetsOf } from '../../helpers/liveConfig';
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

const importMirror = (config: ConfigV2, titlePins: Record<string, string>) => {
    const text = JSON.stringify(toFormatOne(config, titlePins), null, 2);
    const result = importV1Settings(text, { keptKey });
    if (!result.ok) throw new Error(`the importer refused the mirror: ${result.code}: ${result.detail}`);
    return result;
};

describe('the live schema the generator reads', () => {
    test('is not empty, and the generator reaches every key with a value other than its default', () => {
        expect(SCHEMA_KEYS.length).toBeGreaterThan(80);
        for (const key of SCHEMA_KEYS) expect(() => configWithKey(key)).not.toThrow();
    });
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

        expect(loaded(result.config)).toEqual(loaded(config));
    });

    test.each(SEEDS.map((seed) => [seed]))('seed %i: every container filled, every key somewhere', (seed) => {
        const { config, titlePins } = randomLiveConfig(seed);
        generatedIsValid(config);

        const result = importMirror(config, titlePins);

        expect(loaded(result.config)).toEqual(loaded(config));
        expect(result.titlePins).toEqual(titlePins);
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
        const first = importV1Settings(raw, { keptKey });
        if (!first.ok) throw new Error(`the importer refused the file: ${first.code}: ${first.detail}`);

        const text = mirrorTextOf(JSON.stringify(first.config), first.titlePins);
        const second = importV1Settings(text ?? 'null', { keptKey });

        if (!second.ok) throw new Error(`the importer refused the mirror: ${second.code}: ${second.detail}`);
        expect(loaded(second.config)).toEqual(loaded(first.config));
        expect(second.titlePins).toEqual(first.titlePins);
    });
});
