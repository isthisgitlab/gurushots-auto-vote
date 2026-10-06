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
    // Which load the listing is on: a new search or load is a new generation, a member patched into
    // the listing on screen (setMember) is not. What a Retry did belongs to the generation it was
    // pressed on.
    const [generation, setGeneration] = useState(0);
    const requestRef = useRef(0);
    const lastSearchRef = useRef('');

    const load = useCallback(
        async (search: string) => {
            const request = ++requestRef.current;
            lastSearchRef.current = search;
            setGeneration((count) => count + 1);
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

    // A member the listing could not name but a later check did: put it in the listing on screen,
    // without reading the library again.
    const setMember = useCallback((memberId: string) => {
        rememberCurrentMember(memberId);
        setState((prev) =>
            prev.status === 'ready' ? { status: 'ready', listing: { ...prev.listing, memberId } } : prev,
        );
    }, []);

    return { state, known, generation, load, setMember, retry: () => void load(lastSearchRef.current) };
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
 * `unconfirmed` (the listing is ready but the list could not be read for this account, so Retry).
 */
type SavedListStatus = 'ok' | 'pending' | 'unconfirmed';

/** What asking the main process for the account came back with. */
export type AccountCheck = { memberId: string } | { error: 'not-logged-in' | 'account-check-failed' };

/** Why a held list stays `unconfirmed`, as the chooser tells it (each has its own hint). */
type SavedListFailure = 'unconfirmed' | 'check-failed' | 'not-logged-in' | 'read-failed' | 'read-failed-again';

/**
 * The read itself: once the listing shows the saved list is this account's (`ownersList`),
 * `reloadSaved` asks for it and `onRead` gets its ids. A read that gives nothing or rejects is
 * `failed` for that listing; a new listing is not a failed one, so it reads as pending at once
 * instead of flashing the unconfirmed state for a paint, and is read again. `again` retries
 * (`busy` until the read ends, either way); `retried` is true for the listing generation it was
 * pressed on only, so a repeat is never claimed for a different listing.
 */
function useSavedListRead({
    ownersList,
    state,
    generation,
    reloadSaved,
    onRead,
}: {
    ownersList: boolean;
    state: ListState;
    generation: number;
    reloadSaved?: () => Promise<string[] | null>;
    onRead: (ids: string[]) => void;
}) {
    const [reloaded, setReloaded] = useState(false);
    // A retry pressed for the read: it is under way (`busy`), and a failure after one is a repeat.
    const [busy, setBusy] = useState(false);
    const [retriedAt, setRetriedAt] = useState<number | null>(null);
    const [failedAt, setFailedAt] = useState<ListState | null>(null);
    const [attempt, setAttempt] = useState(0);
    const inFlight = useRef(false);
    const latestState = useRef(state);
    latestState.current = state;
    useEffect(() => {
        if (!ownersList || reloaded || !reloadSaved || inFlight.current) return;
        inFlight.current = true;
        const finish = (ids: string[] | null) => {
            inFlight.current = false;
            setBusy(false);
            if (ids === null) {
                setFailedAt(latestState.current);
                return;
            }
            onRead(ids);
            setReloaded(true);
        };
        reloadSaved().then(finish, () => finish(null));
    }, [ownersList, reloaded, reloadSaved, onRead, attempt, state]);
    const again = () => {
        setBusy(true);
        setRetriedAt(generation);
        setFailedAt(null);
        setAttempt((count) => count + 1);
    };
    return { reloaded, failed: failedAt === state, busy, retried: retriedAt === generation, again };
}

/**
 * See SavedListStatus: asks the account check again (`confirmAccount`: the member only, never the
 * library), putting a member it finds into the listing on screen (`onMember`) and recording why it
 * found none (`setCheckFailure`); `setBusy(false)` once it has answered.
 */
function checkAccount({
    confirmAccount,
    onMember,
    setBusy,
    setCheckFailure,
}: {
    confirmAccount: () => Promise<AccountCheck>;
    onMember: (memberId: string) => void;
    setBusy: (busy: boolean) => void;
    setCheckFailure: (failure: 'failed' | 'not-logged-in') => void;
}) {
    const done = (check: AccountCheck) => {
        setBusy(false);
        if ('memberId' in check) onMember(check.memberId);
        else setCheckFailure(check.error === 'not-logged-in' ? 'not-logged-in' : 'failed');
    };
    confirmAccount().then(done, () => done({ error: 'account-check-failed' }));
}

/**
 * The Retry: asks the read again when the owner's list is the one waiting, the account check when
 * the listing could not name the member, else the listing. `busy` covers the check and a retried
 * read; `pressed` once Retry has been pressed; `checkFailure` is why the check found no member.
 */
function useSavedListRetry({
    ownersList,
    memberId,
    generation,
    read,
    confirmAccount,
    onMember,
    retryListing,
}: {
    ownersList: boolean;
    memberId: string | null;
    generation: number;
    read: Pick<ReturnType<typeof useSavedListRead>, 'busy' | 'again'>;
    confirmAccount: () => Promise<AccountCheck>;
    onMember: (memberId: string) => void;
    retryListing: () => void;
}) {
    const [checkBusy, setCheckBusy] = useState(false);
    // Both belong to the listing generation Retry was pressed on: a new search starts clean.
    const [failure, setFailure] = useState<{ generation: number; kind: 'failed' | 'not-logged-in' } | null>(null);
    const [pressedAt, setPressedAt] = useState<number | null>(null);
    const busy = checkBusy || read.busy;
    const retry = () => {
        if (busy) return;
        setFailure(null);
        setPressedAt(generation);
        if (ownersList) read.again();
        else if (memberId === null) {
            setCheckBusy(true);
            checkAccount({
                confirmAccount,
                onMember,
                setBusy: setCheckBusy,
                setCheckFailure: (kind) => setFailure({ generation, kind }),
            });
        } else retryListing();
    };
    return {
        busy,
        pressed: pressedAt === generation,
        checkFailure: failure?.generation === generation ? failure.kind : null,
        retry,
    };
}

/** Which failure keeps an unconfirmed list held: the account check's, or the read's (first, or a repeat). */
const failureOf = (
    checkFailure: 'failed' | 'not-logged-in' | null,
    ownersList: boolean,
    readRetried: boolean,
): SavedListFailure => {
    // Once the listing names the owner the account is known: whatever fails is the read.
    if (ownersList) return readRetried ? 'read-failed-again' : 'read-failed';
    if (checkFailure === 'not-logged-in') return 'not-logged-in';
    return checkFailure === 'failed' ? 'check-failed' : 'unconfirmed';
};

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
 * fails or rejects, ends in `unconfirmed` with a `failure` that says which, and `retry` asks again.
 * For an unknown member that is `confirmAccount` (the member only, never the library again), whose
 * answer goes into the listing on screen through `onMember`; a signed-out answer has no retry. For
 * a failed read it is the read, and a second failure is `read-failed-again`. `busy` is true from the
 * press until the answer; `retrying` also covers the read that follows a press; `checking` is any
 * read for a ready listing on its way; `confirmed` is true once a pressed Retry has lifted the hold
 * and the list is read.
 */
export function useSavedListReread({
    withheld,
    owner,
    state,
    generation,
    reloadSaved,
    confirmAccount,
    retryListing,
    onMember,
    onRead,
}: {
    withheld: boolean;
    owner: string;
    state: ListState;
    /** Which load of the listing this is (see useLibraryListing): what a Retry did belongs to one. */
    generation: number;
    reloadSaved?: () => Promise<string[] | null>;
    confirmAccount: () => Promise<AccountCheck>;
    retryListing: () => void;
    onMember: (memberId: string) => void;
    onRead: (ids: string[]) => void;
}) {
    const memberId = state.status === 'ready' ? state.listing.memberId : null;
    const ownersList = withheld && owner !== '' && memberId === owner;
    const canRead = !!reloadSaved;
    const read = useSavedListRead({ ownersList, state, generation, reloadSaved, onRead });
    const retrying = useSavedListRetry({
        ownersList: ownersList && canRead,
        memberId,
        generation,
        read,
        confirmAccount,
        onMember,
        retryListing,
    });

    const otherAccount = memberId !== null && owner !== '' && memberId !== owner;
    const unread = withheld && !read.reloaded && !otherAccount;
    const waiting = state.status !== 'ready' || (ownersList && canRead && !read.failed);
    const status: SavedListStatus = !unread ? 'ok' : waiting ? 'pending' : 'unconfirmed';
    const checking = status === 'pending' && state.status === 'ready';
    const failure = status === 'unconfirmed' ? failureOf(retrying.checkFailure, ownersList, read.retried) : null;
    return {
        status,
        failure,
        retry: retrying.retry,
        busy: retrying.busy,
        checking,
        retrying: retrying.busy || (retrying.pressed && checking),
        confirmed: retrying.pressed && status === 'ok' && read.reloaded,
    };
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
