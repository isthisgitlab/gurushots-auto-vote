/**
 * The remote-page half of the site build (scripts/build-site/remote*.ts): one phone page per link version under
 * /remote/v<N>/, the local build standing in for its own link version only when it is that version's pick, and a
 * build that fails rather than deploy without a page some desktop depends on. Releases, downloads and unzip are injected: nothing here reaches the network.
 */

// The shared tests/setup.ts mocks `path` and `fs` globally; this suite builds a real temp tree.
jest.unmock('node:path');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('fs');

import fs = require('node:fs');
import os = require('node:os');
import nodePath = require('node:path');
import { invalid } from '../helpers/invalid';
import { fakeDownload, fakeUnzip, pageRelease, remoteSiteDeps, sha256 } from '../helpers/remoteSite';
import {
    REMOTE_PAGE_ZIP_PATTERN,
    buildRemoteSite,
    downloadFromGitHub,
    listReleasesFromGitHub,
    selectLinkVersionPages,
} from '../../scripts/build-site';

import type { RemoteRelease } from '../../scripts/build-site';

describe('the remote page tree', () => {
    let tmp: string;
    let out: string;
    let dist: string;
    let logSpy: jest.SpiedFunction<typeof console.log>;

    const write = (rel: string, body: string) => {
        const full = nodePath.join(tmp, rel);
        fs.mkdirSync(nodePath.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    };
    const read = (...parts: string[]) => fs.readFileSync(nodePath.join(out, 'remote', ...parts), 'utf8');
    const listing = () => fs.readdirSync(nodePath.join(out, 'remote')).sort();

    /** The local build's dist/: the loader, the app stylesheet, and the page it staged for `linkVersion`. */
    const seedDist = (linkVersion = 2): void => {
        write(nodePath.join('dist', 'remote-loader.html'), '<!doctype html><title>loader</title>');
        write(nodePath.join('dist', 'remoteLoader-bundle.js'), '// loader');
        write(nodePath.join('dist', 'styles.css'), 'body{}');
        write(nodePath.join('dist', 'remote', `v${linkVersion}`, 'index.html'), '<html>local</html>');
        write(nodePath.join('dist', 'remote', `v${linkVersion}`, 'remote-bundle.js'), '// page');
        write(nodePath.join('dist', 'remote', `v${linkVersion}`, 'styles.css'), 'staged-css');
        write(nodePath.join('dist', 'remote', `v${linkVersion}`, 'THIRD_PARTY_NOTICES.txt'), 'local-notices');
    };

    beforeEach(() => {
        tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'build-site-remote-'));
        out = nodePath.join(tmp, 'dist-site');
        dist = nodePath.join(tmp, 'dist');
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    describe('what lands in dist-site/remote/', () => {
        test('the loader, the released v1 archive, and the local v2 page land together', async () => {
            seedDist(2);
            const v1Archive = 'https://example.com/9.9.8/remote-page-v1.zip';
            const unzip = jest.fn(async (zipPath: string, dir: string): Promise<void> => {
                await fakeUnzip(zipPath, dir);
                const archive = fs.readFileSync(zipPath, 'utf8');
                fs.writeFileSync(nodePath.join(dir, 'remote-bundle.js'), `bundle:${archive}`);
            });
            await buildRemoteSite(out, '9.9.9', remoteSiteDeps(dist, [pageRelease('9.9.8', [1])], { unzip }));

            expect(listing()).toEqual(['index.html', 'remoteLoader-bundle.js', 'styles.css', 'v1', 'v2']);
            expect(read('index.html')).toContain('loader');
            expect(read('v1', 'index.html')).toBe(`<html>${v1Archive}</html>`);
            expect(read('v1', 'remote-bundle.js')).toBe(`bundle:${v1Archive}`);
            expect(read('v1', 'styles.css')).toBe(`css:${v1Archive}`);
            expect(read('v1', 'THIRD_PARTY_NOTICES.txt')).toBe(`notices:${v1Archive}`);
            expect(read('v2', 'index.html')).toBe('<html>local</html>');
            expect(read('v2', 'remote-bundle.js')).toBe('// page');
            expect(read('v2', 'styles.css')).toBe('body{}');
            expect(read('v2', 'THIRD_PARTY_NOTICES.txt')).toBe('local-notices');
            expect(fs.existsSync(nodePath.join(out, 'remote', '9.9.9'))).toBe(false);
        });

        test('no page of an app-version directory, whatever releases carry', async () => {
            seedDist();
            await buildRemoteSite(
                out,
                '9.9.9',
                remoteSiteDeps(dist, [
                    pageRelease('9.8.0-beta.2', [1], { prerelease: true }),
                    pageRelease('9.8.1', [1]),
                ]),
            );
            expect(listing().filter((name) => /^\d/.test(name))).toEqual([]);
        });

        test('the app stylesheet lands at the loader root and in the page the local build stands in for, not in a downloaded one', async () => {
            seedDist(2);
            await buildRemoteSite(out, '9.9.9', remoteSiteDeps(dist, [pageRelease('9.9.8', [1])]));
            expect(read('styles.css')).toBe('body{}');
            expect(read('v2', 'styles.css')).toBe('body{}');
            // A downloaded page keeps its own release's stylesheet and notices.
            expect(read('v1', 'styles.css')).toBe('css:https://example.com/9.9.8/remote-page-v1.zip');
            expect(read('v1', 'THIRD_PARTY_NOTICES.txt')).toBe('notices:https://example.com/9.9.8/remote-page-v1.zip');
            // The local page keeps the notices it staged.
            expect(read('v2', 'THIRD_PARTY_NOTICES.txt')).toBe('local-notices');
        });

        test('the third-party notices sit beside the loader, and nothing is invented when the build has none', async () => {
            seedDist();
            write(nodePath.join('dist', 'THIRD_PARTY_NOTICES.txt'), 'NOTICES');
            await buildRemoteSite(out, '9.9.9', remoteSiteDeps(dist));
            expect(read('THIRD_PARTY_NOTICES.txt')).toBe('NOTICES');

            const bare = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'build-site-remote-bare-'));
            try {
                fs.rmSync(nodePath.join(dist, 'THIRD_PARTY_NOTICES.txt'));
                await buildRemoteSite(bare, '9.9.9', remoteSiteDeps(dist));
                expect(fs.existsSync(nodePath.join(bare, 'remote', 'THIRD_PARTY_NOTICES.txt'))).toBe(false);
            } finally {
                fs.rmSync(bare, { recursive: true, force: true });
            }
        });

        test('a stylesheet without the local page lands at the loader root while the required v1 archive stays published', async () => {
            write(nodePath.join('dist', 'styles.css'), 'body{}');
            await buildRemoteSite(out, '9.9.9', remoteSiteDeps(dist));
            expect(read('styles.css')).toBe('body{}');
            expect(read('v1', 'index.html')).toContain('9.9.8/remote-page-v1.zip');
        });

        test('without the local build nothing is created, and the skipped steps are said', async () => {
            await buildRemoteSite(out, '9.9.9', remoteSiteDeps(dist, [], { linkVersion: 1 }));
            expect(fs.existsSync(nodePath.join(out, 'remote'))).toBe(false);
            expect(logSpy).toHaveBeenCalledWith('⏭️  remote/ loader: build:react has not produced it yet');
            expect(logSpy).toHaveBeenCalledWith('⏭️  remote/v1/: build:react has not staged it yet');
            expect(logSpy).toHaveBeenCalledWith('⏭️  remote/styles.css: build:css has not produced it yet');
        });
    });

    describe('which release supplies a link version', () => {
        test('the newest stable release wins over a newer pre-release, wherever the listing puts it', async () => {
            seedDist(2); // develop is on v2; v1 must come from the releases
            const downloads: string[] = [];
            await buildRemoteSite(
                out,
                '9.9.9',
                remoteSiteDeps(
                    dist,
                    [
                        pageRelease('9.9.7', [1]),
                        pageRelease('9.9.11-beta.1', [1], { prerelease: true }), // newer, but a pre-release
                        pageRelease('9.9.8', [1]), // the newest stable
                    ],
                    {
                        linkVersion: 2,
                        downloadFile: async (url) => {
                            downloads.push(url);
                            return fakeDownload(url);
                        },
                    },
                ),
            );
            expect(read('v1', 'index.html')).toContain('9.9.8/remote-page-v1.zip');
            expect(downloads.some((url) => url.includes('9.9.11-beta.1'))).toBe(false);
            expect(read('v2', 'index.html')).toBe('<html>local</html>');
        });

        test('a pre-release supplies a link version only when no stable release carries it', async () => {
            seedDist(2);
            await buildRemoteSite(
                out,
                '9.9.9',
                remoteSiteDeps(dist, [pageRelease('9.9.8-beta.1', [1], { prerelease: true })], { linkVersion: 2 }),
            );
            expect(read('v1', 'index.html')).toContain('9.9.8-beta.1/remote-page-v1.zip');
        });

        test('a beta local build does not replace the stable page users get', async () => {
            seedDist(1);
            await buildRemoteSite(
                out,
                '9.9.10-beta.1',
                remoteSiteDeps(dist, [pageRelease('9.9.9', [1])], { linkVersion: 1 }),
            );
            expect(read('v1', 'index.html')).toContain('9.9.9/remote-page-v1.zip');
            expect(read('v1', 'styles.css')).toBe('css:https://example.com/9.9.9/remote-page-v1.zip');
            expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('(the local build)'));
        });

        test('a beta local build stands in when no stable release carries its link version', async () => {
            seedDist(1);
            await buildRemoteSite(
                out,
                '9.9.10-beta.1',
                remoteSiteDeps(dist, [pageRelease('9.9.10-beta.0', [1], { prerelease: true })], { linkVersion: 1 }),
            );
            expect(read('v1', 'index.html')).toBe('<html>local</html>');
        });

        test('a stable local build stands in for its own link version, even when an older stable carries it', async () => {
            seedDist(1);
            await buildRemoteSite(out, '9.9.9', remoteSiteDeps(dist, [pageRelease('9.9.8', [1])], { linkVersion: 1 }));
            expect(read('v1', 'index.html')).toBe('<html>local</html>');
        });

        test('an older stable local build does not replace a newer stable v1', async () => {
            seedDist(1);
            await buildRemoteSite(out, '9.9.8', remoteSiteDeps(dist, [pageRelease('9.9.9', [1])], { linkVersion: 1 }));
            expect(read('v1', 'index.html')).toContain('9.9.9/remote-page-v1.zip');
        });

        test('a stable local build replaces a newer pre-release v1 (no stable release carries it yet)', async () => {
            seedDist(1);
            await buildRemoteSite(
                out,
                '9.9.9',
                remoteSiteDeps(dist, [pageRelease('9.9.10-beta.1', [1], { prerelease: true })], { linkVersion: 1 }),
            );
            expect(read('v1', 'index.html')).toBe('<html>local</html>');
        });

        test('an older pre-release local build does not replace a newer pre-release v1', async () => {
            seedDist(1);
            await buildRemoteSite(
                out,
                '9.9.10-beta.1',
                remoteSiteDeps(dist, [pageRelease('9.9.10-beta.2', [1], { prerelease: true })], { linkVersion: 1 }),
            );
            expect(read('v1', 'index.html')).toContain('9.9.10-beta.2/remote-page-v1.zip');
        });

        test('a newer pre-release local build replaces an older pre-release v1', async () => {
            seedDist(1);
            await buildRemoteSite(
                out,
                '9.9.10-beta.3',
                remoteSiteDeps(dist, [pageRelease('9.9.10-beta.2', [1], { prerelease: true })], { linkVersion: 1 }),
            );
            expect(read('v1', 'index.html')).toBe('<html>local</html>');
        });

        test('drafts and tags that are not release versions are skipped', async () => {
            seedDist(2);
            await buildRemoteSite(
                out,
                '9.9.9',
                remoteSiteDeps(
                    dist,
                    [
                        pageRelease('9.9.20', [1], { draft: true }),
                        pageRelease('nightly', [1]),
                        pageRelease('9.9.8', [1]),
                    ],
                    { linkVersion: 2 },
                ),
            );
            expect(read('v1', 'index.html')).toContain('9.9.8/remote-page-v1.zip');
        });

        test('every link version is published, older and newer than the local one', async () => {
            seedDist(2);
            await buildRemoteSite(
                out,
                '9.9.9',
                remoteSiteDeps(dist, [pageRelease('9.9.8', [1]), pageRelease('9.9.12', [3, 999])], { linkVersion: 2 }),
            );
            expect(listing()).toEqual(['index.html', 'remoteLoader-bundle.js', 'styles.css', 'v1', 'v2', 'v3', 'v999']);
        });
    });

    describe('selectLinkVersionPages', () => {
        const asset = (name: string) => ({ name, browser_download_url: `https://example.com/${name}` });

        test('matches only the anchored remote-page-v<1-999>.zip names', () => {
            const names = [
                'remote-page-v1.zip',
                'remote-page-v999.zip',
                'remote-page-v0.zip',
                'remote-page-v01.zip',
                'remote-page-v1000.zip',
                'remote-page-v1.zip.sha256',
                'x-remote-page-v1.zip',
                'remote-page.zip',
            ];
            expect(names.filter((name) => REMOTE_PAGE_ZIP_PATTERN.test(name))).toEqual([
                'remote-page-v1.zip',
                'remote-page-v999.zip',
            ]);
            const release: RemoteRelease = { tag_name: 'v1.0.0', assets: names.map(asset) };
            expect([...selectLinkVersionPages([release]).keys()].sort((a, b) => a - b)).toEqual([1, 999]);
        });

        test('a release with a zip and no checksum is still the pick (the build then fails on it)', () => {
            const picks = selectLinkVersionPages([pageRelease('1.0.0', [1], { checksum: false })]);
            expect(picks.get(1)?.checksum).toBeUndefined();
            expect(picks.get(1)?.tag).toBe('v1.0.0');
        });

        test('a listing without any phone page picks nothing', () => {
            expect(selectLinkVersionPages([{ tag_name: 'v1.0.0', assets: [] }]).size).toBe(0);
        });
    });

    describe('a page some desktop depends on cannot be missing', () => {
        test('a failed release listing (a rate limit) fails the site build', async () => {
            seedDist();
            await expect(
                buildRemoteSite(out, '9.9.9', {
                    ...remoteSiteDeps(dist),
                    listReleases: async () => {
                        throw new Error('releases listing failed (403)');
                    },
                }),
            ).rejects.toThrow('could not list the releases for the phone pages: releases listing failed (403)');
        });

        test('a listing that fails without a reason is still said', async () => {
            seedDist();
            await expect(
                buildRemoteSite(out, '9.9.9', { ...remoteSiteDeps(dist), listReleases: () => Promise.reject(null) }),
            ).rejects.toThrow('could not list the releases for the phone pages: no reason given');
        });

        test('an older link version no release carries fails the build', async () => {
            seedDist(2);
            await expect(
                buildRemoteSite(out, '9.9.9', remoteSiteDeps(dist, [pageRelease('9.9.8', [3])], { linkVersion: 2 })),
            ).rejects.toThrow('no release carries remote-page-v1.zip');
        });

        test('a zip with no checksum beside it fails the build', async () => {
            seedDist(2);
            await expect(
                buildRemoteSite(
                    out,
                    '9.9.9',
                    remoteSiteDeps(dist, [pageRelease('9.9.8', [1]), pageRelease('9.9.12', [2], { checksum: false })]),
                ),
            ).rejects.toThrow('v9.9.12: remote-page-v2.zip has no remote-page-v2.zip.sha256 beside it');
        });

        test('a zip whose checksum does not match fails the build and is not unpacked', async () => {
            seedDist(2);
            const unzip = jest.fn(fakeUnzip);
            await expect(
                buildRemoteSite(
                    out,
                    '9.9.9',
                    remoteSiteDeps(dist, [pageRelease('9.9.8', [1])], {
                        linkVersion: 2,
                        unzip,
                        downloadFile: async (url) =>
                            Buffer.from(url.endsWith('.sha256') ? `${'0'.repeat(64)}  x.zip\n` : 'tampered'),
                    }),
                ),
            ).rejects.toThrow('v9.9.8: remote-page-v1.zip does not match its checksum');
            expect(unzip).not.toHaveBeenCalled();
            expect(fs.existsSync(nodePath.join(out, 'remote', 'v1'))).toBe(false);
        });

        test.each([
            ['an empty file', ''],
            ['a short hash', 'deadbeef  x.zip\n'],
            ['text that is not a hash', 'not a checksum file\n'],
            ['a hash with a non-hex digit', `${'g'.repeat(64)}  x.zip\n`],
        ])(
            'a checksum file that is %s fails the v2 build as not a SHA-256 file, after only the valid v1 archive unpacks',
            async (_name, body) => {
                seedDist(2);
                const unzip = jest.fn(fakeUnzip);
                await expect(
                    buildRemoteSite(
                        out,
                        '9.9.9',
                        remoteSiteDeps(dist, [pageRelease('9.9.8', [1]), pageRelease('9.9.12', [2])], {
                            unzip,
                            downloadFile: async (url) =>
                                url.includes('remote-page-v2') && url.endsWith('.sha256')
                                    ? Buffer.from(body)
                                    : fakeDownload(url),
                        }),
                    ),
                ).rejects.toThrow('v9.9.12: remote-page-v2.zip.sha256 is not a SHA-256 checksum file');
                expect(unzip).toHaveBeenCalledTimes(1);
                expect(unzip.mock.calls[0]?.[1]).toBe(nodePath.join(out, 'remote', 'v1'));
            },
        );

        test('a failed download of a newer link version fails the build', async () => {
            seedDist(2);
            await expect(
                buildRemoteSite(
                    out,
                    '9.9.9',
                    remoteSiteDeps(dist, [pageRelease('9.9.12', [1, 2])], {
                        downloadFile: async (url) => {
                            if (url.includes('remote-page-v2')) throw new Error('download failed (500)');
                            return fakeDownload(url);
                        },
                    }),
                ),
            ).rejects.toThrow('download failed (500)');
        });
    });

    test('the real unzip puts the zip content in place', async () => {
        seedDist(2);
        // A real zip: `zip` is on the runner; skip building it when the tool is absent.
        const zipDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'zip-src-'));
        fs.writeFileSync(nodePath.join(zipDir, 'index.html'), '<html>paged</html>');
        const zipPath = nodePath.join(zipDir, 'remote-page.zip');
        const childProcess = jest.requireActual<typeof import('node:child_process')>('node:child_process');
        try {
            childProcess.execFileSync('zip', ['-q', '-j', zipPath, nodePath.join(zipDir, 'index.html')]);
        } catch {
            fs.rmSync(zipDir, { recursive: true, force: true });
            return;
        }
        const zipBytes = fs.readFileSync(zipPath);
        await buildRemoteSite(
            out,
            '9.9.7',
            remoteSiteDeps(dist, [pageRelease('9.9.8', [1, 2])], {
                downloadFile: async (url) =>
                    url.endsWith('.sha256') ? Buffer.from(`${sha256(zipBytes)}  x.zip\n`) : zipBytes,
                // The real unzip dep (the default) runs here.
                unzip: invalid<(zipPath: string, dir: string) => Promise<void>>(undefined),
            }),
        );
        expect(read('v2', 'index.html')).toContain('paged');
        fs.rmSync(zipDir, { recursive: true, force: true });
    });
});

describe('the GitHub fetchers (the real remote-site deps)', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        delete (globalThis as { fetch?: unknown }).fetch;
    });

    const page = (size: number, from = 0) =>
        Array.from({ length: size }, (_, i) => ({ tag_name: `v1.0.${from + i}`, assets: [] }));
    const asFetch = (mock: unknown): typeof fetch => invalid<typeof fetch>(mock);
    const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
        invalid<Response>({ ok, status, json: async () => body });

    test('the listing is read in full, page by page, against the fixed API address, without a token it was not given', async () => {
        const fetchMock = jest
            .fn<Promise<Response>, [string, RequestInit]>()
            .mockResolvedValueOnce(jsonResponse(page(100)))
            .mockResolvedValueOnce(jsonResponse(page(100, 100)))
            .mockResolvedValueOnce(jsonResponse(page(7, 200)));
        const token = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;
        try {
            const releases = await listReleasesFromGitHub(asFetch(fetchMock));
            expect(releases).toHaveLength(207);
            expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
                'https://api.github.com/repos/isthisgitlab/gurushots-auto-vote/releases?per_page=100&page=1',
                'https://api.github.com/repos/isthisgitlab/gurushots-auto-vote/releases?per_page=100&page=2',
                'https://api.github.com/repos/isthisgitlab/gurushots-auto-vote/releases?per_page=100&page=3',
            ]);
            expect(fetchMock.mock.calls[0]?.[1]).toEqual({
                headers: { 'User-Agent': 'gurushots-auto-vote-site-build' },
            });
        } finally {
            if (token !== undefined) process.env.GITHUB_TOKEN = token;
        }
    });

    test('an empty last page ends the read; a failed or malformed page fails it', async () => {
        const empty = jest.fn(async () => jsonResponse([]));
        await expect(listReleasesFromGitHub(empty)).resolves.toEqual([]);
        await expect(listReleasesFromGitHub(async () => jsonResponse({}, false, 403))).rejects.toThrow(
            'releases listing failed (403)',
        );
        await expect(listReleasesFromGitHub(async () => jsonResponse({ message: 'x' }))).rejects.toThrow(
            'releases listing failed (not a list)',
        );
    });

    test('the Link header is never followed: the token only goes to the fixed API address', async () => {
        const token = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'ghs_test_token';
        try {
            const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(async () =>
                invalid<Response>({
                    ok: true,
                    status: 200,
                    headers: { get: () => '<https://evil.example/releases?page=2>; rel="next"' },
                    json: async () => page(3),
                }),
            );
            await listReleasesFromGitHub(asFetch(fetchMock));
            for (const [url, init] of fetchMock.mock.calls) {
                expect(url.startsWith('https://api.github.com/repos/isthisgitlab/gurushots-auto-vote/releases')).toBe(
                    true,
                );
                expect(init).toEqual({
                    headers: { 'User-Agent': 'gurushots-auto-vote-site-build', Authorization: 'Bearer ghs_test_token' },
                });
            }
        } finally {
            if (token === undefined) delete process.env.GITHUB_TOKEN;
            else process.env.GITHUB_TOKEN = token;
        }
    });

    test.each([
        ['a release without a tag', { assets: [] }],
        ['a tag that is not a string', { tag_name: 1, assets: [] }],
        ['assets that are not a list', { tag_name: 'v1.0.0', assets: {} }],
        ['an asset without a name', { tag_name: 'v1.0.0', assets: [{ browser_download_url: 'https://x/y' }] }],
        ['an asset without a url', { tag_name: 'v1.0.0', assets: [{ name: 'a.zip' }] }],
        ['an asset that is not an object', { tag_name: 'v1.0.0', assets: ['a.zip'] }],
        ['a prerelease flag that is not a boolean', { tag_name: 'v1.0.0', assets: [], prerelease: 'yes' }],
        ['a draft flag that is not a boolean', { tag_name: 'v1.0.0', assets: [], draft: 1 }],
        ['a release that is not an object', 'v1.0.0'],
    ])('a release with %s fails the listing', async (_name, release) => {
        await expect(listReleasesFromGitHub(async () => jsonResponse([release]))).rejects.toThrow(
            'releases listing failed (a release is not the expected shape)',
        );
    });

    test('a well-formed release passes the check, with its flags and assets', async () => {
        const release = {
            tag_name: 'v1.0.0',
            prerelease: true,
            draft: false,
            assets: [{ name: 'a.zip', browser_download_url: 'https://x/a.zip' }],
        };
        await expect(listReleasesFromGitHub(async () => jsonResponse([release]))).resolves.toEqual([release]);
    });

    test('the real fetch is the default of the API read', async () => {
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => jsonResponse([])));
        await expect(listReleasesFromGitHub()).resolves.toEqual([]);
    });

    test('an asset download is a plain request: the token is the API reads', async () => {
        const fetchMock = jest.fn(async () =>
            invalid<Response>({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(3) }),
        );
        globalThis.fetch = invalid<typeof fetch>(fetchMock);
        const token = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'ghs_test_token';
        try {
            await expect(downloadFromGitHub('https://example.com/x')).resolves.toEqual(Buffer.alloc(3));
            expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('ghs_test_token');

            globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => jsonResponse({}, false, 404)));
            await expect(downloadFromGitHub('https://example.com/x')).rejects.toThrow(
                'download failed for https://example.com/x (404)',
            );
        } finally {
            if (token === undefined) delete process.env.GITHUB_TOKEN;
            else process.env.GITHUB_TOKEN = token;
        }
    });
});
