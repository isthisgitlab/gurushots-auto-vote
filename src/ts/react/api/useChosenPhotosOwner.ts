import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

// The member id the library listing last reported — the signed-in account, as the
// main process sees it. Held for the page's lifetime: a sign-out reloads the
// renderer, so it never outlives the account it belongs to.
let observedMemberId: string | null = null;

/** Record (or, with null, forget) the signed-in member the library listing reported. */
export const rememberCurrentMember = (memberId: string | null): void => {
    observedMemberId = memberId;
};

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
 * The member id to build a chosen photo's thumbnail from: the list's owner, but
 * only once the listing has shown that owner IS the signed-in account. A list
 * saved under another account must not put that account's photos on screen.
 */
export function useChosenThumbMember(): string | null {
    const owner = useChosenPhotosOwner();
    return owner !== '' && owner === observedMemberId ? owner : null;
}
