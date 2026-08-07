const { validateSetting, getValidationError, SETTINGS_SCHEMA } = require('../../src/js/settings/schema');
const settings = require('../../src/js/settings');

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
        warning: jest.fn(),
    })),
}));

describe('scheduled fill schema validation', () => {
    test('all five keys exist, are per-challenge, and sit in the scheduledFill group', () => {
        const keys = [
            'useScheduledFill',
            'scheduledFillTime',
            'scheduledFillBeforeEnd',
            'scheduledFillWindowMinutes',
            'scheduledFillReplaces',
        ];
        for (const key of keys) {
            expect(SETTINGS_SCHEMA[key]).toBeDefined();
            expect(SETTINGS_SCHEMA[key].perChallenge).toBe(true);
            expect(SETTINGS_SCHEMA[key].group).toBe('scheduledFill');
        }
    });

    describe('scheduledFillTime', () => {
        test.each([[''], ['00:00'], ['09:05'], ['21:30'], ['23:59']])('accepts %p', (value) => {
            expect(validateSetting('scheduledFillTime', value)).toBe(true);
            expect(getValidationError('scheduledFillTime', value)).toBeNull();
        });

        test.each([['24:00'], ['9:5'], ['21:30:00'], ['25:99'], ['2130'], [' 21:30'], [null], [2130], [true], [{}]])(
            'rejects %p',
            (value) => {
                expect(validateSetting('scheduledFillTime', value)).toBe(false);
                expect(getValidationError('scheduledFillTime', value)).not.toBeNull();
            },
        );

        test('rejection message is actionable, not the generic fallback', () => {
            expect(getValidationError('scheduledFillTime', '24:00')).toBe('expected 24h HH:MM or empty');
        });
    });

    describe('scheduledFillBeforeEnd', () => {
        test.each([[0], [300], [5 * 3600], [30 * 24 * 3600]])('accepts %p seconds', (value) => {
            expect(validateSetting('scheduledFillBeforeEnd', value)).toBe(true);
        });

        test.each([[-1], [1.5], [30 * 24 * 3600 + 1], ['300'], [null], [NaN]])('rejects %p', (value) => {
            expect(validateSetting('scheduledFillBeforeEnd', value)).toBe(false);
        });
    });

    describe('scheduledFillWindowMinutes', () => {
        test.each([[5], [60], [720]])('accepts %p minutes', (value) => {
            expect(validateSetting('scheduledFillWindowMinutes', value)).toBe(true);
        });

        test.each([[4], [0], [721], [60.5], ['60'], [null]])('rejects %p', (value) => {
            expect(validateSetting('scheduledFillWindowMinutes', value)).toBe(false);
        });
    });

    describe('booleans', () => {
        test.each(['useScheduledFill', 'scheduledFillReplaces'])('%s accepts booleans only', (key) => {
            expect(validateSetting(key, true)).toBe(true);
            expect(validateSetting(key, false)).toBe(true);
            expect(validateSetting(key, 'true')).toBe(false);
            expect(validateSetting(key, 1)).toBe(false);
        });
    });
});

describe('scheduled fill override auto-clear (scalar keys payoff)', () => {
    // The settings facade clears an override that equals the global default via
    // strict equality — verify that works for the scheduled-fill keys, since
    // this was the reason the feature uses scalar keys instead of one object.
    // Drives the in-memory headless-store seam (same as challenge-profiles.test.js)
    // so loadSettings/saveSettings round-trip without touching fs.
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

    test('setting an override back to the schema default removes it', () => {
        expect(settings.setChallengeOverride('scheduledFillTime', '123', '21:30')).toBe(true);
        expect(settings.getChallengeOverride('scheduledFillTime', '123')).toBe('21:30');

        // '' equals the schema default → the override must clear, not persist.
        expect(settings.setChallengeOverride('scheduledFillTime', '123', '')).toBe(true);
        expect(settings.getChallengeOverride('scheduledFillTime', '123')).toBeNull();

        expect(settings.setChallengeOverride('scheduledFillWindowMinutes', '123', 30)).toBe(true);
        expect(settings.setChallengeOverride('scheduledFillWindowMinutes', '123', 60)).toBe(true);
        expect(settings.getChallengeOverride('scheduledFillWindowMinutes', '123')).toBeNull();
    });
});
