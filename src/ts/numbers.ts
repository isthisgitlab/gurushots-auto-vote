/**
 * `value` when it is a finite number, else `fallback`. A caller holding an
 * optional number gets a number back without a cast (Number.isFinite does not
 * narrow). Dependency-free, so the renderer can use it too.
 */
const finiteOr = <F>(value: number | null | undefined, fallback: F): number | F =>
    value != null && Number.isFinite(value) ? value : fallback;

/**
 * Number.isInteger as a type guard: the standard one does not narrow an
 * unknown value to number.
 */
const isInteger = (value: unknown): value is number => Number.isInteger(value);

export { finiteOr, isInteger };
