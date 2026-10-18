/**
 * Structural equality for editor values (scalars, arrays, plain objects), compared as JSON, so object key order
 * matters: compare a value only with one cloned from the same source. The renderer's copy of the comparison
 * settings/defaults.ts uses, because the renderer must not import the settings facade.
 */
export const valuesEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
