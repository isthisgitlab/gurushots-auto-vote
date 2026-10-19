/**
 * The conversion of a migrated 1.x blob to the 2.x configuration: how the sign-in state, app preferences, defaults,
 * profiles, scenarios, rules and per-challenge state are placed, where the renames apply, and which references are
 * reported as blocked.
 */

import { convertV1Blob, TOP_LEVEL_ONLY_KEYS } from '../../../src/ts/settings/importV1/convert';
import { getV1Defaults } from '../../../src/ts/settings/importV1/defaults';
import { V1_MIGRATION_FLAGS } from '../../../src/ts/settings/importV1/migrations';
import { V1_REFUSED_KEY_PREFIX } from '../../../src/ts/settings/importV1/renames';

import type { V1Blob } from '../../../src/ts/settings/importV1/types';

type Values = Record<string, unknown>;

const blobWith = (challengeSettings: Values = {}, top: Values = {}): V1Blob => {
    const base = getV1Defaults();
    return { ...base, ...top, challengeSettings: { ...base.challengeSettings, ...challengeSettings } };
};
const convert = (challengeSettings: Values = {}, top: Values = {}, mockStored = true) =>
    convertV1Blob(blobWith(challengeSettings, top), { mockStored });
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

    test('a mock value is carried only when the 1.x file held one, so the build default applies otherwise', () => {
        expect(convert({}, { mock: true }, true).config.app.mock).toBe(true);
        expect(convert({}, { mock: false }, true).config.app.mock).toBe(false);
        const { config } = convert({}, { mock: true, theme: 'dark' }, false);
        expect(config.app).not.toHaveProperty('mock');
        expect(config.app.theme).toBe('dark');
    });

    test('the app-state flags 1.x read only from the top level have no copy among the defaults', () => {
        expect([...TOP_LEVEL_ONLY_KEYS].sort()).toEqual([
            'autovoteRunning',
            'autovoteStartedLaunch',
            'chosenPhotosClearedAt',
            'chosenPhotosMemberId',
            'noticeAcknowledgedVersion',
            'skipUpdateVersion',
        ]);
        const { config } = convert(
            {
                globalDefaults: {
                    ...getV1Defaults().challengeSettings.globalDefaults,
                    exposure: 80,
                    autovoteRunning: true,
                },
            },
            { autovoteRunning: true, skipUpdateVersion: '2.0', noticeAcknowledgedVersion: 3 },
        );
        for (const key of TOP_LEVEL_ONLY_KEYS) expect(config.defaults).not.toHaveProperty(key);
        expect(config.defaults).toMatchObject({ exposure: 80 });
        // The top-level values themselves are the app's (and `chosenPhotosMemberId` the account's).
        expect(config.app).toMatchObject({
            autovoteRunning: true,
            skipUpdateVersion: '2.0',
            noticeAcknowledgedVersion: 3,
        });
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

describe('a key named like a rename target in a 1.x file', () => {
    // 1.x never read such a key, so it must not start to act in 2.x: it goes from every map the importer renames.
    test('is dropped from the app preferences, defaults, profiles, rules and challenge values', () => {
        const { config } = convert(
            {
                globalDefaults: { autoSubmit: true, exposure: 80 },
                profiles: { P: { autoSubmit: true, emergencySubmit: 5, exposure: 60 } },
                titleRules: [{ title: 'a', autoSubmit: true, autoJoin: true }],
                perChallenge: { '1': { autoSubmit: true, exposure: 70 } },
            },
            { notifyOnAutoSubmit: true, theme: 'dark' },
        );
        expect(config.app).toEqual(expect.not.objectContaining({ notifyOnAutoSubmit: expect.anything() }));
        expect(config.app.theme).toBe('dark');
        expect(config.defaults).toMatchObject({ exposure: 80 });
        expect(config.defaults).not.toHaveProperty('autoSubmit', true);
        expect(config.profiles).toEqual({ P: { exposure: 60 } });
        expect(config.rules).toEqual([{ title: 'a', autoJoin: true }]);
        expect(config.challenges).toEqual({ '1': { values: { exposure: 70 } } });
    });

    test('also goes beside its 1.x counterpart: the 1.x value is kept under the 2.x name', () => {
        const { config } = convert({
            profiles: { P: { autoFill: true, autoSubmit: false } },
            titleRules: [{ title: 'a', autoFill: true, autoSubmit: false }],
        });
        expect(config.profiles).toEqual({ P: { autoSubmit: true } });
        expect(config.rules).toEqual([{ title: 'a', autoSubmit: true }]);
    });

    test('keeps a scenario that 1.x refused refused: the key stays, under a name no setting answers to', () => {
        const { config } = convert({
            scenarios: {
                Plan: {
                    name: 'Plan',
                    version: 1,
                    start: 'a',
                    phases: { a: { settings: { autoSubmit: true, exposure: 80 } } },
                },
            },
        });
        expect(config.scenarios).toEqual({
            Plan: {
                name: 'Plan',
                version: 1,
                start: 'a',
                phases: { a: { settings: { exposure: 80, [`${V1_REFUSED_KEY_PREFIX}autoSubmit`]: true } } },
            },
        });
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
        expect(convert({ titlePins: 5 }).titlePins).toEqual({});
        expect(convert({ titlePins: null }).titlePins).toEqual({});
        expect(convert({ titlePins: JSON.parse('{"__proto__":"x","constructor":"y","7":"z"}') }).titlePins).toEqual({
            '7': 'z',
        });
    });
});

describe('a title-pin container of the wrong kind', () => {
    // 1.x looks a title up as `pinned[id]` when the value has `id` as an own property: an array's elements and a
    // string's characters are found by index.
    test('an array gives its string elements by index', () => {
        expect(convert({ titlePins: ['Macro', 5, 'Night'] }).titlePins).toEqual({ '0': 'Macro', '2': 'Night' });
    });

    test('a string gives its characters by index', () => {
        expect(convert({ titlePins: 'ab' }).titlePins).toEqual({ '0': 'a', '1': 'b' });
        expect(convert({ titlePins: '' }).titlePins).toEqual({});
    });

    test('a number or a boolean has no own properties to read', () => {
        expect(convert({ titlePins: 0 }).titlePins).toEqual({});
        expect(convert({ titlePins: true }).titlePins).toEqual({});
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
    const rule = (number: number, title?: string) => ({ kind: 'rule', number, ...(title ? { title } : {}) });

    test('a rule naming a missing profile is listed with its number (from 1), its title and the name', () => {
        expect(
            refs({
                titleRules: [{ title: 'a' }, { title: 'b', profile: 'Night owl' }, { title: 'c', profile: 'Day' }],
                profiles: { day: { exposure: 80 } },
            }),
        ).toEqual([{ holder: rule(2, 'b'), refers: 'profile', name: 'Night owl' }]);
    });

    test('a rule with no title is listed by its number only, and a long title is cut', () => {
        expect(
            refs({
                titleRules: [
                    { profile: 'Gone' },
                    { title: 'x'.repeat(100), profile: 'Gone' },
                    { title: '  ', profile: 'Gone' },
                ],
            }),
        ).toEqual([
            { holder: rule(1), refers: 'profile', name: 'Gone' },
            { holder: rule(2, `${'x'.repeat(39)}…`), refers: 'profile', name: 'Gone' },
            { holder: rule(3), refers: 'profile', name: 'Gone' },
        ]);
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
        ).toEqual([
            { holder: rule(1), refers: 'profile', name: 'constructor' },
            { holder: rule(2), refers: 'profile', name: ' __PROTO__ ' },
        ]);
    });

    test('a scenario value naming a scenario that is not stored is listed in profiles, rules and challenges, not in the defaults', () => {
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
                titlePins: { '123': 'Sunset' },
            }),
        ).toEqual([
            { holder: { kind: 'profile', name: 'Night' }, refers: 'scenario', name: 'plan b' },
            { holder: { kind: 'profile', name: 'Odd "name"' }, refers: 'scenario', name: 'Gone' },
            { holder: rule(2, 'b'), refers: 'scenario', name: 'Gone' },
            { holder: { kind: 'challenge', id: '123', title: 'Sunset' }, refers: 'scenario', name: 'Plan B' },
            { holder: { kind: 'challenge', id: 'a.b' }, refers: 'scenario', name: 'Gone' },
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
        ).toEqual([{ holder: { kind: 'challenge', id: '1' }, refers: 'scenario', name: 'constructor' }]);
    });

    test('a long name is cut and the report holds names, never other values', () => {
        const [entry] = refs({ perChallenge: { '1': { scenario: 'x'.repeat(200) } } });
        expect(entry).toEqual({
            holder: { kind: 'challenge', id: '1' },
            refers: 'scenario',
            name: `${'x'.repeat(79)}…`,
        });
        expect(refs({ perChallenge: { '1': { scenario: 'Gone', exposure: 99, autoFill: true } } })).toEqual([
            { holder: { kind: 'challenge', id: '1' }, refers: 'scenario', name: 'Gone' },
        ]);
    });

    test('a challenge id and its title are cut too, and a title of blanks is none', () => {
        // (An id that is a small integer comes first in an object's order.)
        const [blank, long] = refs({
            perChallenge: { ['9'.repeat(100)]: { scenario: 'Gone' }, '2': { scenario: 'Gone' } },
            titlePins: { ['9'.repeat(100)]: 'T'.repeat(200), '2': '  ' },
        });
        expect(long).toMatchObject({ holder: { id: `${'9'.repeat(79)}…`, title: `${'T'.repeat(79)}…` } });
        expect(blank).toEqual({ holder: { kind: 'challenge', id: '2' }, refers: 'scenario', name: 'Gone' });
    });
});
