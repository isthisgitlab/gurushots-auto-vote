/**
 * Shared external-URL safety gate.
 *
 * Lives here (dependency-free, next to logSafe) so BOTH platform bridges share
 * one definition: the Electron `open-external-url` handler (ipc/misc.handlers.js)
 * and the Capacitor `openExternalUrl` bridge (bridge/capacitor.js). Separate
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
 * @param {*} url
 * @returns {boolean} true only for a well-formed https:// URL with no credentials.
 */
const isSafeExternalUrl = (url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
    } catch {
        return false;
    }
};

module.exports = { isSafeExternalUrl };
