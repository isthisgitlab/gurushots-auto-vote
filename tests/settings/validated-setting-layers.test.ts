/**
 * getEffectiveSetting returns what a key's validator allows, whichever layer the value comes from: a hand-edited
 * settings file can hold anything in the global defaults, a per-challenge override, a saved profile or a scenario
 * phase, and none of it may reach a reader. Consumers (the cadence resolvers, the vote rules, the currency
 * automation, the join pass, the headless loop) read these keys without re-checking them, so this is the guard.
 * Each case seeds the raw stored file, bypassing the write path, and a control with a valid value proves the layer
 * is wired before the invalid value is judged.
 */

import type { AndroidHeadlessStore } from '../../src/ts/types/settings';
import settings = require('../../src/ts/settings');
import type * as schemaModule from '../../src/ts/settings/schema';
import type * as scenarioStateStoreModule from '../../src/ts/scenarioStateStore';

const { schemaEntry, validateSetting } = require('../../src/ts/settings/schema') as typeof schemaModule;
const { scenarioStateLedger, initialState } =
    require('../../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule;

jest.mock('../../src/ts/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => category),
    };
});

// Per-challenge keys whose readers hold no guard of their own.
const CHALLENGE_KEYS = [
    'lastMinuteThreshold',
    'voteBeforeBoostLeadMin',
    'voteBeforeFinalWindowLeadMin',
    'finalWindowDuration',
    'boostTime',
    'keyUnlockedBoostTime',
    'autoSwapMax',
    'autoExposureFillMax',
    'autoKeyAfterStart',
    'autoKeyBeforeEnd',
    'autoKeyAfterPercent',
    'autoSwapAfterStart',
    'autoSwapBeforeEnd',
    'autoSwapAfterPercent',
    'autoExposureFillAfterStart',
    'autoExposureFillBeforeEnd',
    'autoExposureFillAfterPercent',
];
// Global-only keys: only the global layer applies.
const GLOBAL_KEYS = [
    'lastMinuteCheckFrequency',
    'autoJoinCycleCoinBudget',
    'currencyReserveKeys',
    'currencyReserveSwaps',
    'currencyReserveFills',
];

// What a hand edit could plausibly leave behind (JSON holds no NaN or Infinity, both read back as null).
const CANDIDATES: unknown[] = [0, -1, 1.5, 1_000_000_000_000, '20', 'x', '', null, true, [], {}];

const invalidValues = (key: string): unknown[] => CANDIDATES.filter((value) => !validateSetting(key, value));

/** A valid value that differs from the key's default, so a control can tell a stored value from the fallback. */
const validOtherValue = (key: string): number => {
    const entry = schemaEntry(key)!;
    const pick = [entry.max, 5400, 7, 2].find(
        (value) => typeof value === 'number' && value !== entry.default && validateSetting(key, value),
    );
    return pick as number;
};

const defaultOf = (key: string): unknown => schemaEntry(key)!.default;

const headlessGlobals = globalThis as typeof globalThis & {
    __GS_HEADLESS__?: boolean;
    AndroidHeadlessStore?: AndroidHeadlessStore;
};
let store: {
    value: string | null;
    keys: Record<string, string>;
    read: () => string | null;
    write: (data: string) => void;
    readKey: (key: string) => string | null;
    writeKey: (key: string, data: string) => void;
};

const seed = (challengeSettings: Record<string, unknown>) => {
    store.value = JSON.stringify({
        theme: 'dark',
        challengeSettings: { globalDefaults: {}, perChallenge: {}, titleRules: [], ...challengeSettings },
    });
};

beforeAll(() => {
    // Burn the once-per-process obsolete-settings cleanup so it never rewrites a seeded blob.
    headlessGlobals.__GS_HEADLESS__ = true;
    headlessGlobals.AndroidHeadlessStore = {
        read: () => JSON.stringify({ challengeSettings: { globalDefaults: {} } }),
        write: () => {},
    };
    settings.loadSettings();
});

beforeEach(() => {
    headlessGlobals.__GS_HEADLESS__ = true;
    store = {
        value: null,
        keys: {},
        read: () => store.value,
        write: (data) => {
            store.value = data;
        },
        readKey: (key) => store.keys[key] ?? null,
        writeKey: (key, data) => {
            store.keys[key] = data;
        },
    };
    headlessGlobals.AndroidHeadlessStore = store;
    settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
});

afterEach(() => {
    delete headlessGlobals.__GS_HEADLESS__;
    delete headlessGlobals.AndroidHeadlessStore;
    settings.rememberChallengeTitles([]);
});

describe('the keys read without a downstream guard', () => {
    test.each([...CHALLENGE_KEYS, ...GLOBAL_KEYS])('%s has a validator that rejects what a hand edit leaves', (key) => {
        expect(invalidValues(key).length).toBeGreaterThan(0);
        expect(validateSetting(key, defaultOf(key))).toBe(true);
    });

    test.each([...CHALLENGE_KEYS, ...GLOBAL_KEYS])('%s is the schema default when the file predates it', (key) => {
        seed({});
        expect(settings.getEffectiveSetting(key, '7')).toBe(defaultOf(key));
        expect(settings.getEffectiveSetting(key, null)).toBe(defaultOf(key));
    });

    test('the lower bounds the removed guards used to enforce are in the validators', () => {
        for (const key of ['lastMinuteCheckFrequency', 'lastMinuteThreshold', 'voteBeforeBoostLeadMin']) {
            expect(validateSetting(key, 0)).toBe(false);
            expect(validateSetting(key, 1)).toBe(true);
        }
        for (const key of ['finalWindowDuration', 'voteBeforeFinalWindowLeadMin']) {
            expect(validateSetting(key, 0)).toBe(false);
            expect(validateSetting(key, -1)).toBe(false);
        }
        for (const key of ['autoSwapMax', 'autoExposureFillMax']) {
            expect(validateSetting(key, 0)).toBe(false);
        }
        // 0 is the "off" sentinel of these, so a negative value is the lower bound that matters.
        for (const key of ['boostTime', 'keyUnlockedBoostTime', 'currencyReserveKeys', 'autoJoinCycleCoinBudget']) {
            expect(validateSetting(key, -1)).toBe(false);
            expect(validateSetting(key, 0)).toBe(true);
        }
    });
});

describe.each(CHALLENGE_KEYS)('%s, whichever layer holds it', (key) => {
    const good = validOtherValue(key);

    test('global default', () => {
        seed({ globalDefaults: { [key]: good } });
        expect(settings.getEffectiveSetting(key, '7')).toBe(good);
        for (const bad of invalidValues(key)) {
            seed({ globalDefaults: { [key]: bad } });
            expect(settings.getEffectiveSetting(key, '7')).toBe(defaultOf(key));
            expect(settings.getEffectiveSetting(key, null)).toBe(defaultOf(key));
        }
    });

    test('per-challenge override', () => {
        seed({ perChallenge: { '7': { [key]: good } } });
        expect(settings.getEffectiveSetting(key, '7')).toBe(good);
        for (const bad of invalidValues(key)) {
            seed({ globalDefaults: { [key]: good }, perChallenge: { '7': { [key]: bad } } });
            // The bad override is dropped, so the layer below it answers.
            expect(settings.getEffectiveSetting(key, '7')).toBe(good);
        }
    });

    test('saved profile named by a rule', () => {
        const rule = { title: 'Big show', profile: 'P' };
        seed({ profiles: { P: { [key]: good } }, titleRules: [rule] });
        expect(settings.getEffectiveSetting(key, '7')).toBe(good);
        for (const bad of invalidValues(key)) {
            seed({ profiles: { P: { [key]: bad } }, titleRules: [rule] });
            // A profile with an unusable value contributes nothing at all.
            expect(settings.getEffectiveSetting(key, '7')).toBe(defaultOf(key));
        }
    });

    test('scenario phase', () => {
        const scenario = (value: unknown) => ({
            Plan: { name: 'Plan', version: 1, start: 'p', phases: { p: { settings: { [key]: value } } } },
        });
        const assigned = { '7': { scenario: 'Plan' } };
        seed({ scenarios: scenario(good), perChallenge: assigned });
        scenarioStateLedger.set(7, initialState('Plan', 'p', 1000));
        expect(settings.getEffectiveSetting(key, '7')).toBe(good);
        for (const bad of invalidValues(key)) {
            seed({ scenarios: scenario(bad), perChallenge: assigned });
            // A scenario holding an unusable value is not in use, so no overlay applies.
            expect(settings.getEffectiveSetting(key, '7')).toBe(defaultOf(key));
        }
    });
});

describe.each(GLOBAL_KEYS)('%s, a global-only key', (key) => {
    test('a stored global default is returned only when valid', () => {
        const good = validOtherValue(key);
        seed({ globalDefaults: { [key]: good } });
        expect(settings.getEffectiveSetting(key, null)).toBe(good);
        for (const bad of invalidValues(key)) {
            seed({ globalDefaults: { [key]: bad } });
            expect(settings.getEffectiveSetting(key, null)).toBe(defaultOf(key));
        }
    });
});

test('the headless loop reads lastMinuteCheckFrequency under the id "global" and gets the global default', () => {
    seed({
        perChallenge: { global: { lastMinuteCheckFrequency: 0 } },
        globalDefaults: { lastMinuteCheckFrequency: 3 },
    });
    expect(settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global')).toBe(3);
});
