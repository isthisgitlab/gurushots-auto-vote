/**
 * Shared catch-path result for IPC handlers: `{ success: false, error }`.
 *
 * Handlers must never throw to the renderer, so the rejection value is
 * read null-safely — a callee that rejects with `null`/`undefined` (or a
 * message-less value) still yields a plain failure object carrying the
 * handler's fallback text.
 *
 * @param {unknown} error - The caught value (anything a promise can reject with).
 * @param {string} fallback - Message used when the caught value has no `message`.
 * @returns {{ success: false, error: string }}
 */
const errorResult = (error, fallback) => ({
    success: false,
    error: /** @type {{ message?: string } | null | undefined} */ (error)?.message || fallback,
});

module.exports = { errorResult };
