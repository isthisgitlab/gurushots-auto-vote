/**
 * Fills `{name}` placeholders in a translated string — t() has no
 * interpolation. Missing / null values render as an empty string.
 */
export const interp = (str: string, vars?: Record<string, unknown>): string =>
    str.replace(/\{(\w+)\}/g, (_: string, k: string) => (vars && vars[k] != null ? String(vars[k]) : ''));
