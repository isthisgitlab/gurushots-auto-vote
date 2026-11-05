/**
 * Doubles for the remote-page site build (scripts/build-site/remote*.ts): the release listing, the downloads and
 * the unzip are injected, so no test reaches the network. A "zip" is its own URL as bytes, and the fake unzip
 * writes the page files from it, so a test can tell which release a page came from.
 */

import nodeCrypto = require('node:crypto');
import nodeFs = require('node:fs');
import nodePath = require('node:path');

import type { RemoteRelease, RemoteSiteDeps } from '../../scripts/build-site';

export const sha256 = (data: Buffer): string => nodeCrypto.createHash('sha256').update(data).digest('hex');

/** The legacy 1.15.0 page's bytes in the tests; their hash is injected as the pin. */
export const LEGACY_BYTES = Buffer.from('legacy-1.15.0-page');
export const LEGACY_ZIP_URL = 'https://example.com/v1.15.0/remote-page.zip';

export const legacyRelease: RemoteRelease = {
    tag_name: 'v1.15.0',
    assets: [{ name: 'remote-page.zip', browser_download_url: LEGACY_ZIP_URL }],
};

/** One release carrying the phone pages of the given link versions (zip + checksum for each). */
export const pageRelease = (
    version: string,
    linkVersions: number[],
    {
        prerelease = false,
        draft = false,
        checksum = true,
    }: { prerelease?: boolean; draft?: boolean; checksum?: boolean } = {},
): RemoteRelease => ({
    tag_name: `v${version}`,
    prerelease,
    draft,
    assets: linkVersions.flatMap((linkVersion) => [
        {
            name: `remote-page-v${linkVersion}.zip`,
            browser_download_url: `https://example.com/${version}/remote-page-v${linkVersion}.zip`,
        },
        ...(checksum
            ? [
                  {
                      name: `remote-page-v${linkVersion}.zip.sha256`,
                      browser_download_url: `https://example.com/${version}/remote-page-v${linkVersion}.zip.sha256`,
                  },
              ]
            : []),
    ]),
});

/** The fake download: a zip is its URL, a checksum file is that zip's hash. The legacy zip is LEGACY_BYTES. */
export const fakeDownload = async (url: string): Promise<Buffer> => {
    if (url === LEGACY_ZIP_URL) return LEGACY_BYTES;
    if (url.endsWith('.sha256')) return Buffer.from(`${sha256(Buffer.from(url.replace(/\.sha256$/, '')))}  x.zip\n`);
    return Buffer.from(url);
};

/** The fake unzip: the page files carry the zip's bytes, so a test reads which release supplied them. */
export const fakeUnzip = async (zipPath: string, dir: string): Promise<void> => {
    const bytes = nodeFs.readFileSync(zipPath, 'utf8');
    nodeFs.writeFileSync(nodePath.join(dir, 'index.html'), `<html>${bytes}</html>`);
    nodeFs.writeFileSync(nodePath.join(dir, 'styles.css'), `css:${bytes}`);
    nodeFs.writeFileSync(nodePath.join(dir, 'THIRD_PARTY_NOTICES.txt'), `notices:${bytes}`);
};

/** The deps of a build with the given releases, nothing real in it. */
export const remoteSiteDeps = (
    dist: string,
    releases: RemoteRelease[] = [],
    extra: RemoteSiteDeps = {},
): RemoteSiteDeps => ({
    dist,
    listReleases: async () => releases,
    getReleaseByTag: async () => legacyRelease,
    downloadFile: fakeDownload,
    unzip: fakeUnzip,
    legacyPageSha256: sha256(LEGACY_BYTES),
    ...extra,
});
