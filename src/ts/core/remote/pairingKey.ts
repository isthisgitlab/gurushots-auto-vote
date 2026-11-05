/**
 * Where the phone keeps the pairing key: only in the link's `#k=` fragment and in that tab's
 * `sessionStorage` — never in `localStorage`, because every Pages site under one origin shares
 * it. The fragment stays in the address bar, so a bookmark or "Add to Home Screen" keeps the
 * link and the phone stays paired with no re-scan. On the Android remote mode the key is also
 * stored in the app's own Preferences under `gs_remote_access` (the wipe clears it with the
 * rest of the local data; see LOCAL_DATA_STORES in settings/localData.ts). Dependency-free.
 */

/** The sessionStorage key the tab's copy of the pairing key is kept under. */
export const PAIRING_KEY_STORAGE = 'remote-pairing-key';

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
 * The loader document's path: it ends in the `remote` segment, with the trailing slash or an
 * `index.html` optional. What comes before is the site's own base path (the Pages site lives
 * under `/gurushots-auto-vote/`; a dev-local origin has none).
 */
const LOADER_PATH_PATTERN = /\/remote(?:\/(?:index\.html)?)?$/;

/**
 * The stable loader's address from a versioned page (`/remote/v<N>/index.html`, or a legacy `/remote/<appVersion>/index.html`): the address bar
 * shows `../#k=<key>`, so a bookmark or "Add to Home Screen" keeps a link that survives the next
 * desktop update and the next link version.
 */
export const loaderAddressBarUrl = (key: string): string => `../#k=${encodeURIComponent(key)}`;

/**
 * The same loader as a navigation target. It is addressed by file name: the Android app's local server
 * answers a directory path with the app's own document, and the Pages site serves the same file.
 */
export const loaderNavigationUrl = (key: string): string => `../index.html#k=${encodeURIComponent(key)}`;

/** Whether `value` reads as a pairing key (base64url, the desktop key's exact length). */
export const isPairingKey = (value: string): boolean => PAIRING_KEY_PATTERN.test(value);

/**
 * The pairing key of a pasted pairing link (`<origin>/remote/#k=<key>`, the Pages loader's
 * address or a dev-local origin), or null when the text is not one: only the key is kept,
 * nothing else of the link. A missing or malformed key, a link to some other path of the site,
 * and non-web schemes are refused — the caller shows the same "not a pairing link" message.
 */
export const parsePairingLink = (link: string): string | null => {
    let url: URL;
    try {
        url = new URL(link.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // The loader's address; a missing trailing slash or an index.html is the same document.
    if (!LOADER_PATH_PATTERN.test(url.pathname)) return null;
    const key = new URLSearchParams(url.hash.slice(1)).get(PAIRING_KEY_PARAM);
    return key !== null && isPairingKey(key) ? key : null;
};

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
