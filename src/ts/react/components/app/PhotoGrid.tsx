import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { BusyContent, InlineLoader } from '@/components/ui/LoadingSpinner';
import { interp } from '@/utils/interp';
import { ipcErrorText } from '@/api/ipcErrorText';
import { reorderLoadedPhotos } from '@/utils/loadedPhotoSort';
import { ListingHeader } from './ListingHeader';
import { MissingTile, PendingTile, PhotoTile, SavedPickTile } from './PhotoTile';
import { MAX_CHOSEN_PHOTOS } from '../../../settings/limits';

import type { FocusEvent, ReactNode } from 'react';
import type { LoadedSort } from '../../../librarySort';
import type { TileStats } from '@/hooks/usePhotoStatsLoader';
import type { LibraryPhoto, ListState } from '@/hooks/useLibraryListing';

const TILE_GRID = 'grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4';

/**
 * The library listing with its states: idle (the not-loaded line, the saved picks as stubs, plus the
 * tiles Auto named that were picked in this opening),
 * loading, an error with Retry, the missing-challenge explanation, and the tiles (the picks the
 * listing does not return pinned first, the rest in the library's order). The defaults are the
 * Chosen Photos list's: numbered, capped at MAX_CHOSEN_PHOTOS.
 *
 * A grid read for a challenge leaves out the photos that challenge refuses once the listing says which it
 * accepts, and counts them in a line of their own. A photo is shown anyway when it is picked (a pick that a later
 * read marks refused keeps its tile and its reason) or when the caller lists it as blocked (it is shown blocked,
 * not counted). The submit modal prunes a refused pick only after a Refresh or a refused submit — not after
 * Load photos or Search.
 *
 * A preview (the library as last loaded, its marks withheld) is never rendered where the grid is read for a
 * challenge: it is another challenge's listing or a distrusted cached one, so its tiles would offer unmarked
 * photos for picking that the fresh read behind it then collapses. The grid holds the loader in its place, as
 * while the read itself is on its way; a re-check that fails lands in the error state (useLibraryListing's
 * load), so a grid with a challenge never waits on a preview that will not resolve.
 *
 * A cut-off listing carries Load more under its tiles: it reads the next batch and appends it, held while any
 * read is in flight, with the failure of the last press in an alert of its own. Every non-preview listing says
 * how many photos are shown in the live status line, so each appended batch is announced; an empty one puts
 * its empty-listing text there instead, so nothing is announced twice.
 */
export function PhotoGrid({
    state,
    known,
    selected,
    locked,
    lockedKey = 'app.photoChooserTileLocked',
    hasChallenge,
    search,
    revalidating,
    recheckFailed,
    submit = false,
    refreshDisabled = false,
    loadMore,
    loadingMore,
    loadMoreFailed,
    blockedIds,
    blockedKey = 'app.photoChooserNotEligible',
    onToggle,
    onRetry,
    onRefresh,
    max = MAX_CHOSEN_PHOTOS,
    fullKey = 'app.photoChooserListFull',
    numbered = true,
    extraPhotos,
    idleMemberId = null,
    idleIds,
    idleKey = 'app.pickIdle',
    idleWithPicksKey = 'app.pickIdleWithPicks',
    savedPicks = null,
    keepIds,
    recommendedIds,
    tileSlot,
    stats,
    sortStats,
    sortBy,
    showStats,
    onTileIds,
}: {
    state: ListState;
    known: Map<string, LibraryPhoto>;
    selected: string[];
    /** The tiles are inert (the submit modal holds picking while it works). */
    locked: boolean;
    /** The translation key of what a locked tile says. */
    lockedKey?: string;
    /** The listing is read for a challenge (and says which photos it accepts), not for the library alone. */
    hasChallenge: boolean;
    /** The listing on screen came from a search: tiles say only what a search can know about a missing pick. */
    search: boolean;
    /** The library is being read again (a preview's re-check, or a Refresh). */
    revalidating: boolean;
    /** The last re-read failed, so what is shown is the library as last loaded. */
    recheckFailed: boolean;
    /** The grid is the submit modal's: its re-check-failed line says picking is held. */
    submit?: boolean;
    /** Refresh cannot be pressed now (a submit is running). */
    refreshDisabled?: boolean;
    /** Reads the batch after the listing on screen and appends it. */
    loadMore: () => void;
    /** The batch read is on its way: Load more is held, and so are the toolbar's Load photos and Refresh. */
    loadingMore: boolean;
    /** Why the last Load more failed (an error code, or `'failed'`); null when it did not. */
    loadMoreFailed: string | null;
    /** Photos the caller already knows cannot be picked (the listing does not say), shown blocked. */
    blockedIds?: ReadonlySet<string>;
    /** The translation key of what a tile in `blockedIds` says. */
    blockedKey?: string;
    onToggle: (id: string) => void;
    onRetry: () => void;
    onRefresh: () => void;
    /** How many photos may be selected: the rest are offered no more. */
    max?: number;
    /** The translation key of what a tile says when the selection is full. */
    fullKey?: string;
    /** Selected tiles show their position (a list's order); off for a plain set. */
    numbered?: boolean;
    /** Records of photos the listing may not return (the suggestions), looked up after it for a selected id. */
    extraPhotos?: ReadonlyMap<string, LibraryPhoto>;
    /** The member that owns the `extraPhotos`: with no listing read yet, the selected tiles take it for their thumbnails. */
    idleMemberId?: string | null;
    /** The ids the idle grid shows, in place whether picked or not (default: the selected ones). */
    idleIds?: string[];
    /** The translation key of the idle line shown while nothing is read. */
    idleKey?: string;
    /** The translation key of the idle line shown while something is picked. */
    idleWithPicksKey?: string;
    /** The saved picks may show as stubs (nothing is read), with this member for their thumbnails. */
    savedPicks?: { memberId: string | null } | null;
    /** Photos the grid keeps showing, with their reason, whatever the listing says (a pick taken back during it). */
    keepIds?: ReadonlySet<string>;
    /** The photos GuruShots suggests for the challenge; their tiles carry the recommended mark. */
    recommendedIds?: ReadonlyArray<string>;
    /**
     * Rendered under a selected tile, inside its grid cell (the chooser's pin toggles); the function decides
     * which tiles get content. Absent, the tile is the grid cell as before (the submit modal).
     */
    tileSlot?: (id: string) => ReactNode;
    /** The stats the Show-stats loader has read, by photo id: a full tile's line and label come from here. */
    stats?: ReadonlyMap<string, TileStats>;
    /** The snapshot the loaded-photo sort goes by, so answers landing mid-run cannot move the tiles. */
    sortStats?: ReadonlyMap<string, TileStats>;
    /** The loaded-photo sort the toolbar selected (default `library`: the listing's own order). */
    sortBy?: LoadedSort;
    /** Show stats is on: full tiles carry their ratio, likes and Guru picks. */
    showStats?: boolean;
    /** Reports the ids the grid renders as full photo tiles, for the picker's stats loader. */
    onTileIds?: (ids: string[]) => void;
}) {
    const { t } = useTranslation();
    const recommended = new Set(recommendedIds ?? []);
    // Every won id this chooser has been told of: a search that no longer lists a chosen photo still knows it has won.
    const everWon = useRef(new Set<string>());
    // The element that last had the keyboard focus, and the hidden-count line an element the fresh read
    // hides hands it to.
    const lastFocusedTile = useRef<Element | null>(null);
    const hiddenLineRef = useRef<HTMLDivElement>(null);
    // The ids of the full photo tiles the last render made, and the set they were last reported
    // under: the stats loader asks for them (see onTileIds).
    const tileIds: string[] = [];
    const reportedTileIds = useRef<string | null>(null);
    // Load more waits while any read is in flight: its own batch, or a re-read of the listing on screen (a
    // read that takes the listing down shows the loader, and the button is gone with it).
    const loadMoreHeld = loadingMore || revalidating;
    // A tile with the caller's slot under it (the pin toggles name the photo, so they sit with their tile), both in
    // one grid cell. Without a slot the tile is the cell, as before.
    const cell = (id: string, tileEl: ReactNode): ReactNode =>
        tileSlot ? (
            <div key={id} className="flex flex-col gap-1">
                {tileEl}
                {tileSlot(id)}
            </div>
        ) : (
            tileEl
        );
    // An element that leaves the page takes the focus to <body>: when that was one of this grid's (a tile,
    // or the Load more button its final batch took away) and the user had not moved the focus off it (see
    // onBlurCapture), the focus goes to the status line (if it is shown) instead of being lost.
    useLayoutEffect(() => {
        const last = lastFocusedTile.current;
        if (last === null || last.isConnected) return;
        lastFocusedTile.current = null;
        hiddenLineRef.current?.focus();
    });
    // The focus hand-off, shared by the tiles and the Load more button, in the idle and the ready grid: an
    // element that leaves the page takes the focus to <body>, so when that was one of this grid's and the
    // user had not moved the focus off it (see onBlurCapture), the focus goes to the status line (if it is
    // shown) instead of being lost.
    const keepFocus = {
        onFocusCapture: () => {
            // The focus event's target is typed as a bare EventTarget; the focused element is the same node.
            lastFocusedTile.current = document.activeElement;
        },
        onBlurCapture: (event: FocusEvent<HTMLElement>) => {
            // The focus moving to another element of the grid keeps the hand-off. Moving anywhere else ends it, if
            // the user did it: an element that was removed (a browser may report a blur for it) keeps the hand-off.
            const next = event.relatedTarget;
            if (next instanceof Node && event.currentTarget.contains(next)) return;
            queueMicrotask(() => {
                if (lastFocusedTile.current?.isConnected) lastFocusedTile.current = null;
            });
        },
    };
    const render = (): { status: ReactNode; body: ReactNode } => {
        if (state.status === 'idle') {
            // Nothing is read yet: the saved picks show as numbered stubs, and the
            // photos Auto named keep their tiles from the records it brought, so a pick never goes invisible. An
            // unpicked one keeps its place, so it can be picked again.
            const chosenIdle = new Set(selected);
            const shownIdleIds = idleIds ?? selected;
            const numberOf = new Map(selected.map((id, index) => [id, index + 1]));
            const position = (id: string): number | null => (numbered ? (numberOf.get(id) ?? null) : null);
            const atCap = selected.length >= max;
            const tiles = shownIdleIds.map((id) => {
                const record = extraPhotos?.get(id);
                if (record) {
                    tileIds.push(id);
                    return cell(
                        id,
                        <PhotoTile
                            key={id}
                            photo={record}
                            memberId={idleMemberId}
                            selected={chosenIdle.has(id)}
                            position={position(id)}
                            recommended={recommended.has(id)}
                            blockedReason={null}
                            atCap={atCap}
                            fullKey={fullKey}
                            allowedKnown={false}
                            locked={locked}
                            lockedKey={lockedKey}
                            onToggle={onToggle}
                            stats={stats?.get(id) ?? null}
                            showStats={showStats === true}
                        />,
                    );
                }
                if (!savedPicks) return null;
                return cell(
                    id,
                    <SavedPickTile
                        key={id}
                        id={id}
                        memberId={savedPicks.memberId}
                        selected={chosenIdle.has(id)}
                        position={position(id)}
                        atCap={atCap}
                        fullKey={fullKey}
                        locked={locked}
                        lockedKey={lockedKey}
                        onToggle={onToggle}
                    />,
                );
            });
            return {
                status: null,
                body: (
                    <>
                        <p className="text-base-content/70 text-sm" role="status">
                            {t(selected.length > 0 ? idleWithPicksKey : idleKey)}
                        </p>
                        {tiles.some((tile) => tile !== null) && (
                            <div className={TILE_GRID} {...keepFocus}>
                                {tiles}
                            </div>
                        )}
                    </>
                ),
            };
        }
        if (state.status === 'loading')
            return { status: null, body: <InlineLoader text={t('app.photoChooserLoading')} /> };
        if (state.status === 'ready' && state.listing.preview && hasChallenge) {
            // The loader holds a challenge-bound preview's place (see the file doc): the hook runs, and fails,
            // that re-check by the same challenge id this `hasChallenge` comes from.
            return { status: null, body: <InlineLoader text={t('app.photoChooserLoading')} /> };
        }
        if (state.status === 'no-context') {
            return {
                status: null,
                body: (
                    <div role="alert" className="alert alert-warning py-2 text-sm">
                        <span>{t('app.photoChooserNoContext')}</span>
                    </div>
                ),
            };
        }
        if (state.status === 'error') {
            return {
                status: null,
                body: (
                    <div role="alert" className="alert alert-error py-2 text-sm">
                        <div className="flex-1">
                            <p>{t(state.error ? 'app.photoChooserLoadError' : 'app.photoChooserLoadErrorNoDetail')}</p>
                            {state.error && <p className="text-xs">{ipcErrorText(state.error, t)}</p>}
                        </div>
                        <button type="button" className="btn btn-sm" onClick={onRetry}>
                            {t('app.photoChooserRetry')}
                        </button>
                    </div>
                ),
            };
        }
        const { listing } = state;
        const chosen = new Set(selected);
        for (const id of listing.wonIds) everWon.current.add(id);
        const won = everWon.current;
        // A preview's photos carry no marks and are not remembered in `known`, so the selection is looked up in them.
        const previewPhotos = listing.preview ? new Map(listing.photos.map((photo) => [photo.id, photo])) : null;
        const lookup = (id: string): LibraryPhoto | undefined =>
            (previewPhotos ?? known).get(id) ?? extraPhotos?.get(id);
        const atCap = selected.length >= max;
        const refusedHere = (photo: LibraryPhoto): boolean => listing.allowedKnown && !photo.allowed;
        const blockedReasonOf = (photo: LibraryPhoto): string | null => {
            if (blockedIds?.has(photo.id)) return t(blockedKey);
            return refusedHere(photo) ? photo.message || t('app.photoChooserNotEligible') : null;
        };
        // Left out of a grid read for a challenge, in this order: a pick is shown, a blocked photo is shown
        // blocked, a photo the caller keeps shown (`keepIds` — a pick taken back during this listing, the submit
        // modal's) stays visible with its reason (it does not vanish under the click), and a photo the challenge
        // refuses is hidden. The chooser passes no `keepIds`, so an unticked refused pick is hidden at once, and
        // the focus hand-off moves the focus to the status line. Nothing is hidden before the listing says what
        // is accepted (`refusedHere` needs `allowedKnown`, which only a read through a challenge sets — a
        // chooser with no challenge hides nothing).
        const hiddenFromGrid = (photo: LibraryPhoto): boolean =>
            !chosen.has(photo.id) && !blockedIds?.has(photo.id) && !keepIds?.has(photo.id) && refusedHere(photo);
        const refusedHidden = listing.photos.filter(hiddenFromGrid).length;
        // The shown photos in the order they render: the loaded-photo sort reorders them from the
        // sort snapshot, never from the live Map a running read is still filling in.
        const shownPhotos = reorderLoadedPhotos(
            listing.photos.filter((photo) => !hiddenFromGrid(photo)),
            sortBy ?? 'library',
            sortStats ?? new Map(),
        );
        // The ids the listing returns, as a set: a pick's "listed or not" is a lookup, not a scan per pick.
        const listedIds = new Set(listing.photos.map((photo) => photo.id));
        // A non-empty listing with nothing in it to pick: every photo is hidden or blocked, and nothing is picked.
        const noneAccepted =
            listing.allowedKnown &&
            listing.photos.length > 0 &&
            selected.length === 0 &&
            shownPhotos.every((photo) => blockedIds?.has(photo.id));
        // A pick's number is its index in `selected` (the order it is saved in): a photo the listing
        // does not return keeps its number, so it holds its place in the list. The listed picks keep
        // their place in the library's order.
        const numberOf = new Map<string, number>();
        for (const id of selected) {
            numberOf.set(id, numberOf.size + 1);
        }
        const shown = (id: string): number | null => (numbered ? (numberOf.get(id) ?? null) : null);
        const tile = (photo: LibraryPhoto, position: number | null) => {
            tileIds.push(photo.id);
            return cell(
                photo.id,
                <PhotoTile
                    key={photo.id}
                    photo={photo}
                    memberId={listing.memberId}
                    selected={chosen.has(photo.id)}
                    position={position}
                    recommended={recommended.has(photo.id)}
                    blockedReason={blockedReasonOf(photo)}
                    atCap={atCap}
                    fullKey={fullKey}
                    allowedKnown={listing.allowedKnown}
                    locked={locked}
                    lockedKey={lockedKey}
                    onToggle={onToggle}
                    stats={stats?.get(photo.id) ?? null}
                    showStats={showStats === true}
                />,
            );
        };
        // An empty listing's text. A non-preview listing puts it in the live region in place of the Showing
        // line (so "Showing 0 photos" never doubles "No photos found"); a preview, which names no count,
        // keeps it as a body paragraph.
        const emptyKey =
            listing.wonCount > 0 && !listing.truncated ? 'app.photoChooserEmptyAllWon' : 'app.photoChooserEmpty';
        // What the status line says about the listing: how many photos are shown (a non-preview listing says so
        // always, so each appended batch is announced), how many were left out, and that none of the rest can be picked.
        const statusLines = (
            <>
                {!listing.preview && (
                    <p className={`text-base-content/70 ${listing.photos.length === 0 ? 'text-sm' : 'text-xs'}`}>
                        {listing.photos.length === 0
                            ? t(emptyKey)
                            : interp(t('app.photoChooserShowing'), { count: shownPhotos.length })}
                    </p>
                )}
                {refusedHidden > 0 && (
                    <p className="text-base-content/70 text-xs">
                        {interp(
                            t(
                                listing.truncated
                                    ? 'app.photoChooserRefusedHiddenTruncated'
                                    : 'app.photoChooserRefusedHidden',
                            ),
                            { count: refusedHidden },
                        )}
                    </p>
                )}
                {noneAccepted && (
                    <p className="text-base-content/70 text-sm">
                        {t(
                            listing.truncated
                                ? 'app.photoChooserNoneAcceptedTruncated'
                                : 'app.photoChooserNoneAccepted',
                        )}
                    </p>
                )}
            </>
        );
        // The batch read: its failure, then the button that reads on (and retries a failure). A preview has no
        // continuation, and a complete listing has nothing more to read.
        const loadMoreArea =
            !listing.preview && listing.truncated ? (
                <>
                    {loadMoreFailed !== null && (
                        <div role="alert" className="alert alert-error py-2 text-sm">
                            {/* The library-read failure keeps the Load-more wording, not the neutral first-read
                                text ipcErrorText maps it to: photos were read, only the next batch failed. */}
                            <span>
                                {loadMoreFailed === 'library-read-failed'
                                    ? t('app.photoChooserLoadMoreFailed')
                                    : ipcErrorText(loadMoreFailed, t, 'app.photoChooserLoadMoreFailed')}
                            </span>
                        </div>
                    )}
                    <button
                        type="button"
                        className={`btn btn-outline btn-sm self-start ${loadMoreHeld ? 'btn-disabled' : ''}`}
                        // aria-disabled, not disabled: a disabled button drops the keyboard focus to <body>.
                        aria-disabled={loadMoreHeld}
                        aria-busy={loadingMore}
                        onClick={() => {
                            if (!loadMoreHeld) loadMore();
                        }}
                        {...keepFocus}
                    >
                        <BusyContent busy={loadMoreHeld} label={t('app.pickLoadMore')}>
                            {t('app.pickLoadMore')}
                        </BusyContent>
                    </button>
                </>
            ) : null;
        return {
            status: statusLines,
            body: (
                <>
                    <ListingHeader
                        readAtMs={listing.readAtMs}
                        reading={revalidating}
                        disabled={refreshDisabled || loadingMore}
                        preview={listing.preview}
                        recheckFailed={recheckFailed}
                        hasChallenge={hasChallenge}
                        submit={submit}
                        onRefresh={onRefresh}
                    />
                    {!hasChallenge && (
                        <p className="text-base-content/70 text-xs">{t('app.photoChooserEligibilityLater')}</p>
                    )}
                    {listing.wonCount > 0 && (
                        <p className="text-base-content/70 text-xs">
                            {interp(
                                t(
                                    listing.truncated
                                        ? 'app.photoChooserWonHiddenTruncated'
                                        : 'app.photoChooserWonHidden',
                                ),
                                {
                                    count: listing.wonCount,
                                },
                            )}
                        </p>
                    )}
                    {listing.preview && listing.photos.length === 0 && (
                        <p className="text-base-content/70 text-sm">{t(emptyKey)}</p>
                    )}
                    <div className={TILE_GRID} {...keepFocus}>
                        {/* The picks the listing does not return stay pinned first, in pick order. */}
                        {selected
                            .filter((id) => !listedIds.has(id))
                            .map((id) => {
                                const photo = lookup(id);
                                if (photo) return tile(photo, shown(id));
                                if (listing.preview && !won.has(id)) {
                                    return cell(
                                        id,
                                        <PendingTile
                                            key={id}
                                            id={id}
                                            position={shown(id)}
                                            recheckFailed={recheckFailed}
                                            onToggle={onToggle}
                                        />,
                                    );
                                }
                                // No batch read so far has shown the pick: a stub keeps it visible (and removable)
                                // without reading on — in a library listing it may lie beyond the batch, in a search
                                // the note says reading on would not find it; a won pick keeps its missing tile,
                                // which says why it is gone.
                                if (listing.truncated && !won.has(id)) {
                                    return cell(
                                        id,
                                        <SavedPickTile
                                            key={id}
                                            id={id}
                                            memberId={listing.memberId}
                                            selected={chosen.has(id)}
                                            position={shown(id)}
                                            atCap={atCap}
                                            fullKey={fullKey}
                                            locked={locked}
                                            lockedKey={lockedKey}
                                            onToggle={onToggle}
                                            noteKey={
                                                search
                                                    ? 'app.photoChooserUnreachedTileNoteSearch'
                                                    : 'app.photoChooserUnreachedTileNote'
                                            }
                                        />,
                                    );
                                }
                                return cell(
                                    id,
                                    <MissingTile
                                        key={id}
                                        id={id}
                                        position={shown(id)}
                                        count={listing.photos.length}
                                        hasChallenge={hasChallenge}
                                        search={search}
                                        won={won.has(id)}
                                        onToggle={onToggle}
                                    />,
                                );
                            })}
                        {shownPhotos.map((photo) => tile(photo, shown(photo.id)))}
                    </div>
                    {loadMoreArea}
                </>
            ),
        };
    };
    const { status, body } = render();
    // The full-tile ids report once per SET change, keyed from a sorted copy: the grid's own
    // reordering (a loaded sort applying, a reorder-at-run-end) renders the same tiles and sends
    // nothing, and the loader re-asks only ids without stats anyway. The ids themselves go in the
    // grid's render order, so the loader reads the visible top first.
    const tileIdsKey = [...tileIds].sort().join('\n');
    useEffect(() => {
        if (onTileIds === undefined || reportedTileIds.current === tileIdsKey) return;
        reportedTileIds.current = tileIdsKey;
        onTileIds(tileIds);
        // tileIds is this render's collection of the same set the key names; listing it in deps
        // would re-run the effect every render for a report the key guard would drop anyway.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onTileIds, tileIdsKey]);
    return (
        <>
            {/* One live region at the same place in every state, so a line that arrives in it is announced. It is
                also where the focus goes when the tile it was on is left out of the listing. */}
            <div role="status" tabIndex={-1} ref={hiddenLineRef} className="empty:hidden">
                {status}
            </div>
            {body}
        </>
    );
}
