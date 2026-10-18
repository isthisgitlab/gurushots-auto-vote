import { isPlainObject } from '../../plainObject';

// The value with every object's keys in sorted order (arrays keep theirs), so equal content stringifies equally.
const withSortedKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withSortedKeys);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, withSortedKeys(value[key])]),
    );
};

/**
 * Structural equality for editor values (scalars, arrays, plain objects), compared as JSON. Object key order
 * deliberately does not matter (a value reset and set back keeps its content, not its key order); array order does.
 * settings/defaults.ts has its own comparison, which stays key-order-sensitive: the two are not to be re-synced.
 * Separate because the renderer must not import the settings facade.
 */
export const valuesEqual = (a: unknown, b: unknown): boolean =>
    JSON.stringify(withSortedKeys(a)) === JSON.stringify(withSortedKeys(b));
