/**
 * First-seen challenge-title pins on the settings facade.
 *
 * Covers getTitlePins (defensive copy, prototype-key safety) and
 * mergeTitlePins (first-seen-wins merge, removals, length/count caps).
 *
 * Drives the in-memory headless-store seam (same one title-tag-rules.test.js
 * uses) so the facade's loadSettings/saveSettings round-trip without touching fs.
 */

const settings = require('../../src/js/settings');

jest.mock('../../src/js/logger', () => ({
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
    let store;

    beforeEach(() => {
        globalThis.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        globalThis.AndroidHeadlessStore = store;
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
    });

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
        const before = store.write.mock.calls.length;
        expect(settings.mergeTitlePins({}, [])).toBe(true);
        expect(settings.mergeTitlePins(null, null)).toBe(true);
        expect(store.write.mock.calls.length).toBe(before);
    });

    test('getTitlePins returns a defensive copy', () => {
        settings.mergeTitlePins({ 1: 'Original' }, []);
        const pins = settings.getTitlePins();
        pins['1'] = 'mutated';
        pins['999'] = 'injected';
        expect(settings.getTitlePins()).toEqual({ 1: 'Original' });
    });

    test('stored titles are truncated to the 200-char cap', () => {
        settings.mergeTitlePins({ 1: 'x'.repeat(250) }, []);
        expect(settings.getTitlePins()).toEqual({ 1: 'x'.repeat(200) });
    });

    test('empty/whitespace/non-string titles are not stored', () => {
        settings.mergeTitlePins({ 1: '', 2: '   ', 3: 42, 4: 'Real' }, []);
        expect(settings.getTitlePins()).toEqual({ 4: 'Real' });
    });

    test('whitespace-only stored value (corrupted blob) is filtered on read', () => {
        settings.mergeTitlePins({ 1: 'Real' }, []);
        // Simulate external tampering: inject a whitespace-only pin directly
        // into the persisted blob, bypassing mergeTitlePins' validation.
        const blob = JSON.parse(store.value);
        blob.challengeSettings.titlePins['2'] = '   ';
        store.value = JSON.stringify(blob);

        expect(settings.getTitlePins()).toEqual({ 1: 'Real' });
    });

    test('entry count is capped at 500', () => {
        const adds = {};
        for (let i = 0; i < 510; i++) {
            adds[`id-${i}`] = `Title ${i}`;
        }
        settings.mergeTitlePins(adds, []);
        expect(Object.keys(settings.getTitlePins())).toHaveLength(500);
    });

    test('a prototype-named id never surfaces a non-string prototype member', () => {
        settings.mergeTitlePins({ __proto__: 'Proto Title', constructor: 'Ctor Title', 1: 'Real' }, []);
        const pins = settings.getTitlePins();
        // Object-literal `__proto__` keys don't become own properties, so the
        // facade must only ever return validated own string entries.
        for (const [, title] of Object.entries(pins)) {
            expect(typeof title).toBe('string');
        }
        expect(pins['1']).toBe('Real');
        expect(Object.prototype.hasOwnProperty.call(pins, '__proto__')).toBe(false);
    });
});
