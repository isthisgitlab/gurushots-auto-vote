/**
 * Validation rules for the autoFillSchedule setting: an array of at most 3
 * strict { count, seconds } rows — count an integer 2..4 (unique across the
 * array; GuruShots challenges allow at most 4 images and entry 1 always
 * exists), seconds an integer 0..MAX_SCHEDULE_SECONDS (30 days). Mirrors the
 * tag-list-validation suite so the zod boundary itself is pinned, not just
 * the migration output that happens to pass it.
 */

const { validateSetting } = require('../../src/js/settings/schema');

const KEY = 'autoFillSchedule';
const MAX_SECONDS = 30 * 24 * 3600;

describe('autoFillSchedule schema validation', () => {
    test('empty array is valid (deliberate opt-out — auto-fill never submits)', () => {
        expect(validateSetting(KEY, [])).toBe(true);
    });

    test('the schema default shape is valid', () => {
        expect(
            validateSetting(KEY, [
                { count: 2, seconds: 1800 },
                { count: 3, seconds: 1200 },
                { count: 4, seconds: 600 },
            ]),
        ).toBe(true);
    });

    test('boundary values are valid (count 2 and 4, seconds 0 and the 30-day cap)', () => {
        expect(
            validateSetting(KEY, [
                { count: 2, seconds: 0 },
                { count: 4, seconds: MAX_SECONDS },
            ]),
        ).toBe(true);
    });

    test('non-array is invalid', () => {
        expect(validateSetting(KEY, 'schedule')).toBe(false);
        expect(validateSetting(KEY, null)).toBe(false);
        expect(validateSetting(KEY, { count: 2, seconds: 600 })).toBe(false);
    });

    test('duplicate counts are invalid', () => {
        expect(
            validateSetting(KEY, [
                { count: 2, seconds: 1800 },
                { count: 2, seconds: 600 },
            ]),
        ).toBe(false);
    });

    test('count below 2 or above 4 is invalid', () => {
        expect(validateSetting(KEY, [{ count: 1, seconds: 600 }])).toBe(false);
        expect(validateSetting(KEY, [{ count: 0, seconds: 600 }])).toBe(false);
        expect(validateSetting(KEY, [{ count: 5, seconds: 600 }])).toBe(false);
        expect(validateSetting(KEY, [{ count: 21, seconds: 600 }])).toBe(false);
    });

    test('non-integer count or seconds is invalid', () => {
        expect(validateSetting(KEY, [{ count: 2.5, seconds: 600 }])).toBe(false);
        expect(validateSetting(KEY, [{ count: 2, seconds: 600.5 }])).toBe(false);
    });

    test('negative seconds or seconds beyond the 30-day cap are invalid', () => {
        expect(validateSetting(KEY, [{ count: 2, seconds: -1 }])).toBe(false);
        expect(validateSetting(KEY, [{ count: 2, seconds: MAX_SECONDS + 1 }])).toBe(false);
    });

    test('rows missing a field or with non-numeric fields are invalid', () => {
        expect(validateSetting(KEY, [{ count: 2 }])).toBe(false);
        expect(validateSetting(KEY, [{ seconds: 600 }])).toBe(false);
        expect(validateSetting(KEY, [{ count: '2', seconds: 600 }])).toBe(false);
        expect(validateSetting(KEY, [null])).toBe(false);
    });

    test('extra keys on a row are rejected (.strict() fails closed)', () => {
        expect(validateSetting(KEY, [{ count: 2, seconds: 600, extra: true }])).toBe(false);
        expect(validateSetting(KEY, [{ count: 2, seconds: 600, __proto__constructor: 1 }])).toBe(false);
    });

    test('more than 3 rows is invalid', () => {
        // Four rows necessarily exceed the row cap (only counts 2..4 exist);
        // this pins the .max(3) bound alongside the unique-count refinement.
        const rows = [
            { count: 2, seconds: 100 },
            { count: 3, seconds: 200 },
            { count: 4, seconds: 300 },
            { count: 4, seconds: 400 },
        ];
        expect(validateSetting(KEY, rows)).toBe(false);
    });
});
