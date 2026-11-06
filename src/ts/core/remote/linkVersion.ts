/**
 * The link version the phone last reached, kept so the loader can go straight to that version's page on a return
 * visit instead of connecting just to read it. It lives in `localStorage` under an app-namespaced key (a mismatch
 * costs one extra connect, never a wrong page), as `<fingerprint>:<N>`; the fingerprint is the first 16 hex
 * digits of the SHA-256 of the pairing room's id, so a value kept for another pairing is not trusted. It never
 * holds the pairing key (the key stays out of `localStorage`, see pairingKey.ts), and a hash of the room id, itself a
 * hash of the key, tells nothing of it. `N` is written without a leading zero or an exponent and read back under the
 * same rule (`^[1-9]\d{0,2}$`). Only a desktop `hello` writes it.
 *
 * The same module keeps the loop guard: a `sessionStorage` mark, "skipped to N", written before the loader goes
 * straight to v<N>'s page. A page that finds another link version stores it and bounces the tab back to the loader,
 * which then goes to the right page; a page that stores nothing (a write the browser refused) bounces the tab back with
 * the stored version unchanged, and the mark tells the loader it already went there, so it runs the whole flow
 * instead of looping. Dependency-free apart from the pairing key and the room id.
 */

import { takePairingKey } from './pairingKey';
import { isLinkVersion } from './protocol';

/** The `localStorage` key the link version is kept under. */
export const LINK_VERSION_STORAGE = 'gs-remote-link-version';

/** The `sessionStorage` key of the loop guard: the link version this tab already went straight to. */
export const SKIPPED_TO_STORAGE = 'gs-remote-skipped-to';

const FINGERPRINT_DIGITS = 16;

/** The text form of a stored link version: no sign, no leading zero, no exponent, at most three digits. */
const STORED_LINK_VERSION_PATTERN = /^[1-9]\d{0,2}$/;

/** The link version a stored text names, or null when it is not of the stored form (the form is exactly the 1–999 rule). */
const parseStoredLinkVersion = (text: string | null): number | null =>
    text !== null && STORED_LINK_VERSION_PATTERN.test(text) ? Number(text) : null;

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
        // aislop-ignore-next-line ai-slop/hidden-fallback -- a browser that refuses site data keeps nothing; the caller's fallback is the designed answer and only costs the shortcut
        return fallback;
    }
};

/** Forgets the stored link version (Disconnect, a value that cannot be trusted). */
export const clearLinkVersion = (): void => {
    attempt(() => globalThis.localStorage?.removeItem(LINK_VERSION_STORAGE), undefined);
};

/** Keeps the link version of the desktop this page's pairing reached. Ignores a value that is not a link version, and a page without a key. */
export const storeLinkVersion = async (linkVersion: number): Promise<void> => {
    const key = takePairingKey();
    if (key === null || !isLinkVersion(linkVersion)) return;
    const value = `${await fingerprintOf(key)}:${linkVersion}`;
    attempt(() => globalThis.localStorage?.setItem(LINK_VERSION_STORAGE, value), undefined);
};

/**
 * The stored link version for this pairing key, or null. A value that is not of the stored shape, whose number is
 * not a link version, or that was kept for another pairing is cleared and answers null.
 */
export const storedLinkVersion = async (key: string): Promise<number | null> => {
    const value = attempt(() => globalThis.localStorage?.getItem(LINK_VERSION_STORAGE) ?? null, null);
    if (value === null) return null;
    const [fingerprint, ...rest] = value.split(':');
    const linkVersion = parseStoredLinkVersion(rest.join(':'));
    if (fingerprint === (await fingerprintOf(key)) && linkVersion !== null) return linkVersion;
    clearLinkVersion();
    return null;
};

/** The link version this tab already went straight to, or null (also for a mark that is not of the stored form). */
export const skippedTo = (): number | null =>
    parseStoredLinkVersion(attempt(() => globalThis.sessionStorage?.getItem(SKIPPED_TO_STORAGE) ?? null, null));

/** Marks that this tab is going straight to the link version's page, in the same form the stored value has. */
export const markSkippedTo = (linkVersion: number): void => {
    attempt(() => globalThis.sessionStorage?.setItem(SKIPPED_TO_STORAGE, String(linkVersion)), undefined);
};

/** The page accepted the desktop: the mark has done its work, so a reload of the loader in this tab may go straight on again. */
export const clearSkipMark = (): void => {
    attempt(() => globalThis.sessionStorage?.removeItem(SKIPPED_TO_STORAGE), undefined);
};
