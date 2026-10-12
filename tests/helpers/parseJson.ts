import { isPlainObject } from '../../src/ts/plainObject';

/**
 * Parsed JSON in a test is `unknown` until a guard has checked it: `parseJson`
 * for a value a test only compares, `parseJsonObject` / `parseJsonAs` for one
 * it reads fields from. Guards are built from the combinators below, so a shape
 * a test reads is validated, never asserted with a cast.
 */
type Guard<T> = (value: unknown) => value is T;
type Shape<T> = { [K in keyof T]-?: Guard<T[K]> };

const isString: Guard<string> = (value): value is string => typeof value === 'string';
const isNumber: Guard<number> = (value): value is number => typeof value === 'number';
const isBoolean: Guard<boolean> = (value): value is boolean => typeof value === 'boolean';
const isUnknown: Guard<unknown> = (_value): _value is unknown => true;

const optional =
    <T>(guard: Guard<T>): Guard<T | undefined> =>
    (value): value is T | undefined =>
        value === undefined || guard(value);

const nullable =
    <T>(guard: Guard<T>): Guard<T | null> =>
    (value): value is T | null =>
        value === null || guard(value);

const isArrayOf =
    <T>(guard: Guard<T>): Guard<T[]> =>
    (value): value is T[] =>
        Array.isArray(value) && value.every(guard);

const isRecordOf =
    <T>(guard: Guard<T>): Guard<Record<string, T>> =>
    (value): value is Record<string, T> =>
        isPlainObject(value) && Object.values(value).every(guard);

/** An object whose listed keys each satisfy their guard; other keys are left alone. */
const isShape =
    <T extends object>(shape: Shape<T>): Guard<T> =>
    (value): value is T => {
        if (!isPlainObject(value)) return false;
        for (const key in shape) {
            if (!shape[key](value[key])) return false;
        }
        return true;
    };

const parseJson = (text: string): unknown => JSON.parse(text);

const parseJsonAs = <T>(text: string, guard: Guard<T>): T => {
    const parsed = parseJson(text);
    if (!guard(parsed)) throw new Error(`parsed JSON does not have the expected shape: ${text.slice(0, 200)}`);
    return parsed;
};

const parseJsonObject = (text: string): Record<string, unknown> => parseJsonAs(text, isPlainObject);

export {
    isArrayOf,
    isBoolean,
    isNumber,
    isRecordOf,
    isShape,
    isString,
    isUnknown,
    nullable,
    optional,
    parseJson,
    parseJsonAs,
    parseJsonObject,
};
export type { Guard };
