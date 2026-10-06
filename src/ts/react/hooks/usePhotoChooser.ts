/**
 * State behind the Chosen Photos chooser: the library listing for a challenge, which account the
 * saved lists belong to, and the re-read of a list that came without its ids.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import * as ipc from '@/api/ipc';

import type { WindowApi } from '../../types/ipc';

type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;
export type LibraryPhoto = Listing['photos'][number];

/**
 * What the chooser is showing. `ready` keeps the listing's photos beside what
 * the response said about them; every other state is a reason there are none.
 */
export type ListState =
    | { status: 'loading' }
    | { status: 'ready'; listing: Listing }
    | { status: 'no-context' }
    | { status: 'error'; error: string | null };

/**
 * The library listing for a challenge and what has been learned from it: the
 * current state, every photo any response has listed so far (by id), and `load`
 * to read again for a search term. A response for any but the newest request is a
 * late answer and is dropped; leaving drops whatever is still in flight.
 */
export function useLibraryListing(challengeId: string | number | null) {
    const [state, setState] = useState<ListState>({ status: 'loading' });
    // Every photo any response has listed, by id: a selected photo that a narrower
    // search omits keeps its record and is not shown as a missing tile.
    const [known, setKnown] = useState<Map<string, LibraryPhoto>>(new Map());
    const requestRef = useRef(0);
    const lastSearchRef = useRef('');

    const load = useCallback(
        async (search: string) => {
            const request = ++requestRef.current;
            lastSearchRef.current = search;
            setState({ status: 'loading' });
            const result = await ipc.callOrNull(() => ipc.getLibraryPhotos(challengeId, search || undefined));
            if (request !== requestRef.current) return;
            if (result?.success) {
                rememberCurrentMember(result.memberId);
                setKnown(
                    (prev) =>
                        new Map([...prev, ...result.photos.map((photo): [string, LibraryPhoto] => [photo.id, photo])]),
                );
                setState({ status: 'ready', listing: result });
            } else if (result?.error === 'no-challenge-context') {
                setState({ status: 'no-context' });
            } else {
                // A 'superseded' answer to the newest request means nothing newer is coming: offer Retry.
                const error = result?.error && result.error !== 'superseded' ? result.error : null;
                setState({ status: 'error', error });
            }
        },
        [challengeId],
    );

    useEffect(() => {
        void load('');
        return () => {
            requestRef.current += 1;
        };
    }, [load]);

    return { state, known, load, retry: () => void load(lastSearchRef.current) };
}

/**
 * Whether the lists on record belong to another account than the signed-in one,
 * judged on the list the modal opened with (`savedCount`), not the live selection,
 * so choosing photos does not make the notice come and go. Once seen it stays until
 * the lists are removed: a search puts the listing back to loading (or an error),
 * which must not hide the notice and the photos it withholds. `onFirstSeen` runs
 * once, as soon as it is seen — the other account's photos are not this account's
 * to build on, so the selection then starts empty.
 */
export function useOtherAccountLists({
    savedCount,
    owner,
    state,
    removed,
    onFirstSeen,
}: {
    savedCount: number;
    owner: string;
    state: ListState;
    removed: boolean;
    onFirstSeen: () => void;
}): boolean {
    const currentMember = state.status === 'ready' ? state.listing.memberId : null;
    const otherNow = savedCount > 0 && owner !== '' && currentMember !== null && owner !== currentMember;
    const seen = useRef(false);
    const otherAccount = !removed && (otherNow || seen.current);
    const startedFresh = useRef(false);
    // Latched here, after the render that saw it, not during it.
    useLayoutEffect(() => {
        if (otherNow) seen.current = true;
    }, [otherNow]);
    useLayoutEffect(() => {
        if (otherAccount && !startedFresh.current) {
            startedFresh.current = true;
            onFirstSeen();
        }
    }, [otherAccount, onFirstSeen]);
    return otherAccount;
}

/**
 * Where the re-read of a saved list stands: `ok` (nothing to read, read, or another account's
 * list, which the notice covers), `pending` (the listing or the read is still on its way) or
 * `unconfirmed` (the listing is ready but the list's account could not be confirmed, so Retry).
 */
export type SavedListStatus = 'ok' | 'pending' | 'unconfirmed';

/**
 * A saved list can come without its ids (the main process withholds them until it knows whose
 * account this is), so the selection then starts empty, which is not what is saved. Once the
 * listing shows the list is this account's, `reloadSaved` reads it again (the member is known now,
 * so its ids come through) and `onRead` seeds the selection from it. Another account's list stays
 * withheld: the other-account notice covers it, and saving a new selection over it is then the
 * user's choice.
 *
 * While the status is not `ok` Save is held back — an empty or partial selection would replace the
 * user's own list — and the tiles are inert, so a late read cannot overwrite what was picked. A
 * listing that is ready but cannot say who is signed in (the member lookup failed), or a read that
 * fails or rejects, ends in `unconfirmed`, and `retry` asks again: the listing in the first case,
 * the read in the other.
 */
export function useSavedListReread({
    withheld,
    owner,
    state,
    reloadSaved,
    retryListing,
    onRead,
}: {
    withheld: boolean;
    owner: string;
    state: ListState;
    reloadSaved?: () => Promise<string[] | null>;
    retryListing: () => void;
    onRead: (ids: string[]) => void;
}): { status: SavedListStatus; retry: () => void } {
    const [reloaded, setReloaded] = useState(false);
    const [phase, setPhase] = useState<'idle' | 'reading' | 'failed'>('idle');
    const [attempt, setAttempt] = useState(0);
    const inFlight = useRef(false);
    const memberId = state.status === 'ready' ? state.listing.memberId : null;
    const ownersList = withheld && owner !== '' && memberId === owner;
    useEffect(() => {
        if (!ownersList || reloaded || !reloadSaved || inFlight.current) return;
        inFlight.current = true;
        setPhase('reading');
        const finish = (ids: string[] | null) => {
            inFlight.current = false;
            if (ids === null) {
                setPhase('failed');
                return;
            }
            onRead(ids);
            setReloaded(true);
            setPhase('idle');
        };
        reloadSaved().then(finish, () => finish(null));
    }, [ownersList, reloaded, reloadSaved, onRead, attempt]);

    const otherAccount = memberId !== null && owner !== '' && memberId !== owner;
    const unread = withheld && !reloaded && !otherAccount;
    const waiting = state.status !== 'ready' || (ownersList && !!reloadSaved && phase !== 'failed');
    const status: SavedListStatus = !unread ? 'ok' : waiting ? 'pending' : 'unconfirmed';
    // The listing could not say who is signed in: ask it again. Otherwise the read itself failed.
    const retry = () => {
        if (ownersList) {
            setPhase('idle');
            setAttempt((count) => count + 1);
        } else retryListing();
    };
    return { status, retry };
}

/**
 * Saving the selection: `save` hands it to `onSave` and closes on success; a refused or rejected
 * save leaves the chooser open on its error (`saveFailed`).
 */
export function useChooserSave(
    selected: string[],
    onSave: (ids: string[]) => boolean | Promise<boolean>,
    onClose: () => void,
) {
    const [saving, setSaving] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);
    const save = () => {
        void (async () => {
            setSaving(true);
            setSaveFailed(false);
            let ok = false;
            try {
                ok = (await onSave(selected)) !== false;
            } catch {
                // A rejected save leaves the modal open on its error, like a refused one.
            }
            setSaving(false);
            if (ok) onClose();
            else setSaveFailed(true);
        })();
    };
    return { save, saving, saveFailed };
}
