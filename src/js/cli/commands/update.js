/**
 * CLI update check. Reuses the shared GitHub Releases poller
 * (services/UpdateChecker) — the same "is there a newer version?" answer the
 * GUI uses. The CLI does not self-install (it ships no packaged updater); it
 * prints the download / releases URL so the user fetches the binary manually,
 * mirroring Android's system-installer hand-off.
 */

const logger = require('../../logger');
const updateChecker = require('../../services/UpdateChecker');
const pkg = require('../../../../package.json');

// Release metadata (tag, asset URL, error message) is third-party data from
// the GitHub API. Strip C0/C1 control + escape characters before printing so
// a crafted tag or asset name can't inject ANSI sequences into the terminal.
// Pattern built via RegExp so no literal control bytes live in the source.
// no-control-regex is disabled deliberately: matching control chars is the
// whole point — we strip them so they can't reach the terminal.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');
const plain = (s) => String(s ?? '').replace(CONTROL_CHARS, '');

const checkUpdates = async () => {
    const ui = logger.withCategory('ui');
    ui.info('=== GuruShots Auto Voter - Update Check ===');
    ui.info(`Current version: ${pkg.version}`);

    let result;
    try {
        result = await updateChecker.checkForUpdates({
            currentVersion: pkg.version,
            // A prerelease build (version contains a hyphen, e.g. 1.0.0-beta.1)
            // tracks the beta channel; stable builds track the production latest.
            isBetaChannel: pkg.version.includes('-'),
            assetSuffix: null,
        });
    } catch (err) {
        ui.error(`Update check failed: ${plain(err?.message || String(err))}`);
        ui.info(`Check manually: ${updateChecker.getReleasesUrl()}`);
        return;
    }

    if (result.error) {
        ui.error(`Update check failed: ${plain(result.error)}`);
        ui.info(`Check manually: ${updateChecker.getReleasesUrl()}`);
        return;
    }

    if (!result.updateAvailable) {
        ui.success(`You're up to date (${pkg.version}).`);
        return;
    }

    ui.success(`Update available: ${plain(result.version)}${result.isPrerelease ? ' (prerelease)' : ''}`);
    if (result.releaseDate) ui.info(`Released: ${plain(result.releaseDate)}`);
    ui.info(`Download: ${plain(result.downloadUrl || updateChecker.getReleasesUrl())}`);
    // The CLI ships no packaged updater — be explicit so the user knows an
    // action is required (mirrors Android's manual system-installer hand-off).
    ui.info('This CLI does not self-update — download the release and replace the binary manually.');
};

module.exports = { checkUpdates };
