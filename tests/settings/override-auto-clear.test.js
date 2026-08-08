/**
 * Per-challenge override auto-clear for reference-typed settings.
 *
 * _applyChallengeOverride prunes an override that equals the effective global
 * default. That comparison was reference-equality, so array-typed settings
 * (mustIncludeTags/shouldIncludeTags) never matched their default and a
 * "set back to default" override was stored forever instead of cleared.
 * Now valuesEqual (content compare) drives the pruning; these tests assert
 * the observable boundary: getChallengeOverride / getEffectiveSetting no
 * longer report an override once the value matches the default again.
 *
 * Drives the in-memory headless-store seam (same as title-tag-rules.test.js)
 * so the facade's loadSettings/saveSettings round-trip without touching fs.
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

describe('settings facade — override auto-clear vs global default', () => {
    let store;
    const challengeId = '123456';

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

    describe('array-typed setting (mustIncludeTags, schema default [])', () => {
        it('stores an override that differs from the default', () => {
            expect(settings.setChallengeOverride('mustIncludeTags', challengeId, ['macro'])).toBe(true);
            expect(settings.getChallengeOverride('mustIncludeTags', challengeId)).toEqual(['macro']);
            expect(settings.getEffectiveSetting('mustIncludeTags', challengeId)).toEqual(['macro']);
        });

        it('clears the override when set back to a value equal to the default', () => {
            settings.setChallengeOverride('mustIncludeTags', challengeId, ['macro']);
            // A fresh [] is content-equal but not reference-equal to the
            // schema default — the exact case the old !== compare got wrong.
            expect(settings.setChallengeOverride('mustIncludeTags', challengeId, [])).toBe(true);
            expect(settings.getChallengeOverride('mustIncludeTags', challengeId)).toBeNull();
        });

        it('never stores an override equal to the default in the first place', () => {
            expect(settings.setChallengeOverride('mustIncludeTags', challengeId, [])).toBe(true);
            expect(settings.getChallengeOverride('mustIncludeTags', challengeId)).toBeNull();
        });

        it('clears against a user-modified global default, not just the schema default', () => {
            settings.setGlobalDefault('mustIncludeTags', ['street']);
            settings.setChallengeOverride('mustIncludeTags', challengeId, ['macro']);
            expect(settings.setChallengeOverride('mustIncludeTags', challengeId, ['street'])).toBe(true);
            expect(settings.getChallengeOverride('mustIncludeTags', challengeId)).toBeNull();
            expect(settings.getEffectiveSetting('mustIncludeTags', challengeId)).toEqual(['street']);
        });
    });

    describe('primitive setting keeps its existing behavior', () => {
        it('still sets and clears a numeric override (exposure)', () => {
            const defaultValue = settings.getGlobalDefault('exposure');
            expect(settings.setChallengeOverride('exposure', challengeId, defaultValue === 90 ? 80 : 90)).toBe(true);
            expect(settings.getChallengeOverride('exposure', challengeId)).not.toBeNull();
            expect(settings.setChallengeOverride('exposure', challengeId, defaultValue)).toBe(true);
            expect(settings.getChallengeOverride('exposure', challengeId)).toBeNull();
        });
    });
});
