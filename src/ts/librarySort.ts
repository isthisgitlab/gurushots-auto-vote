/**
 * The library orders a picker read can ask the server for. Dependency-free so
 * the API layer, the IPC validation, the CLI and the mock all read from one
 * list.
 *
 * The live endpoint takes `order` + `sort`, but the pair cannot be relied on
 * without a search, so the date orders are enforced on the answers client-side
 * (`orderByUploadDate` below). Votes desc is what this app has always sent and
 * stays the default. Any other `order` value the endpoint takes (`views`,
 * `likes`, `guru_pick`, `ratio`) — and any unknown one — silently falls back
 * to date desc there, so no name outside this list is ever sent.
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

/**
 * The date orders enforced on what a read returned: the endpoint's `order`+`sort` pair cannot be
 * relied on without a search, so a read's photos are ordered here — per answer in the handler
 * (`ipc/actions/library.ts`), across the loaded batches in the grid (`PhotoGrid.tsx`). The
 * `'votes'` arm returns the input array itself; the date arms return a copy. A photo without an
 * upload date sorts last in both directions, and ties keep the order the server sent
 * (Array.prototype.sort is stable).
 */
const orderByUploadDate = <P extends { uploadDate: number | null }>(photos: P[], order: LibraryOrder): P[] => {
    if (order !== 'newest' && order !== 'oldest') return photos;
    const direction = order === 'newest' ? -1 : 1;
    return [...photos].sort((a, b) => {
        if (a.uploadDate === null) return b.uploadDate === null ? 0 : 1;
        if (b.uploadDate === null) return -1;
        return direction * (a.uploadDate - b.uploadDate);
    });
};

export { LIBRARY_ORDERS, LOADED_SORTS, isLibraryOrder, isLoadedSort, orderByUploadDate };
export type { LibraryOrder, LoadedSort };
