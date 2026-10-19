import { valuesEqual } from '@/utils/valuesEqual';

describe('valuesEqual', () => {
    test('compares scalars, arrays and objects by content', () => {
        expect(valuesEqual(1, 1)).toBe(true);
        expect(valuesEqual(1, '1')).toBe(false);
        expect(valuesEqual(null, undefined)).toBe(false);
        expect(valuesEqual([1, { a: 2 }], [1, { a: 2 }])).toBe(true);
        expect(valuesEqual([1, 2], [2, 1])).toBe(false);
    });

    test('ignores object key order at every depth, but not array order', () => {
        expect(valuesEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
        expect(valuesEqual([{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).toBe(true);
        expect(valuesEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
        expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });
});
