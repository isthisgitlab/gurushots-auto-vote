/**
 * `value` when it is a finite number, else `fallback`. A caller holding an
 * optional number gets a number back without a cast (Number.isFinite does not
 * narrow). Dependency-free, so the renderer can use it too.
 */
const finiteOr = <F>(value: number | null | undefined, fallback: F): number | F =>
    value != null && Number.isFinite(value) ? value : fallback;

export { finiteOr };
