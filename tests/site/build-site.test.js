// Unit tests for the GitHub Pages renderer. The pure helpers guard the
// source Markdown invariant: as the README/docs evolve,
// their cross-links must keep resolving on the static site. Importing the module
// is side-effect-free — main() runs only when the file is the entry point.
// main() itself is exercised against a temp repo tree under os.tmpdir(); the
// real dist-site/ is never written.

// The shared tests/setup.js mocks `path` and `fs` globally (no `.posix`); this
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
        constructor() {
            this.walkers = [];
        }
        use(ext) {
            if (ext.walkTokens) this.walkers.push(ext.walkTokens);
        }
        parse(md) {
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

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { resetHeadings } = require('marked-gfm-heading-id');

const {
    hasScheme,
    srcDirOf,
    toRepoPath,
    rewriteLink,
    rewriteImage,
    render,
    buildNav,
    PAGES,
    main,
    runCli,
} = require('../../scripts/build-site.js');

const pageBySrc = (src) => PAGES.find((p) => p.src === src);

const BLOB = 'https://github.com/isthisgitlab/gurushots-auto-vote/blob/master';
const RAW = 'https://raw.githubusercontent.com/isthisgitlab/gurushots-auto-vote/master';

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
    it('rewrites relative images to the raw host and leaves absolute ones', () => {
        expect(rewriteImage('src/assets/logo.png', '')).toBe(`${RAW}/src/assets/logo.png`);
        expect(rewriteImage('https://img.shields.io/badge.svg', '')).toBe('https://img.shields.io/badge.svg');
        expect(rewriteImage('', '')).toBe('');
        expect(rewriteImage('#frag', '')).toBe('#frag');
    });
});

describe('buildNav (language switch)', () => {
    it('shows English content pages + a "Latviski" switch on English pages', () => {
        const nav = buildNav(pageBySrc('README.md'));
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
        const nav = buildNav(pageBySrc('README.lv.md'));
        expect(nav).toContain('🇬🇧 English');
        expect(nav).toContain('href="./index.html"');
        expect(nav).toContain('href="./usage.lv.html"');
        // the Latvian side has no separate scheduling page, and shouldn't offer "Latviski"
        expect(nav).not.toContain('href="./scheduling.html"');
        expect(nav).not.toContain('🇱🇻 Latviski');
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
    let tmp;
    let out;
    let logSpy;
    let errorSpy;
    let exitSpy;

    const write = (rel, body) => {
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
        write('dist-site/stale.html', 'old');

        await main(opts());

        expect(fs.readdirSync(out).sort()).toEqual([
            'index.html',
            'logo.png',
            'lv.html',
            'scheduling.html',
            'usage.html',
            'usage.lv.html',
        ]);
        const index = fs.readFileSync(nodePath.join(out, 'index.html'), 'utf8');
        expect(index).toContain('<title>GuruShots Auto Vote</title>');
        expect(index).toContain('<a href="./scheduling.html">Scheduling</a>');
        expect(index).toContain('<a href="./usage.html#-usage">Usage</a>');
        expect(index).toContain(`<img src="${RAW}/src/assets/logo.png" alt="Logo">`);
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
        for (const fn of ['rmSync', 'mkdirSync', 'writeFileSync', 'copyFileSync']) {
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
