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

import * as runtime from '../runtime';
import * as logger from '../logger';

import type { CapacitorGlobals } from '../types/capacitor';

// The native plugin, when this build registered it. Accessed lazily (only
// after downloadAndInstall's isCapacitor() gate) so non-Capacitor paths never
// touch globalThis.Capacitor.
const getNativeInstaller = () => (globalThis as CapacitorGlobals).Capacitor?.Plugins?.ApkInstaller || null;

// Browser fallback: hand the URL to the system browser. One extra tap vs the
// native installer but works with no native code and matches the sideload
// distribution users are already used to.
const openInBrowser = (downloadUrl: string, version: string | null | undefined) => {
    try {
        const Cap = (globalThis as CapacitorGlobals).Capacitor;
        if (Cap?.Plugins?.Browser?.open) {
            void Cap.Plugins.Browser.open({ url: downloadUrl });
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
 * @param opts.downloadUrl - Direct APK URL from the GitHub release.
 * @param opts.version - Version string for logging / UI feedback.
 * @param opts.onProgress - Called
 *   with native download-progress events when the native plugin is used.
 */
const downloadAndInstall = async ({
    downloadUrl,
    version,
    onProgress,
}: {
    downloadUrl: string;
    version?: string | null;
    onProgress?: (progress: { percent?: number }) => void;
}): Promise<{ success: boolean; version?: string | null; error?: string; viaFallback?: boolean }> => {
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
                    void removeListener();
                } catch {
                    // listener cleanup is best-effort
                }
            }
        }
    }

    return openInBrowser(downloadUrl, version);
};

export { downloadAndInstall };
