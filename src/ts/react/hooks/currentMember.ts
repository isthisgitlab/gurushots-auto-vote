/**
 * The member id the library listings report — the signed-in account, as the main process sees it.
 * A listing carries it, so once one has landed the chosen-photo chips can build their thumbnails
 * from it. Held for the page's lifetime: a sign-out reloads the renderer, so it never outlives the
 * account it belongs to. One account per install: a new value replaces the old, and nothing
 * compares or invalidates beyond that.
 */

import { useSyncExternalStore } from 'react';

let currentMemberId: string | null = null;
const observers = new Set<() => void>();

/** Record (or, with null, forget) the member id a listing reported. */
export const rememberCurrentMember = (memberId: string | null): void => {
    if (memberId === currentMemberId) return;
    currentMemberId = memberId;
    observers.forEach((notify) => notify());
};

const subscribeToMember = (notify: () => void): (() => void) => {
    observers.add(notify);
    return () => {
        observers.delete(notify);
    };
};

const readCurrentMember = (): string | null => currentMemberId;

/** The member id the last listing that carried one reported, or null before that. */
export function useCurrentMember(): string | null {
    return useSyncExternalStore(subscribeToMember, readCurrentMember);
}
