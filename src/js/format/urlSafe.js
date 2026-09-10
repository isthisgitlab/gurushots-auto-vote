/**
 * Shared external-URL safety gate.
 *
 * Lives here (dependency-free, next to logSafe) so BOTH platform bridges share
 * one definition: the Electron `open-external-url` handler (ipc/misc.handlers.js)
 * and the Capacitor `openExternalUrl` bridge (bridge/capacitor.js). Previously
 * only the Electron side enforced https, so the two platforms silently diverged
 * on a security control — a future caller passing API-sourced data through the
 * Android path would have got a weaker guarantee (file:, intent:, javascript:,
 * app-scheme handlers) than on desktop.
 *
 * Every legitimate call site opens an https page (gurushots.com, GitHub
 * releases). Refusing anything else keeps this from ever becoming an
 * open-any-scheme primitive.
 *
 * @param {*} url
 * @returns {boolean} true only for a well-formed https:// URL string.
 */
const isSafeExternalUrl = (url) => typeof url === 'string' && url.startsWith('https://');

module.exports = { isSafeExternalUrl };
