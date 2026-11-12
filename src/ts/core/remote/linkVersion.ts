/**
 * The historical stored link-version key is cleared on Disconnect. Routing now follows the URL, so no current code
 * writes or reads it. The same module keeps the per-tab skip marker that bounds one target's versioned-page bounce.
 */

import { isPairingKey } from './pairingKey';

import type { PairingTarget } from './pairingKey';

/** The `localStorage` key the link version is kept under. */
export const LINK_VERSION_STORAGE = 'gs-remote-link-version';

/** The `sessionStorage` key of the loop guard: the pairing target this tab already went straight to. */
export const SKIPPED_TO_STORAGE = 'gs-remote-skipped-to';

/** The text form of a stored link version: no sign, no leading zero, no exponent, at most three digits. */
const STORED_LINK_VERSION_PATTERN = /^[1-9]\d{0,2}$/;

/** The link version a stored text names, or null when it is not of the stored form (the form is exactly the 1–999 rule). */
const parseStoredLinkVersion = (text: string | null): number | null =>
    text !== null && STORED_LINK_VERSION_PATTERN.test(text) ? Number(text) : null;

/** A target-aware loop mark, or null for a legacy version-only or malformed value. */
const parseSkipMark = (text: string | null): PairingTarget | null => {
    const [version, key, ...rest] = text?.split(':') ?? [];
    const linkVersion = parseStoredLinkVersion(version ?? null);
    return rest.length === 0 && linkVersion !== null && key !== undefined && isPairingKey(key)
        ? { key, linkVersion }
        : null;
};

/** Runs a storage action; a browser that refuses site data cannot retain the per-tab marker. */
const attempt = <T>(action: () => T, fallback: T): T => {
    try {
        return action();
    } catch {
        // aislop-ignore-next-line ai-slop/hidden-fallback -- browser storage is optional; the caller handles the unavailable value
        return fallback;
    }
};

/** Forgets the stored link version (Disconnect, a value that cannot be trusted). */
export const clearLinkVersion = (): void => {
    attempt(() => globalThis.localStorage?.removeItem(LINK_VERSION_STORAGE), undefined);
};

/** Whether this tab already went straight to this exact target (legacy version-only marks cannot block a target). */
export const skippedTo = (target: PairingTarget): boolean => {
    const marked = parseSkipMark(attempt(() => globalThis.sessionStorage?.getItem(SKIPPED_TO_STORAGE) ?? null, null));
    return marked?.linkVersion === target.linkVersion && marked.key === target.key;
};

/** Marks that this tab is going straight to this target's page. */
export const markSkippedTo = (target: PairingTarget): void => {
    attempt(
        () => globalThis.sessionStorage?.setItem(SKIPPED_TO_STORAGE, `${target.linkVersion}:${target.key}`),
        undefined,
    );
};

/** The page accepted the desktop: the mark has done its work, so a reload of the loader in this tab may go straight on again. */
export const clearSkipMark = (): void => {
    attempt(() => globalThis.sessionStorage?.removeItem(SKIPPED_TO_STORAGE), undefined);
};
