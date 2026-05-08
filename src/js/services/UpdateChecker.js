/**
 * Shared GitHub Releases poller. Decides *whether* an update is
 * available; each platform's installer decides *how* to deliver it.
 *
 * Electron uses electron-updater (which has its own poll machinery
 * driven by the publishConfig in electron-builder) — this module is
 * the path for any Electron flow that wants the same answer without
 * spinning up the full electron-updater Promise. Android uses this
 * unconditionally because the WebView has no equivalent of
 * electron-updater.
 *
 * No fs, no electron — pure axios + semver comparison. Safe to bundle
 * into the Capacitor renderer.
 */

const axios = require('axios');

const REPO_OWNER = 'isthisgitlab';
const REPO_NAME = 'gurushots-auto-vote';

const releasesLatestUrl = () => `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const releasesListUrl = (perPage = 10) =>
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=${perPage}`;

/**
 * Compare two dotted-numeric versions optionally followed by -beta.N etc.
 * Returns -1, 0, or 1 in the usual way. Pre-release suffixes sort below
 * the same base version (1.0.0-beta.1 < 1.0.0).
 */
const compareSemver = (a, b) => {
    const parse = (v) => {
        const cleaned = v.replace(/^v/, '');
        const [base, pre] = cleaned.split('-', 2);
        const parts = base.split('.').map((n) => parseInt(n, 10) || 0);
        return { parts, pre: pre || null };
    };
    const av = parse(a);
    const bv = parse(b);
    for (let i = 0; i < Math.max(av.parts.length, bv.parts.length); i++) {
        const ai = av.parts[i] || 0;
        const bi = bv.parts[i] || 0;
        if (ai !== bi) return ai > bi ? 1 : -1;
    }
    if (av.pre === bv.pre) return 0;
    if (av.pre === null) return 1; // 1.0.0 > 1.0.0-beta
    if (bv.pre === null) return -1;
    return av.pre > bv.pre ? 1 : -1;
};

/**
 * Pick the asset whose filename matches the requested platform glob.
 * E.g. '.apk' for Android, '.dmg' for macOS DMG.
 */
const pickAsset = (release, suffix) => {
    if (!release?.assets) return null;
    return release.assets.find((a) => typeof a.name === 'string' && a.name.endsWith(suffix)) || null;
};

/**
 * Fetch latest release information and compare against currentVersion.
 *
 * @param {Object} opts
 * @param {string} opts.currentVersion - Current app version (without leading 'v').
 * @param {boolean} [opts.isBetaChannel] - When true, picks the newest prerelease instead of the production latest.
 * @param {string} [opts.assetSuffix] - File extension to pick from release assets (e.g. '.apk'). If omitted,
 *   downloadUrl falls back to the release HTML page so the user can download manually.
 * @returns {Promise<{
 *   updateAvailable: boolean,
 *   version: string|null,
 *   downloadUrl: string|null,
 *   isPrerelease: boolean,
 *   releaseNotes: string,
 *   releaseDate: string|null,
 *   error?: string,
 * }>}
 */
const checkForUpdates = async ({ currentVersion, isBetaChannel = false, assetSuffix = null } = {}) => {
    const empty = {
        updateAvailable: false,
        version: null,
        downloadUrl: null,
        isPrerelease: false,
        releaseNotes: '',
        releaseDate: null,
    };
    if (!currentVersion) {
        return { ...empty, error: 'currentVersion is required' };
    }
    try {
        let release = null;
        if (isBetaChannel) {
            const { data } = await axios.get(releasesListUrl(10));
            // Newest matching prerelease (sorted by published_at descending in GitHub API).
            release = (data || []).find((r) => r.prerelease) || null;
        } else {
            const { data } = await axios.get(releasesLatestUrl());
            release = data || null;
        }
        if (!release || !release.tag_name) return empty;

        const remoteVersion = release.tag_name.replace(/^v/, '');
        const updateAvailable = compareSemver(remoteVersion, currentVersion) > 0;

        const asset = assetSuffix ? pickAsset(release, assetSuffix) : null;
        const downloadUrl = asset?.browser_download_url || release.html_url || null;

        return {
            updateAvailable,
            version: remoteVersion,
            downloadUrl,
            isPrerelease: !!release.prerelease,
            releaseNotes: release.body || '',
            releaseDate: release.published_at || null,
        };
    } catch (error) {
        return { ...empty, error: error.message || 'Failed to check for updates' };
    }
};

const getReleasesUrl = () => `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

module.exports = {
    checkForUpdates,
    compareSemver,
    pickAsset,
    getReleasesUrl,
    REPO_OWNER,
    REPO_NAME,
};
