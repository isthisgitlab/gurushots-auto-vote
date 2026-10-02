/**
 * isIdArg is the runtime boundary check for challenge / image ids received
 * over IPC: a non-blank string within the id length cap or a finite number,
 * nothing else.
 */

import type * as isIdArgModule from '../../src/ts/ipc/isIdArg';

const { isIdArg, invalidArgs, MAX_IPC_ID_LENGTH } = require('../../src/ts/ipc/isIdArg') as typeof isIdArgModule;

describe('isIdArg', () => {
    test.each([
        ['a string id', '123'],
        ['a numeric id', 123],
        ['zero', 0],
        ['a string at the length cap', 'x'.repeat(MAX_IPC_ID_LENGTH)],
    ])('accepts %s', (_label, value) => {
        expect(isIdArg(value)).toBe(true);
    });

    test.each([
        ['an empty string', ''],
        ['a blank string', '   '],
        ['a string one over the length cap', 'x'.repeat(MAX_IPC_ID_LENGTH + 1)],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['an object', { id: 1 }],
        ['null', null],
        ['undefined', undefined],
    ])('rejects %s', (_label, value) => {
        expect(isIdArg(value)).toBe(false);
    });
});

describe('invalidArgs', () => {
    test('is the machine-coded failure result', () => {
        expect(invalidArgs).toEqual({ success: false, error: 'invalid-args' });
    });

    test('is immutable', () => {
        expect(Object.isFrozen(invalidArgs)).toBe(true);
    });
});
