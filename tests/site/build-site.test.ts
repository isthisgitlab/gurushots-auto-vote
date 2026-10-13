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
const fs = jest.mocked(fsModule);
import os = require('node:os');
import nodePathModule = require('node:path');
const nodePath = jest.mocked(nodePathModule);
import type * as marked_gfm_heading_idModule from 'marked-gfm-heading-id';
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
    main,
    runCli,
} = require('../../scripts/build-site') as typeof build_siteModule;

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
        expect(rewriteImage('https://img.shields.io/badge/Bitcoin-000', 'Bitcoin', '')).toBe('./badges/bitcoin.svg');
        expect(rewriteImage('https://coveralls.io/badge.svg', 'Coverage Status', '')).toBeNull();
        expect(rewriteImage('//cdn.example.com/x.png', 'Ethereum', '')).toBe('./badges/ethereum.svg');
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

    it('draws a single coloured block when there is no label, and escapes the text', () => {
        const svg = badgeSvg({ message: 'A&B <"x">', color: '#000' });
        expect(svg).not.toContain('fill="#555"');
        expect(svg).toContain('aria-label="A&#38;B &#60;&#34;x&#34;&#62;"');
        expect(svg).not.toContain('<"x">');
    });

    it('references no other host', () => {
        for (const badge of Object.values(BADGES)) {
            expect(badgeSvg(badge)).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
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

    const opts = () => ({ rootDir: tmp, out, layoutFile: nodePath.join(tmp, 'layout.html') });

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
        expect(fs.readdirSync(nodePath.join(out, 'badges')).sort()).toEqual([
            'bitcoin.svg',
            'ethereum.svg',
            'license.svg',
        ]);
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
