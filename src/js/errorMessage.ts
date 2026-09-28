/**
 * The message a caught value carries, as text: its `message` when that is
 * truthy (a non-string one, e.g. an API's numeric code, is stringified),
 * otherwise undefined. A promise can reject with anything — an Error, a plain
 * object, a string, null — so read it through here rather than casting.
 * Dependency-free, so the renderer can use it too.
 */
const errorMessage = (error: unknown): string | undefined => {
    if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
    const { message } = error;
    return message ? String(message) : undefined;
};

export { errorMessage };
