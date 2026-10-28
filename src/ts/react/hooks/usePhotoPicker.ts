/**
 * The picker behind the photo choosers: the on-demand library listing with its Load photos, Load more
 * and Search, the Auto ranking with its suggestions strip and paging, and the idle grid's memory of
 * what has been picked in this opening. The caller owns the selection (`selected`) and what it means
 * (a submit's pick, a saved list): this hook only reads and ranks.
 *
 * The toolbar's session state — the library order, the loaded-photo sort and Show stats — is here
 * too, with the stats loader it drives (`usePhotoStatsLoader`, the only caller of `get-photo-stats`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSuggestPhotos } from '@/api/useSuggestPhotos';
import { useLibraryListing } from '@/hooks/useLibraryListing';
import { usePhotoStatsLoader } from '@/hooks/usePhotoStatsLoader';
import { MAX_SUGGEST_EXCLUDE } from '../../settings/limits';

import type { LibraryPhoto } from '@/hooks/useLibraryListing';
import type { LibraryUsage } from '../../types/photoPicker';

/** What Auto ranked: the photos best first, the member that owns them, and whether stats were partly skipped. */
export type Suggested = { photos: LibraryPhoto[]; rankOffset: number; memberId: string | null; statsLimited: boolean };

export function usePhotoPicker({
    challengeId,
    usage,
    alwaysFresh,
    selected,
}: {
    challengeId: string | number | null;
    usage: LibraryUsage;
    /** Cached reads come back as previews, so nothing can be trusted until the fresh read behind one lands. */
    alwaysFresh: boolean;
    /** The caller's selection, in its own order: the idle grid keeps each id's tile in place once picked. */
    selected: string[];
}) {
    const {
        state,
        known,
        requestId,
        revalidating,
        recheckFailed,
        order,
        setOrder,
        load,
        refresh,
        retry,
        loadMore,
        loadingMore,
        loadMoreFailed,
        isSearch,
    } = useLibraryListing(challengeId, { alwaysFresh, onDemand: true, usage });
    // Whether the read on screen is one Load photos started: only that one shows Load photos as busy.
    const [loadPhotosReading, setLoadPhotosReading] = useState(false);
    // Bumped by Load photos to remount the search box empty, so it never shows a term the grid is not filtered by.
    const [searchKey, setSearchKey] = useState(0);

    // Auto: the ranking on screen, the records of every photo it has named (a picked suggestion keeps its tile
    // when the strip clears), and the failure of the last press. An answer is kept only while the epoch it
    // was asked in is current: a Refresh, a refreshed submit or closing the chooser ends it.
    const { suggest: runSuggest, loading: suggesting } = useSuggestPhotos();
    const [suggested, setSuggested] = useState<Suggested | null>(null);
    const [suggestedKnown, setSuggestedKnown] = useState<ReadonlyMap<string, LibraryPhoto>>(new Map());
    // The member of the last answer that named one: it survives the strip clearing, so picks keep their thumbnails.
    const [suggestedMemberId, setSuggestedMemberId] = useState<string | null>(null);
    const [suggestFailure, setSuggestFailure] = useState<string | null>(null);
    // The ids Auto has named since the last listing read, in order: the next press asks for the ones after them.
    const [shownIds, setShownIds] = useState<string[]>([]);
    // Every id picked in this opening, in first-pick order: while idle the grid keeps each one's tile in place
    // when it is unpicked, so the tile (and the focus on it) stays and the pick can be made again. The state
    // remembers the ids once they are unpicked; a pick is shown in the render that makes it.
    const [idleSeen, setIdleSeen] = useState<string[]>([]);
    useEffect(() => {
        setIdleSeen((prev) => {
            const added = selected.filter((id) => !prev.includes(id));
            return added.length > 0 ? [...prev, ...added] : prev;
        });
    }, [selected]);
    const idleShown = [...idleSeen, ...selected.filter((id) => !idleSeen.includes(id))];
    const suggestEpoch = useRef(0);
    useEffect(
        () => () => {
            suggestEpoch.current += 1;
        },
        [],
    );
    const stats = usePhotoStatsLoader();
    // The tiles the grid last reported as shown (it hides refused and blocked photos, so fewer than
    // the listing holds): the sort reorders those tiles, so the count follows the reports, and null
    // means not reported yet — the loaded count stands in for it in the help line.
    const [shownCount, setShownCount] = useState<number | null>(null);
    // The grid's report, wrapped so each one records the shown count first; the dep is the loader's
    // setTileIds — one function for the opening — so the wrapper's identity holds beside it.
    const { setTileIds: reportTileIds } = stats;
    const setTileIds = useCallback(
        (ids: readonly string[]) => {
            setShownCount(ids.length);
            reportTileIds(ids);
        },
        [reportTileIds],
    );

    // The suggestions are of the listing they were ranked beside: a new read drops them, and an answer still on
    // its way.
    const clearSuggestions = useCallback(() => {
        suggestEpoch.current += 1;
        setSuggested(null);
        setSuggestFailure(null);
        setShownIds([]);
    }, []);

    /** Load photos: reads one batch of the library, and empties the search box (remounted through `searchKey`). */
    const loadPhotos = useCallback(() => {
        setLoadPhotosReading(true);
        setSearchKey((key) => key + 1);
        void load('');
    }, [load]);

    /** Search: reads the library for the term, and stops showing Load photos as the read on screen. */
    const search = useCallback(
        (term: string) => {
            setLoadPhotosReading(false);
            void load(term);
        },
        [load],
    );

    /** Ends a Load photos read (a Refresh, a refreshed submit) and drops the ranking on screen with it. */
    const resetLoadPhotos = useCallback(() => {
        setLoadPhotosReading(false);
        clearSuggestions();
    }, [clearSuggestions]);

    const autoSuggest = useCallback(async () => {
        // Auto ranks for a challenge; the control that calls this is shown only where there is one.
        if (challengeId === null) return;
        const epoch = suggestEpoch.current;
        setSuggestFailure(null);
        const result = await runSuggest(challengeId, usage, shownIds);
        if (epoch !== suggestEpoch.current) return;
        if (!result.success) {
            setSuggested(null);
            setSuggestFailure(result.error);
            // Every photo that fits has been shown: the next press starts again from the best.
            if (result.error === 'no-more-suggestions') setShownIds([]);
            return;
        }
        // At the cap the list is dropped, as at the end of the photos: a longer one would be refused.
        const shown = [...shownIds, ...result.photos.map((photo) => photo.id)];
        setShownIds(shown.length >= MAX_SUGGEST_EXCLUDE ? [] : shown);
        setSuggested({ ...result, rankOffset: shownIds.length });
        if (result.memberId !== null) setSuggestedMemberId(result.memberId);
        setSuggestedKnown(
            (prev) => new Map([...prev, ...result.photos.map((photo): [string, LibraryPhoto] => [photo.id, photo])]),
        );
    }, [challengeId, runSuggest, usage, shownIds]);

    return {
        state,
        known,
        requestId,
        revalidating,
        recheckFailed,
        order,
        setOrder,
        refresh,
        retry,
        loadMore,
        loadingMore,
        loadMoreFailed,
        isSearch,
        loadPhotosReading,
        searchKey,
        loadPhotos,
        search,
        resetLoadPhotos,
        suggesting,
        suggested,
        suggestedKnown,
        suggestedMemberId,
        suggestFailure,
        shownIds,
        idleShown,
        autoSuggest,
        sortBy: stats.sortBy,
        setSortBy: stats.setSortBy,
        showStats: stats.showStats,
        setShowStats: stats.setShowStats,
        stats: stats.stats,
        sortStats: stats.sortStats,
        statsProgress: stats.statsProgress,
        statsRead: stats.statsRead,
        statsMissing: stats.statsMissing,
        retryStats: stats.retryStats,
        setTileIds,
        shownCount,
    };
}
