// The release side of the remote-page site build: the GitHub releases API (read in full, page by
// page, against one fixed address), the downloads, and the choice of which release supplies each
// link version's phone page.

import { isPlainObject } from '../../src/ts/core/plainObject';
import { compareReleaseVersions, isReleaseVersion } from '../../src/ts/core/remote/protocol';
import { REPO } from './pages';

/** The release assets of one link version's phone page and its checksum file (build.yml attaches both). */
export const REMOTE_PAGE_ZIP_PATTERN = /^remote-page-v([1-9]\d{0,2})\.zip$/;
export const checksumNameOf = (zipName: string): string => `${zipName}.sha256`;

/** The fixed address of the releases API: the token is only ever sent here, never to a link a response names. */
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

/** How many releases one listing page asks for (the API's maximum). */
export const RELEASES_PER_PAGE = 100;

/** One GitHub release as the releases API answers it, trimmed to what the site build reads. */
export type RemoteRelease = {
    tag_name: string;
    prerelease?: boolean;
    draft?: boolean;
    assets: Array<{ name: string; browser_download_url: string }>;
};

/** The injected outer effects of the remote-page tree build; each defaults to the real thing. */
export type RemoteSiteDeps = {
    /** The repo's dist/ with the local build's remote bundles. */
    dist?: string;
    /** The link version the local build speaks (defaults to the protocol's LINK_VERSION). */
    linkVersion?: number;
    /** The GitHub releases listing, read in full (network). */
    listReleases?: () => Promise<RemoteRelease[]>;
    /** One release asset (network). */
    downloadFile?: (url: string) => Promise<Buffer>;
    /** Extracts a zip into a directory (the `unzip` CLI). */
    unzip?: (zipPath: string, dir: string) => Promise<void>;
};

const isReleaseAsset = (value: unknown): value is RemoteRelease['assets'][number] =>
    isPlainObject(value) && typeof value.name === 'string' && typeof value.browser_download_url === 'string';

const isBooleanOrAbsent = (value: unknown): boolean => value === undefined || typeof value === 'boolean';

/** Whether a parsed JSON value is a release as the build reads it; the API's answer is checked, never cast. */
const isRemoteRelease = (value: unknown): value is RemoteRelease =>
    isPlainObject(value) &&
    typeof value.tag_name === 'string' &&
    Array.isArray(value.assets) &&
    value.assets.every(isReleaseAsset) &&
    isBooleanOrAbsent(value.prerelease) &&
    isBooleanOrAbsent(value.draft);

/**
 * The API request headers. A `GITHUB_TOKEN` in the environment (the CI script's, not app configuration) lifts the
 * API's anonymous rate limit.
 */
const apiHeaders = (): Record<string, string> => {
    const token = process.env.GITHUB_TOKEN;
    return { 'User-Agent': 'gurushots-auto-vote-site-build', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
};

/**
 * The default GitHub releases listing: every release, pre-releases and drafts included (the caller filters), read
 * page by page as `?per_page=100&page=n` against the fixed `RELEASES_API`. The `Link` header is never followed: the
 * token would travel to whatever address it names.
 */
export const listReleasesFromGitHub = async (fetchImpl: typeof fetch = fetch): Promise<RemoteRelease[]> => {
    const releases: RemoteRelease[] = [];
    for (let page = 1; ; page++) {
        const response = await fetchImpl(`${RELEASES_API}?per_page=${RELEASES_PER_PAGE}&page=${page}`, {
            headers: apiHeaders(),
        });
        if (!response.ok) throw new Error(`releases listing failed (${response.status})`);
        const batch: unknown = await response.json();
        if (!Array.isArray(batch)) throw new Error('releases listing failed (not a list)');
        if (!batch.every(isRemoteRelease)) {
            throw new Error('releases listing failed (a release is not the expected shape)');
        }
        releases.push(...batch);
        if (batch.length < RELEASES_PER_PAGE) return releases;
    }
};

export const downloadFromGitHub = async (url: string): Promise<Buffer> => {
    const response = await fetch(url, { headers: { 'User-Agent': 'gurushots-auto-vote-site-build' } });
    if (!response.ok) throw new Error(`download failed for ${url} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
};

/** The phone page one release supplies for one link version. */
export type LinkVersionPage = {
    linkVersion: number;
    tag: string;
    prerelease: boolean;
    zip: { name: string; browser_download_url: string };
    /** The release's checksum asset for the zip, or undefined when it carries none. */
    checksum: { name: string; browser_download_url: string } | undefined;
};

/** The release version a tag names (`v1.2.3` → `1.2.3`). */
export const versionOfTag = (tag: string): string => tag.replace(/^v/, '');

/** Every phone page the releases carry: a published (not draft) release whose tag is a release version, one per anchored zip name. */
const pagesOf = (release: RemoteRelease): LinkVersionPage[] => {
    if (release.draft === true || !isReleaseVersion(versionOfTag(release.tag_name))) return [];
    return release.assets.flatMap((asset) => {
        const match = REMOTE_PAGE_ZIP_PATTERN.exec(asset.name);
        if (match === null) return [];
        return [
            {
                linkVersion: Number(match[1]),
                tag: release.tag_name,
                prerelease: release.prerelease === true,
                zip: asset,
                checksum: release.assets.find((other) => other.name === checksumNameOf(asset.name)),
            },
        ];
    });
};

/** Whether `candidate` is a better pick for its link version than `best`: a stable release over a pre-release, then the newer version. */
const betterPick = (candidate: LinkVersionPage, best: LinkVersionPage): boolean => {
    if (candidate.prerelease !== best.prerelease) return !candidate.prerelease;
    return compareReleaseVersions(versionOfTag(candidate.tag), versionOfTag(best.tag)) > 0;
};

/**
 * The release that supplies each link version's page: the newest stable release that carries
 * `remote-page-v<N>.zip` (by version, not by listing order), and only when no stable release carries it the newest
 * pre-release. Drafts and tags that are not release versions are skipped.
 */
export const selectLinkVersionPages = (releases: RemoteRelease[]): Map<number, LinkVersionPage> => {
    const picks = new Map<number, LinkVersionPage>();
    for (const page of releases.flatMap(pagesOf)) {
        const best = picks.get(page.linkVersion);
        if (best === undefined || betterPick(page, best)) picks.set(page.linkVersion, page);
    }
    return picks;
};
