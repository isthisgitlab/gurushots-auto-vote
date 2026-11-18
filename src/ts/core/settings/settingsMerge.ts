/**
 * Makes a settings change again on a settings document that another writer (the Android app window or its background
 * service) saved meanwhile: a three-way merge of the text the change was made on (`base`), the changed text (`ours`)
 * and what is stored now (`theirs`). Only what `ours` changed against `base` is applied, so a setting the other
 * writer changed is kept; where both changed one value, `ours` wins.
 *
 * `ours` is the configuration persistence writes: the stored values over the defaults, with the values a load rejects
 * replaced by their defaults. `base` and `theirs` are normalised the same way before they are compared, so a setting
 * that is absent from the stored text but filled by its default in `ours`, or a stored value the load replaced, is not
 * a change `ours` made.
 */

import { isPlainObject } from '../plainObject';
import { dropInvalidValues, mergeWithDefaults } from './loadValidation';

const own = (object: Record<string, unknown>, key: string): unknown =>
    Object.hasOwn(object, key) ? object[key] : undefined;

const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i]));
    if (isPlainObject(a) && isPlainObject(b)) {
        const keys = Object.keys(a);
        return (
            keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
        );
    }
    return false;
};

// The keys of three objects merged one by one, each by `decide(key)`; `undefined` is a value that is not there: a key that `ours`
// removed comes out undefined, and is left out.
const mergeKeys = (
    from: Record<string, unknown>,
    ours: Record<string, unknown>,
    theirs: Record<string, unknown>,
    decide: (key: string) => (base: unknown, ours: unknown, theirs: unknown) => unknown,
): Record<string, unknown> => {
    const entries: Array<[string, unknown]> = [];
    for (const key of new Set([...Object.keys(from), ...Object.keys(ours), ...Object.keys(theirs)])) {
        const value = decide(key)(own(from, key), own(ours, key), own(theirs, key));
        if (value !== undefined) entries.push([key, value]);
    }
    // fromEntries defines own properties, so a stored `__proto__` key stays data and never reaches the prototype.
    return Object.fromEntries(entries);
};

const merge = (base: unknown, ours: unknown, theirs: unknown): unknown => {
    if (equal(ours, base)) return theirs;
    if (equal(theirs, base)) return ours;
    if (!isPlainObject(ours) || !isPlainObject(theirs)) return ours;
    return mergeKeys(isPlainObject(base) ? base : {}, ours, theirs, () => merge);
};

// What one side changed against `base` wins; where both changed, `both` decides.
const leaf = (
    base: unknown,
    ours: unknown,
    theirs: unknown,
    both: (ours: unknown, theirs: unknown) => unknown,
): unknown => {
    if (equal(ours, base)) return theirs;
    if (equal(theirs, base)) return ours;
    return both(ours, theirs);
};

const generationOf = (value: unknown): number =>
    isPlainObject(value) && typeof value.generation === 'number' ? value.generation : -1;

// The installation assignment is one record with a fence: two changes are never mixed field by field, the later generation
// stands whole (a stale copy of it never overwrites a newer one).
const fencedAssignment = (ours: unknown, theirs: unknown): unknown =>
    generationOf(theirs) > generationOf(ours) ? theirs : ours;

// The collection's revision counts changes: two writers that both changed it made a change the other lacks, so the
// merged collection is a newer revision than either.
const advancedRevision = (ours: unknown, theirs: unknown): unknown =>
    typeof ours === 'number' && typeof theirs === 'number' && ours !== theirs ? Math.max(ours, theirs) + 1 : ours;

// The top-level members that are merged as units rather than field by field.
const UNITS: Record<string, (base: unknown, ours: unknown, theirs: unknown) => unknown> = {
    installationScenario: (base, ours, theirs) => leaf(base, ours, theirs, fencedAssignment),
    scenarioDefinitionsRevision: (base, ours, theirs) => leaf(base, ours, theirs, advancedRevision),
};

const mergeConfig = (
    base: Record<string, unknown>,
    ours: Record<string, unknown>,
    theirs: Record<string, unknown>,
): Record<string, unknown> => mergeKeys(base, ours, theirs, (key) => (Object.hasOwn(UNITS, key) ? UNITS[key] : merge));

// An absent text is no settings at all.
const parseObject = (text: string | null, what: string): Record<string, unknown> => {
    if (!text) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        // The parser's message can quote the text (the token among it): only the class of the failure is reported.
        throw new Error(`the ${what} settings are not valid JSON`);
    }
    if (!isPlainObject(parsed)) throw new Error(`the ${what} settings are not one JSON object`);
    return parsed;
};

// A stored config text as the load would have made of it: filled, without the values it rejects, as the text `ours`
// was made from.
const parseConfig = (text: string | null, what: string): Record<string, unknown> => {
    const config = mergeWithDefaults(parseObject(text, what));
    dropInvalidValues(config);
    return { ...config };
};

/**
 * The text of `ours` made on `theirs` (JSON, as persistence writes it); `ours` itself when nothing else was saved since
 * `base`.
 *
 * @param base - the text `ours` was made from (null: none was stored)
 * @param theirs - what is stored now (null: nothing is)
 * @throws when `base` or `theirs` is not one JSON object: what is stored is unreadable, and is not overwritten
 */
export const rebaseConfigText = (base: string | null, ours: string, theirs: string | null): string => {
    if (theirs === base) return ours;
    return JSON.stringify(
        mergeConfig(parseConfig(base, 'earlier'), parseObject(ours, 'new'), parseConfig(theirs, 'stored')),
        null,
        2,
    );
};
