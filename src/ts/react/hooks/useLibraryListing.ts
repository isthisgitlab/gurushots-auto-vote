/**
 * The library listing behind the photo choosers: what is on screen, every photo any fresh read has listed,
 * and the reads that keep it current.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import * as ipc from '@/api/ipc';

import { asPreview } from '../../libraryPreview';

import type { WindowApi } from '../../types/ipc';

type LibraryAnswer = Awaited<ReturnType<WindowApi['getLibraryPhotos']>>;
type Listing = Extract<LibraryAnswer, { success: true }>;
type LibraryFailure = Exclude<LibraryAnswer, { success: true }>;
export type LibraryPhoto = Listing['photos'][number];

/**
 * What the chooser is showing. `ready` keeps the listing's photos beside what
 * the response said about them (a `preview` listing is the library as last loaded, its marks withheld);
 * every other state is a reason there are none.
 */
export type ListState =
    | { status: 'loading' }
    | { status: 'ready'; listing: Listing }
    | { status: 'no-context' }
    | { status: 'error'; error: string | null };

type ReadMode = 'cached' | 'fresh';

const ACCOUNT_GONE = new Set(['account-changed', 'not-logged-in', 'No authentication token found']);

const replacesListing = (error: string | undefined): boolean =>
    error === 'no-challenge-context' || (error !== undefined && ACCOUNT_GONE.has(error));

/**
 * The listing for a challenge. A no-search read may come from memory as a preview, which is read again in
 * the background; a search, Retry and Refresh read afresh. Answers to any but the newest request are dropped.
 */
export function useLibraryListing(
    challengeId: string | number | null,
    { alwaysFresh = false }: { alwaysFresh?: boolean } = {},
) {
    const [state, setState] = useState<ListState>({ status: 'loading' });
    // Every photo any fresh response has listed, by id: a selected photo that a narrower
    // search omits keeps its record and is not shown as a missing tile.
    const [known, setKnown] = useState<Map<string, LibraryPhoto>>(new Map());
    // Which load the listing is on: a new search or load is a new generation, a member patched into
    // the listing on screen (setMember) is not. What a Retry did belongs to the generation it ends
    // up on.
    const [generation, setGeneration] = useState(0);
    const [revalidating, setRevalidating] = useState(false);
    const [recheckFailed, setRecheckFailed] = useState(false);
    const generationRef = useRef(0);
    const requestRef = useRef(0);
    const lastSearchRef = useRef('');
    // The member on screen: the background re-check of a preview, which cannot name one, keeps it.
    const memberRef = useRef<string | null>(null);

    const read = useCallback(
        (search: string, mode: ReadMode) =>
            ipc.callOrNull(() => ipc.getLibraryPhotos(challengeId, search || undefined, mode)),
        [challengeId],
    );

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
        rememberCurrentMember(memberId);
        if (switched || !listing.preview) {
            setKnown((prev) => {
                const base = switched ? new Map<string, LibraryPhoto>() : prev;
                if (listing.preview) return base;
                return new Map([...base, ...listing.photos.map((photo): [string, LibraryPhoto] => [photo.id, photo])]);
            });
        }
        setState({ status: 'ready', listing: { ...listing, memberId } });
    }, []);

    /** An answer that is not a listing: where it leaves the chooser (the account gone clears what was shown). */
    const showFailure = useCallback((result: LibraryFailure | null) => {
        setRevalidating(false);
        if (result?.error === 'no-challenge-context') {
            setState({ status: 'no-context' });
        } else if (result?.error !== undefined && ACCOUNT_GONE.has(result.error)) {
            setKnown(new Map());
            memberRef.current = null;
            setState({ status: 'error', error: result.error });
        } else {
            // A 'superseded' answer to the newest request means nothing newer is coming: offer Retry.
            const error = result?.error && result.error !== 'superseded' ? result.error : null;
            setState({ status: 'error', error });
        }
    }, []);

    const load = useCallback(
        async (search: string, mode: ReadMode = search ? 'fresh' : 'cached') => {
            const request = ++requestRef.current;
            lastSearchRef.current = search;
            generationRef.current += 1;
            setGeneration(generationRef.current);
            setRevalidating(false);
            setRecheckFailed(false);
            setState({ status: 'loading' });
            const startedAt = Date.now();
            const result = await read(search, mode);
            if (request !== requestRef.current) return;
            if (!result?.success) return showFailure(result);
            // A cached answer is a preview when it says so, or when the caller trusts no cached marks: unless
            // the read walked the library just now (it began after this request), which a second read repeats.
            const cachedMarks = mode === 'cached' && alwaysFresh && !result.preview && result.readAtMs < startedAt;
            const asShown = cachedMarks ? { ...asPreview(result), preview: true } : result;
            show(asShown);
            if (!asShown.preview) return;
            setRevalidating(true);
            const fresh = await read(search, 'fresh');
            if (request !== requestRef.current) return;
            setRevalidating(false);
            if (fresh?.success) show(fresh, true);
            else if (replacesListing(fresh?.error)) showFailure(fresh);
            else setRecheckFailed(true);
        },
        [read, show, showFailure, alwaysFresh],
    );

    useEffect(() => {
        void load('');
        return () => {
            requestRef.current += 1;
        };
    }, [load]);

    // Reads the current search again without taking the listing off the screen: the new listing replaces it
    // when it lands, and that is a new generation (answered here, like retry's, for the caller to record).
    const refreshRead = useCallback(async () => {
        const request = ++requestRef.current;
        setRevalidating(true);
        setRecheckFailed(false);
        const result = await read(lastSearchRef.current, 'fresh');
        if (request !== requestRef.current) return;
        setRevalidating(false);
        if (result?.success) {
            generationRef.current += 1;
            setGeneration(generationRef.current);
            show(result);
        } else if (replacesListing(result?.error)) {
            showFailure(result);
        } else setRecheckFailed(true);
    }, [read, show, showFailure]);
    const refresh = useCallback(() => {
        void refreshRead();
        return generationRef.current + 1;
    }, [refreshRead]);

    // A member the listing could not name but a later check did: put it in the listing on screen,
    // without reading the library again.
    const setMember = useCallback((memberId: string) => {
        memberRef.current = memberId;
        rememberCurrentMember(memberId);
        setState((prev) =>
            prev.status === 'ready' ? { status: 'ready', listing: { ...prev.listing, memberId } } : prev,
        );
    }, []);

    // Reads the listing again; answers the generation that read is, so a Retry can be recorded
    // against the listing it created rather than the one it replaced.
    const retry = () => {
        void load(lastSearchRef.current, 'fresh');
        return generationRef.current;
    };

    return { state, known, generation, revalidating, recheckFailed, load, refresh, setMember, retry };
}
