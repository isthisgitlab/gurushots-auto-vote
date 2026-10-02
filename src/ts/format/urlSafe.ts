const parseUrl = (url: string): URL | null => {
    try {
        return new URL(url);
    } catch {
        return null;
    }
};

const hasNoCredentials = (parsed: URL): boolean => parsed.username === '' && parsed.password === '';

/**
 * Shared external-URL safety gate.
 *
 * Lives here (dependency-free, next to logSafe) so BOTH platform bridges share
 * one definition: the Electron `open-external-url` handler (ipc/misc.handlers.ts)
 * and the Capacitor `openExternalUrl` bridge (bridge/capacitor.ts). Separate
 * copies would let the two platforms silently diverge on a security control —
 * a caller passing API-sourced data through the Android path could get a
 * weaker guarantee (file:, intent:, javascript:, app-scheme handlers) than on
 * desktop.
 *
 * Every legitimate call site opens an https page (gurushots.com, GitHub
 * releases). Refusing anything else keeps this from ever becoming an
 * open-any-scheme primitive.
 *
 * Also rejects embedded userinfo (`https://real.com@evil.com/`): a bare
 * startsWith('https://') check passes that, but the browser navigates to the
 * host AFTER the `@`, so userinfo is a lookalike-host redirect vector.
 *
 * @returns true only for a well-formed https:// URL with no credentials.
 */
const isSafeExternalUrl = (url: unknown): boolean => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return false;
    const parsed = parseUrl(url);
    return parsed !== null && parsed.protocol === 'https:' && hasNoCredentials(parsed);
};

/**
 * Gate for a link the user clicked inside rendered content (a challenge's
 * welcome message) or a page the app must not navigate to itself: the Electron
 * window-open and navigation guard hands these to the system browser or mail
 * client. Wider than isSafeExternalUrl by http: and mailto:, with the same
 * no-credentials rule on the web schemes.
 *
 * @returns true only for an http(s) URL without credentials or a mailto: URL.
 */
const isOpenableLinkUrl = (url: string): boolean => {
    const parsed = parseUrl(url);
    if (parsed === null) return false;
    if (parsed.protocol === 'mailto:') return true;
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && hasNoCredentials(parsed);
};

export { isSafeExternalUrl, isOpenableLinkUrl };
