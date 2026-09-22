/**
 * Fills `{name}` placeholders in a translated string — t() has no
 * interpolation. Missing / null values render as an empty string.
 *
 * @param {string} str
 * @param {Record<string, unknown>} [vars]
 * @returns {string}
 */
export const interp = (str, vars) =>
    String(str).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
