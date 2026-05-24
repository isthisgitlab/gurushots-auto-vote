// Unit tests for the GitHub Pages renderer's pure helpers. These guard the
// "README is the single source of truth" invariant: as the README/docs evolve,
// their cross-links must keep resolving on the static site. Importing the module
// is side-effect-free — main() runs only under `require.main === module`.

// The shared tests/setup.js mocks `path` globally (no `.posix`); this suite
// tests real path resolution, so restore the actual module for this file only.
jest.unmock('node:path');
jest.unmock('path');

const {
    hasScheme,
    srcDirOf,
    toRepoPath,
    rewriteLink,
    rewriteImage,
    render,
    buildNav,
    PAGES,
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
        expect(srcDirOf('docs/INSTALACIJA.md')).toBe('docs');
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
        expect(rewriteLink('docs/INSTALACIJA.md', '')).toBe('./installacija.html');
        expect(rewriteLink('docs/scheduling.md', '')).toBe('./scheduling.html');
        // from a doc in docs/, ../README.md is the home page
        expect(rewriteLink('../README.md', 'docs')).toBe('./index.html');
        expect(rewriteLink('scheduling.md', 'docs')).toBe('./scheduling.html');
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
});

describe('rewriteImage', () => {
    it('rewrites relative images to the raw host and leaves absolute ones', () => {
        expect(rewriteImage('src/assets/logo.png', '')).toBe(`${RAW}/src/assets/logo.png`);
        expect(rewriteImage('https://img.shields.io/badge.svg', '')).toBe('https://img.shields.io/badge.svg');
    });
});

describe('buildNav (language switch)', () => {
    it('shows English content pages + a "Latviski" switch on English pages', () => {
        const nav = buildNav(pageBySrc('README.md'));
        expect(nav).toContain('href="./index.html"');
        expect(nav).toContain('href="./scheduling.html"');
        // the switch points to the Latvian guide, labelled in Latvian
        expect(nav).toContain('🇱🇻 Latviski');
        expect(nav).toContain('href="./installacija.html"');
        // no "back to English" link while already in English
        expect(nav).not.toContain('🇬🇧 English');
        // current page is marked active
        expect(nav).toMatch(/href="\.\/index\.html" class="btn btn-ghost btn-sm btn-active"/);
    });

    it('shows an "English" switch back to the README on the Latvian page', () => {
        const nav = buildNav(pageBySrc('docs/INSTALACIJA.md'));
        expect(nav).toContain('🇬🇧 English');
        expect(nav).toContain('href="./index.html"');
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
