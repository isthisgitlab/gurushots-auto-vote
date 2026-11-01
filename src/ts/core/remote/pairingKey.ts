/**
 * Where the phone keeps the pairing key: only in the link's `#k=` fragment and in that tab's
 * `sessionStorage` — never in `localStorage`, because every Pages site under one origin shares
 * it. The fragment stays in the address bar, so a bookmark or "Add to Home Screen" keeps the
 * link and the phone stays paired with no re-scan. Dependency-free.
 */

/** The sessionStorage key the tab's copy of the pairing key is kept under. */
export const PAIRING_KEY_STORAGE = 'remote-pairing-key';

/** The fragment parameter the pairing link carries the key in (`#k=<key>`). */
export const PAIRING_KEY_PARAM = 'k';

const keptKey = (): string | null => {
    try {
        return globalThis.sessionStorage?.getItem(PAIRING_KEY_STORAGE) ?? null;
    } catch {
        return null; // a browser that refuses site data: the fragment still carries the key
    }
};

const keepKey = (key: string): void => {
    try {
        globalThis.sessionStorage?.setItem(PAIRING_KEY_STORAGE, key);
    } catch {
        // memory only
    }
};

/**
 * The pairing key this page was opened with: taken from the fragment when there is one (and
 * kept for the tab, so a reload keeps working), otherwise from what the tab kept. The
 * fragment itself is left in the address bar. Null when the page was opened without a key.
 */
export const takePairingKey = (): string | null => {
    const given = new URLSearchParams(globalThis.location.hash.slice(1)).get(PAIRING_KEY_PARAM);
    if (given !== null && given.length > 0) keepKey(given);
    return given && given.length > 0 ? given : keptKey();
};
