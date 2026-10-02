import { errorMessage } from '../src/ts/errorMessage';

describe('errorMessage', () => {
    test.each<[string, unknown, string | undefined]>([
        ['an Error', new Error('boom'), 'boom'],
        ['a plain object with a message', { message: 'plain' }, 'plain'],
        ['an empty message', new Error(''), undefined],
        ['a non-string message', { message: 42 }, '42'],
        ['a falsy message', { message: 0 }, undefined],
        ['an object without a message', { code: 1 }, undefined],
        ['a string', 'text', undefined],
        ['null', null, undefined],
        ['undefined', undefined, undefined],
    ])('%s', (_label, error, expected) => {
        expect(errorMessage(error)).toBe(expected);
    });
});
