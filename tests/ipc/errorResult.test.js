/**
 * errorResult is the shared catch-path envelope for IPC handlers. It must
 * read the caught value null-safely so a handler's catch block can never
 * itself throw to the renderer.
 */

const { errorResult } = require('../../src/js/ipc/errorResult');

describe('errorResult', () => {
    test.each([
        ['an Error with a message', new Error('boom'), 'boom'],
        ['an Error with an empty message', new Error(''), 'fallback'],
        ['null', null, 'fallback'],
        ['undefined', undefined, 'fallback'],
        ['a bare string', 'oops', 'fallback'],
    ])('maps %s to a failure envelope', (_label, error, expected) => {
        expect(errorResult(error, 'fallback')).toEqual({ success: false, error: expected });
    });
});
