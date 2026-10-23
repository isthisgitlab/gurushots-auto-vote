/**
 * The library listing behind the photo choosers: what is on screen, every photo any fresh read has listed,
 * and the reads that keep it current.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as ipc from '@/api/ipc';
import { rememberCurrentMember } from './currentMember';

import { asPreview } from '../../libraryPreview';
import { LIBRARY_BATCH_PHOTOS, MAX_LIBRARY_KEEP_PHOTOS, MAX_WON_IDS } from '../../settings/limits';

import type { WindowApi } from '../../types/ipc';
import type { LibraryUsage } from '../../types/photoPicker';

type LibraryAnswer = Awaited<ReturnType<WindowApi['getLibraryPhotos']>>;
type Listing = Extract<LibraryAnswer, { success: true }>;
type LibraryFailure = Exclude<LibraryAnswer, { success: true }>;
export type LibraryPhoto = Listing['photos'][number];

/**
 * What the chooser is showing. `ready` keeps the listing's photos beside what
 * the response said about them (a `preview` listing is the library as last loaded, its marks withheld);
 * every other state is a reason there are none. `idle` is a chooser that reads nothing until asked to.
 */
export type ListState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; listing: Listing }
    | { status: 'no-context' }
    | { status: 'error'; error: string | null };

type ReadMode = 'cached' | 'fresh';

// The failures that mean there is no session: what was shown clears, and a Retry is not offered —
// signing in again is the way out.
const SIGNED_OUT = new Set(['not-logged-in', 'No authentication token found']);

const replacesListing = (error: string | undefined): boolean =>
    error === 'no-challenge-context' || (error !== undefined && SIGNED_OUT.has(error));

/**
 * How far a re-read of a listing goes: what the batch rule counts — the allowed photos once the marks are
 * known, every photo before that — clamped to 1..MAX_LIBRARY_KEEP_PHOTOS. The handler and the mock serve
 * exactly this many photos, so a Refresh, Retry or re-check re-reads what is on screen instead of
 * shrinking it. The one exception is the re-check behind a borrowed preview (another challenge's, or an expired
 * one) when the listing names a challenge: it reads a single batch, because a challenge-bound grid holds a
 * loader for such a preview instead of its photos.
 */
const countedKeep = (listing: Listing): number => {
    const counted = listing.allowedKnown
        ? listing.photos.filter((photo) => photo.allowed).length
        : listing.photos.length;
    return Math.min(MAX_LIBRARY_KEEP_PHOTOS, Math.max(1, counted));
};

/**
 * The listing for a challenge. A no-search read may come from memory as a preview, which is read again in
 * the background; a search, Retry and Refresh read afresh. Answers to any but the newest request are dropped.
 * With `onDemand` nothing is read on mount: the listing is `idle` until `load` (or `retry`) is called.
 * `usage` is what the listing's eligibility marks are read for (submit, or a swap's). With `onDemand` a change of it
 * reads nothing by itself and the next read sends the new one; without `onDemand` it re-reads, as a change of
 * challenge does.
 */
export function useLibraryListing(
    challengeId: string | number | null,
    {
        alwaysFresh = false,
        onDemand = false,
        usage = 'submit',
    }: { alwaysFresh?: boolean; onDemand?: boolean; usage?: LibraryUsage } = {},
) {
    const [state, setState] = useState<ListState>({ status: onDemand ? 'idle' : 'loading' });
    // Every photo any fresh response has listed, by id: a selected photo that a narrower
    // search omits keeps its record and is not shown as a missing tile.
    const [known, setKnown] = useState<Map<string, LibraryPhoto>>(new Map());
    const [revalidating, setRevalidating] = useState(false);
    const [recheckFailed, setRecheckFailed] = useState(false);
    // The read of the next batch after the listing on screen: whether it is on its way, and why it
    // failed (the listing itself stays). `null` is no failure.
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreFailed, setLoadMoreFailed] = useState<string | null>(null);
    // The synchronous guard against two load-more triggers in one tick: it carries the request the
    // in-flight batch read belongs to, so a second trigger on the same listing returns at once.
    const loadingMoreRef = useRef<number | null>(null);
    // One monotonic id for the newest request: the staleness check after every await, and the number
    // refresh and retry hand back. A load, a search and a re-read mint a new one; an appended batch
    // does not. Which read's listing is on screen is `shownRequestId` below.
    const requestIdRef = useRef(0);
    // The id of the read whose listing is on screen, stamped when `show` puts one there — not the ref,
    // which a refresh bumps the moment it starts reading: the listing on screen, and with it the id the
    // pick-prune consumers hold, must change only when a new listing actually replaces it.
    const [shownRequestId, setShownRequestId] = useState(0);
    // The search term of the listing on screen, set when one is shown from the read that owns
    // `lastSearchRef`: an appended batch does not show, so it keeps the term.
    const [searchTerm, setSearchTerm] = useState('');
    const lastSearchRef = useRef('');
    // The member of the listing on screen: the background re-check of a preview, which cannot name one, keeps it.
    const memberRef = useRef<string | null>(null);
    // The state of the newest render, for callbacks that must not depend on `state`.
    const latestState = useRef(state);
    latestState.current = state;

    const read = useCallback(
        (search: string, mode: ReadMode, start: number, keep: number) =>
            ipc.callOrNull(() => ipc.getLibraryPhotos(challengeId, search || undefined, mode, usage, start, keep)),
        [challengeId, usage],
    );

    // How far a re-read of what is on screen goes: the counted extent of the listing on screen.
    // From the error state there is no listing, so one batch.
    const keepOnScreen = useCallback(() => {
        const current = latestState.current;
        if (current.status !== 'ready') return LIBRARY_BATCH_PHOTOS;
        return countedKeep(current.listing);
    }, []);

    /**
     * Puts a listing on screen and remembers the member it names; a fresh one feeds `known`, which a change of
     * member empties first. The re-check of a preview (`keepMember`) that cannot name a member keeps the one
     * already shown.
     */
    const show = useCallback((listing: Listing, keepMember = false) => {
        const previous = memberRef.current;
        const memberId = listing.memberId ?? (keepMember ? previous : null);
        const switched = previous !== null && memberId !== previous;
        memberRef.current = memberId;
        // The chosen-photo chips build their thumbnails from the member a listing names.
        if (memberId !== null) rememberCurrentMember(memberId);
        if (switched || !listing.preview) {
            setKnown((prev) => {
                const base = switched ? new Map<string, LibraryPhoto>() : prev;
                if (listing.preview) return base;
                return new Map([...base, ...listing.photos.map((photo): [string, LibraryPhoto] => [photo.id, photo])]);
            });
        }
        setSearchTerm(lastSearchRef.current);
        setShownRequestId(requestIdRef.current);
        setState({ status: 'ready', listing: { ...listing, memberId } });
    }, []);

    /** An answer that is not a listing: where it leaves the chooser (signed out clears what was shown). */
    const showFailure = useCallback((result: LibraryFailure | null) => {
        setRevalidating(false);
        if (result?.error === 'no-challenge-context') {
            setState({ status: 'no-context' });
        } else if (result?.error !== undefined && SIGNED_OUT.has(result.error)) {
            setKnown(new Map());
            memberRef.current = null;
            setState({ status: 'error', error: result.error });
        } else {
            setState({ status: 'error', error: result?.error ?? null });
        }
    }, []);

    const load = useCallback(
        async (search: string, mode: ReadMode = search ? 'fresh' : 'cached', keep: number = LIBRARY_BATCH_PHOTOS) => {
            const request = ++requestIdRef.current;
            lastSearchRef.current = search;
            setRevalidating(false);
            setRecheckFailed(false);
            setLoadingMore(false);
            setLoadMoreFailed(null);
            setState({ status: 'loading' });
            const startedAt = Date.now();
            const result = await read(search, mode, 0, keep);
            if (request !== requestIdRef.current) return;
            if (!result?.success) return showFailure(result);
            // A cached answer is a preview when it says so, or when the caller trusts no cached marks: unless
            // the read walked the library just now (it began after this request), which a second read repeats.
            const cachedMarks = mode === 'cached' && alwaysFresh && !result.preview && result.readAtMs < startedAt;
            const asShown = cachedMarks ? { ...asPreview(result), preview: true } : result;
            show(asShown);
            if (!asShown.preview) return;
            setRevalidating(true);
            // The re-check's extent. With a challenge, a cached answer of this same challenge is re-read to its
            // own accepted extent (`result` still knows the marks), so the photos — and the picks made beside
            // them — stay on screen; a borrowed preview (another challenge's, or an expired one) is read for one
            // batch, since a challenge-bound grid holds a loader for it, not its photos. Without a challenge the
            // preview on screen is re-read to its own extent, so nothing shown shrinks.
            const recheckKeep =
                challengeId !== null && !cachedMarks
                    ? LIBRARY_BATCH_PHOTOS
                    : countedKeep(cachedMarks ? result : asShown);
            const fresh = await read(search, 'fresh', 0, recheckKeep);
            if (request !== requestIdRef.current) return;
            setRevalidating(false);
            if (fresh?.success) show(fresh, true);
            else if (replacesListing(fresh?.error) || challengeId !== null)
                // With a challenge, any failed re-check lands in the error state, as a failed cold read does —
                // superseded and signed-out included: the grid holds a loader for the preview, so there is no
                // listing to leave up under a recheck-failed line, and Retry reads one batch from there. Without
                // one, only the answers that replace the listing do; every other failure keeps the preview on
                // screen with `recheckFailed`, because it is worth keeping.
                showFailure(fresh);
            else setRecheckFailed(true);
        },
        [read, show, showFailure, alwaysFresh, challengeId],
    );

    useEffect(() => {
        if (!onDemand) void load('');
        return () => {
            requestIdRef.current += 1;
        };
    }, [load, onDemand]);

    // Reads the current search again without taking the listing off the screen: the new listing replaces it
    // when it lands, and that read's id is answered here (like retry's) for the caller to record.
    const refreshRead = useCallback(async () => {
        const request = ++requestIdRef.current;
        setRevalidating(true);
        setRecheckFailed(false);
        setLoadingMore(false);
        setLoadMoreFailed(null);
        const result = await read(lastSearchRef.current, 'fresh', 0, keepOnScreen());
        if (request !== requestIdRef.current) return;
        setRevalidating(false);
        if (result?.success) show(result);
        else if (replacesListing(result?.error)) showFailure(result);
        else setRecheckFailed(true);
    }, [read, show, showFailure, keepOnScreen]);
    const refresh = useCallback(() => {
        void refreshRead();
        return requestIdRef.current;
    }, [refreshRead]);

    // Reads the listing again; answers the id of the read it starts, so a Retry can be recorded
    // against the listing it creates rather than the one it replaced. The extent re-read is the one
    // on screen now, read before load takes the listing down.
    const retry = () => {
        void load(lastSearchRef.current, 'fresh', keepOnScreen());
        return requestIdRef.current;
    };

    /**
     * Reads the batch after the listing on screen and appends it: the same listing, so the same request
     * and nothing re-stamped on it. An answer to a request a newer read replaced is dropped silently —
     * that read has already cleared the flags. A `superseded` one that survives the check (the newer
     * read came from another window) is a `loadMoreFailed`, like every other failure that keeps the
     * listing; a signed-out one replaces the listing, as for any read.
     */
    const loadMore = useCallback(async () => {
        const current = latestState.current;
        // One batch read in flight at a time: a second trigger in the same tick returns at once — it
        // would read the same nextStart again — and the guards below must rule out every other
        // reader for the updater's narrowing to hold. A newer request reads freely; a superseded
        // read's answer never reaches the updater (the request guard drops it).
        if (loadingMoreRef.current === requestIdRef.current) return;
        if (current.status !== 'ready' || current.listing.preview) return;
        const request = requestIdRef.current;
        const { nextStart, memberId } = current.listing;
        loadingMoreRef.current = request;
        try {
            setLoadingMore(true);
            setLoadMoreFailed(null);
            const result = await read(lastSearchRef.current, 'fresh', nextStart, LIBRARY_BATCH_PHOTOS);
            if (request !== requestIdRef.current) return;
            if (result === null || !result.success) {
                setLoadingMore(false);
                // The listing is replaced only when the session is gone; anything else keeps it and says why.
                if (replacesListing(result?.error)) showFailure(result);
                else setLoadMoreFailed(result?.error ?? 'failed');
                return;
            }
            if (memberId === null && result.memberId !== null) {
                memberRef.current = result.memberId;
                // The first answer to name the member feeds the store too, as a listing landing would.
                rememberCurrentMember(result.memberId);
            }
            // The batch joins the listing on screen. The request guard rules out a newer read — an
            // older loadMore's answer included — and the in-flight guard a sibling loadMore, so
            // between the guards and this updater nothing else can move the state off `ready`; the
            // remaining check exists only to narrow ListState for the typechecker.
            setKnown(
                (prev) =>
                    new Map([...prev, ...result.photos.map((photo): [string, LibraryPhoto] => [photo.id, photo])]),
            );
            setState((prev) => {
                /* istanbul ignore if */
                if (prev.status !== 'ready') return prev;
                const listed = new Set(prev.listing.photos.map((photo) => photo.id));
                const added = result.photos.filter((photo) => !listed.has(photo.id));
                const tracked = new Set(prev.listing.wonIds);
                const overlap = result.wonIds.filter((id) => tracked.has(id)).length;
                return {
                    status: 'ready',
                    listing: {
                        ...prev.listing,
                        photos: [...prev.listing.photos, ...added],
                        wonIds: [...new Set([...prev.listing.wonIds, ...result.wonIds])].slice(0, MAX_WON_IDS),
                        wonCount: prev.listing.wonCount + (result.wonCount - overlap),
                        truncated: result.truncated,
                        nextStart: result.nextStart,
                        memberId: prev.listing.memberId ?? result.memberId,
                    },
                };
            });
            setLoadingMore(false);
        } finally {
            // A superseded read leaves the guard alone: it belongs to the read that replaced it.
            if (loadingMoreRef.current === request) loadingMoreRef.current = null;
        }
    }, [read, showFailure]);

    // Whether the listing on screen came from a non-empty search term: true while a read of one is
    // ready (a Refresh and a Retry re-read the same term and keep it; a `load('')` clears it). Every
    // other state — idle, loading, error, no-context — is not a search listing.
    const isSearch = state.status === 'ready' && searchTerm !== '';

    return {
        state,
        known,
        requestId: shownRequestId,
        revalidating,
        recheckFailed,
        load,
        refresh,
        retry,
        loadMore,
        loadingMore,
        loadMoreFailed,
        isSearch,
    };
}
