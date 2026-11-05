// The remote-access half of the site build. The phone page is versioned by link version
// (core/remote/protocol.ts LINK_VERSION): `/remote/v<N>/` serves every desktop that speaks link
// version N. The local build stages its own link version; every other link version, older and
// newer, is unpacked from the GitHub releases' `remote-page-v<N>.zip` assets, each verified
// against its checksum file. The legacy 1.15.0 page (which named its page by app version) comes from
// its tag and is checked against a pinned hash.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { errorMessage } from '../../src/ts/core/errorMessage';
import { LINK_VERSION, compareReleaseVersions } from '../../src/ts/core/remote/protocol';
import { NOTICES_ASSET_NAME } from '../../src/ts/core/thirdPartyNotices';
import {
    downloadFromGitHub,
    getReleaseByTagFromGitHub,
    listReleasesFromGitHub,
    selectLinkVersionPages,
    versionOfTag,
} from './remoteReleases';
import type { LinkVersionPage, RemoteRelease, RemoteSiteDeps } from './remoteReleases';
import { LEGACY_PAGE_VERSION, unpackLegacyPage, unpackLinkVersionPage } from './remoteUnpack';

const distDir = path.join(__dirname, '..', '..', 'dist');

const unzipWithCli = async (zipPath: string, dir: string): Promise<void> => {
    execFileSync('unzip', ['-o', zipPath, '-d', dir], { stdio: 'pipe' });
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

/** The local build's page: it stages `dist/remote/v<linkVersion>/`, and stands in for that link version when it is the pick. */
const copyLocalPage = (ensureOut: () => string, dist: string, name: string): void => {
    const localDir = path.join(dist, 'remote', name);
    if (fs.existsSync(localDir)) {
        fs.cpSync(localDir, path.join(ensureOut(), name), { recursive: true });
        console.log(`✓ remote/${name}/ (the local build)`);
    } else {
        console.log(`⏭️  remote/${name}/: build:react has not staged it yet`);
    }
};

// The app stylesheet for the loader, and for the page the local build stands in for: build:site runs
// build:css first, so dist/styles.css is this run's product — copied deterministically, never a
// leftover. A page unpacked from a release keeps the stylesheet and notices of its own release.
const copyAppStylesheet = (ensureOut: () => string, dist: string, localName: string | null): void => {
    const appCss = path.join(dist, 'styles.css');
    if (fs.existsSync(appCss)) {
        fs.copyFileSync(appCss, path.join(ensureOut(), 'styles.css'));
        if (localName !== null && fs.existsSync(path.join(ensureOut(), localName))) {
            fs.copyFileSync(appCss, path.join(ensureOut(), localName, 'styles.css'));
        }
        console.log('✓ remote/styles.css (the app stylesheet, loader root and the local build)');
    } else {
        console.log('⏭️  remote/styles.css: build:css has not produced it yet');
    }
};

/**
 * The release listing for the other link versions, or a thrown Error that fails the build: a deploy
 * that silently drops a page some desktops depend on is worse than a failed deploy, which keeps the live site.
 */
const listReleasesOrThrow = async (listReleases: () => Promise<RemoteRelease[]>): Promise<RemoteRelease[]> => {
    try {
        return await listReleases();
    } catch (error) {
        throw new Error(
            `could not list the releases for the phone pages: ${errorMessage(error) ?? 'no reason given'}`,
            {
                cause: error,
            },
        );
    }
};

/**
 * Whether the local build stands in for its own link version: when no release carries that version's page; when the
 * local build is stable and the pick is a pre-release or not newer; or when both are pre-releases and the local one is not older. A
 * beta never replaces the page stable users get, and an older build never replaces a newer release's page.
 */
const localStandsIn = (appVersion: string, pick: LinkVersionPage | undefined): boolean => {
    if (pick === undefined) return true;
    const notOlder = compareReleaseVersions(appVersion, versionOfTag(pick.tag)) >= 0;
    const stable = !appVersion.includes('-');
    // A stable build always wins over a pre-release pick, whatever its version: stable users never get a beta's page.
    return stable ? pick.prerelease || notOlder : pick.prerelease && notOlder;
};

/** The link versions below the local one must all be published: a desktop on one of them depends on its page. */
const requireOlderPages = (localLinkVersion: number, picks: Map<number, LinkVersionPage>): void => {
    for (let older = 1; older < localLinkVersion; older++) {
        if (!picks.has(older)) {
            throw new Error(`no release carries remote-page-v${older}.zip — the site would lose link version ${older}`);
        }
    }
};

/**
 * Fills `dist-site/remote/`: the thin loader at `remote/index.html`, the local build's page under
 * `remote/v<N>/` (when it stands in for its link version), every other link version unpacked from
 * the newest stable release that carries its `remote-page-v<N>.zip`, and the legacy 1.15.0 page.
 * Any page that cannot be fetched or verified fails the build.
 */
const buildRemoteSite = async (out: string, appVersion: string, deps: RemoteSiteDeps = {}): Promise<void> => {
    const dist = deps.dist ?? distDir;
    const localLinkVersion = deps.linkVersion ?? LINK_VERSION;
    // The directory appears only once something is copied into it.
    const remoteOut = path.join(out, 'remote');
    const ensureOut = (): string => {
        fs.mkdirSync(remoteOut, { recursive: true });
        return remoteOut;
    };
    // The defaults are the real GitHub fetchers; the tests inject theirs.
    const unpackDeps = { download: deps.downloadFile ?? downloadFromGitHub, unzip: deps.unzip ?? unzipWithCli };

    const picks = selectLinkVersionPages(await listReleasesOrThrow(deps.listReleases ?? listReleasesFromGitHub));
    requireOlderPages(localLinkVersion, picks);
    const standsIn = localStandsIn(appVersion, picks.get(localLinkVersion));
    const localName = `v${localLinkVersion}`;

    copyLoader(ensureOut, dist);
    if (standsIn) copyLocalPage(ensureOut, dist, localName);
    copyAppStylesheet(ensureOut, dist, standsIn ? localName : null);

    for (const [linkVersion, page] of picks) {
        if (linkVersion === localLinkVersion && standsIn) continue;
        await unpackLinkVersionPage(page, path.join(ensureOut(), `v${linkVersion}`), unpackDeps);
    }
    await unpackLegacyPage(
        deps.getReleaseByTag ?? getReleaseByTagFromGitHub,
        path.join(ensureOut(), LEGACY_PAGE_VERSION),
        unpackDeps,
        deps.legacyPageSha256,
    );
};

export { buildRemoteSite };
