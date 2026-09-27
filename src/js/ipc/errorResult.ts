/**
 * Shared catch-path result for IPC handlers: `{ success: false, error }`.
 *
 * Handlers must never throw to the renderer, so the rejection value is
 * read null-safely — a callee that rejects with `null`/`undefined` (or a
 * message-less value) still yields a plain failure object carrying the
 * handler's fallback text.
 *
 * @param error - The caught value (anything a promise can reject with).
 * @param fallback - Message used when the caught value has no `message`.
 */
const errorResult = (error: unknown, fallback: string): { success: false; error: string } => ({
    success: false,
    error: (error as { message?: string } | null | undefined)?.message || fallback,
});

export { errorResult };
