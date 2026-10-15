/**
 * Keys that name Object.prototype members (`constructor`, `toString`, `__proto__`,
 * `hasOwnProperty`) are never settings, setting keys or challenge ids: none of
 * them persists, pollutes Object.prototype, or turns the next load into a
 * defaults fallback that the next save writes over the file. Also: the API
 * timeout, retry count and retry delay, and the check frequency, are bounded at load and on write.
 *
 * Drives the in-memory headless-store seam, like settings-coverage.test.ts.
 */

jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => cat),
        __cat: cat,
    };
});

import settings = require('../../src/ts/settings');
import type * as schemaModule from '../../src/ts/settings/schema';
import type { ConfigV2 } from '../../src/ts/types/config';
import { invalid } from '../helpers/invalid';
import { isConfig } from '../helpers/storedShapes';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import { parseJson, parseJsonAs } from '../helpers/parseJson';

const { schemaEntry } = require('../../src/ts/settings/schema') as typeof schemaModule;

const PROTOTYPE_KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

describe('prototype-named keys', () => {
    let store: MemoryStore;
    const saved = () => parseJsonAs(store.value!, isConfig);
    const seed = (obj: unknown) => {
        store.value = JSON.stringify(obj);
        settings.loadSettings();
    };

    beforeEach(() => {
        store = installHeadlessStore();
        jest.clearAllMocks();
    });

    afterAll(() => {
        removeHeadlessStore();
    });

    afterEach(() => {
        // Whatever a test tried, Object.prototype stays clean.
        expect(Object.keys(Object.prototype)).toEqual([]);
        expect(({} as Record<string, unknown>).exposure).toBeUndefined();
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    describe('the schema lookup', () => {
        test.each(PROTOTYPE_KEYS)('%s is no schema entry', (key) => {
            expect(schemaEntry(key)).toBeUndefined();
            expect(settings.getValidationError(key, 1)).toBeNull();
        });

        test('a real key still resolves', () => {
            expect(schemaEntry('exposure')?.validation).toBeDefined();
        });
    });

    describe.each(PROTOTYPE_KEYS)('%s', (key) => {
        test('setSetting refuses it and persists nothing', () => {
            seed({ app: { theme: 'dark' } });
            const before = store.value;
            expect(settings.setSetting(key, 1)).toBe(false);
            expect(store.value).toBe(before);
        });

        test('setGlobalDefault refuses it', () => {
            seed({ app: { theme: 'dark' } });
            const before = store.value;
            expect(settings.setGlobalDefault(key, 1)).toBe(false);
            expect(store.value).toBe(before);
        });

        test('setChallengeOverride refuses it as a setting key', () => {
            seed({ app: { theme: 'dark' } });
            const before = store.value;
            expect(settings.setChallengeOverride(key, '123', 1)).toBe(false);
            expect(store.value).toBe(before);
        });

        test('setChallengeOverrides refuses it among the overrides', () => {
            seed({ app: { theme: 'dark' } });
            const before = store.value;
            expect(settings.setChallengeOverrides('123', JSON.parse(`{"${key}":1}`))).toBe(false);
            expect(store.value).toBe(before);
        });

        test('saveSettings refuses a payload carrying it, whole', () => {
            seed({ app: { theme: 'dark' } });
            const before = store.value;
            const payload = invalid<Partial<ConfigV2>>(
                parseJson(`{"app":{"theme":"light","${key}":{"polluted":true}}}`),
            );
            expect(settings.saveSettings(payload)).toBe(false);
            expect(store.value).toBe(before);
        });

        test('a stored file holding it loads, drops it, and still saves', () => {
            // Written by hand (or by an older build): the load must not throw into the defaults fallback.
            store.value = `{"app":{"theme":"dark","${key}":{"polluted":true}},"defaults":{"${key}":1}}`;

            const loaded = settings.loadSettings();

            expect(loaded.app.theme).toBe('dark');
            expect(Object.hasOwn(loaded.app, key)).toBe(false);
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
            expect(saved().app.theme).toBe('light');
            expect(Object.hasOwn(saved().app, key)).toBe(false);
        });

        test('reading it back gives null / the default, never an Object member', () => {
            seed({ app: { theme: 'dark' } });
            expect(settings.getGlobalDefault(key)).toBeUndefined();
            expect(settings.getChallengeOverride(key, '123')).toBeNull();
            expect(settings.isSettingModified(key)).toBe(false);
            expect(settings.isGlobalDefaultModified(key)).toBe(false);
        });
    });

    describe.each(['__proto__', 'constructor', 'prototype'])('the challenge id %s', (id) => {
        test('setChallengeOverride refuses it and never writes onto Object.prototype', () => {
            seed({ app: { theme: 'dark' } });
            const before = store.value;
            expect(settings.setChallengeOverride('exposure', id, 55)).toBe(false);
            expect(store.value).toBe(before);
        });

        test('setChallengeOverrides refuses it', () => {
            seed({ app: { theme: 'dark' } });
            const before = store.value;
            expect(settings.setChallengeOverrides(id, { exposure: 55 })).toBe(false);
            expect(settings.setChallengeOverrides(` ${id} `, { exposure: 55 })).toBe(false);
            expect(store.value).toBe(before);
        });

        test('replaceChallengeOverrides, removeChallengeOverride and applyChallengeProfile refuse it', () => {
            seed({ app: { theme: 'dark' }, profiles: { P: { exposure: 60 } } });
            const before = store.value;
            expect(settings.replaceChallengeOverrides(id, { exposure: 55 })).toBe(false);
            expect(settings.removeChallengeOverride('exposure', id)).toBe(false);
            expect(settings.applyChallengeProfile('P', id)).toBe(false);
            expect(store.value).toBe(before);
        });

        test('reads answer as for an unknown challenge', () => {
            seed({ app: { theme: 'dark' } });
            expect(settings.getChallengeOverride('exposure', id)).toBeNull();
            expect(settings.getChallengeOverrides(id)).toEqual({});
            expect(settings.getEffectiveSetting('exposure', id)).toBe(settings.getEffectiveSetting('exposure', null));
        });

        test('a stored file holding it loads without it', () => {
            store.value = `{"app":{"theme":"dark"},"challenges":{"${id}":{"values":{"exposure":55}},"7":{"values":{"exposure":60}}}}`;

            const loaded = settings.loadSettings();

            expect(Object.hasOwn(loaded.challenges, id)).toBe(false);
            expect(loaded.challenges['7'].values).toEqual({ exposure: 60 });
        });
    });

    test('hasOwnProperty as a challenge id is a plain id: its container is created as an own property', () => {
        seed({ app: { theme: 'dark' } });
        expect(settings.setChallengeOverride('exposure', 'hasOwnProperty', 55)).toBe(true);
        expect(Object.hasOwn(saved().challenges, 'hasOwnProperty')).toBe(true);
        expect(settings.getChallengeOverride('exposure', 'hasOwnProperty')).toBe(55);
        expect(settings.getChallengeOverride('toString', 'hasOwnProperty')).toBeNull();
    });

    describe('the API timeout, retry count and delay, and the check frequency are bounded', () => {
        test.each([
            ['apiTimeout', 0],
            ['apiTimeout', -5],
            ['apiTimeout', 301],
            ['apiTimeout', Number.NaN],
            ['apiMaxRetries', -1],
            ['apiMaxRetries', 11],
            ['apiMaxRetries', 2.5],
            ['apiRetryBaseDelayMs', 99],
            ['apiRetryBaseDelayMs', 10_001],
            ['apiRetryBaseDelayMs', 1000.5],
            ['apiRetryBaseDelayMs', Number.NaN],
            ['checkFrequencyMin', 0],
            ['checkFrequencyMin', 61],
            ['checkFrequencyMin', Number.NaN],
            ['checkFrequencyMax', 0.5],
            ['checkFrequencyMax', 61],
        ])('%s = %p is refused on write', (key, bad) => {
            seed({ app: { theme: 'dark' } });
            const before = store.value;
            expect(settings.setSetting(key, bad)).toBe(false);
            expect(settings.saveAppSettings({ [key]: bad })).toBe(false);
            expect(settings.saveAppSettings({ [key]: 'x' })).toBe(false);
            expect(store.value).toBe(before);
        });

        test.each([
            ['apiTimeout', 1],
            ['apiTimeout', 300],
            ['apiMaxRetries', 0],
            ['apiMaxRetries', 10],
            ['apiRetryBaseDelayMs', 100],
            ['apiRetryBaseDelayMs', 10_000],
            ['checkFrequencyMin', 1],
            ['checkFrequencyMax', 60],
            ['checkFrequencyMax', 2.5],
        ])('%s = %p is accepted', (key, ok) => {
            seed({ app: { theme: 'dark' } });
            expect(settings.setSetting(key, ok)).toBe(true);
            expect(saved().app[key]).toBe(ok);
        });

        test.each([
            ['apiTimeout', 100000, 30],
            ['apiTimeout', 0, 30],
            ['apiMaxRetries', 1000, 3],
            ['apiMaxRetries', -2, 3],
            ['apiRetryBaseDelayMs', 0, 1000],
            ['apiRetryBaseDelayMs', 1e9, 1000],
            ['checkFrequencyMin', 0, 3],
            ['checkFrequencyMin', -4, 3],
            ['checkFrequencyMax', 1000, 3],
            ['checkFrequencyMax', 0, 3],
        ])('a stored %s of %p is dropped for the default %p', (key, bad, fallback) => {
            store.value = JSON.stringify({ app: { theme: 'dark', [key]: bad } });

            expect(settings.loadSettings().app[key]).toBe(fallback);
            expect(settings.loadSettings().app.theme).toBe('dark');
        });

        test('an out-of-range value is said once, not on every read', () => {
            let warning: jest.Mock<void, [string, ...unknown[]]> | undefined;
            jest.isolateModules(() => {
                const isolated = require('../../src/ts/settings') as typeof settings;
                warning = (
                    require('../../src/ts/logger') as unknown as {
                        __cat: { warning: jest.Mock<void, [string, ...unknown[]]> };
                    }
                ).__cat.warning;
                installHeadlessStore({ config: JSON.stringify({ app: { theme: 'dark', apiTimeout: 100000 } }) });
                isolated.loadSettings();
                isolated.loadSettings();
                isolated.loadSettings();
            });

            expect(warning).toHaveBeenCalledTimes(1);
            expect(warning).toHaveBeenCalledWith(expect.stringContaining('apiTimeout'));
        });
    });
});

describe('a schema entry without a validator', () => {
    afterEach(() => {
        jest.dontMock('../../src/ts/settings/schema');
    });

    test('is skipped by the load-time validation instead of throwing into the defaults fallback', () => {
        let loaded: ConfigV2 | undefined;
        jest.isolateModules(() => {
            jest.doMock('../../src/ts/settings/schema', () => {
                const actual = jest.requireActual<typeof schemaModule>('../../src/ts/settings/schema');
                return {
                    ...actual,
                    schemaEntry: (key: string) =>
                        key === 'hollow' ? invalid({ type: 'number', perChallenge: false }) : actual.schemaEntry(key),
                };
            });
            const isolated = require('../../src/ts/settings') as typeof settings;
            installHeadlessStore({
                config: JSON.stringify({ app: { theme: 'dark' }, defaults: { hollow: 1, exposure: 70 } }),
            });
            loaded = isolated.loadSettings();
        });
        removeHeadlessStore();

        expect(loaded?.app.theme).toBe('dark');
        expect(loaded?.defaults).toEqual(expect.objectContaining({ hollow: 1, exposure: 70 }));
    });
});
