const { validateSetting, getValidationError, SETTINGS_SCHEMA, MAX_SCHEDULED_FILL_ENTRIES } =
    require('../../src/ts/settings/schema') as typeof schemaModule;
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import settings = require('../../src/ts/settings');
import type * as schemaModule from '../../src/ts/settings/schema';

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
        ] as const;
        for (const key of keys) {
            expect(SETTINGS_SCHEMA[key]).toBeDefined();
            expect(SETTINGS_SCHEMA[key].perChallenge).toBe(true);
            expect(SETTINGS_SCHEMA[key].group).toBe('scheduledFill');
        }
    });

    test('both trigger keys default to the empty list (off)', () => {
        expect(SETTINGS_SCHEMA.scheduledFillTime.default).toEqual([]);
        expect(SETTINGS_SCHEMA.scheduledFillBeforeEnd.default).toEqual([]);
    });

    describe('scheduledFillTime (list of daily HH:MM times)', () => {
        test.each([[[]], [['00:00']], [['09:05', '21:30']], [['23:59', '00:00', '12:00']]])('accepts %p', (value) => {
            expect(validateSetting('scheduledFillTime', value)).toBe(true);
            expect(getValidationError('scheduledFillTime', value)).toBeNull();
        });

        test('accepts entries in any order (CLI users paste JSON)', () => {
            expect(validateSetting('scheduledFillTime', ['21:30', '09:00'])).toBe(true);
        });

        test.each([[['24:00']], [['9:5']], [['21:30', '25:99']], [['']], [[2130]], [[null]]])(
            'rejects a list with a bad entry %p',
            (value) => {
                expect(validateSetting('scheduledFillTime', value)).toBe(false);
                expect(getValidationError('scheduledFillTime', value)).not.toBeNull();
            },
        );

        test.each([['21:30'], [null], [2130], [true], [{}]])('rejects the non-array value %p', (value) => {
            expect(validateSetting('scheduledFillTime', value)).toBe(false);
        });

        test('rejects duplicates with an actionable message', () => {
            expect(validateSetting('scheduledFillTime', ['21:30', '21:30'])).toBe(false);
            expect(getValidationError('scheduledFillTime', ['21:30', '21:30'])).toBe('duplicate times');
        });

        test('rejects more than the entry cap with an actionable message', () => {
            const over = Array.from({ length: MAX_SCHEDULED_FILL_ENTRIES + 1 }, (_, i) => `0${i}:00`.slice(-5));
            expect(validateSetting('scheduledFillTime', over)).toBe(false);
            expect(getValidationError('scheduledFillTime', over)).toBe(`at most ${MAX_SCHEDULED_FILL_ENTRIES} times`);
        });

        test('entry-level rejection message is actionable, not the generic fallback', () => {
            expect(getValidationError('scheduledFillTime', ['24:00'])).toBe('expected 24h HH:MM');
        });
    });

    describe('scheduledFillBeforeEnd (list of seconds offsets)', () => {
        test.each([[[]], [[300]], [[14400, 36000]], [[1, 30 * 24 * 3600]]])('accepts %p', (value) => {
            expect(validateSetting('scheduledFillBeforeEnd', value)).toBe(true);
        });

        test.each([[[0]], [[-1]], [[1.5]], [[30 * 24 * 3600 + 1]], [['300']], [[null]], [[NaN]]])(
            'rejects a list with a bad entry %p',
            (value) => {
                expect(validateSetting('scheduledFillBeforeEnd', value)).toBe(false);
            },
        );

        test.each([[300], [null], ['300'], [{}]])('rejects the non-array value %p', (value) => {
            expect(validateSetting('scheduledFillBeforeEnd', value)).toBe(false);
        });

        test('rejects duplicates and over-cap lists', () => {
            expect(validateSetting('scheduledFillBeforeEnd', [300, 300])).toBe(false);
            const over = Array.from({ length: MAX_SCHEDULED_FILL_ENTRIES + 1 }, (_, i) => (i + 1) * 60);
            expect(validateSetting('scheduledFillBeforeEnd', over)).toBe(false);
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

describe('scheduled fill override auto-clear', () => {
    // Scalars auto-clear by strict equality; arrays clear via valuesEqual's
    // JSON.stringify comparison, which is ORDER SENSITIVE — an override equal
    // to the default but reordered does not auto-clear (same accepted caveat
    // as autoSubmitSchedule; the UI emits canonical order, making it
    // nearly unobservable). Drives the in-memory headless-store seam.

    beforeEach(() => {
        installHeadlessStore();
    });

    afterEach(() => {
        removeHeadlessStore();
    });

    test('setting an override back to the [] default removes it', () => {
        expect(settings.setChallengeOverride('scheduledFillTime', '123', ['21:30'])).toBe(true);
        expect(settings.getChallengeOverride('scheduledFillTime', '123')).toEqual(['21:30']);

        expect(settings.setChallengeOverride('scheduledFillTime', '123', [])).toBe(true);
        expect(settings.getChallengeOverride('scheduledFillTime', '123')).toBeNull();

        expect(settings.setChallengeOverride('scheduledFillWindowMinutes', '123', 30)).toBe(true);
        expect(settings.setChallengeOverride('scheduledFillWindowMinutes', '123', 60)).toBe(true);
        expect(settings.getChallengeOverride('scheduledFillWindowMinutes', '123')).toBeNull();
    });

    test('order-sensitivity caveat: a reordered default-equal override persists (documented behavior)', () => {
        expect(settings.setGlobalDefault('scheduledFillTime', ['09:00', '21:30'])).toBe(true);
        // Same set, different order — valuesEqual (JSON.stringify) sees a
        // difference, so this is stored as an override rather than cleared.
        expect(settings.setChallengeOverride('scheduledFillTime', '123', ['21:30', '09:00'])).toBe(true);
        expect(settings.getChallengeOverride('scheduledFillTime', '123')).toEqual(['21:30', '09:00']);
    });
});
