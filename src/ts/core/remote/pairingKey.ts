/**
 * Where the phone keeps the pairing key: only in the link's `#k=` fragment — never in
 * `localStorage`, because every Pages site under one origin shares it. The fragment stays in the
 * address bar, so a bookmark or "Add to Home Screen" keeps the link and the phone stays paired
 * with no re-scan. On the Android remote mode the key is also
 * stored in the app's own Preferences under `gs_remote_access` (the wipe clears it with the
 * rest of the local data; see LOCAL_DATA_STORES in settings/localData.ts). Dependency-free.
 */

/** The fragment parameter the pairing link carries the key in (`#k=<key>`). */
export const PAIRING_KEY_PARAM = 'k';

/**
 * The Preferences key the Android remote mode stores its pairing key under: the desktop pairing
 * store's key (remote-access.json / `gs_remote_access`), so the wipe's store list covers it.
 */
export const ANDROID_PAIRING_KEY_PREF = 'gs_remote_access';

/** The pairing key's shape: 32 random bytes in base64url, as the desktop's pairing store makes them. */
const PAIRING_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The current remote page's canonical path. What comes before is the site's own base path (the
 * Pages site lives under `/gurushots-auto-vote/`; a dev-local origin has none).
 */
const CURRENT_REMOTE_PAGE_PATH_PATTERN = /\/remote\/v2\/(?:index\.html)?$/;

/** Whether `value` reads as a pairing key (base64url, the desktop key's exact length). */
export const isPairingKey = (value: string): boolean => PAIRING_KEY_PATTERN.test(value);

/**
 * The validated key in a pasted current pairing link. Canonical current page paths only are
 * accepted; malformed fragments, unrelated paths, and non-web schemes are refused.
 */
export const parsePairingLink = (link: string): string | null => {
    let url: URL;
    try {
        url = new URL(link.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const fragment = new URLSearchParams(url.hash.slice(1));
    const keys = fragment.getAll(PAIRING_KEY_PARAM);
    const key = keys[0];
    if (key === undefined || keys.length !== 1 || !isPairingKey(key)) return null;
    if (fragment.has('v')) return null;
    return CURRENT_REMOTE_PAGE_PATH_PATTERN.test(url.pathname) ? key : null;
};

/**
 * The pairing key this page was opened with, read only from the fragment. The fragment itself
 * is left in the address bar. Null when it is absent, malformed, or duplicated.
 */
export const takePairingKey = (): string | null => {
    const keys = new URLSearchParams(globalThis.location.hash.slice(1)).getAll(PAIRING_KEY_PARAM);
    const key = keys[0];
    return key !== undefined && keys.length === 1 && isPairingKey(key) ? key : null;
};
