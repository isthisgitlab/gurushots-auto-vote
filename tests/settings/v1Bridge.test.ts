/**
 * The bridge between the 1.x `settings.json` on disk and the current setting names in memory: the key renaming in both
 * directions over every place a key can sit, the removal of 2.x names a file should not hold, and what the loader and
 * the saver do with it (the file never holds a 2.x name).
 */

import type { AndroidHeadlessStore } from '../../src/ts/types/settings';
import { invalid } from '../helpers/invalid';
import { parseJsonObject } from '../helpers/parseJson';
import { toCurrentNames, toStoredNames, withoutCurrentNames } from '../../src/ts/settings/v1Bridge';
import settings = require('../../src/ts/settings');

type Values = Record<string, unknown>;

const stored1x = (): Values => ({
    notifyOnAutoFill: true,
    theme: 'dark',
    challengeSettings: {
        globalDefaults: { autoFill: true, emergencyFill: 600, exposure: 80 },
        perChallenge: { '1': { boostFillNew: true, protectUncertainAutoFills: false }, '2': 5 },
        titleRules: [{ title: 'Macro', autoFill: true, profile: 'P' }, 'junk', null],
        profiles: { P: { autoFillSchedule: [{ count: 2, seconds: 60 }], fillWithoutTagMatch: false }, Odd: 'x' },
        scenarios: {
            Plan: { name: 'Plan', version: 1, start: 'a', phases: { a: { settings: { turboFillNew: true } }, b: 'x' } },
            Bare: { name: 'Bare', version: 1, start: 'a', phases: { a: { rules: [] } } },
            NoPhases: { name: 'NoPhases' },
            Junk: 5,
        },
        titleProfileSuppressions: { '1': true },
        entryPins: { '1': { boost: 'e1' } },
        titlePins: { '1': 'Macro' },
    },
});

const current = (): Values => ({
    notifyOnAutoSubmit: true,
    theme: 'dark',
    challengeSettings: {
        globalDefaults: { autoSubmit: true, emergencySubmit: 600, exposure: 80 },
        perChallenge: { '1': { boostNewSubmit: true, protectUncertainAutoSubmits: false }, '2': 5 },
        titleRules: [{ title: 'Macro', autoSubmit: true, profile: 'P' }, 'junk', null],
        profiles: { P: { autoSubmitSchedule: [{ count: 2, seconds: 60 }], submitWithoutTagMatch: false }, Odd: 'x' },
        scenarios: {
            Plan: {
                name: 'Plan',
                version: 1,
                start: 'a',
                phases: { a: { settings: { turboNewSubmit: true } }, b: 'x' },
            },
            Bare: { name: 'Bare', version: 1, start: 'a', phases: { a: { rules: [] } } },
            NoPhases: { name: 'NoPhases' },
            Junk: 5,
        },
        titleProfileSuppressions: { '1': true },
        entryPins: { '1': { boost: 'e1' } },
        titlePins: { '1': 'Macro' },
    },
});

describe('toCurrentNames and toStoredNames', () => {
    test('rename the keys in every place a setting key can sit, and only keys', () => {
        expect(toCurrentNames(stored1x())).toEqual(current());
    });

    test('map the current names back to the 1.x names', () => {
        expect(toStoredNames(current())).toEqual(stored1x());
    });

    test('change a copy, not the blob they are given', () => {
        const blob = stored1x();
        toCurrentNames(blob);
        expect(blob).toEqual(stored1x());
        const loaded = current();
        toStoredNames(loaded);
        expect(loaded).toEqual(current());
    });

    test('add no container the blob does not have', () => {
        const blob = { theme: 'dark', challengeSettings: { perChallenge: {} } };
        expect(toCurrentNames(blob)).toEqual(blob);
        expect(Object.keys(toCurrentNames(blob).challengeSettings)).toEqual(['perChallenge']);
    });

    test('leave a container of the wrong kind as it is', () => {
        const blob = {
            challengeSettings: { globalDefaults: [1], perChallenge: 'x', titleRules: {}, profiles: null, scenarios: 3 },
        };
        expect(toCurrentNames(blob)).toEqual(blob);
        expect(toStoredNames(blob)).toEqual(blob);
    });

    test.each([
        ['no challengeSettings', { autoFill: true }],
        ['a challengeSettings that is not an object', { challengeSettings: ['autoFill'] }],
    ])('rename the top level of a blob with %s', (_name, blob) => {
        expect(toStoredNames(toCurrentNames(blob))).toEqual(blob);
    });

    test('hand back a value that is not a plain object', () => {
        const list = ['autoFill'];
        expect(toCurrentNames(list)).toBe(list);
        expect(toStoredNames(list)).toBe(list);
    });

    test('keep a 2.x name that has no 1.x counterpart in the blob, and the 1.x value where both are', () => {
        expect(toCurrentNames({ challengeSettings: { globalDefaults: { autoSubmit: false } } })).toEqual({
            challengeSettings: { globalDefaults: { autoSubmit: false } },
        });
        expect(
            toCurrentNames({ challengeSettings: { globalDefaults: { autoFill: true, autoSubmit: false } } }),
        ).toEqual({ challengeSettings: { globalDefaults: { autoSubmit: true } } });
    });
});

describe('withoutCurrentNames', () => {
    const file = (value: unknown): [Values, string] => [invalid<Values>(value), JSON.stringify(value)];

    test('hands back the parsed file itself when its text holds no 2.x name', () => {
        const [parsed, raw] = file(stored1x());
        expect(withoutCurrentNames(parsed, raw)).toBe(parsed);
    });

    test('removes the 2.x names from every map and keeps the 1.x ones', () => {
        const [parsed, raw] = file({
            autoSubmit: true,
            notifyOnAutoFill: true,
            challengeSettings: {
                globalDefaults: { autoSubmit: true, emergencySubmit: 1 },
                perChallenge: { '1': { autoFill: true, autoSubmit: false } },
                titleRules: [{ title: 'a', autoSubmit: true }],
                profiles: { P: { turboNewSubmit: true, exposure: 80 } },
                scenarios: { Plan: { name: 'Plan', phases: { a: { settings: { exposure: 70 } } } } },
            },
        });
        expect(withoutCurrentNames(parsed, raw)).toEqual({
            notifyOnAutoFill: true,
            challengeSettings: {
                globalDefaults: {},
                perChallenge: { '1': { autoFill: true } },
                titleRules: [{ title: 'a' }],
                profiles: { P: { exposure: 80 } },
                scenarios: { Plan: { name: 'Plan', phases: { a: { settings: { exposure: 70 } } } } },
            },
        });
    });

    test('keeps a 2.x name in a scenario phase under a name no setting answers to, so the document stays refused', () => {
        const [parsed, raw] = file({
            challengeSettings: {
                scenarios: {
                    Plan: { name: 'Plan', phases: { a: { settings: { autoFill: true, autoSubmit: true } } } },
                },
            },
        });
        const { challengeSettings } = withoutCurrentNames(parsed, raw) as {
            challengeSettings: { scenarios: { Plan: { phases: { a: { settings: Values } } } } };
        };
        expect(challengeSettings.scenarios.Plan.phases.a.settings).toEqual({
            autoFill: true,
            'ignored by 1.x: autoSubmit': true,
        });
    });
});

describe('the loader and the saver', () => {
    const headless = globalThis as typeof globalThis & {
        __GS_HEADLESS__?: boolean;
        AndroidHeadlessStore?: AndroidHeadlessStore;
    };
    let store: { value: string | null };

    beforeEach(() => {
        store = { value: null };
        headless.__GS_HEADLESS__ = true;
        headless.AndroidHeadlessStore = {
            read: () => store.value,
            write: (data) => {
                store.value = data;
            },
        };
    });

    afterEach(() => {
        delete headless.__GS_HEADLESS__;
        delete headless.AndroidHeadlessStore;
    });

    const onDisk = (): string => store.value ?? '';

    test('load the 1.x file under the current names', () => {
        store.value = JSON.stringify({
            notifyOnAutoFill: true,
            challengeSettings: {
                globalDefaults: { autoFill: false, emergencyFill: 600 },
                perChallenge: { '7': { boostFillNew: true } },
            },
        });
        const loaded = settings.loadSettings();
        expect(loaded.notifyOnAutoSubmit).toBe(true);
        expect(loaded.challengeSettings.globalDefaults).toEqual({ autoSubmit: false, emergencySubmit: 600 });
        expect(loaded.challengeSettings.perChallenge['7']).toEqual({ boostNewSubmit: true });
        expect(settings.getEffectiveSetting('autoSubmit', '7')).toBe(false);
        expect(settings.getEffectiveSetting('boostNewSubmit', '7')).toBe(true);
    });

    test('ignore a 2.x name the 1.x file holds', () => {
        store.value = JSON.stringify({
            challengeSettings: {
                globalDefaults: { autoSubmit: false },
                perChallenge: { '7': { boostNewSubmit: true } },
            },
        });
        expect(settings.getEffectiveSetting('autoSubmit', '7')).toBe(settings.SETTINGS_SCHEMA.autoSubmit.default);
        expect(settings.getEffectiveSetting('boostNewSubmit', '7')).toBe(
            settings.SETTINGS_SCHEMA.boostNewSubmit.default,
        );
    });

    test('save under the 1.x names: a change never puts a 2.x name in the file', () => {
        store.value = JSON.stringify({ challengeSettings: { globalDefaults: { autoFill: true, exposure: 80 } } });
        expect(settings.setChallengeOverride('autoSubmit', '7', false)).toBe(true);
        expect(settings.setGlobalDefault('emergencySubmit', 120)).toBe(true);
        expect(settings.setSetting('notifyOnAutoSubmit', true)).toBe(true);
        for (const name of ['autoSubmit', 'emergencySubmit', 'notifyOnAutoSubmit'])
            expect(onDisk()).not.toContain(name);
        expect(parseJsonObject(onDisk())).toMatchObject({
            notifyOnAutoFill: true,
            challengeSettings: {
                globalDefaults: { autoFill: true, emergencyFill: 120, exposure: 80 },
                perChallenge: { '7': { autoFill: false } },
            },
        });
        expect(settings.getEffectiveSetting('autoSubmit', '7')).toBe(false);
    });

    test('write a migrated file back under the 1.x names', () => {
        store.value = JSON.stringify({
            challengeSettings: { globalDefaults: { emergencyFill: 5, autoFillIntervalMinutes: 15 } },
        });
        expect(settings.getEffectiveSetting('emergencySubmit', null)).toBe(300);
        expect(onDisk()).toContain('"emergencyFill": 300');
        expect(onDisk()).toContain('"autoFillSchedule"');
        expect(onDisk()).not.toContain('Submit');
    });
});
