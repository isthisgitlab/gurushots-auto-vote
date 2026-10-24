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
 * The sorts a picker's toolbar can apply to the photos it has loaded. `library` is the server's
 * order above; the other three reorder what is loaded from the per-photo stats (`get-photo-stats`),
 * which no server sort exists for.
 */
const LOADED_SORTS = ['library', 'ratio', 'likes', 'guruPicks'] as const;

type LoadedSort = (typeof LOADED_SORTS)[number];

/**
 * Whether a received value names a library order; a renderer or CLI can send
 * anything. `Object.hasOwn`, never `in`: 'toString' and '__proto__' are
 * inherited member names, not orders, and must not pass.
 */
const isLibraryOrder = (value: unknown): value is LibraryOrder =>
    typeof value === 'string' && Object.hasOwn(LIBRARY_ORDERS, value);

/**
 * Whether a received value names a loaded-photo sort. A plain `includes` over
 * the fixed array is the same guard here: there is no key lookup to spoof, and
 * an inherited name like 'toString' is not an element of the list.
 */
const isLoadedSort = (value: unknown): value is LoadedSort =>
    typeof value === 'string' && (LOADED_SORTS as readonly string[]).includes(value);

export { LIBRARY_ORDERS, LOADED_SORTS, isLibraryOrder, isLoadedSort };
export type { LibraryOrder, LoadedSort };
