/**
 * What a rejected setting value may put in a log line: a photo list is counted wherever it sits in the value, credentials
 * are redacted, and any other value is logged as it came.
 */

import { loggableSettingValue } from '../../src/ts/settings/logValue';

describe('loggableSettingValue', () => {
    test('counts a photo list, never lists it', () => {
        expect(loggableSettingValue('chosenPhotos', ['img_a', 'img_b'])).toBe('2 photo(s)');
    });

    test('counts a photo list that sits inside a malformed value', () => {
        const logged = loggableSettingValue('chosenPhotos', { wrapped: { chosenPhotos: ['img_a', 'img_b', 'img_c'] } });

        expect(logged).toEqual({ wrapped: { chosenPhotos: '3 photo(s)' } });
        expect(JSON.stringify(logged)).not.toContain('img_');
    });

    test('redacts a credential nested in a value', () => {
        expect(loggableSettingValue('theme', { token: 'secret', note: 'x' })).toEqual({
            token: '[REDACTED]',
            note: 'x',
        });
    });

    test.each([['dark'], [42], [true], [null], [['a', 'b']]])('returns %j as it came', (value) => {
        expect(loggableSettingValue('theme', value)).toEqual(value);
    });
});
