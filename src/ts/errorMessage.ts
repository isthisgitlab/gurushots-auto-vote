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

/**
 * `errorMessage` for a failed file operation, safe to log: Node quotes the paths in its messages (`open '/Users/…/x.json'`,
 * `rename '…' -> '…'`), and a path carries the user's home folder, so each path is cut to its file name. The quoted
 * part runs from the first quote to the last one, so an apostrophe inside a path (`C:\Users\O'Brien\x.json`) does not
 * end it.
 */
const fileErrorMessage = (error: unknown): string | undefined => {
    const text = errorMessage(error);
    const first = text?.indexOf("'") ?? -1;
    const last = text?.lastIndexOf("'") ?? -1;
    if (text === undefined || last <= first) return text;
    const paths = text
        .slice(first + 1, last)
        .split("' -> '")
        .map((path) =>
            /[\\/]/.test(path) ? path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) : path,
        );
    return `${text.slice(0, first)}'${paths.join("' -> '")}'${text.slice(last + 1)}`;
};

/**
 * What kind of error a caught value is (its `name`), for a log line that must not quote it: a JSON parse error's message
 * quotes the text it could not read, which can hold ids.
 */
const errorKind = (error: unknown): string => (error instanceof Error ? error.name : 'not an error');

export { errorKind, errorMessage, fileErrorMessage };
