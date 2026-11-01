// Unit tests for the GitHub Pages renderer. The pure helpers guard the
// source Markdown invariant: as the README/docs evolve,
// their cross-links must keep resolving on the static site. Importing the module
// is side-effect-free — main() runs only when the file is the entry point.
// main() itself is exercised against a temp repo tree under os.tmpdir(); the
// real dist-site/ is never written.

// The shared tests/setup.ts mocks `path` and `fs` globally (no `.posix`); this
// suite tests real path resolution and real temp-dir rendering, so restore the
// actual modules for this file only.
jest.unmock('node:path');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('fs');

// `marked` ships ESM-only, which this Jest setup cannot load. A minimal
// line-based stand-in: each line is a link, an image, or a paragraph, and every
// token is passed through the registered walkTokens hooks before rendering —
// enough to pin build-site's link/image rewriting wiring.
jest.mock('marked', () => ({
    Marked: class {
        declare walkers: Array<(token: { type: string; text: string; href?: string }) => void>;
        constructor() {
            this.walkers = [];
        }
        use(ext: { walkTokens?: (token: { type: string; text: string; href?: string }) => void }) {
            if (ext.walkTokens) this.walkers.push(ext.walkTokens);
        }
        parse(md: string) {
            return md
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                    const m = line.match(/^(!?)\[([^\]]*)\]\(([^)]*)\)$/);
                    const token = m
                        ? { type: m[1] ? 'image' : 'link', text: m[2], href: m[3] }
                        : { type: 'paragraph', text: line };
                    this.walkers.forEach((walk) => walk(token));
                    if (token.type === 'image') return `<img src="${token.href}" alt="${token.text}">`;
                    if (token.type === 'link') return `<a href="${token.href}">${token.text}</a>`;
                    return `<p>${token.text}</p>`;
                })
                .join('\n');
        }
    },
}));
jest.mock('marked-gfm-heading-id', () => ({
    gfmHeadingId: jest.fn(() => ({})),
    resetHeadings: jest.fn(),
}));

import fsModule = require('node:fs');
import nodeCrypto = require('node:crypto');
const fs = jest.mocked(fsModule);
import os = require('node:os');
import nodePathModule = require('node:path');
const nodePath = jest.mocked(nodePathModule);
import type * as marked_gfm_heading_idModule from 'marked-gfm-heading-id';
import { invalid } from '../helpers/invalid';
import type * as build_siteModule from '../../scripts/build-site';
const { resetHeadings } = jest.mocked(require('marked-gfm-heading-id') as typeof marked_gfm_heading_idModule);

const {
    hasScheme,
    srcDirOf,
    toRepoPath,
    rewriteLink,
    rewriteImage,
    badgeSvg,
    render,
    buildNav,
    PAGES,
    BADGES,
    buildRemoteSite,
    selectRemotePageReleases,
    REMOTE_RELEASE_COUNT,
    listReleasesFromGitHub,
    downloadFromGitHub,
    main,
    runCli,
} = require('../../scripts/build-site') as typeof build_siteModule;

/** A fetch whose every call answers the given response shape (only the fields the build reads). */
const respondWith = (response: unknown): typeof fetch =>
    invalid<typeof fetch>(jest.fn(async () => invalid<Response>(response)));
/** A releases listing with nothing in it: the build stays network-free. */
const emptyReleasesFetch = (): typeof fetch => respondWith({ ok: true, status: 200, json: async () => [] });

const pageBySrc = (src: string) => PAGES.find((p) => p.src === src);

const BLOB = 'https://github.com/isthisgitlab/gurushots-auto-vote/blob/master';
const REAL_LAYOUT = nodePath.join(__dirname, '..', '..', 'scripts', 'site', 'layout.html');

describe('hasScheme', () => {
    it('recognises absolute, mailto, custom-scheme, and protocol-relative URLs', () => {
        expect(hasScheme('https://example.com')).toBe(true);
        expect(hasScheme('mailto:a@b.com')).toBe(true);
        expect(hasScheme('bitcoin:3JSKTwYk')).toBe(true);
        expect(hasScheme('//cdn.example.com/x.js')).toBe(true);
    });

    it('treats repo-relative paths as schemeless', () => {
        expect(hasScheme('docs/scheduling.md')).toBe(false);
        expect(hasScheme('./LICENSE')).toBe(false);
        expect(hasScheme('../README.md')).toBe(false);
    });
});

describe('srcDirOf', () => {
    it('returns "" for root files and the directory for nested files', () => {
        expect(srcDirOf('README.md')).toBe('');
        expect(srcDirOf('docs/scheduling.md')).toBe('docs');
    });
});

describe('toRepoPath', () => {
    it('resolves links relative to the source file directory', () => {
        expect(toRepoPath('', 'docs/scheduling.md')).toBe('docs/scheduling.md');
        expect(toRepoPath('docs', '../README.md')).toBe('README.md');
        expect(toRepoPath('docs', 'scheduling.md')).toBe('docs/scheduling.md');
        expect(toRepoPath('', './LICENSE')).toBe('LICENSE');
    });
});

describe('rewriteLink', () => {
    it('maps in-set .md links to their generated .html page', () => {
        expect(rewriteLink('README.lv.md', '')).toBe('./lv.html');
        expect(rewriteLink('docs/scheduling.md', '')).toBe('./scheduling.html');
        expect(rewriteLink('docs/usage.md#auto-submit-missing-entries', '')).toBe(
            './usage.html#auto-submit-missing-entries',
        );
        expect(rewriteLink('docs/usage.lv.md#-problēmu-risināšana', '')).toBe('./usage.lv.html#-problēmu-risināšana');
        // from a doc in docs/, ../README.md is the home page
        expect(rewriteLink('../README.md', 'docs')).toBe('./index.html');
        expect(rewriteLink('scheduling.md', 'docs')).toBe('./scheduling.html');
        expect(rewriteLink('../README.lv.md#instalācija-katrai-platformai', 'docs')).toBe(
            './lv.html#instalācija-katrai-platformai',
        );
    });

    it('sends other repo-relative targets to the GitHub blob URL', () => {
        expect(rewriteLink('LICENSE', '')).toBe(`${BLOB}/LICENSE`);
        expect(rewriteLink('../CONTRIBUTING.md', 'docs')).toBe(`${BLOB}/CONTRIBUTING.md`);
    });

    it('passes anchors and scheme URLs through unchanged', () => {
        expect(rewriteLink('#-features', '')).toBe('#-features');
        expect(rewriteLink('https://example.com', '')).toBe('https://example.com');
        expect(rewriteLink('bitcoin:3JSKTwYk', '')).toBe('bitcoin:3JSKTwYk');
    });

    it('preserves #fragment and ?query suffixes when rewriting', () => {
        expect(rewriteLink('docs/scheduling.md#cron', '')).toBe('./scheduling.html#cron');
        expect(rewriteLink('LICENSE?raw=1', '')).toBe(`${BLOB}/LICENSE?raw=1`);
    });

    it('leaves empty and query-only hrefs untouched', () => {
        expect(rewriteLink('', '')).toBe('');
        expect(rewriteLink('?tab=readme', 'docs')).toBe('?tab=readme');
    });
});

describe('rewriteImage', () => {
    it('serves relative images from the site, resolved against the source directory', () => {
        expect(rewriteImage('src/assets/logo.png', 'Logo', '')).toBe('./images/src/assets/logo.png');
        expect(rewriteImage('shot.png', 'Shot', 'docs')).toBe('./images/docs/shot.png');
    });

    it('keeps a remote image only as a known static badge and drops every other one', () => {
        expect(rewriteImage('https://img.shields.io/badge/license-ISC-blue.svg', 'License', '')).toBe(
            './badges/license.svg',
        );
        expect(rewriteImage('https://coveralls.io/badge.svg', 'Coverage Status', '')).toBeNull();
        expect(rewriteImage('//cdn.example.com/x.png', 'License', '')).toBe('./badges/license.svg');
        expect(rewriteImage('https://example.com/x.png', 'constructor', '')).toBeNull();
    });

    it('drops empty, anchor-only and out-of-repo images', () => {
        expect(rewriteImage('', 'x', '')).toBeNull();
        expect(rewriteImage('#frag', 'x', '')).toBeNull();
        expect(rewriteImage('../../outside.png', 'x', 'docs')).toBeNull();
        expect(rewriteImage('..', 'x', '')).toBeNull();
    });
});

describe('badgeSvg', () => {
    it('draws a two-part badge with an accessible name', () => {
        const svg = badgeSvg(BADGES.License);
        expect(svg).toContain('role="img" aria-label="license: Apache-2.0"');
        expect(svg).toContain('<title>license: Apache-2.0</title>');
        expect(svg).toContain('fill="#555"');
        expect(svg).toContain('fill="#007ec6"');
        expect(svg).toContain('>license</text>');
        expect(svg).toContain('>Apache-2.0</text>');
    });

    it('escapes the label and the message in the accessible name', () => {
        const svg = badgeSvg({ label: 'a<b', message: 'A&B <"x">', color: '#000' });
        expect(svg).toContain('aria-label="a&#60;b: A&#38;B &#60;&#34;x&#34;&#62;"');
        expect(svg).not.toContain('<"x">');
    });

    it('references no other host', () => {
        for (const badge of Object.values(BADGES)) {
            const urls = new Set(badgeSvg(badge).match(/https?:\/\/[^\s"'<>)]+/g));
            expect([...urls]).toEqual(['http://www.w3.org/2000/svg']);
        }
    });
});

describe('buildNav (language switch)', () => {
    it('shows English content pages + a "Latviski" switch on English pages', () => {
        const nav = buildNav(pageBySrc('README.md')!);
        expect(nav).toContain('href="./index.html"');
        expect(nav).toContain('href="./scheduling.html"');
        expect(nav).toContain('href="./usage.html"');
        // the switch points to the Latvian guide, labelled in Latvian
        expect(nav).toContain('🇱🇻 Latviski');
        expect(nav).toContain('href="./lv.html"');
        // no "back to English" link while already in English
        expect(nav).not.toContain('🇬🇧 English');
        // current page is marked active
        expect(nav).toMatch(/href="\.\/index\.html" class="btn btn-ghost btn-sm btn-active"/);
    });

    it('shows an "English" switch back to the README on the Latvian page', () => {
        const nav = buildNav(pageBySrc('README.lv.md')!);
        expect(nav).toContain('🇬🇧 English');
        expect(nav).toContain('href="./index.html"');
        expect(nav).toContain('href="./usage.lv.html"');
        // the Latvian side has no separate scheduling page, and shouldn't offer "Latviski"
        expect(nav).not.toContain('href="./scheduling.html"');
        expect(nav).not.toContain('🇱🇻 Latviski');
    });

    it('keeps the privacy pages out of the navbar (the footer links them)', () => {
        expect(buildNav(pageBySrc('README.md')!)).not.toContain('privacy');
        expect(buildNav(pageBySrc('README.lv.md')!)).not.toContain('privacy');
        expect(buildNav(pageBySrc('docs/privacy.md')!)).not.toContain('privacy');
    });
});

describe('render', () => {
    it('replaces tokens and treats $ sequences in values literally', () => {
        expect(render('a {{x}} b', { x: 'Z' })).toBe('a Z b');
        expect(render('{{a}}{{a}}', { a: 'q' })).toBe('qq');
        // a value containing String.replace specials must not be interpreted
        expect(render('{{v}}', { v: '$&$1$$' })).toBe('$&$1$$');
    });
});

describe('main with every default', () => {
    const root = nodePath.join(__dirname, '..', '..');

    test('the parameter defaults are the repo paths, evaluated before any output', async () => {
        // main() with no arguments: every destructuring default (rootDir, out, layoutFile,
        // remoteSite) evaluates. The temp tree has no logo, so main stops at the logo check —
        // exactly where runCli's booby-trap test stops it — and nothing is written.
        const logSpy2 = jest.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy2 = jest.spyOn(console, 'error').mockImplementation(() => {});
        const exitSpy2 = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        globalThis.fetch = emptyReleasesFetch();
        try {
            // The defaults are the real repo paths: main() renders the real site (build output,
            // gitignored) exactly as `pnpm build:site` would — real release listing included,
            // stubbed here to an empty one so the test stays network-free. Whether the repo's dist/
            // holds a renderer build depends on the machine (CI tests before building), so only the
            // remote step having run off the default dist is asserted, never its output.
            await main();
            expect(fs.existsSync(nodePath.join(root, 'dist-site', 'index.html'))).toBe(true);
            expect(logSpy2).toHaveBeenCalledWith(
                expect.stringMatching(/^(✓ remote\/index\.html|⏭️ {2}remote\/ loader)/),
            );
        } finally {
            delete (globalThis as { fetch?: unknown }).fetch;
            exitSpy2.mockRestore();
            logSpy2.mockRestore();
            errorSpy2.mockRestore();
        }
    });
});

describe('buildRemoteSite (the /remote/ tree)', () => {
    let tmp: string;
    let out: string;
    let dist: string;
    let logSpy: jest.SpiedFunction<typeof console.log>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;

    const write = (rel: string, body: string) => {
        const full = nodePath.join(tmp, rel);
        fs.mkdirSync(nodePath.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    };

    /** A tiny real zip (one file, stored) so the unzip dep can be exercised for real when wanted. */
    const seedDist = (version: string): void => {
        write(nodePath.join('dist', 'remote-loader.html'), '<!doctype html><title>loader</title>');
        write(nodePath.join('dist', 'remoteLoader-bundle.js'), '// loader');
        write(nodePath.join('dist', 'styles.css'), 'body{}');
        write(nodePath.join('dist', 'remote', version, 'index.html'), `<html>v${version}</html>`);
        write(nodePath.join('dist', 'remote', version, 'remote-bundle.js'), '// page');
    };

    const release = (version: string, withZip: boolean, prerelease = false) => ({
        tag_name: `v${version}`,
        prerelease,
        assets: withZip
            ? [
                  { name: 'remote-page.zip', browser_download_url: `https://example.com/${version}.zip` },
                  { name: 'remote-page.zip.sha256', browser_download_url: `https://example.com/${version}.sha256` },
              ]
            : [],
    });

    beforeEach(() => {
        tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'build-site-remote-'));
        out = nodePath.join(tmp, 'dist-site');
        dist = nodePath.join(tmp, 'dist');
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('copies the loader and the local version, unpacks older zips after verifying their checksums, skips the rest', async () => {
        seedDist('9.9.9');
        const zipBytes = Buffer.from('zip-of-9.9.8');
        const sha256 = (data: Buffer) => nodeCrypto.createHash('sha256').update(data).digest('hex');
        await buildRemoteSite(out, '9.9.9', {
            dist,
            listReleases: async () => [
                release('9.9.9', true), // the current version: never downloaded
                release('9.9.8', true),
                release('9.9.7', false), // no zip yet: skipped with a log
            ],
            downloadFile: async (url: string) =>
                url.endsWith('.zip') ? zipBytes : Buffer.from(`${sha256(zipBytes)}  remote-page.zip\n`),
            unzip: async (_zip, dir) => {
                fs.writeFileSync(nodePath.join(dir, 'index.html'), `<html>v${nodePath.basename(dir)}</html>`);
            },
        });

        expect(fs.readdirSync(nodePath.join(out, 'remote')).sort()).toEqual([
            '9.9.8',
            '9.9.9',
            'index.html',
            'remoteLoader-bundle.js',
            'styles.css',
        ]);
        // The app stylesheet lands in the loader root and the current version dir.
        expect(fs.readFileSync(nodePath.join(out, 'remote', 'styles.css'), 'utf8')).toBe('body{}');
        expect(fs.readFileSync(nodePath.join(out, 'remote', '9.9.9', 'styles.css'), 'utf8')).toBe('body{}');
        expect(fs.readFileSync(nodePath.join(out, 'remote', 'index.html'), 'utf8')).toContain('loader');
        expect(fs.readFileSync(nodePath.join(out, 'remote', '9.9.9', 'index.html'), 'utf8')).toContain('v9.9.9');
        expect(fs.readFileSync(nodePath.join(out, 'remote', '9.9.8', 'index.html'), 'utf8')).toContain('v9.9.8');
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no remote-page.zip attached yet'));
    });

    test('a pre-release newer than the newest stable is kept and unpacked; an older one is dropped', async () => {
        seedDist('9.9.9');
        const zipBytes = Buffer.from('zip');
        const sha256 = (data: Buffer) => nodeCrypto.createHash('sha256').update(data).digest('hex');
        await buildRemoteSite(out, '9.9.9', {
            dist,
            listReleases: async () => [
                release('9.9.10-beta.1', true, true), // newer than the newest stable: kept
                release('9.9.9', true), // the current version: never downloaded
                release('9.9.8-beta.2', true, true), // older than the newest stable: dropped
                release('9.9.8', true),
            ],
            downloadFile: async (url: string) =>
                url.endsWith('.zip') ? zipBytes : Buffer.from(`${sha256(zipBytes)}  remote-page.zip\n`),
            unzip: async (_zip, dir) => {
                fs.writeFileSync(nodePath.join(dir, 'index.html'), `<html>v${nodePath.basename(dir)}</html>`);
            },
        });
        expect(fs.readdirSync(nodePath.join(out, 'remote')).sort()).toEqual([
            '9.9.10-beta.1',
            '9.9.8',
            '9.9.9',
            'index.html',
            'remoteLoader-bundle.js',
            'styles.css',
        ]);
    });

    test('a pre-release older than the newest stable is never unpacked, however big its zip', async () => {
        seedDist('9.9.9');
        await buildRemoteSite(out, '9.9.9', {
            dist,
            listReleases: async () => [release('9.9.9', true), release('9.9.8-beta.2', true, true)],
            downloadFile: async () => {
                throw new Error('must not download');
            },
        });
        expect(fs.existsSync(nodePath.join(out, 'remote', '9.9.8-beta.2'))).toBe(false);
    });

    test('the limit still holds with betas present: at most REMOTE_RELEASE_COUNT pages, betas included in the count', async () => {
        seedDist('9.9.9');
        const releases = [
            ...Array.from({ length: REMOTE_RELEASE_COUNT - 2 }, (_, i) => release(`9.9.${100 + i}-beta.1`, true, true)),
            ...Array.from({ length: 6 }, (_, i) => release(`9.8.${i}`, true)),
        ];
        const downloaded: string[] = [];
        const zipBytes = Buffer.from('zip');
        const sha256 = (data: Buffer) => nodeCrypto.createHash('sha256').update(data).digest('hex');
        await buildRemoteSite(out, '9.9.9', {
            dist,
            listReleases: async () => releases,
            downloadFile: async (url: string) => {
                downloaded.push(url);
                return url.endsWith('.zip') ? zipBytes : Buffer.from(`${sha256(zipBytes)}  remote-page.zip\n`);
            },
            unzip: async (_zip, dir) => {
                fs.writeFileSync(nodePath.join(dir, 'index.html'), `<html>v${nodePath.basename(dir)}</html>`);
            },
        });
        // REMOTE_RELEASE_COUNT + 4 kept candidates (8 betas, 6 stables) cut to ten, betas first:
        // each of the ten is tried as a zip and its checksum, the last four stables are beyond the cut.
        expect(downloaded).toHaveLength(REMOTE_RELEASE_COUNT * 2);
        expect(downloaded.some((url) => url.includes('beta'))).toBe(true);
        expect(downloaded.some((url) => url.includes('9.8.2.'))).toBe(false);
        expect(fs.readdirSync(nodePath.join(out, 'remote')).sort()).toEqual(
            [
                ...Array.from({ length: REMOTE_RELEASE_COUNT - 2 }, (_, i) => `9.9.${100 + i}-beta.1`),
                '9.8.0',
                '9.8.1',
                '9.9.9',
                'index.html',
                'remoteLoader-bundle.js',
                'styles.css',
            ].sort(),
        );
    });

    test('a failed release listing (a rate limit) fails the site build', async () => {
        seedDist('9.9.9');
        await expect(
            buildRemoteSite(out, '9.9.9', {
                dist,
                listReleases: async () => {
                    throw new Error('releases listing failed (403)');
                },
            }),
        ).rejects.toThrow('could not list the releases for the older phone pages: releases listing failed (403)');
    });

    test('a listing that fails without a reason is still said', async () => {
        seedDist('9.9.9');
        await expect(buildRemoteSite(out, '9.9.9', { dist, listReleases: () => Promise.reject(null) })).rejects.toThrow(
            'could not list the releases for the older phone pages: no reason given',
        );
    });

    test('the third-party notices sit beside the loader, and nothing is invented when the build has none', async () => {
        seedDist('9.9.9');
        write(nodePath.join('dist', 'THIRD_PARTY_NOTICES.txt'), 'NOTICES');
        await buildRemoteSite(out, '9.9.9', { dist, listReleases: async () => [] });
        expect(fs.readFileSync(nodePath.join(out, 'remote', 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toBe('NOTICES');

        const bare = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'build-site-remote-bare-'));
        try {
            fs.rmSync(nodePath.join(dist, 'THIRD_PARTY_NOTICES.txt'));
            await buildRemoteSite(bare, '9.9.9', { dist, listReleases: async () => [] });
            expect(fs.existsSync(nodePath.join(bare, 'remote', 'THIRD_PARTY_NOTICES.txt'))).toBe(false);
        } finally {
            fs.rmSync(bare, { recursive: true, force: true });
        }
    });

    test('a stylesheet without the local version page lands at the loader root only', async () => {
        write(nodePath.join('dist', 'styles.css'), 'body{}');
        await buildRemoteSite(out, '9.9.9', { dist, listReleases: async () => [] });
        expect(fs.readFileSync(nodePath.join(out, 'remote', 'styles.css'), 'utf8')).toBe('body{}');
        expect(fs.existsSync(nodePath.join(out, 'remote', '9.9.9'))).toBe(false);
    });

    test('a zip whose checksum does not match is refused', async () => {
        seedDist('9.9.9');
        await buildRemoteSite(out, '9.9.9', {
            dist,
            listReleases: async () => [release('9.9.8', true)],
            downloadFile: async (url: string) =>
                Buffer.from(url.endsWith('.zip') ? 'tampered' : 'deadbeef  remote-page.zip\n'),
            unzip: async () => {
                throw new Error('must not run');
            },
        });
        expect(fs.existsSync(nodePath.join(out, 'remote', '9.9.8'))).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('does not match its checksum'));
    });

    test('without the local build nothing remote is created, and the empty release list downloads nothing', async () => {
        globalThis.fetch = emptyReleasesFetch();
        try {
            await buildRemoteSite(out, '9.9.9', { dist });
            expect(fs.existsSync(nodePath.join(out, 'remote'))).toBe(false);
            expect(logSpy).toHaveBeenCalledWith('⏭️  remote/ loader: build:react has not produced it yet');
            expect(logSpy).toHaveBeenCalledWith('⏭️  remote/9.9.9/: build:react has not staged it yet');
            expect(logSpy).toHaveBeenCalledWith('⏭️  remote/styles.css: build:css has not produced it yet');
        } finally {
            delete (globalThis as { fetch?: unknown }).fetch;
        }
    });

    test('main without remoteSite uses the real defaults: the repo dist and the real release listing', async () => {
        // main() with no remoteSite option: every destructuring default runs (rootDir, out,
        // layoutFile, remoteSite) — the repo's real dist/ and the real (stubbed here) GitHub
        // listing. The temp tree carries the files the rest of main() reads.
        globalThis.fetch = emptyReleasesFetch();
        write('src/assets/logo.png', 'PNG');
        write('package.json', JSON.stringify({ version: '9.9.9' }));
        write('layout.html', '<main>{{content}}</main>');
        // main() renders every PAGES entry; seed each one it walks.
        for (const page of PAGES) write(page.src, `# ${page.src}`);
        try {
            await main({ rootDir: tmp, out, layoutFile: nodePath.join(tmp, 'layout.html') });
            // The repo's dist/ may or may not hold a renderer build (CI tests before building).
            expect(fs.existsSync(nodePath.join(out, 'index.html'))).toBe(true);
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringMatching(/^(✓ remote\/index\.html|⏭️ {2}remote\/ loader)/),
            );
        } finally {
            delete (globalThis as { fetch?: unknown }).fetch;
        }
    });

    test('a release whose version directory already exists is not unpacked twice', async () => {
        seedDist('9.9.9');
        const target = nodePath.join(out, 'remote', '9.9.8');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(nodePath.join(target, 'index.html'), '<html>kept</html>');
        await buildRemoteSite(out, '9.9.9', {
            dist,
            listReleases: async () => [release('9.9.8', true)],
            downloadFile: async () => {
                throw new Error('must not download');
            },
        });
        expect(fs.readFileSync(nodePath.join(target, 'index.html'), 'utf8')).toBe('<html>kept</html>');
    });

    test('the real unzip puts the zip content in place', async () => {
        seedDist('9.9.9');
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
        const target = nodePath.join(out, 'remote', '9.9.8');
        await buildRemoteSite(out, '9.9.9', {
            dist,
            listReleases: async () => [release('9.9.8', true)],
            downloadFile: async (url: string) =>
                url.endsWith('.zip')
                    ? fs.readFileSync(zipPath)
                    : Buffer.from(
                          `${nodeCrypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')}  remote-page.zip\n`,
                      ),
            // The real unzip dep (the default) runs here.
            unzip: invalid<(zipPath: string, dir: string) => Promise<void>>(undefined),
        });
        expect(fs.readFileSync(nodePath.join(target, 'index.html'), 'utf8')).toContain('paged');
        fs.rmSync(zipDir, { recursive: true, force: true });
    });
});

describe('selectRemotePageReleases', () => {
    const rel = (tag: string, prerelease = false) => ({ tag_name: tag, prerelease, assets: [] });

    test('keeps the stable releases in order and caps the total at REMOTE_RELEASE_COUNT', () => {
        const releases = [
            rel('v9.9.1'),
            rel('v9.9.2'), // out of order on purpose: the newest stable wins wherever it sits
            ...Array.from({ length: REMOTE_RELEASE_COUNT }, (_, i) => rel(`v9.8.${20 - i}`)),
        ];
        expect(selectRemotePageReleases(releases).map((r) => r.tag_name)).toEqual([
            'v9.9.1',
            'v9.9.2',
            ...Array.from({ length: REMOTE_RELEASE_COUNT - 2 }, (_, i) => `v9.8.${20 - i}`),
        ]);
    });

    test('keeps a pre-release newer than the newest stable and drops older and malformed ones', () => {
        const releases = [
            rel('v9.9.10-beta.1', true), // newer than the newest stable: kept
            rel('v9.9.9'),
            rel('not-a-version', true), // no release version to compare: dropped
            rel('v9.9.8-beta.2', true), // older than the newest stable: dropped
            rel('v9.9.8'),
        ];
        expect(selectRemotePageReleases(releases).map((r) => r.tag_name)).toEqual([
            'v9.9.10-beta.1',
            'v9.9.9',
            'v9.9.8',
        ]);
    });

    test('drops every pre-release when the listing has no stable release', () => {
        expect(selectRemotePageReleases([rel('v9.9.10-beta.1', true), rel('v9.9.9-beta.3', true)])).toEqual([]);
    });
});

describe('main (full render into a temp tree)', () => {
    let tmp: string;
    let out: string;
    let logSpy: jest.SpiedFunction<typeof console.log>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;
    let exitSpy: jest.SpiedFunction<typeof process.exit>;

    const write = (rel: string, body: string) => {
        const full = nodePath.join(tmp, rel);
        fs.mkdirSync(nodePath.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    };

    const seedRepo = ({ logo = true, latvian = true } = {}) => {
        write('package.json', JSON.stringify({ version: '9.9.9' }));
        write('layout.html', '<title>{{title}}</title><nav>{{nav}}</nav><main>{{content}}</main>v{{version}}');
        write('README.md', '# Title\n[Scheduling](docs/scheduling.md)\n![Logo](src/assets/logo.png)\n[Lic](LICENSE)');
        write('docs/scheduling.md', '[Home](../README.md)');
        if (latvian) write('README.lv.md', 'Sveiki');
        if (logo) write('src/assets/logo.png', 'PNG');
    };

    const opts = () => ({
        rootDir: tmp,
        out,
        layoutFile: nodePath.join(tmp, 'layout.html'),
        // The remote tree reads the repo's dist/ in production; the tests keep it out and
        // answer an empty release list so nothing is downloaded.
        remoteSite: { dist: nodePath.join(tmp, 'missing-dist'), listReleases: async () => [] },
    });

    beforeEach(() => {
        tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'build-site-'));
        out = nodePath.join(tmp, 'dist-site');
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        // process.exit must actually halt main() the way it does in production.
        exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        resetHeadings.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('renders every page with rewritten links, clears stale output, and copies the logo', async () => {
        seedRepo();
        write(
            'README.md',
            '# Title\n[Usage](docs/usage.md#-usage)\n[Scheduling](docs/scheduling.md)\n![Logo](src/assets/logo.png)\n[Lic](LICENSE)',
        );
        write('docs/usage.md', '[Home](../README.md)\n[Latviski](usage.lv.md)');
        write('docs/usage.lv.md', '[Sākums](../README.lv.md)\n[English](usage.md)');
        write('docs/privacy.md', '[Home](../README.md)');
        write('docs/privacy.lv.md', '[Sākums](../README.lv.md)');
        write('dist-site/stale.html', 'old');

        await main(opts());

        expect(fs.readdirSync(out).sort()).toEqual([
            'badges',
            'images',
            'index.html',
            'logo.png',
            'lv.html',
            'privacy.html',
            'privacy.lv.html',
            'scheduling.html',
            'usage.html',
            'usage.lv.html',
        ]);
        expect(fs.readdirSync(nodePath.join(out, 'badges')).sort()).toEqual(['license.svg']);
        expect(fs.readFileSync(nodePath.join(out, 'badges', 'license.svg'), 'utf8')).toContain(
            'aria-label="license: Apache-2.0"',
        );
        expect(fs.readFileSync(nodePath.join(out, 'images', 'src', 'assets', 'logo.png'), 'utf8')).toBe('PNG');
        const index = fs.readFileSync(nodePath.join(out, 'index.html'), 'utf8');
        expect(index).toContain('<title>GuruShots Auto Vote</title>');
        expect(index).toContain('<a href="./scheduling.html">Scheduling</a>');
        expect(index).toContain('<a href="./usage.html#-usage">Usage</a>');
        expect(index).toContain('<img src="./images/src/assets/logo.png" alt="Logo">');
        expect(index).toContain(`<a href="${BLOB}/LICENSE">Lic</a>`);
        expect(index).toContain('<p># Title</p>');
        expect(index).toContain('v9.9.9');
        expect(index).toContain('btn-active');
        // links in docs/ resolve relative to docs/
        expect(fs.readFileSync(nodePath.join(out, 'scheduling.html'), 'utf8')).toContain(
            '<a href="./index.html">Home</a>',
        );
        expect(fs.readFileSync(nodePath.join(out, 'usage.html'), 'utf8')).toContain(
            '<a href="./usage.lv.html">Latviski</a>',
        );
        expect(fs.readFileSync(nodePath.join(out, 'usage.lv.html'), 'utf8')).toContain(
            '<a href="./lv.html">Sākums</a>',
        );
        expect(fs.readFileSync(nodePath.join(out, 'logo.png'), 'utf8')).toBe('PNG');
        expect(resetHeadings).toHaveBeenCalledTimes(PAGES.length);
        expect(logSpy).toHaveBeenCalledWith(
            `✓ copied logo.png\n✓ rendered ${PAGES.length} page(s) to dist-site/ for v9.9.9`,
        );
    });

    describe('built with the real layout', () => {
        const seedSite = () => {
            seedRepo();
            write('docs/usage.md', 'usage');
            write('docs/scheduling.md', 'scheduling');
            write('docs/usage.lv.md', 'lietošana');
            write('docs/privacy.md', 'privacy');
            write('docs/privacy.lv.md', 'privātums');
        };
        const built = (name: string) => fs.readFileSync(nodePath.join(out, name), 'utf8');

        it('loads nothing from another host: remote badges become static files or text, scripts and styles are local', async () => {
            seedSite();
            write(
                'README.md',
                [
                    '![License](https://img.shields.io/badge/license-ISC-blue.svg)',
                    '![Build Status](https://github.com/isthisgitlab/gurushots-auto-vote/actions/workflows/build.yml/badge.svg)',
                    '![Coverage Status](//coveralls.io/repos/github/x/y/badge.svg)',
                    '![Logo](src/assets/logo.png)',
                    '[External](https://example.com)',
                ].join('\n'),
            );

            await main({ ...opts(), layoutFile: REAL_LAYOUT });

            const index = built('index.html');
            expect(index).toContain('<img src="./badges/license.svg" alt="License">');
            expect(index).toContain('<p>Build Status</p>');
            expect(index).toContain('<p>Coverage Status</p>');
            expect(index).toContain('<img src="./images/src/assets/logo.png" alt="Logo">');
            for (const page of PAGES) {
                const html = built(page.out);
                const hosts = [
                    ...[...html.matchAll(/<(?:img|script|iframe|source|video|audio)\b[^>]*\bsrc="([^"]*)"/g)].map(
                        (m) => m[1],
                    ),
                    ...[...html.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]),
                ];
                expect(hosts.length).toBeGreaterThan(0);
                for (const url of hosts) expect(url).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i);
            }
        });

        it('asks browsers for no referrer on every page', async () => {
            seedSite();

            await main({ ...opts(), layoutFile: REAL_LAYOUT });

            for (const page of PAGES) {
                expect(built(page.out)).toContain('<meta name="referrer" content="no-referrer" />');
            }
        });

        it('builds the privacy page in both languages and links it from the footer in that language', async () => {
            seedSite();

            await main({ ...opts(), layoutFile: REAL_LAYOUT });

            expect(built('privacy.html')).toContain('<title>Website privacy — GuruShots Auto Vote</title>');
            expect(built('privacy.lv.html')).toContain('<title>Vietnes privātums — GuruShots Auto Vote</title>');
            for (const page of PAGES) {
                const href = page.lang === 'en' ? './privacy.html' : './privacy.lv.html';
                const label = page.lang === 'en' ? 'Website privacy' : 'Vietnes privātums';
                expect(built(page.out)).toContain(`<a class="link" href="${href}">${label}</a>`);
            }
        });

        it('translates the footer and the page language on Latvian pages', async () => {
            seedSite();

            await main({ ...opts(), layoutFile: REAL_LAYOUT });

            const lv = built('lv.html');
            expect(lv).toContain('<html lang="lv"');
            expect(lv).toContain('Nav saistīts ar GuruShots.');
            expect(lv).toContain('Pirmkods vietnē GitHub');
            expect(lv).not.toContain('Not affiliated');
            const en = built('index.html');
            expect(en).toContain('<html lang="en"');
            expect(en).toContain('Not affiliated with GuruShots.');
            expect(en).toContain('Source on GitHub');
        });

        it('exits 1 when a page uses an image that is not in the repo', async () => {
            seedSite();
            write('README.md', '![Shot](missing.png)');

            await expect(main({ ...opts(), layoutFile: REAL_LAYOUT })).rejects.toThrow('exit 1');

            expect(errorSpy).toHaveBeenCalledWith('✗ image not found: missing.png');
        });
    });

    it('exits 1 before touching the output dir when the logo is missing', async () => {
        seedRepo({ logo: false });
        write('dist-site/stale.html', 'old');

        await expect(main(opts())).rejects.toThrow('exit 1');

        expect(errorSpy).toHaveBeenCalledWith(`✗ logo not found: ${nodePath.join('src', 'assets', 'logo.png')}`);
        expect(fs.readdirSync(out)).toEqual(['stale.html']);
    });

    it('exits 1 when a page source is missing', async () => {
        seedRepo();

        await expect(main(opts())).rejects.toThrow('exit 1');

        expect(errorSpy).toHaveBeenCalledWith('✗ source not found: docs/usage.md');
    });

    it('runCli uses the real repo paths and turns a failure into exit 1', async () => {
        // Hermetic: the first existsSync (the logo check) reports missing, so
        // main() stops before any output; write paths are booby-trapped in
        // case that ever changes, so the real dist-site/ can never be touched.
        jest.spyOn(fs, 'existsSync').mockReturnValueOnce(false);
        for (const fn of ['rmSync', 'mkdirSync', 'writeFileSync', 'copyFileSync'] as const) {
            jest.spyOn(fs, fn).mockImplementation(() => {
                throw new Error(`unexpected fs.${fn}`);
            });
        }
        exitSpy.mockReset();
        exitSpy.mockImplementationOnce((code) => {
            throw new Error(`exit ${code}`);
        });

        await runCli();

        expect(errorSpy).toHaveBeenCalledWith(`✗ logo not found: ${nodePath.join('src', 'assets', 'logo.png')}`);
        expect(errorSpy).toHaveBeenCalledWith(new Error('exit 1'));
        expect(exitSpy.mock.calls).toEqual([[1], [1]]);
    });
});

describe('the GitHub fetchers (the real remote-site deps)', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('the releases listing asks for headroom beyond the kept ten, sends no token it was not given, and refuses a failed response', async () => {
        const fetchMock = jest.fn(
            async () => ({ ok: true, status: 200, json: async () => [{ tag_name: 'v1.0.0' }] }) as Response,
        );
        globalThis.fetch = fetchMock as typeof fetch;
        const token = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;
        try {
            await expect(listReleasesFromGitHub()).resolves.toEqual([{ tag_name: 'v1.0.0' }]);
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('per_page=30'),
                expect.objectContaining({ headers: { 'User-Agent': 'gurushots-auto-vote-site-build' } }),
            );

            globalThis.fetch = respondWith({ ok: false, status: 403 });
            await expect(listReleasesFromGitHub()).rejects.toThrow('releases listing failed (403)');
        } finally {
            delete (globalThis as { fetch?: unknown }).fetch;
            if (token !== undefined) process.env.GITHUB_TOKEN = token;
        }
    });

    test('a GITHUB_TOKEN in the environment authorizes the listing, and only the listing', async () => {
        const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as Response);
        globalThis.fetch = fetchMock as typeof fetch;
        const token = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'ghs_test_token';
        try {
            await listReleasesFromGitHub();
            expect(fetchMock).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: { 'User-Agent': 'gurushots-auto-vote-site-build', Authorization: 'Bearer ghs_test_token' },
                }),
            );
            // An asset download is a plain request to the release's CDN; the token is the API's.
            fetchMock.mockClear();
            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                arrayBuffer: async () => new ArrayBuffer(1),
            } as Response);
            await downloadFromGitHub('https://example.com/x');
            expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('ghs_test_token');
        } finally {
            delete (globalThis as { fetch?: unknown }).fetch;
            if (token === undefined) delete process.env.GITHUB_TOKEN;
            else process.env.GITHUB_TOKEN = token;
        }
    });

    test('the asset download answers the bytes and refuses a failed response', async () => {
        globalThis.fetch = respondWith({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(3) });
        try {
            await expect(downloadFromGitHub('https://example.com/x')).resolves.toEqual(Buffer.alloc(3));

            globalThis.fetch = respondWith({ ok: false, status: 404 });
            await expect(downloadFromGitHub('https://example.com/x')).rejects.toThrow(
                'download failed for https://example.com/x (404)',
            );
        } finally {
            delete (globalThis as { fetch?: unknown }).fetch;
        }
    });
});
