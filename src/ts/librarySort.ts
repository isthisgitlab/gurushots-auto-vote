/**
 * The library orders a picker read can ask the server for. Dependency-free so
 * the API layer, the IPC validation, the CLI and the mock all read from one
 * list.
 *
 * The live endpoint sorts with `order` + `sort` (captured 2026-10-24): votes
 * desc is what this app has always sent and stays the default, date desc/asc
 * are GuruShots' own Newest/Oldest. Any other `order` value the endpoint takes
 * (`views`, `likes`, `guru_pick`, `ratio`) — and any unknown one — silently
 * falls back to date desc there, so no name outside this list is ever sent.
 */

const LIBRARY_ORDERS = {
    votes: { order: 'votes', sort: 'desc' },
    newest: { order: 'date', sort: 'desc' },
    oldest: { order: 'date', sort: 'asc' },
} as const;

type LibraryOrder = keyof typeof LIBRARY_ORDERS;

/**
 * Whether a received value names a library order; a renderer or CLI can send
 * anything. `Object.hasOwn`, never `in`: 'toString' and '__proto__' are
 * inherited member names, not orders, and must not pass.
 */
const isLibraryOrder = (value: unknown): value is LibraryOrder =>
    typeof value === 'string' && Object.hasOwn(LIBRARY_ORDERS, value);

export { LIBRARY_ORDERS, isLibraryOrder };
export type { LibraryOrder };
