/**
 * Validation rules for the tag-list settings (mustIncludeTags,
 * shouldIncludeTags). The schema accepts arrays of non-empty,
 * non-whitespace, length-capped strings up to a max array size.
 */

const { validateSetting } = require('../../src/js/settings/schema');

describe('tag-list schema validation', () => {
    describe('mustIncludeTags', () => {
        test('empty array is valid (the default — means "no filter")', () => {
            expect(validateSetting('mustIncludeTags', [])).toBe(true);
        });

        test('array of non-empty strings is valid', () => {
            expect(validateSetting('mustIncludeTags', ['sunset', 'beach'])).toBe(true);
        });

        test('non-array is invalid', () => {
            expect(validateSetting('mustIncludeTags', 'sunset')).toBe(false);
            expect(validateSetting('mustIncludeTags', null)).toBe(false);
            expect(validateSetting('mustIncludeTags', { tag: 'sunset' })).toBe(false);
        });

        test('array with non-string entry is invalid', () => {
            expect(validateSetting('mustIncludeTags', ['sunset', 42])).toBe(false);
            expect(validateSetting('mustIncludeTags', [null])).toBe(false);
        });

        test('empty string entries are invalid', () => {
            expect(validateSetting('mustIncludeTags', [''])).toBe(false);
            expect(validateSetting('mustIncludeTags', ['sunset', ''])).toBe(false);
        });

        test('whitespace-only entries are invalid (no silent no-op filters)', () => {
            expect(validateSetting('mustIncludeTags', ['   '])).toBe(false);
            expect(validateSetting('mustIncludeTags', ['\t'])).toBe(false);
        });

        test('strings longer than 50 chars are invalid', () => {
            const longTag = 'a'.repeat(51);
            expect(validateSetting('mustIncludeTags', [longTag])).toBe(false);
            // 50 chars exactly is the boundary.
            expect(validateSetting('mustIncludeTags', ['a'.repeat(50)])).toBe(true);
        });

        test('arrays larger than 50 entries are invalid', () => {
            const tags51 = Array.from({ length: 51 }, (_, i) => `tag${i}`);
            const tags50 = Array.from({ length: 50 }, (_, i) => `tag${i}`);
            expect(validateSetting('mustIncludeTags', tags51)).toBe(false);
            expect(validateSetting('mustIncludeTags', tags50)).toBe(true);
        });
    });

    describe('shouldIncludeTags', () => {
        test('uses the same validator as mustIncludeTags', () => {
            // Just spot-check; full coverage above is sufficient.
            expect(validateSetting('shouldIncludeTags', [])).toBe(true);
            expect(validateSetting('shouldIncludeTags', ['sunset'])).toBe(true);
            expect(validateSetting('shouldIncludeTags', [''])).toBe(false);
            expect(validateSetting('shouldIncludeTags', ['   '])).toBe(false);
            expect(validateSetting('shouldIncludeTags', null)).toBe(false);
        });
    });

    describe('fillWithoutTagMatch', () => {
        test('accepts booleans, rejects everything else', () => {
            expect(validateSetting('fillWithoutTagMatch', true)).toBe(true);
            expect(validateSetting('fillWithoutTagMatch', false)).toBe(true);
            expect(validateSetting('fillWithoutTagMatch', 'true')).toBe(false);
            expect(validateSetting('fillWithoutTagMatch', 1)).toBe(false);
            expect(validateSetting('fillWithoutTagMatch', null)).toBe(false);
        });
    });
});
