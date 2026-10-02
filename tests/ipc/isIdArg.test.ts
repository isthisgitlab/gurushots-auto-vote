/**
 * isIdArg is the runtime boundary check for challenge / image ids received
 * over IPC: a non-blank string or a finite number, nothing else.
 */

import type * as isIdArgModule from '../../src/ts/ipc/isIdArg';

const { isIdArg } = require('../../src/ts/ipc/isIdArg') as typeof isIdArgModule;

describe('isIdArg', () => {
    test.each([
        ['a string id', '123'],
        ['a numeric id', 123],
        ['zero', 0],
    ])('accepts %s', (_label, value) => {
        expect(isIdArg(value)).toBe(true);
    });

    test.each([
        ['an empty string', ''],
        ['a blank string', '   '],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['an object', { id: 1 }],
        ['null', null],
        ['undefined', undefined],
    ])('rejects %s', (_label, value) => {
        expect(isIdArg(value)).toBe(false);
    });
});
