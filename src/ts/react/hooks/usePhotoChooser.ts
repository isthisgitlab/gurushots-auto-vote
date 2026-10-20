/**
 * State behind the Chosen Photos chooser: which account the saved lists belong to (checked on open,
 * never by reading the library), and the re-read of a list that came without its ids.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ListState } from './useLibraryListing';

/**
 * Whether the lists on record belong to another account than the signed-in one,
 * judged on the list the modal opened with (`savedCount`), not the live selection,
 * so choosing photos does not make the notice come and go. Once seen it stays until
 * the lists are removed: a search puts the listing back to loading (or an error),
 * which must not hide the notice and the photos it withholds. `onFirstSeen` runs
 * once, as soon as it is seen — the other account's photos are not this account's
 * to build on, so the selection then starts empty. The member is the known one:
 * the check's answer, or a listing's once a read has named it.
 */
export function useOtherAccountLists({
    savedCount,
    owner,
    memberId,
    removed,
    onFirstSeen,
}: {
    savedCount: number;
    owner: string;
    memberId: string | null;
    removed: boolean;
    onFirstSeen: () => void;
}): boolean {
    const otherNow = savedCount > 0 && owner !== '' && memberId !== null && owner !== memberId;
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
 * list, which the notice covers), `pending` (the member is still being asked for, or the read is
 * still on its way) or `unconfirmed` (the list could not be read for this account, so Retry).
 */
type SavedListStatus = 'ok' | 'pending' | 'unconfirmed';

/** What asking the main process for the account came back with. */
export type AccountCheck = { memberId: string } | { error: 'not-logged-in' | 'account-check-failed' };

/** Why a held list stays `unconfirmed`, as the chooser tells it (each has its own hint). */
type SavedListFailure =
    | 'unconfirmed'
    | 'check-failed'
    | 'not-logged-in'
    | 'read-failed'
    | 'read-failed-again'
    | 'owner-read-failed';

/**
 * The read itself: once the member shows the saved list is this account's (`ownersList`),
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
    // The same flag as a ref: an effect that runs late (preact defers them past the render) reads
    // the current value, not the one its render closed over, so a finished read is never repeated.
    const reloadedRef = useRef(false);
    // A retry pressed for the read: it is under way (`busy`), and a failure after one is a repeat.
    const [busy, setBusy] = useState(false);
    const [retriedAt, setRetriedAt] = useState<number | null>(null);
    const [failedAt, setFailedAt] = useState<ListState | null>(null);
    const [attempt, setAttempt] = useState(0);
    const inFlight = useRef(false);
    const latestState = useRef(state);
    latestState.current = state;
    useEffect(() => {
        if (!ownersList || reloadedRef.current || !reloadSaved || inFlight.current) return;
        inFlight.current = true;
        const finish = (ids: string[] | null) => {
            // The in-flight slot is released only after the states have been set: a render flushed
            // between them must not see the read as finished (and ask again).
            if (ids === null) {
                setBusy(false);
                setFailedAt(latestState.current);
                inFlight.current = false;
                return;
            }
            onRead(ids);
            reloadedRef.current = true;
            setReloaded(true);
            setBusy(false);
            inFlight.current = false;
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
 * The Retry, and the member check the chooser runs on opening: with `checkOnOpen` (a list is on
 * record somewhere) the member is asked for once, without a press, as soon as no listing and no
 * earlier check has named it. The Retry asks the read again when the owner's list is the one
 * waiting, the account check when no member is known, else the listing (the owner record may still
 * land while one is read). `busy` covers the check and a retried read; `pressed` once Retry has
 * been pressed; `asking` is the member check on its way; `checkFailure` is why the check found no
 * member — kept until a new check or a member that lands replaces it, never dropped by a listing
 * read that changes nothing about the account.
 */
function useSavedListRetry({
    ownersList,
    memberId,
    generation,
    read,
    confirmAccount,
    onMember,
    retryListing,
    checkOnOpen,
}: {
    ownersList: boolean;
    memberId: string | null;
    generation: number;
    read: Pick<ReturnType<typeof useSavedListRead>, 'busy' | 'again'>;
    confirmAccount: () => Promise<AccountCheck>;
    onMember: (memberId: string) => void;
    /** Reads the listing again and answers the generation that read is. */
    retryListing: () => number;
    checkOnOpen: boolean;
}) {
    const [checkBusy, setCheckBusy] = useState(false);
    // Why the check found no member. It belongs to no listing generation: a Load all or a Search
    // says nothing about the account, so only a new check, or a member a check or listing names,
    // may replace it.
    const [failure, setFailure] = useState<'failed' | 'not-logged-in' | null>(null);
    const [pressedAt, setPressedAt] = useState<number | null>(null);
    const asked = useRef(false);
    useEffect(() => {
        if (!checkOnOpen || asked.current || memberId !== null) return;
        asked.current = true;
        setCheckBusy(true);
        checkAccount({ confirmAccount, onMember, setBusy: setCheckBusy, setCheckFailure: setFailure });
    }, [checkOnOpen, memberId, confirmAccount, onMember]);
    // A member that lands (the check's own answer, or a listing's) replaces the failure.
    useEffect(() => {
        if (memberId !== null) setFailure(null);
    }, [memberId]);
    const busy = checkBusy || read.busy;
    const retry = () => {
        if (busy) return;
        setFailure(null);
        // The press belongs to the generation it ends up on: a listing reload makes a new one.
        let pressedOn = generation;
        if (ownersList) read.again();
        else if (memberId === null) {
            setCheckBusy(true);
            checkAccount({ confirmAccount, onMember, setBusy: setCheckBusy, setCheckFailure: setFailure });
        } else pressedOn = retryListing();
        setPressedAt(pressedOn);
    };
    return { busy, pressed: pressedAt === generation, asking: checkBusy, checkFailure: failure, retry };
}

/** Which failure keeps an unconfirmed list held: the owner read's, the check's, or the read's (first, or a repeat). */
const failureOf = (
    ownerFailed: boolean,
    checkFailure: 'failed' | 'not-logged-in' | null,
    ownersList: boolean,
    readRetried: boolean,
): SavedListFailure => {
    // The owner read itself failed: whose list this is cannot even be asked about.
    if (ownerFailed) return 'owner-read-failed';
    // Once the member names the owner the account is known: whatever fails is the read.
    if (ownersList) return readRetried ? 'read-failed-again' : 'read-failed';
    if (checkFailure === 'not-logged-in') return 'not-logged-in';
    return checkFailure === 'failed' ? 'check-failed' : 'unconfirmed';
};

/**
 * A saved list can come without its ids (the main process withholds them until it knows whose
 * account this is), so the selection then starts empty, which is not what is saved. The member is
 * asked for on opening when a list is on record anywhere (`checkOnOpen`: `confirmAccount`, the
 * member only, never the library — its answer may land before the owner read does) and put into the
 * listing on screen through `onMember`; a listing that names one wins over the check's answer. Once
 * the member shows the list is this account's, `reloadSaved` reads it again (the member is known
 * now, so its ids come through) and `onRead` seeds the selection from it. Another account's list
 * stays withheld: the other-account notice covers it, and saving a new selection over it is then
 * the user's choice.
 *
 * While the status is not `ok` Save is held back — an empty or partial selection would replace the
 * user's own list — and the tiles are inert, so a late read cannot overwrite what was picked. A
 * member that cannot be named, an owner record that cannot be read, or a read that fails or
 * rejects, ends in `unconfirmed` with a `failure` that says which, and `retry` asks again: for an
 * unknown member that is `confirmAccount` (a signed-out answer has no retry), for a failed read the
 * read (a second failure is `read-failed-again`), for a member with no owner on record the listing
 * (the owner may still land while one is read). A failed owner read is the caller's to retry (it
 * re-reads the record, never the library). `busy` is true from the press until the answer;
 * `asking` is the member check on its way; `retrying` also covers the read that follows a press;
 * `checking` is any ask or read still on its way; `confirmed` is true once a pressed Retry has
 * lifted the hold and the list is read.
 */
export function useSavedListReread({
    withheld,
    owner,
    ownerKnown,
    ownerFailed,
    memberId,
    state,
    generation,
    reloadSaved,
    confirmAccount,
    retryListing,
    onMember,
    onRead,
    checkOnOpen,
}: {
    withheld: boolean;
    owner: string;
    /** Whether the owner record has been read (as opposed to still on its way). */
    ownerKnown: boolean;
    /** The owner read landed with an error: whose list this is cannot be judged. */
    ownerFailed: boolean;
    /** The member known without a library read: the check's answer, or a listing's once one is read. */
    memberId: string | null;
    state: ListState;
    /** Which load of the listing this is (see useLibraryListing): what a Retry did belongs to one. */
    generation: number;
    reloadSaved?: () => Promise<string[] | null>;
    confirmAccount: () => Promise<AccountCheck>;
    retryListing: () => number;
    onMember: (memberId: string) => void;
    onRead: (ids: string[]) => void;
    /** Whether to ask for the member on opening: a list is on record somewhere (this layer's own, or an owner any save has stamped). */
    checkOnOpen: boolean;
}) {
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
        checkOnOpen,
    });

    const otherAccount = memberId !== null && owner !== '' && memberId !== owner;
    const unread = withheld && !read.reloaded && !otherAccount;
    // The member matters for any list a check was run for, not only a withheld one: a pick that
    // came with its ids is held the same while the account is unknown or the check has failed.
    const memberHeld = checkOnOpen && memberId === null;
    // So does the owner: whose list this is cannot be judged while its record is still on its way
    // (or has failed), and saving restamps the owner — so it waits too.
    const ownerHeld = checkOnOpen && !ownerKnown;
    // Waiting on the member (its check on the way, or yet to be named with no failure recorded),
    // on the owner read the judgement needs, on a listing read that can bring the missing piece (a
    // Retry with no owner on record reloads it), or on the read. A failed owner read is not
    // waiting: it has answered.
    const waiting =
        (memberHeld && retrying.checkFailure === null) ||
        (ownerHeld && !ownerFailed) ||
        (ownerKnown && owner === '' && memberId !== null && state.status === 'loading') ||
        (ownersList && canRead && !read.failed);
    const status: SavedListStatus = !unread && !memberHeld && !ownerHeld ? 'ok' : waiting ? 'pending' : 'unconfirmed';
    const checking = status === 'pending';
    const failure =
        status === 'unconfirmed' ? failureOf(ownerFailed, retrying.checkFailure, ownersList, read.retried) : null;
    return {
        status,
        failure,
        retry: retrying.retry,
        busy: retrying.busy,
        askingMember: retrying.asking,
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
