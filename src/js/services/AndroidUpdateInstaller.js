/**
 * Android-side updater. Prefers an in-app download + system-installer flow
 * via the native `ApkInstaller` Capacitor plugin (AndroidManifest already
 * declares REQUEST_INSTALL_PACKAGES, a FileProvider, and the package-archive
 * VIEW <queries>). When the plugin is unavailable (older build, plugin not
 * registered) it falls back to handing the URL to the system browser, which
 * recognizes .apk and downloads it; tapping the completed-download
 * notification then invokes the system installer.
 *
 * The native path emits `downloadProgress` listener events so a progress bar
 * can settle as the APK downloads; the browser fallback has no progress.
 */

const runtime = require('../runtime');
const logger = require('../logger');

// The native plugin, when this build registered it. Accessed lazily so
// non-Capacitor paths never touch globalThis.Capacitor.
const getNativeInstaller = () => {
    if (!runtime.isCapacitor()) return null;
    try {
        return globalThis.Capacitor?.Plugins?.ApkInstaller || null;
    } catch {
        return null;
    }
};

// Browser fallback: hand the URL to the system browser. One extra tap vs the
// native installer but works with no native code and matches the sideload
// distribution users are already used to.
const openInBrowser = (downloadUrl, version) => {
    try {
        const Cap = globalThis.Capacitor;
        if (Cap?.Plugins?.Browser?.open) {
            Cap.Plugins.Browser.open({ url: downloadUrl });
            return { success: true, version, viaFallback: true };
        }
    } catch {
        // fall through to window.open
    }
    if (typeof globalThis.open === 'function') {
        globalThis.open(downloadUrl, '_blank');
        return { success: true, version, viaFallback: true };
    }
    if (typeof globalThis.location !== 'undefined') {
        globalThis.location.href = downloadUrl;
        return { success: true, version, viaFallback: true };
    }
    return { success: false, error: 'No mechanism to open the download URL' };
};

/**
 * Download the APK and hand off to the system installer.
 *
 * @param {Object} opts
 * @param {string} opts.downloadUrl - Direct APK URL from the GitHub release.
 * @param {string} [opts.version] - Version string for logging / UI feedback.
 * @param {(progress: {percent?: number}) => void} [opts.onProgress] - Called
 *   with native download-progress events when the native plugin is used.
 * @returns {Promise<{success: boolean, version?: string, error?: string}>}
 */
const downloadAndInstall = async ({ downloadUrl, version, onProgress } = {}) => {
    if (!downloadUrl) return { success: false, error: 'No download URL provided' };
    if (!runtime.isCapacitor()) return { success: false, error: 'Android updater is a no-op outside Capacitor' };

    const native = getNativeInstaller();
    if (native?.downloadAndInstall) {
        let removeListener = null;
        try {
            if (onProgress && typeof native.addListener === 'function') {
                const handle = await native.addListener('downloadProgress', (data) => onProgress(data));
                removeListener = handle && typeof handle.remove === 'function' ? () => handle.remove() : null;
            }
            const result = await native.downloadAndInstall({ url: downloadUrl, version: version || '' });
            return { success: result?.success !== false, version, ...result };
        } catch (err) {
            logger.withCategory('update').error('Native APK install failed; falling back to browser', err);
            // fall through to the browser fallback below
        } finally {
            if (removeListener) {
                try {
                    removeListener();
                } catch {
                    // listener cleanup is best-effort
                }
            }
        }
    }

    return openInBrowser(downloadUrl, version);
};

module.exports = { downloadAndInstall };
