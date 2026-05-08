/**
 * Android-side updater. Triggers a download of the APK from a
 * GitHub release URL and lets the system handle install via the
 * normal "downloaded APK -> install" flow.
 *
 * Design choices and trade-offs:
 *  - We deliberately do NOT use @capacitor/filesystem to download
 *    in-app and Intent.ACTION_VIEW to launch the system installer.
 *    That cleaner UX needs a custom Capacitor plugin (small Java/
 *    Kotlin helper) which is out of scope here. Documented as the
 *    next escalation in the plan.
 *  - Instead we hand the download URL to whichever browser the user
 *    has registered. Chrome / system browser recognizes .apk and
 *    downloads it; tapping the completed-download notification
 *    invokes the system installer with REQUEST_INSTALL_PACKAGES
 *    (manifest already declares it).
 *  - One UX tap more than the in-app installer would be, but works
 *    today, requires no native code, and stays consistent with
 *    sideload distribution (the user is already used to manual APK
 *    installs).
 */

const runtime = require('../runtime');

/**
 * Open the APK download URL externally so Chrome / system browser
 * downloads it; the user then taps the download notification to
 * invoke the system installer.
 *
 * @param {Object} opts
 * @param {string} opts.downloadUrl - Direct APK URL from the GitHub release.
 * @param {string} [opts.version] - Version string for logging / UI feedback.
 * @returns {Promise<{success: boolean, version?: string, error?: string}>}
 */
const downloadAndInstall = async ({ downloadUrl, version } = {}) => {
    if (!downloadUrl) return { success: false, error: 'No download URL provided' };
    if (!runtime.isCapacitor()) return { success: false, error: 'Android updater is a no-op outside Capacitor' };

    // Prefer the Capacitor Browser plugin if the consumer happens to
    // have it installed (we do not declare it as a dep, so this is a
    // best-effort hook for the day someone adds it).
    try {
        const Cap = globalThis.Capacitor;
        if (Cap?.Plugins?.Browser?.open) {
            await Cap.Plugins.Browser.open({ url: downloadUrl });
            return { success: true, version };
        }
    } catch {
        // fall through to window.open
    }

    if (typeof globalThis.open === 'function') {
        globalThis.open(downloadUrl, '_blank');
        return { success: true, version };
    }
    if (typeof globalThis.location !== 'undefined') {
        globalThis.location.href = downloadUrl;
        return { success: true, version };
    }
    return { success: false, error: 'No mechanism to open the download URL' };
};

module.exports = { downloadAndInstall };
