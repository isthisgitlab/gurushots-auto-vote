// The remote-access half of the site build: the older phone pages come from the
// GitHub releases' remote-page.zip assets, unpacked only after each checksum
// verifies, beside the loader and the current version the local build staged.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { errorMessage } from '../../src/ts/core/errorMessage';
import { compareReleaseVersions, isReleaseVersion } from '../../src/ts/core/remote/protocol';
import { NOTICES_ASSET_NAME } from '../../src/ts/core/thirdPartyNotices';
import { REPO } from './pages';

/** The release asset names of the phone page and its checksum file (build.yml attaches both). */
export const REMOTE_PAGE_ZIP = 'remote-page.zip';
export const REMOTE_CHECKSUM_FILE = 'remote-page.zip.sha256';
/** How many past releases' phone pages the site keeps. */
export const REMOTE_RELEASE_COUNT = 10;
/** How many releases the listing asks for: headroom, since pre-releases older than the newest stable are filtered out before the cut. */
const REMOTE_RELEASE_FETCH_COUNT = 30;

const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
const distDir = path.join(__dirname, '..', '..', 'dist');

/** One GitHub release as the releases API answers it, trimmed to what the site build reads. */
export type RemoteRelease = {
    tag_name: string;
    prerelease?: boolean;
    assets: Array<{ name: string; browser_download_url: string }>;
};

/** The injected outer effects of the remote-page tree build; each defaults to the real thing. */
export type RemoteSiteDeps = {
    /** The repo's dist/ with the local build's remote bundles. */
    dist?: string;
    /** The GitHub releases listing (network). */
    listReleases?: () => Promise<RemoteRelease[]>;
    /** One release asset (network). */
    downloadFile?: (url: string) => Promise<Buffer>;
    /** Extracts a zip into a directory (the `unzip` CLI). */
    unzip?: (zipPath: string, dir: string) => Promise<void>;
};

/**
 * The default GitHub releases listing: the newest releases, pre-releases included (the caller filters).
 * A `GITHUB_TOKEN` in the environment (the CI script's, not app configuration) lifts the API's anonymous rate limit.
 */
export const listReleasesFromGitHub = async (): Promise<RemoteRelease[]> => {
    const token = process.env.GITHUB_TOKEN;
    const response = await fetch(`${RELEASES_API}?per_page=${REMOTE_RELEASE_FETCH_COUNT}`, {
        headers: {
            'User-Agent': 'gurushots-auto-vote-site-build',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
    if (!response.ok) throw new Error(`releases listing failed (${response.status})`);
    return (await response.json()) as RemoteRelease[];
};

export const downloadFromGitHub = async (url: string): Promise<Buffer> => {
    const response = await fetch(url, { headers: { 'User-Agent': 'gurushots-auto-vote-site-build' } });
    if (!response.ok) throw new Error(`download failed for ${url} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
};

const unzipWithCli = async (zipPath: string, dir: string): Promise<void> => {
    execFileSync('unzip', ['-o', zipPath, '-d', dir], { stdio: 'pipe' });
};

/**
 * The releases whose phone page the site keeps: every stable release, plus each pre-release
 * whose version is newer than the newest stable (a beta-channel desktop must find its page),
 * newest first, at most REMOTE_RELEASE_COUNT in total.
 */
export const selectRemotePageReleases = (releases: RemoteRelease[]): RemoteRelease[] => {
    const versionOf = (release: RemoteRelease): string => release.tag_name.replace(/^v/, '');
    const newestStable = releases
        .filter((release) => release.prerelease !== true)
        .map(versionOf)
        .filter(isReleaseVersion)
        .reduce<string | null>(
            (best, version) => (best !== null && compareReleaseVersions(best, version) >= 0 ? best : version),
            null,
        );
    return releases
        .filter(
            (release) =>
                release.prerelease !== true ||
                (newestStable !== null &&
                    isReleaseVersion(versionOf(release)) &&
                    compareReleaseVersions(versionOf(release), newestStable) > 0),
        )
        .slice(0, REMOTE_RELEASE_COUNT);
};

// The thin, stable loader: the pairing link opens this, whatever version the desktop runs.
const copyLoader = (ensureOut: () => string, dist: string): void => {
    const loaderHtml = path.join(dist, 'remote-loader.html');
    const loaderBundle = path.join(dist, 'remoteLoader-bundle.js');
    if (fs.existsSync(loaderHtml) && fs.existsSync(loaderBundle)) {
        const target = ensureOut();
        fs.copyFileSync(loaderHtml, path.join(target, 'index.html'));
        fs.copyFileSync(loaderBundle, path.join(target, 'remoteLoader-bundle.js'));
        // The loader bundles third-party code too, so its directory carries the notices, like each version's.
        const notices = path.join(dist, NOTICES_ASSET_NAME);
        if (fs.existsSync(notices)) fs.copyFileSync(notices, path.join(target, NOTICES_ASSET_NAME));
        console.log('✓ remote/index.html (the /remote/ loader)');
    } else {
        console.log('⏭️  remote/ loader: build:react has not produced it yet');
    }
};

/** The current version's page: the local build is that version. */
const copyLocalVersion = (ensureOut: () => string, dist: string, version: string): void => {
    const localVersionDir = path.join(dist, 'remote', version);
    if (fs.existsSync(localVersionDir)) {
        fs.cpSync(localVersionDir, path.join(ensureOut(), version), { recursive: true });
        console.log(`✓ remote/${version}/ (the local build)`);
    } else {
        console.log(`⏭️  remote/${version}/: build:react has not staged it yet`);
    }
};

// The app stylesheet for both documents: build:site runs build:css first, so dist/styles.css
// is this run's product — copied deterministically, never a leftover.
const copyAppStylesheet = (ensureOut: () => string, dist: string, version: string): void => {
    const appCss = path.join(dist, 'styles.css');
    if (fs.existsSync(appCss)) {
        fs.copyFileSync(appCss, path.join(ensureOut(), 'styles.css'));
        if (fs.existsSync(path.join(ensureOut(), version))) {
            fs.copyFileSync(appCss, path.join(ensureOut(), version, 'styles.css'));
        }
        console.log('✓ remote/styles.css (the app stylesheet, loader root and current version)');
    } else {
        console.log('⏭️  remote/styles.css: build:css has not produced it yet');
    }
};

/**
 * The release listing for the older phone pages, or a thrown Error that fails the build: a deploy
 * that silently drops every older version page is worse than a failed deploy, which keeps the live site.
 */
const listReleasesOrThrow = async (listReleases: () => Promise<RemoteRelease[]>): Promise<RemoteRelease[]> => {
    try {
        return await listReleases();
    } catch (error) {
        throw new Error(
            `could not list the releases for the older phone pages: ${errorMessage(error) ?? 'no reason given'}`,
            { cause: error },
        );
    }
};

/**
 * One older release's page: downloads the zip and its checksum, refuses a zip whose sha256 does
 * not match the checksum file, and unpacks the verified zip into `target` (the temp dir is
 * always cleaned up).
 */
const unpackReleaseZip = async (
    tag: string,
    releaseVersion: string,
    zipUrl: string,
    checksumUrl: string,
    target: string,
    download: (url: string) => Promise<Buffer>,
    unzip: (zipPath: string, dir: string) => Promise<void>,
): Promise<void> => {
    const [zipBytes, checksumBytes] = await Promise.all([download(zipUrl), download(checksumUrl)]);
    const expected = checksumBytes.toString('utf8').trim().split(/\s+/)[0];
    const actual = crypto.createHash('sha256').update(zipBytes).digest('hex');
    if (actual !== expected) {
        console.error(`✗ ${tag}: ${REMOTE_PAGE_ZIP} does not match its checksum — skipping it`);
        return;
    }
    const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-page-')), REMOTE_PAGE_ZIP);
    try {
        fs.writeFileSync(zipPath, zipBytes);
        fs.mkdirSync(target, { recursive: true });
        await unzip(zipPath, target);
    } finally {
        fs.rmSync(path.dirname(zipPath), { recursive: true, force: true });
    }
    console.log(`✓ remote/${releaseVersion}/ (from ${tag}, checksum verified)`);
};

/**
 * Fills `dist-site/remote/`: the thin loader at `remote/index.html`, the local build's page
 * under `remote/<version>/`, and the older versions unpacked from the last releases'
 * `remote-page.zip` assets (each verified against its release's checksum file). A release
 * without the zip yet — true of every release so far — is skipped with a log, and the
 * current version is never downloaded (the local build is that version).
 */
const buildRemoteSite = async (out: string, version: string, deps: RemoteSiteDeps = {}): Promise<void> => {
    const dist = deps.dist ?? distDir;
    // The directory appears only once something is copied into it.
    const remoteOut = path.join(out, 'remote');
    const ensureOut = (): string => {
        fs.mkdirSync(remoteOut, { recursive: true });
        return remoteOut;
    };

    copyLoader(ensureOut, dist);
    copyLocalVersion(ensureOut, dist, version);
    copyAppStylesheet(ensureOut, dist, version);

    // The older versions: the zips the last releases attach, each checksum-verified. The
    // defaults are the real GitHub fetchers; the tests inject theirs.
    const listReleases = deps.listReleases ?? listReleasesFromGitHub;
    const download = deps.downloadFile ?? downloadFromGitHub;
    const unzip = deps.unzip ?? unzipWithCli;
    const releases = await listReleasesOrThrow(listReleases);
    for (const release of selectRemotePageReleases(releases)) {
        const releaseVersion = release.tag_name.replace(/^v/, '');
        if (releaseVersion === version) continue;
        const zip = release.assets.find((asset) => asset.name === REMOTE_PAGE_ZIP);
        const checksum = release.assets.find((asset) => asset.name === REMOTE_CHECKSUM_FILE);
        if (!zip || !checksum) {
            console.log(`⏭️  ${release.tag_name}: no ${REMOTE_PAGE_ZIP} attached yet — skipping`);
            continue;
        }
        const target = path.join(ensureOut(), releaseVersion);
        if (fs.existsSync(target)) continue;
        await unpackReleaseZip(
            release.tag_name,
            releaseVersion,
            zip.browser_download_url,
            checksum.browser_download_url,
            target,
            download,
            unzip,
        );
    }
};

export { buildRemoteSite };
