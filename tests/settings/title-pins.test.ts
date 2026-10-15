/**
 * First-seen challenge-title pins on the settings facade.
 *
 * Covers getTitlePins (defensive copy, prototype-key safety) and
 * mergeTitlePins (first-seen-wins merge, removals, length/count caps).
 *
 * Drives the in-memory headless-store seam (tests/helpers/headlessStore.ts) so the pin store
 * round-trips without touching fs.
 */

import { invalid } from '../helpers/invalid';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { isRecordOf, isString, parseJsonAs } from '../helpers/parseJson';

import type * as settingsModule from '../../src/ts/settings';
import type * as titlePinsModule from '../../src/ts/settings/titlePins';
import type * as jsonStoreModule from '../../src/ts/settings/jsonStore';
import type { MemoryStore } from '../helpers/headlessStore';

const PINS_KEY = 'gs_title_pins';

jest.mock('../../src/ts/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    api: jest.fn(),
    startOperation: jest.fn(),
    endOperation: jest.fn(),
    apiRequest: jest.fn(),
    apiResponse: jest.fn(),
    isDevMode: jest.fn(() => false),
    isSourceCode: jest.fn(() => true),
    getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
    })),
}));

describe('settings facade — first-seen title pins', () => {
    let settings: typeof settingsModule;
    let store: MemoryStore;

    // The pins sit in a cache store of their own, which keeps what it last wrote in memory: a module of its own
    // per test, so that one test's pins are not another's.
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('electron', () => ({}));
        store = installHeadlessStore();
        settings = require('../../src/ts/settings') as typeof settingsModule;
    });

    afterEach(() => {
        removeHeadlessStore();
    });

    const storedPins = () => parseJsonAs(store.keys.get(PINS_KEY) ?? '{}', isRecordOf(isString));

    test('defaults to an empty map', () => {
        expect(settings.getTitlePins()).toEqual({});
    });

    test('round-trips added pins', () => {
        expect(settings.mergeTitlePins({ 1: 'Pink In Nature', 2: 'Street Life' }, [])).toBe(true);
        expect(settings.getTitlePins()).toEqual({ 1: 'Pink In Nature', 2: 'Street Life' });
    });

    test('merge never overwrites an existing pin (first-seen wins)', () => {
        settings.mergeTitlePins({ 1: 'Original' }, []);
        settings.mergeTitlePins({ 1: 'turbo', 2: 'New Pin' }, []);
        expect(settings.getTitlePins()).toEqual({ 1: 'Original', 2: 'New Pin' });
    });

    test('removeIds delete pins; a removed id can be re-added later', () => {
        settings.mergeTitlePins({ 1: 'One', 2: 'Two' }, []);
        settings.mergeTitlePins({}, ['1']);
        expect(settings.getTitlePins()).toEqual({ 2: 'Two' });

        settings.mergeTitlePins({ 1: 'One Again' }, []);
        expect(settings.getTitlePins()).toEqual({ 1: 'One Again', 2: 'Two' });
    });

    test('no-op call (empty adds and removes) does not write', () => {
        expect(settings.mergeTitlePins({}, [])).toBe(true);
        expect(settings.mergeTitlePins(invalid(null), invalid(null))).toBe(true);
        expect(store.keys.has(PINS_KEY)).toBe(false);
    });

    test('the pins are in a store of their own, not in the configuration', () => {
        settings.mergeTitlePins({ 1: 'Pink In Nature' }, []);
        expect(storedPins()).toEqual({ 1: 'Pink In Nature' });
        expect(store.value).toBeNull();
    });

    test('a pin store that cannot be written reports the merge as not saved', () => {
        jest.resetModules();
        jest.doMock('../../src/ts/settings/storage', () => ({
            __esModule: true,
            createJsonStore: () => ({
                readRaw: () => null,
                writeRaw: () => {
                    throw new Error('disk full');
                },
            }),
        }));
        const isolated = require('../../src/ts/settings/titlePins') as typeof titlePinsModule;
        expect(isolated.mergeTitlePins({ 1: 'Pink In Nature' }, [])).toBe(false);
        jest.dontMock('../../src/ts/settings/storage');
    });

    test('a cache that is wiped after it was read holds no pins any more', () => {
        settings.mergeTitlePins({ 1: 'One' }, []);
        expect(settings.getTitlePins()).toEqual({ 1: 'One' });

        // A local-data wipe: the key is gone from the native store and the store forgets what it last wrote.
        store.keys.delete(PINS_KEY);
        (require('../../src/ts/settings/jsonStore') as typeof jsonStoreModule).discardStores();

        expect(settings.getTitlePins()).toEqual({});
    });

    test('a cache that is not JSON holds no pins and is rewritten by the next merge', () => {
        store.keys.set(PINS_KEY, 'not json');
        expect(settings.getTitlePins()).toEqual({});
        expect(settings.mergeTitlePins({ 1: 'One' }, [])).toBe(true);
        expect(settings.getTitlePins()).toEqual({ 1: 'One' });
    });

    test('getTitlePins returns a defensive copy', () => {
        settings.mergeTitlePins({ 1: 'Original' }, []);
        const pins = settings.getTitlePins();
        pins['1'] = 'mutated';
        pins['999'] = 'injected';
        expect(settings.getTitlePins()).toEqual({ 1: 'Original' });
    });

    test('boundary-length and over-length titles are rejected instead of becoming ambiguous pins', () => {
        settings.mergeTitlePins({ 1: 'x'.repeat(settings.MAX_TITLE_LENGTH), 2: 'y'.repeat(250) }, []);
        expect(settings.getTitlePins()).toEqual({});
    });

    test('empty/whitespace/non-string titles are not stored', () => {
        settings.mergeTitlePins(invalid({ 1: '', 2: '   ', 3: 42, 4: 'Real' }), []);
        expect(settings.getTitlePins()).toEqual({ 4: 'Real' });
    });

    test('whitespace-only stored value (corrupted blob) is filtered on read', () => {
        settings.mergeTitlePins({ 1: 'Real' }, []);
        // Simulate external tampering: inject a whitespace-only pin directly
        // into the persisted blob, bypassing mergeTitlePins' validation.
        store.keys.set(PINS_KEY, JSON.stringify({ ...storedPins(), 2: '   ' }));

        expect(settings.getTitlePins()).toEqual({ 1: 'Real' });
    });

    test('legacy boundary-length truncated pins are filtered on read', () => {
        settings.mergeTitlePins({ 1: 'Real' }, []);
        store.keys.set(PINS_KEY, JSON.stringify({ ...storedPins(), 2: 'x'.repeat(settings.MAX_TITLE_LENGTH) }));

        expect(settings.getTitlePins()).toEqual({ 1: 'Real' });
    });

    test('entry count is capped at 500', () => {
        const adds: Record<string, string> = {};
        for (let i = 0; i < 510; i++) {
            adds[`id-${i}`] = `Title ${i}`;
        }
        settings.mergeTitlePins(adds, []);
        expect(Object.keys(settings.getTitlePins())).toHaveLength(500);
    });

    test('a prototype-named id never surfaces a non-string prototype member', () => {
        // JSON.parse (like an API payload) makes `__proto__` a real own key; a
        // plain `__proto__:` literal would only set the prototype.
        settings.mergeTitlePins(
            parseJsonAs('{"__proto__":"Proto Title","constructor":"Ctor Title","1":"Real"}', isRecordOf(isString)),
            [],
        );
        const pins = settings.getTitlePins();
        // The facade must only ever return validated own string entries.
        for (const [, title] of Object.entries(pins)) {
            expect(typeof title).toBe('string');
        }
        expect(pins['1']).toBe('Real');
        expect(Object.prototype.hasOwnProperty.call(pins, '__proto__')).toBe(false);
    });
});
