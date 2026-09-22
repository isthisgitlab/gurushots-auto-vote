/**
 * UpdateChecker — the shared GitHub Releases poller used by the Android
 * bridge and the CLI `update` command. axios is globally mocked by
 * tests/setup.js; each test wires `axios.get` explicitly.
 */

const axios = require('axios');
const {
    checkForUpdates,
    compareSemver,
    pickAsset,
    getReleasesUrl,
    REPO_OWNER,
    REPO_NAME,
} = require('../../src/js/services/UpdateChecker');

const LATEST_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const LIST_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=10`;

describe('UpdateChecker', () => {
    beforeEach(() => {
        axios.get = jest.fn();
    });

    describe('compareSemver', () => {
        it.each([
            ['1.2.3', '1.2.3', 0],
            ['v1.2.3', '1.2.3', 0],
            ['1.2.4', '1.2.3', 1],
            ['1.2.3', '1.10.0', -1],
            ['2.0', '1.9.9', 1],
            ['1.0.0', '1.0', 0],
            ['1.x.0', '1.0.0', 0],
            ['1.0.0', '1.0.0-beta.1', 1],
            ['1.0.0-beta.1', '1.0.0', -1],
            ['1.0.0-beta.2', '1.0.0-beta.1', 1],
            ['1.0.0-beta.1', '1.0.0-beta.2', -1],
            ['1.0.0-beta.1', '1.0.0-beta.1', 0],
        ])('compare(%s, %s) === %d', (a, b, expected) => {
            expect(compareSemver(a, b)).toBe(expected);
        });
    });

    describe('pickAsset', () => {
        const release = {
            assets: [
                { name: 42, browser_download_url: 'bad' },
                { name: 'app.dmg', browser_download_url: 'dmg-url' },
                { name: 'app.apk', browser_download_url: 'apk-url' },
            ],
        };

        it('returns the asset whose name ends with the suffix', () => {
            expect(pickAsset(release, '.apk')).toEqual({ name: 'app.apk', browser_download_url: 'apk-url' });
        });

        it('returns null when nothing matches', () => {
            expect(pickAsset(release, '.exe')).toBeNull();
        });

        it('returns null for a release without assets or no release at all', () => {
            expect(pickAsset({}, '.apk')).toBeNull();
            expect(pickAsset(null, '.apk')).toBeNull();
        });
    });

    it('getReleasesUrl points at the public releases page', () => {
        expect(getReleasesUrl()).toBe(`https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
    });

    describe('checkForUpdates', () => {
        const empty = {
            updateAvailable: false,
            version: null,
            downloadUrl: null,
            isPrerelease: false,
            releaseNotes: '',
            releaseDate: null,
        };

        it('refuses to run without a currentVersion (including no options at all)', async () => {
            await expect(checkForUpdates()).resolves.toEqual({ ...empty, error: 'currentVersion is required' });
            expect(axios.get).not.toHaveBeenCalled();
        });

        it('reports a newer stable release with the matching asset url', async () => {
            axios.get.mockResolvedValue({
                data: {
                    tag_name: 'v2.0.0',
                    prerelease: false,
                    body: 'notes',
                    published_at: '2026-01-01T00:00:00Z',
                    html_url: 'html-url',
                    assets: [{ name: 'app.apk', browser_download_url: 'apk-url' }],
                },
            });

            const result = await checkForUpdates({ currentVersion: '1.0.0', assetSuffix: '.apk' });

            expect(axios.get).toHaveBeenCalledWith(LATEST_URL);
            expect(result).toEqual({
                updateAvailable: true,
                version: '2.0.0',
                downloadUrl: 'apk-url',
                isPrerelease: false,
                releaseNotes: 'notes',
                releaseDate: '2026-01-01T00:00:00Z',
            });
        });

        it('falls back to the html page, empty notes and null date when fields are missing', async () => {
            axios.get.mockResolvedValue({ data: { tag_name: '1.0.0', html_url: 'html-url' } });

            const result = await checkForUpdates({ currentVersion: '1.0.0' });

            expect(result).toEqual({
                updateAvailable: false,
                version: '1.0.0',
                downloadUrl: 'html-url',
                isPrerelease: false,
                releaseNotes: '',
                releaseDate: null,
            });
        });

        it('uses a null downloadUrl when neither the asset nor html_url exist', async () => {
            axios.get.mockResolvedValue({ data: { tag_name: '3.0.0', assets: [] } });

            const result = await checkForUpdates({ currentVersion: '1.0.0', assetSuffix: '.apk' });

            expect(result.downloadUrl).toBeNull();
            expect(result.updateAvailable).toBe(true);
        });

        it('returns the empty result when the latest release has no data or no tag', async () => {
            axios.get.mockResolvedValueOnce({ data: null });
            await expect(checkForUpdates({ currentVersion: '1.0.0' })).resolves.toEqual(empty);

            axios.get.mockResolvedValueOnce({ data: { name: 'untagged' } });
            await expect(checkForUpdates({ currentVersion: '1.0.0' })).resolves.toEqual(empty);
        });

        it('picks the newest prerelease on the beta channel', async () => {
            axios.get.mockResolvedValue({
                data: [
                    { tag_name: 'v1.5.0', prerelease: false },
                    { tag_name: 'v1.6.0-beta.1', prerelease: true, html_url: 'beta-html' },
                    { tag_name: 'v1.4.0-beta.9', prerelease: true },
                ],
            });

            const result = await checkForUpdates({ currentVersion: '1.5.0', isBetaChannel: true });

            expect(axios.get).toHaveBeenCalledWith(LIST_URL);
            expect(result).toMatchObject({
                updateAvailable: true,
                version: '1.6.0-beta.1',
                downloadUrl: 'beta-html',
                isPrerelease: true,
            });
        });

        it('returns the empty result on the beta channel when no prerelease exists or data is null', async () => {
            axios.get.mockResolvedValueOnce({ data: [{ tag_name: 'v1.5.0', prerelease: false }] });
            await expect(checkForUpdates({ currentVersion: '1.0.0', isBetaChannel: true })).resolves.toEqual(empty);

            axios.get.mockResolvedValueOnce({ data: null });
            await expect(checkForUpdates({ currentVersion: '1.0.0', isBetaChannel: true })).resolves.toEqual(empty);
        });

        it('turns a network failure into an error result instead of throwing', async () => {
            axios.get.mockRejectedValueOnce(new Error('ECONNRESET'));
            await expect(checkForUpdates({ currentVersion: '1.0.0' })).resolves.toEqual({
                ...empty,
                error: 'ECONNRESET',
            });

            axios.get.mockRejectedValueOnce({});
            await expect(checkForUpdates({ currentVersion: '1.0.0' })).resolves.toEqual({
                ...empty,
                error: 'Failed to check for updates',
            });
        });
    });
});
