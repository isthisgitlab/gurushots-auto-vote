/**
 * The one "is this a JSON object" check for untrusted data (parsed files,
 * drafts): a non-null object that is not an array. Dependency-free, so the
 * renderer can use it too.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export { isPlainObject };
