/**
 * loadSettings drops stored values whose type a read would misreport: an app or auth value of the wrong type goes
 * back to its default, a container of the wrong kind is replaced by an empty one, and a schema value its validation
 * rejects is removed so the schema default applies. Drives the in-memory headless-store seam so loadSettings
 * round-trips without fs.
 */

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { parseJson } from '../helpers/parseJson';
import settings = require('../../src/ts/settings');
import type * as defaultsModule from '../../src/ts/settings/defaults';
import type { MemoryStore } from '../helpers/headlessStore';
const { getDefaultSettings } = require('../../src/ts/settings/defaults') as typeof defaultsModule;

const mockWarning = jest.fn<void, [message: string, data?: unknown]>();
jest.mock('../../src/ts/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    isDevMode: jest.fn(() => false),
    isSourceCode: jest.fn(() => true),
    getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: mockWarning,
    })),
}));

let store: MemoryStore;
const seed = (blob: unknown) => {
    store.value = JSON.stringify(blob);
};
const warnings = () => mockWarning.mock.calls.map(([message]) => message);
const INVALID = 'Ignoring stored settings that are not valid (defaults apply): ';

beforeEach(() => {
    mockWarning.mockClear();
    store = installHeadlessStore();
});

afterEach(() => {
    removeHeadlessStore();
});

describe('loadSettings validation', () => {
    test('a valid file loads as stored, with no warning, and an unchanged file is not re-checked', () => {
        seed({ version: 2, app: { theme: 'dark' }, defaults: { exposure: 80 }, challenges: { c1: { values: {} } } });
        expect(settings.loadSettings().defaults.exposure).toBe(80);
        expect(settings.loadSettings().app.theme).toBe('dark');
        expect(warnings()).toEqual([]);
    });

    test('an app value of the wrong type goes back to its default', () => {
        seed({ app: { theme: 5, customTimezones: ['Europe/Riga', 3], mock: 'yes', apiTimeout: '30', language: 'lv' } });
        const loaded = settings.loadSettings().app;
        const defaults = getDefaultSettings().app;
        expect(loaded.theme).toBe(defaults.theme);
        expect(loaded.customTimezones).toEqual(defaults.customTimezones);
        expect(loaded.mock).toBe(defaults.mock);
        expect(loaded.apiTimeout).toBe(defaults.apiTimeout);
        expect(loaded.language).toBe('lv');
        expect(warnings()).toEqual([`${INVALID}app.theme, app.customTimezones, app.apiTimeout, app.mock`]);
    });

    test('an app number outside its range goes back to its default', () => {
        seed({ app: { checkFrequencyMin: 0, checkFrequencyMax: 61, apiMaxRetries: 1.5 } });
        const loaded = settings.loadSettings().app;
        expect([loaded.checkFrequencyMin, loaded.checkFrequencyMax, loaded.apiMaxRetries]).toEqual([3, 3, 3]);
    });

    test('an app-state flag its schema entry rejects is removed; a name that is a prototype member is dropped', () => {
        const hostile = parseJson(
            '{"__proto__":1,"constructor":2,"autovoteRunning":"yes","noticeAcknowledgedVersion":3}',
        );
        seed({ app: hostile });
        const loaded = settings.loadSettings().app;
        expect(Object.hasOwn(loaded, 'autovoteRunning')).toBe(false);
        expect(loaded.noticeAcknowledgedVersion).toBe(3);
        expect(Object.hasOwn(loaded, '__proto__')).toBe(false);
        expect(Object.hasOwn(loaded, 'constructor')).toBe(false);
        expect(warnings()[0]).toMatch(/app\.__proto__, app\.constructor, app\.autovoteRunning$/);
    });

    test('an app block that is not an object is replaced by the defaults', () => {
        seed({ app: [1, 2] });
        expect(settings.loadSettings().app).toEqual(getDefaultSettings().app);
        expect(warnings()).toEqual([`${INVALID}app`]);
    });

    test('a missing app value is filled with its default, silently', () => {
        seed({ app: { language: 'lv' } });
        expect(settings.loadSettings().app).toEqual({ ...getDefaultSettings().app, language: 'lv' });
        expect(warnings()).toEqual([]);
    });

    describe('the sign-in state is strict', () => {
        test('the token and the account strings must be strings, the API headers an object of strings', () => {
            seed({
                auth: {
                    token: 7,
                    apiHeaders: { 'x-a': 'b', 'x-c': 4 },
                    lastUsername: null,
                    chosenPhotosMemberId: 'm1',
                },
            });
            const { auth } = settings.loadSettings();
            expect(auth).toEqual({ token: '', apiHeaders: {}, lastUsername: '', chosenPhotosMemberId: 'm1' });
            expect(warnings()).toEqual([`${INVALID}auth.token, auth.apiHeaders, auth.lastUsername`]);
        });

        test('headers that are not an object are replaced', () => {
            seed({ auth: { token: 't', apiHeaders: ['x'] } });
            expect(settings.loadSettings().auth).toEqual({ ...getDefaultSettings().auth, token: 't' });
        });

        test('an auth block that is not an object is replaced by the empty one', () => {
            seed({ auth: 'token' });
            expect(settings.loadSettings().auth).toEqual(getDefaultSettings().auth);
            expect(warnings()).toEqual([`${INVALID}auth`]);
        });

        test('a valid auth block loads as stored', () => {
            seed({ auth: { token: 't', apiHeaders: { a: 'b' }, lastUsername: 'u', chosenPhotosMemberId: 'm' } });
            expect(settings.loadSettings().auth).toEqual({
                token: 't',
                apiHeaders: { a: 'b' },
                lastUsername: 'u',
                chosenPhotosMemberId: 'm',
            });
            expect(warnings()).toEqual([]);
        });
    });

    test('a container of the wrong kind is replaced by its empty one; a missing one is added silently', () => {
        seed({ defaults: ['x'], profiles: 3, scenarios: [], rules: {}, seededProfiles: 'a', challenges: null });
        const loaded = settings.loadSettings();
        expect(loaded.defaults).toEqual({});
        expect(loaded.profiles).toEqual({});
        expect(loaded.scenarios).toEqual({});
        expect(loaded.rules).toEqual([]);
        expect(loaded.seededProfiles).toEqual([]);
        expect(loaded.challenges).toEqual({});
        expect(warnings()).toEqual([`${INVALID}defaults, profiles, scenarios, challenges, seededProfiles, rules`]);

        seed({ version: 2 });
        const filled = settings.loadSettings();
        expect(filled.defaults).toEqual({});
        expect(filled.challenges).toEqual({});
        expect(filled.rules).toEqual([]);
        expect(warnings()).toHaveLength(1);
    });

    test('a version that is not 2 is read as a 2', () => {
        seed({ version: 'one' });
        expect(settings.loadSettings().version).toBe(2);
    });

    test('a missing container is added on every read of an unchanged file, not only the first', () => {
        seed({ version: 2, app: { language: 'lv' } });
        expect(settings.loadSettings().challenges).toEqual({});
        expect(settings.loadSettings().challenges).toEqual({});
        expect(settings.cleanupStaleChallengeSetting([])).toBe(true);
    });

    test('schema values their validation rejects are removed; valid and unknown keys stay', () => {
        seed({
            defaults: { exposure: 'high', autoSubmit: true, noSuchSetting: 1 },
            challenges: {
                c1: { values: { exposure: 150, autoSubmit: false } },
                c2: 7,
            },
        });
        const { defaults, challenges } = settings.loadSettings();
        expect(defaults).toEqual({ autoSubmit: true, noSuchSetting: 1 });
        expect(challenges).toEqual({ c1: { values: { autoSubmit: false } } });
        expect(settings.getGlobalDefault('exposure')).toBe(100);
        expect(warnings()).toEqual([`${INVALID}defaults.exposure, challenges.c1.values.exposure, challenges.c2`]);
    });

    test('the parts of a challenge record that are of the wrong kind are dropped', () => {
        seed({
            challenges: {
                a: { values: 'x', suppressRuleProfile: true, pins: { boost: 'e1' } },
                b: { values: { exposure: 50 }, suppressRuleProfile: false, pins: ['e1'] },
                constructor: { values: { exposure: 50 } },
            },
        });
        const { challenges } = settings.loadSettings();
        expect(challenges).toEqual({
            a: { suppressRuleProfile: true, pins: { boost: 'e1' } },
            b: { values: { exposure: 50 } },
        });
        expect(warnings()[0]).toMatch(
            /challenges\.a\.values, challenges\.b\.suppressRuleProfile, challenges\.b\.pins, challenges\.constructor$/,
        );
    });

    describe('the record of the import', () => {
        const imported = {
            at: '2026-10-15T10:00:00.000Z',
            sha256: '',
            report: { refsBlocked: ['a'] },
            acknowledged: false,
        };

        test('is kept when it has its shape', () => {
            seed({ imported });
            expect(settings.loadSettings().imported).toEqual(imported);
            expect(warnings()).toEqual([]);
        });

        test.each([
            ['a string', 'x'],
            ['no report', { ...imported, report: undefined }],
            ['report refs that are not strings', { ...imported, report: { refsBlocked: [1] } }],
            ['an acknowledged that is not a boolean', { ...imported, acknowledged: 'no' }],
            ['an at that is not a string', { ...imported, at: 4 }],
        ])('is dropped with %s', (_what, value) => {
            // The warning of an unchanged invalid file is said once, so another one comes between the cases.
            seed({ defaults: { exposure: -1 } });
            settings.loadSettings();
            mockWarning.mockClear();
            seed({ imported: value });
            expect(settings.loadSettings().imported).toBeUndefined();
            expect(warnings()).toEqual([`${INVALID}imported`]);
        });
    });

    test('the same invalid file warns once; a different one warns again, on one line', () => {
        seed({ challenges: { 'a\nb': 1 } });
        settings.loadSettings();
        settings.loadSettings();
        expect(warnings()).toEqual([`${INVALID}challenges.a b`]);

        seed({ defaults: { exposure: -1 } });
        settings.loadSettings();
        expect(warnings()).toHaveLength(2);
    });
});
