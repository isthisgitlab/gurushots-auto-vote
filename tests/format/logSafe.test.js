/**
 * format/logSafe — failureText: the text a failure log line carries for any
 * caught value. It is never empty, because logger.endOperation treats empty
 * error text as a successful completion.
 */

const { failureText } = require('../../src/js/format/logSafe');

describe('failureText', () => {
    test.each([
        ['an Error with a message', new Error('offline'), 'offline'],
        ['an object with a non-string message', { message: 503 }, '503'],
        ['an Error without a message', new Error(''), 'Error'],
        ['a bare string', 'boom', 'boom'],
        ['null', null, 'unknown error'],
        ['undefined', undefined, 'unknown error'],
        ['an empty string', '', 'unknown error'],
    ])('%s → %p', (_label, error, expected) => {
        expect(failureText(error)).toBe(expected);
    });
});
