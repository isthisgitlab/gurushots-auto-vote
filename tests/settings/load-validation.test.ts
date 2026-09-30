/**
 * loadSettings drops stored values whose type a read would misreport: a
 * top-level value of the wrong type goes back to its default, and a schema
 * value its validation rejects is removed so the schema default applies.
 * Drives the in-memory headless-store seam so loadSettings round-trips
 * without fs.
 */

import type { AndroidHeadlessStore } from '../../src/js/types/settings';
import settings = require('../../src/js/settings');
import type * as defaultsModule from '../../src/js/settings/defaults';
const { getDefaultSettings } = require('../../src/js/settings/defaults') as typeof defaultsModule;

const mockWarning = jest.fn<void, [message: string, data?: unknown]>();
jest.mock('../../src/js/logger', () => ({
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

const headlessGlobals = globalThis as typeof globalThis & {
    __GS_HEADLESS__?: boolean;
    AndroidHeadlessStore?: AndroidHeadlessStore;
};
let store: { value: string | null; read: jest.Mock<string | null, []>; write: jest.Mock<void, [string]> };
const seed = (blob: unknown) => {
    store.value = JSON.stringify(blob);
};
const warnings = () => mockWarning.mock.calls.map(([message]) => message);

beforeEach(() => {
    mockWarning.mockClear();
    headlessGlobals.__GS_HEADLESS__ = true;
    store = {
        value: null,
        read: jest.fn(() => store.value),
        write: jest.fn((data) => {
            store.value = data;
        }),
    };
    headlessGlobals.AndroidHeadlessStore = store;
});

afterEach(() => {
    delete headlessGlobals.__GS_HEADLESS__;
    delete headlessGlobals.AndroidHeadlessStore;
});

describe('loadSettings validation', () => {
    test('a valid file loads as stored, with no warning, and an unchanged file is not re-checked', () => {
        seed({ theme: 'dark', challengeSettings: { globalDefaults: { exposure: 80 }, perChallenge: { c1: {} } } });
        expect(settings.loadSettings().challengeSettings.globalDefaults.exposure).toBe(80);
        expect(settings.loadSettings().theme).toBe('dark');
        expect(warnings()).toEqual([]);
    });

    test('a top-level value of the wrong type goes back to its default', () => {
        seed({ theme: 5, customTimezones: ['Europe/Riga', 3], mock: 'yes', apiTimeout: '30', language: 'lv' });
        const loaded = settings.loadSettings();
        const defaults = getDefaultSettings();
        expect(loaded.theme).toBe(defaults.theme);
        expect(loaded.customTimezones).toEqual(defaults.customTimezones);
        expect(loaded.mock).toBe(defaults.mock);
        expect(loaded.apiTimeout).toBe(defaults.apiTimeout);
        expect(loaded.language).toBe('lv');
        expect(warnings()).toEqual([
            'Ignoring stored settings that are not valid (defaults apply): theme, customTimezones, apiTimeout, mock',
        ]);
    });

    test('a challengeSettings block that is not an object is replaced by the defaults', () => {
        seed({ challengeSettings: [1, 2] });
        expect(settings.loadSettings().challengeSettings).toEqual(getDefaultSettings().challengeSettings);
        expect(warnings()[0]).toMatch(/: challengeSettings$/);
    });

    test('a container of the wrong kind is replaced by its default; a missing one is added silently', () => {
        const defaults = getDefaultSettings().challengeSettings;
        seed({ challengeSettings: { globalDefaults: ['x'], titleRules: [] } });
        const loaded = settings.loadSettings().challengeSettings;
        expect(loaded.globalDefaults).toEqual(defaults.globalDefaults);
        expect(loaded.perChallenge).toEqual({});
        expect(loaded.titleProfileSuppressions).toEqual({});
        expect(warnings()).toEqual([expect.stringMatching(/: challengeSettings\.globalDefaults$/)]);

        seed({ challengeSettings: { globalDefaults: {}, perChallenge: 'x', titleProfileSuppressions: [] } });
        const next = settings.loadSettings().challengeSettings;
        expect(next.perChallenge).toEqual({});
        expect(next.titleProfileSuppressions).toEqual({});
        expect(warnings()[1]).toMatch(
            /: challengeSettings\.perChallenge, challengeSettings\.titleProfileSuppressions$/,
        );
    });

    test('a missing container is added on every read of an unchanged file, not only the first', () => {
        // A current blob (no migration rewrites it) that predates one container.
        seed(getDefaultSettings());
        settings.loadSettings();
        const current = JSON.parse(store.value as string) as ReturnType<typeof getDefaultSettings>;
        const challengeSettings = Object.fromEntries(
            Object.entries(current.challengeSettings).filter(([key]) => key !== 'titleProfileSuppressions'),
        );
        seed({ ...current, challengeSettings });
        expect(settings.loadSettings().challengeSettings.titleProfileSuppressions).toEqual({});
        expect(settings.loadSettings().challengeSettings.titleProfileSuppressions).toEqual({});
        expect(settings.cleanupStaleChallengeSetting([])).toBe(true);
    });

    test('schema values their validation rejects are removed; valid and unknown keys stay', () => {
        seed({
            challengeSettings: {
                globalDefaults: { exposure: 'high', autoFill: true, noSuchSetting: 1 },
                perChallenge: { c1: { exposure: 150, autoFill: false }, c2: 7 },
            },
        });
        const { globalDefaults, perChallenge } = settings.loadSettings().challengeSettings;
        expect(globalDefaults).toEqual({ autoFill: true, noSuchSetting: 1 });
        expect(perChallenge).toEqual({ c1: { autoFill: false } });
        expect(settings.getGlobalDefault('exposure')).toBe(
            getDefaultSettings().challengeSettings.globalDefaults.exposure,
        );
        expect(warnings()).toEqual([
            'Ignoring stored settings that are not valid (defaults apply): challengeSettings.globalDefaults.exposure, challengeSettings.perChallenge.c1.exposure, challengeSettings.perChallenge.c2',
        ]);
    });

    test('the same invalid file warns once; a different one warns again, on one line', () => {
        seed({ challengeSettings: { globalDefaults: {}, perChallenge: { 'a\nb': 1 } } });
        settings.loadSettings();
        settings.loadSettings();
        expect(warnings()).toEqual([
            'Ignoring stored settings that are not valid (defaults apply): challengeSettings.perChallenge.a b',
        ]);

        seed({ challengeSettings: { globalDefaults: { exposure: -1 } } });
        settings.loadSettings();
        expect(warnings()).toHaveLength(2);
    });
});
