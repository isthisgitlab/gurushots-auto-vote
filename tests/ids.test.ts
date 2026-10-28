/**
 * ids.ts — the one id rule shared by the active-challenge boundary
 * (challengeIntegrity) and the IPC id check (ipc/isIdArg).
 */

import type * as idsModule from '../src/ts/ids';

const { isValidId } = require('../src/ts/ids') as typeof idsModule;

describe('isValidId', () => {
    test.each([
        ['a positive safe integer', 1],
        ['a large safe integer', 2 ** 53 - 1],
        ['a numeric string', '135938'],
        ['a letter-leading token', 'entry_001'],
        ['a token with dashes and dots-cap', 'a-_9'],
        ['a 64-character token', 'x'.repeat(64)],
        ['a single letter', 'a'],
    ])('accepts %s', (_label, value) => {
        expect(isValidId(value)).toBe(true);
        // The guard narrows exactly to the id types.
        if (isValidId(value)) expect(['string', 'number']).toContain(typeof value);
    });

    test.each([
        ['zero', 0],
        ['a negative integer', -5],
        ['a fraction', 2.5],
        ['an unsafe integer', 2 ** 53],
        ['a non-finite number', Infinity],
        ['NaN', NaN],
        ['the string zero', '0'],
        ['a string of zeros', '000'],
        ['a leading dash', '-1'],
        ['a lone dash', '-'],
        ['a lone underscore', '_'],
        ['a leading underscore (prototype-poisoning key)', '__proto__'],
        ['a leading @ (the scenario ALL_KEY)', '@all'],
        ['surrounding spaces', ' 12 '],
        ['an empty string', ''],
        ['the reserved words', 'null'],
        ['undefined as a string', 'undefined'],
        ['constructor as a string', 'constructor'],
        ['prototype as a string', 'prototype'],
        ['a boolean', true],
        ['null', null],
        ['undefined', undefined],
        ['an object', { id: 1 }],
        ['an array', ['1']],
    ])('rejects %s', (_label, value) => {
        expect(isValidId(value)).toBe(false);
    });
});
