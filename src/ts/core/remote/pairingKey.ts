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

/** A versioned remote page path, with a strict decimal link version. */
const VERSIONED_PAGE_PATH_PATTERN = /\/remote\/v([1-9]\d{0,2})(?:\/(?:index\.html)?)?$/;

/** The fragment version used only when a versioned page redirects to the root loader. */
const LINK_VERSION_PARAM = 'v';

/** A parsed pairing link keeps the version the phone must run with its persistent pairing key. */
export type PairingTarget = { key: string; linkVersion: number };

/**
 * The root loader as a navigation target. It is addressed by file name: the Android app's local server
 * answers a directory path with its own document, and the Pages site serves the same file. A modern
 * versioned page includes its checked version so the loader never needs a stored-version preference.
 */
export const loaderNavigationUrl = (key: string, linkVersion: number): string => {
    const fragment = new URLSearchParams({ [PAIRING_KEY_PARAM]: key });
    fragment.set(LINK_VERSION_PARAM, String(linkVersion));
    return `../index.html#${fragment.toString()}`;
};

/** Whether `value` reads as a pairing key (base64url, the desktop key's exact length). */
export const isPairingKey = (value: string): boolean => PAIRING_KEY_PATTERN.test(value);

/**
 * The validated pairing target of a pasted link. Unversioned loader URLs are v1. A canonical
 * versioned page path is authoritative; a loader may carry a `v` fragment from a modern page redirect.
 * Malformed or conflicting metadata, unrelated paths, and non-web schemes are refused.
 */
export const parsePairingLink = (link: string): PairingTarget | null => {
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
    const versions = fragment.getAll(LINK_VERSION_PARAM);
    if (versions.length > 1) return null;
    const hinted = versions[0];
    const hint = hinted !== undefined && /^[1-9]\d{0,2}$/.test(hinted) ? Number(hinted) : null;
    if (hinted !== undefined && hint === null) return null;
    const versioned = VERSIONED_PAGE_PATH_PATTERN.exec(url.pathname);
    if (versioned !== null) {
        const linkVersion = Number(versioned[1]);
        if (hinted !== undefined) return null;
        return { key, linkVersion };
    }
    if (!LOADER_PATH_PATTERN.test(url.pathname)) return null;
    return { key, linkVersion: hint ?? 1 };
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
