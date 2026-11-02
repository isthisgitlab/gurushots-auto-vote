/**
 * The desktop version the phone last reached, kept so the loader can go straight to that version's page on a return
 * visit instead of connecting just to read it. It lives in `localStorage` under an app-namespaced key (a mismatch
 * costs one extra connect, never a wrong page), as `<fingerprint>:<version>`; the fingerprint is the first 16 hex
 * digits of the SHA-256 of the pairing room's id, so a value kept for another pairing is not trusted. It never
 * holds the pairing key (the key stays out of `localStorage`, see pairingKey.ts), and a hash of the room id, itself a
 * hash of the key, tells nothing of it. Written only from a desktop's `hello` whose version is a release version.
 *
 * The same module keeps the loop guard: a `sessionStorage` mark, "skipped to V", written before the loader goes
 * straight to V's page. A page that finds another desktop version stores it and bounces the tab back to the loader,
 * which then goes to the right page; a page that stores nothing (an older one) bounces the tab back with the stored
 * version unchanged, and the mark tells the loader it already went there, so it runs the whole flow instead of
 * looping. Dependency-free apart from the pairing key and the room id.
 */

import { takePairingKey } from './pairingKey';
import { isReleaseVersion } from './protocol';

/** The `localStorage` key the desktop version is kept under. */
export const DESKTOP_VERSION_STORAGE = 'gs-remote-desktop-version';

/** The `sessionStorage` key of the loop guard: the version this tab already went straight to. */
export const SKIPPED_TO_STORAGE = 'gs-remote-skipped-to';

const FINGERPRINT_DIGITS = 16;

const sha256Hex = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * The short fingerprint of a pairing key's room: the room id is the SHA-256 of the key (trystero.ts, `roomIdForKey`),
 * and the fingerprint is the first digits of the SHA-256 of that id. It is only compared with itself, so it needs
 * to be the same for a key every time, not to equal anything else.
 */
const fingerprintOf = async (key: string): Promise<string> =>
    (await sha256Hex(await sha256Hex(key))).slice(0, FINGERPRINT_DIGITS);

/** Runs a storage action; a browser that refuses site data keeps nothing, which only costs the shortcut. */
const attempt = <T>(action: () => T, fallback: T): T => {
    try {
        return action();
    } catch {
        return fallback;
    }
};

/** Forgets the stored desktop version (Disconnect, a value that cannot be trusted). */
export const clearDesktopVersion = (): void => {
    attempt(() => globalThis.localStorage?.removeItem(DESKTOP_VERSION_STORAGE), undefined);
};

/** Keeps the version of the desktop this page's pairing reached. Ignores a version that is not a release version, and a page without a key. */
export const storeDesktopVersion = async (version: string): Promise<void> => {
    const key = takePairingKey();
    if (key === null || !isReleaseVersion(version)) return;
    const value = `${await fingerprintOf(key)}:${version}`;
    attempt(() => globalThis.localStorage?.setItem(DESKTOP_VERSION_STORAGE, value), undefined);
};

/**
 * The stored version for this pairing key, or null. A value that is not of the stored shape, whose version is not a
 * release version, or that was kept for another pairing is cleared and answers null.
 */
export const storedDesktopVersion = async (key: string): Promise<string | null> => {
    const value = attempt(() => globalThis.localStorage?.getItem(DESKTOP_VERSION_STORAGE) ?? null, null);
    if (value === null) return null;
    const [fingerprint, ...rest] = value.split(':');
    const version = rest.join(':');
    if (fingerprint === (await fingerprintOf(key)) && isReleaseVersion(version)) return version;
    clearDesktopVersion();
    return null;
};

/** The version this tab already went straight to, or null. */
export const skippedTo = (): string | null =>
    attempt(() => globalThis.sessionStorage?.getItem(SKIPPED_TO_STORAGE) ?? null, null);

/** Marks that this tab is going straight to the version's page. */
export const markSkippedTo = (version: string): void => {
    attempt(() => globalThis.sessionStorage?.setItem(SKIPPED_TO_STORAGE, version), undefined);
};

/** The page accepted the desktop: the mark has done its work, so a reload of the loader in this tab may go straight on again. */
export const clearSkipMark = (): void => {
    attempt(() => globalThis.sessionStorage?.removeItem(SKIPPED_TO_STORAGE), undefined);
};
