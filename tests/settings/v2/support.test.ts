/**
 * The pieces the equivalence harness stands on: the random file generator and the mapping of an importer result back
 * to a 1.x blob.
 */

import { V1_SETTINGS_SCHEMA } from '../../../src/ts/settings/importV1/schema';
import { importV1Settings } from '../../../src/ts/settings/importV1';
import { liveKey, v1ViewOf } from './liveAdapter';
import { drawFor, makeRng, parseSeeds, randomCase, SCHEMA_KEYS, valueFor } from './random';

describe('the random file generator', () => {
    test.each(SCHEMA_KEYS)('%s: has a generator whose draws mostly pass the frozen validator', (key) => {
        const rng = makeRng(7);
        const entry = V1_SETTINGS_SCHEMA[key as keyof typeof V1_SETTINGS_SCHEMA];
        let accepted = 0;
        for (let i = 0; i < 100; i += 1) {
            if (entry.validation.safeParse(drawFor(rng, key)).success) accepted += 1;
            expect(entry.validation.safeParse(valueFor(rng, key)).success).toBe(true);
        }
        expect(accepted).toBeGreaterThanOrEqual(80);
    });

    test('a seed gives the same file and challenges, another seed another', () => {
        expect(randomCase(5)).toEqual(randomCase(5));
        expect(randomCase(5).raw).not.toBe(randomCase(6).raw);
    });

    test('a file is read as a settings file', () => {
        for (let seed = 1; seed <= 20; seed += 1) {
            const result = importV1Settings(randomCase(seed).raw);
            expect(result).toMatchObject({ ok: true });
        }
    });

    test('seeds: a comma list of seeds and ranges, the default when blank', () => {
        expect(parseSeeds('7,100-102, 9', [1])).toEqual([7, 100, 101, 102, 9]);
        expect(parseSeeds('5-3', [1])).toEqual([]);
        expect(parseSeeds(undefined, [1, 2])).toEqual([1, 2]);
        expect(parseSeeds('  ', [1, 2])).toEqual([1, 2]);
    });
});

describe('v1ViewOf', () => {
    test('puts a converted file back in the 1.x shape', () => {
        const raw = JSON.stringify({
            theme: 'dark',
            token: 'secret',
            challengeSettings: {
                globalDefaults: { autoFill: true },
                perChallenge: { '1': { emergencyFill: 600 } },
                titleRules: [{ title: 'Macro', profile: 'P', autoFill: true }],
                profiles: { P: { boostFillNew: true }, Odd: 'x' },
                scenarios: { S: { name: 'S', phases: { a: { settings: { autoFill: true } }, b: 'x' } }, T: 5 },
                titlePins: { '1': 'Macro' },
                entryPins: { '1': { boost: 'e1' } },
                titleProfileSuppressions: { '1': true },
            },
        });
        const result = importV1Settings(raw);
        if (!result.ok) throw new Error(result.detail);
        const view = v1ViewOf(result.config, result.titlePins);
        expect(view).toMatchObject({
            theme: 'dark',
            token: 'secret',
            _timeUnitMigratedV1: true,
            _challengeRulesOrderedV1: true,
            challengeSettings: {
                globalDefaults: { autoFill: true },
                perChallenge: { '1': { emergencyFill: 600 } },
                titleRules: [{ title: 'Macro', profile: 'P', autoFill: true }],
                profiles: { P: { boostFillNew: true }, Odd: 'x' },
                scenarios: { S: { name: 'S', phases: { a: { settings: { autoFill: true } }, b: 'x' } }, T: 5 },
                titlePins: { '1': 'Macro' },
                entryPins: { '1': { boost: 'e1' } },
                titleProfileSuppressions: { '1': true },
            },
        });
    });

    test('live names are the 2.x names of the renamed keys', () => {
        expect(liveKey('autoFill')).toBe('autoSubmit');
        expect(liveKey('boostFillNewOnConflict')).toBe('boostNewSubmitOnConflict');
        expect(liveKey('autoExposureFill')).toBe('autoExposureFill');
        expect(liveKey('scenario')).toBe('scenario');
    });
});
