/**
 * The one "is this a JSON object" check for untrusted data (parsed files,
 * drafts): a non-null object that is not an array. Dependency-free, so the
 * renderer can use it too.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export { isPlainObject };
