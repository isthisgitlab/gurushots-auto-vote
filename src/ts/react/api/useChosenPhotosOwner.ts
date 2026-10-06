import { useSyncExternalStore } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

// The member id the library listing last reported — the signed-in account, as the
// main process sees it. Held for the page's lifetime: a sign-out reloads the
// renderer, so it never outlives the account it belongs to. Readers subscribe, so
// what shows a list updates once a listing has told it whose account this is.
let observedMemberId: string | null = null;
const observers = new Set<() => void>();

/** Record (or, with null, forget) the signed-in member the library listing reported. */
export const rememberCurrentMember = (memberId: string | null): void => {
    if (memberId === observedMemberId) return;
    observedMemberId = memberId;
    observers.forEach((notify) => notify());
};

const subscribeToMember = (notify: () => void): (() => void) => {
    observers.add(notify);
    return () => {
        observers.delete(notify);
    };
};

const readObservedMember = (): string | null => observedMemberId;

const fetchOwner = async (): Promise<string> => {
    const owner = await ipc.getSetting('chosenPhotosMemberId');
    return typeof owner === 'string' ? owner : '';
};

/**
 * The member who last saved a Chosen Photos list ('' = not recorded yet). Kept
 * current across settings writes, since saving a list stamps its owner.
 */
export function useChosenPhotosOwner(): string {
    const { data: owner } = useIpcQuery(fetchOwner, { initialData: '', subscribe: true });
    return owner;
}

/**
 * How the saved lists relate to the signed-in account, as far as a library
 * listing has shown which account that is (until then the renderer cannot tell,
 * so `otherAccount` is false and `thumbMember` null).
 *
 * `thumbMember` is the member id to build a chosen photo's thumbnail from: the
 * list's owner, once the listing has shown that owner IS the signed-in account.
 * `otherAccount` is true when the lists belong to a different account, whose
 * photos must be neither shown nor named.
 */
export function useChosenListAccount(): { thumbMember: string | null; otherAccount: boolean } {
    const owner = useChosenPhotosOwner();
    const signedIn = useSyncExternalStore(subscribeToMember, readObservedMember);
    return {
        thumbMember: owner !== '' && owner === signedIn ? owner : null,
        otherAccount: owner !== '' && signedIn !== null && owner !== signedIn,
    };
}
