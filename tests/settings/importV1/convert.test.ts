/**
 * The conversion of a migrated 1.x blob to the 2.x configuration: how the sign-in state, app preferences, defaults,
 * profiles, scenarios, rules and per-challenge state are placed, where the renames apply, and which references are
 * reported as blocked.
 */

import { convertV1Blob } from '../../../src/ts/settings/importV1/convert';
import { getV1Defaults } from '../../../src/ts/settings/importV1/defaults';
import { V1_MIGRATION_FLAGS } from '../../../src/ts/settings/importV1/migrations';

import type { V1Blob } from '../../../src/ts/settings/importV1/types';

type Values = Record<string, unknown>;

const blobWith = (challengeSettings: Values = {}, top: Values = {}): V1Blob => {
    const base = getV1Defaults();
    return { ...base, ...top, challengeSettings: { ...base.challengeSettings, ...challengeSettings } };
};
const convert = (challengeSettings: Values = {}, top: Values = {}) => convertV1Blob(blobWith(challengeSettings, top));
const refs = (challengeSettings: Values = {}, top: Values = {}) => convert(challengeSettings, top).report.refsBlocked;

describe('the sign-in state and the app preferences', () => {
    test('the four auth keys become auth, and nothing else does', () => {
        const { config } = convert(
            {},
            {
                token: 'tok',
                apiHeaders: { 'x-a': 'b' },
                lastUsername: 'me',
                chosenPhotosMemberId: 'm-1',
                theme: 'dark',
            },
        );
        expect(config.auth).toEqual({
            token: 'tok',
            apiHeaders: { 'x-a': 'b' },
            lastUsername: 'me',
            chosenPhotosMemberId: 'm-1',
        });
        for (const key of ['token', 'apiHeaders', 'lastUsername', 'chosenPhotosMemberId']) {
            expect(config.app).not.toHaveProperty(key);
        }
    });

    test('app is every other top-level key but challengeSettings and the migrations one-time flags', () => {
        const flags = Object.fromEntries(V1_MIGRATION_FLAGS.map((flag) => [flag, true]));
        const { config } = convert(
            {},
            {
                ...flags,
                theme: 'dark',
                language: 'lv',
                windowBounds: { main: { width: 1 } },
                autovoteRunning: true,
                futureKey: [1],
            },
        );
        expect(config.app).toMatchObject({
            theme: 'dark',
            language: 'lv',
            windowBounds: { main: { width: 1 } },
            autovoteRunning: true,
            futureKey: [1],
            onboardingCompleted: false,
            mock: expect.any(Boolean),
        });
        expect(Object.keys(config.app).filter((key) => key.startsWith('_'))).toEqual([]);
        expect(config.app).not.toHaveProperty('challengeSettings');
        expect(config.version).toBe(2);
        expect(config).not.toHaveProperty('imported');
    });

    test('a top-level key to rename is renamed', () => {
        const { config } = convert({}, { notifyOnAutoFill: true, notifyOnEmergencyFill: false, notifyOnBoost: true });
        expect(config.app).toMatchObject({
            notifyOnAutoSubmit: true,
            notifyOnEmergencySubmit: false,
            notifyOnBoost: true,
        });
        expect(config.app).not.toHaveProperty('notifyOnAutoFill');
    });

    test('auth values of the wrong kind become empty ones, and header values must be strings', () => {
        const { config } = convert({}, { token: 4, apiHeaders: { a: 'x', b: 5, c: null }, lastUsername: null });
        expect(config.auth).toEqual({ token: '', apiHeaders: { a: 'x' }, lastUsername: '', chosenPhotosMemberId: '' });
        expect(convert({}, { apiHeaders: ['x'] }).config.auth.apiHeaders).toEqual({});
    });
});

describe('defaults, profiles, scenarios, rules', () => {
    test('defaults are the global defaults with renamed keys', () => {
        const { config } = convert({ globalDefaults: { autoFill: true, exposure: 80, boostFillNewOnConflict: true } });
        expect(config.defaults).toEqual({ autoSubmit: true, exposure: 80, boostNewSubmitOnConflict: true });
    });

    test('profiles keep their names and are renamed inside; a value that is no object is kept as stored', () => {
        const { config } = convert({
            profiles: {
                Night: { autoFill: true, fillWithoutTagMatch: false, turboFillNew: true, autoSwap: true },
                Odd: 'junk',
                Listy: [{ autoFill: 1 }],
            },
        });
        expect(config.profiles).toEqual({
            Night: { autoSubmit: true, submitWithoutTagMatch: false, turboNewSubmit: true, autoSwap: true },
            Odd: 'junk',
            Listy: [{ autoFill: 1 }],
        });
        expect(convert({ profiles: 'junk' }).config.profiles).toEqual({});
        expect(convert({ profiles: ['x'] }).config.profiles).toEqual({});
        expect(convert().config.profiles).toEqual({});
    });

    test('seededProfiles keeps its names', () => {
        expect(convert({ seededProfiles: ['a', 3, 'b'] }).config.seededProfiles).toEqual(['a', 'b']);
        expect(convert({ seededProfiles: 'junk' }).config.seededProfiles).toEqual([]);
        expect(convert().config.seededProfiles).toEqual([]);
    });

    test('scenarios are renamed inside their phase settings; one that is no object is kept', () => {
        const { config } = convert({
            scenarios: {
                Plan: {
                    name: 'Plan',
                    version: 1,
                    start: 'a',
                    phases: { a: { settings: { autoFill: true, emergencyFill: 0 } } },
                },
                Broken: 5,
            },
        });
        expect(config.scenarios).toEqual({
            Plan: {
                name: 'Plan',
                version: 1,
                start: 'a',
                phases: { a: { settings: { autoSubmit: true, emergencySubmit: 0 } } },
            },
            Broken: 5,
        });
        expect(convert({ scenarios: null }).config.scenarios).toEqual({});
    });

    test('rules keep their order and fields, with the inline value keys renamed; an entry that is no object stays', () => {
        const rule = { title: 'Macro', autoFill: true, autoJoin: true, profile: 'Night', mustIncludeTags: ['a'] };
        const { config } = convert({ titleRules: [rule, 'junk', null, { type: 'flash', autoFill: false }] });
        expect(config.rules).toEqual([
            { title: 'Macro', autoSubmit: true, autoJoin: true, profile: 'Night', mustIncludeTags: ['a'] },
            'junk',
            null,
            { type: 'flash', autoSubmit: false },
        ]);
        expect(rule).toHaveProperty('autoFill', true);
    });

    test('the title pins come back next to the config, not in it', () => {
        const { config, titlePins } = convert({ titlePins: { '1': 'Macro', '2': 5, '3': 'Night' } });
        expect(titlePins).toEqual({ '1': 'Macro', '3': 'Night' });
        expect(JSON.stringify(config)).not.toContain('Macro');
        expect(convert().titlePins).toEqual({});
        expect(convert({ titlePins: 'junk' }).titlePins).toEqual({});
        expect(convert({ titlePins: JSON.parse('{"__proto__":"x","constructor":"y","7":"z"}') }).titlePins).toEqual({
            '7': 'z',
        });
    });
});

describe('one record per challenge', () => {
    test('values, a rule-profile suppression and pins merge into one record per id', () => {
        const { config } = convert({
            perChallenge: { '1': { autoFill: true, exposure: 70 }, '2': { exposure: 60 } },
            titleProfileSuppressions: { '2': true, '3': true, '4': false, '5': 'yes' },
            entryPins: { '1': { boost: 'e1', turbo: 'e2' }, '3': { turbo: 'e3' }, '6': { boost: 'e6' } },
        });
        expect(config.challenges).toEqual({
            '1': { values: { autoSubmit: true, exposure: 70 }, pins: { boost: 'e1', turbo: 'e2' } },
            '2': { values: { exposure: 60 }, suppressRuleProfile: true },
            '3': { suppressRuleProfile: true, pins: { turbo: 'e3' } },
            '6': { pins: { boost: 'e6' } },
        });
    });

    test('an id with a per-challenge entry keeps `values`, even an empty one', () => {
        const { config } = convert({ perChallenge: { '1': {} } });
        expect(config.challenges).toEqual({ '1': { values: {} } });
        expect(Object.hasOwn(config.challenges['1'], 'values')).toBe(true);
    });

    test('an id with only a false suppression has no record', () => {
        expect(convert({ titleProfileSuppressions: { '4': false } }).config.challenges).toEqual({});
    });

    test('a pin record keeps only string pins; one with none is an empty record', () => {
        const { config } = convert({
            entryPins: { '1': { boost: 5, turbo: 'e2', extra: 'x' }, '2': 'junk', '3': null },
        });
        expect(config.challenges).toEqual({ '1': { pins: { turbo: 'e2' } }, '2': { pins: {} }, '3': { pins: {} } });
    });

    test('an id naming a prototype member is not a challenge', () => {
        const { config } = convert({
            perChallenge: JSON.parse('{"__proto__":{"exposure":1},"constructor":{"exposure":2},"9":{"exposure":3}}'),
            titleProfileSuppressions: JSON.parse('{"prototype":true}'),
            entryPins: JSON.parse('{"__proto__":{"boost":"e"}}'),
        });
        expect(Object.keys(config.challenges)).toEqual(['9']);
        expect(Object.getPrototypeOf(config.challenges)).toBe(Object.prototype);
    });
});

describe('references 1.x could not resolve', () => {
    test('a rule naming a missing profile is listed with its index and the name', () => {
        expect(
            refs({
                titleRules: [{ title: 'a' }, { title: 'b', profile: 'Night owl' }, { title: 'c', profile: 'Day' }],
                profiles: { day: { exposure: 80 } },
            }),
        ).toEqual(['rules[1].profile: "Night owl"']);
    });

    test('a profile is found whatever its case and spacing, and a rule with no profile name is not a reference', () => {
        expect(
            refs({
                titleRules: [
                    { profile: '  DAY ' },
                    { profile: '' },
                    { profile: '   ' },
                    { profile: 5 },
                    'junk',
                    null,
                    { title: 'x' },
                ],
                profiles: { Day: { exposure: 80 } },
            }),
        ).toEqual([]);
    });

    test('a rule naming a reserved profile is listed even when such a profile is stored', () => {
        expect(
            refs({
                titleRules: [{ profile: 'constructor' }, { profile: ' __PROTO__ ' }],
                profiles: JSON.parse('{"constructor":{"exposure":80},"__proto__":{"exposure":70}}'),
            }),
        ).toEqual(['rules[0].profile: "constructor"', 'rules[1].profile: " __PROTO__ "']);
    });

    test('a scenario value naming a scenario that is not stored is listed in defaults, profiles, rules and challenges', () => {
        expect(
            refs({
                globalDefaults: { scenario: 'Plan B' },
                profiles: { Night: { scenario: 'plan b' }, 'Odd "name"': { scenario: 'Gone' } },
                titleRules: [
                    { title: 'a', scenario: 'Plan A' },
                    { title: 'b', scenario: 'Gone', profile: 'Night' },
                ],
                perChallenge: { '123': { scenario: 'Plan B' }, 'a.b': { scenario: 'Gone' } },
                scenarios: { 'plan a': { name: 'Plan A' } },
            }),
        ).toEqual([
            'defaults.scenario: "Plan B"',
            'profiles["Night"].scenario: "plan b"',
            'profiles["Odd \\"name\\""].scenario: "Gone"',
            'rules[1].scenario: "Gone"',
            'challenges.123.values.scenario: "Plan B"',
            'challenges["a.b"].values.scenario: "Gone"',
        ]);
    });

    test('a scenario that is stored, an opt-out, an empty or non-string value, or an empty map is no reference', () => {
        expect(
            refs({
                globalDefaults: { scenario: '' },
                profiles: { Night: { scenario: 'PLAN A ' }, Odd: 'junk', Empty: {} },
                titleRules: [{ scenario: '' }, { scenario: 7 }, { scenario: '  ' }],
                perChallenge: { '1': { scenario: 'plan a' }, '2': { exposure: 1 } },
                titleProfileSuppressions: { '3': true },
                scenarios: { 'Plan A': {} },
            }),
        ).toEqual([]);
    });

    test('a reserved scenario name never resolves, even when stored under it', () => {
        expect(
            refs({
                perChallenge: { '1': { scenario: 'constructor' } },
                scenarios: JSON.parse('{"constructor":{}}'),
            }),
        ).toEqual(['challenges.1.values.scenario: "constructor"']);
    });

    test('a long name is cut and the report holds names, never other values', () => {
        const [entry] = refs({ perChallenge: { '1': { scenario: 'x'.repeat(200) } } });
        expect(entry).toBe(`challenges.1.values.scenario: "${'x'.repeat(80)}"`);
        expect(refs({ perChallenge: { '1': { scenario: 'Gone', exposure: 99, autoFill: true } } })).toEqual([
            'challenges.1.values.scenario: "Gone"',
        ]);
    });

    test('control characters in a name are escaped, so an entry stays one line', () => {
        const [entry] = refs({ titleRules: [{ profile: 'a\nb\u0007' }] });
        expect(entry).toBe('rules[0].profile: "a\\nb\\u0007"');
    });
});
