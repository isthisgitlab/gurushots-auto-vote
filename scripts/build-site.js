#!/usr/bin/env node

// Renders the project's Markdown docs into a small, self-contained static site
// for GitHub Pages. The README stays the single source of truth — this script
// only transforms it (and the two docs it links to) into branded HTML that
// reuses the app's Tailwind + DaisyUI styling. Run `pnpm build:site` to also
// build the CSS; this file just emits the HTML and copies assets.
//
// The pure helpers (hasScheme/toRepoPath/rewriteLink/rewriteImage/render/
// srcDirOf) are exported for unit tests; main() runs only when the file is
// executed directly (require.main === module), so requiring it has no effect.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist-site');
const layoutPath = path.join(__dirname, 'site', 'layout.html');

const REPO = 'isthisgitlab/gurushots-auto-vote';
const GITHUB_BLOB = `https://github.com/${REPO}/blob/master`;
const GITHUB_RAW = `https://raw.githubusercontent.com/${REPO}/master`;
const SITE_DESCRIPTION =
    'Automated voting for GuruShots challenges — a shared engine shipped as a desktop GUI, a CLI, and an Android app.';

// Markdown source → output page. `nav` is the navbar label and `lang` groups
// pages by language. The navbar is generated per page from this list (see
// buildNav) so it cannot drift from the rendered pages. Keys are repo-relative
// POSIX paths so link rewriting can resolve against them; add a page here and
// links to it across the set resolve on-site.
const PAGES = [
    { src: 'README.md', out: 'index.html', title: 'GuruShots Auto Vote', nav: 'Home', lang: 'en' },
    {
        src: 'docs/scheduling.md',
        out: 'scheduling.html',
        title: 'Scheduling — GuruShots Auto Vote',
        nav: 'Scheduling',
        lang: 'en',
    },
    {
        src: 'docs/INSTALACIJA.md',
        out: 'installacija.html',
        title: 'Instalācija — GuruShots Auto Vote',
        nav: 'Sākums',
        lang: 'lv',
    },
];

// The site is bilingual: an English side (README + scheduling) and a Latvian
// side (the standalone install guide). Every page carries a switch to the OTHER
// language's entry page, labelled in the target language — so the Latvian guide
// shows "🇬🇧 English" (the way back) instead of a useless "Latviski".
const LANGUAGES = {
    en: { entry: 'index.html', switchLabel: '🇬🇧 English' },
    lv: { entry: 'installacija.html', switchLabel: '🇱🇻 Latviski' },
};

const srcToOut = Object.fromEntries(PAGES.map((p) => [p.src, p.out]));

const navLink = (out, label, active) =>
    `<a href="./${out}" class="btn btn-ghost btn-sm${active ? ' btn-active' : ''}">${label}</a>`;

// Per-page navbar: the current language's pages (current one marked active),
// followed by a switch to the other language's entry page.
const buildNav = (page) => {
    const links = PAGES.filter((p) => p.lang === page.lang).map((p) => navLink(p.out, p.nav, p.out === page.out));
    const target = page.lang === 'en' ? 'lv' : 'en';
    links.push(navLink(LANGUAGES[target].entry, LANGUAGES[target].switchLabel, false));
    return links.join('\n');
};

const hasScheme = (url) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('//');

// POSIX directory of a repo-relative source path ('' for root-level files).
const srcDirOf = (src) => {
    const dir = path.posix.dirname(src.split(path.sep).join('/'));
    return dir === '.' ? '' : dir;
};

// Resolve `rel` (a link target) to a repo-relative path with no leading ./,
// interpreted relative to `srcDir` (the directory of the file the link is in).
const toRepoPath = (srcDir, rel) => path.posix.normalize(path.posix.join(srcDir, rel)).replace(/^\.\//, '');

// Anchors and absolute/scheme URLs (http, mailto, bitcoin:, ethereum:, …) pass
// through. Relative links to a rendered page become its .html; any other
// repo-relative target (LICENSE, ../CONTRIBUTING.md, …) points at GitHub. Any
// ?query / #fragment suffix is preserved either way.
const rewriteLink = (href, srcDir) => {
    if (!href || href.startsWith('#') || hasScheme(href)) return href;
    const cut = href.search(/[?#]/);
    const rel = cut >= 0 ? href.slice(0, cut) : href;
    const suffix = cut >= 0 ? href.slice(cut) : '';
    if (rel === '') return href;
    const repoPath = toRepoPath(srcDir, rel);
    if (Object.prototype.hasOwnProperty.call(srcToOut, repoPath)) {
        return `./${srcToOut[repoPath]}${suffix}`;
    }
    return `${GITHUB_BLOB}/${repoPath}${suffix}`;
};

// The README references no local images today, but if one is ever added a
// relative <img> must resolve to GitHub's raw host to render off-repo.
const rewriteImage = (src, srcDir) => {
    if (!src || src.startsWith('#') || hasScheme(src)) return src;
    return `${GITHUB_RAW}/${toRepoPath(srcDir, src)}`;
};

const render = (template, tokens) => {
    let html = template;
    for (const [key, value] of Object.entries(tokens)) {
        // split/join (not String.replace) so `$` sequences in a value are literal.
        html = html.split(`{{${key}}}`).join(value);
    }
    return html;
};

const main = async () => {
    const { Marked } = await import('marked');
    const { gfmHeadingId, resetHeadings } = await import('marked-gfm-heading-id');

    // Encapsulate the per-page source directory in a closure (not a module
    // global) so the synchronous walkTokens hook resolves links against the
    // page currently being rendered without leaking state between pages.
    let activeSrcDir = '';
    const marked = new Marked({ gfm: true });
    marked.use(gfmHeadingId());
    marked.use({
        walkTokens(token) {
            if (token.type === 'link') token.href = rewriteLink(token.href, activeSrcDir);
            else if (token.type === 'image') token.href = rewriteImage(token.href, activeSrcDir);
        },
    });

    const logoSrc = path.join(root, 'src', 'assets', 'logo.png');
    if (!fs.existsSync(logoSrc)) {
        console.error(`✗ logo not found: ${path.relative(root, logoSrc)}`);
        process.exit(1);
    }

    const layout = fs.readFileSync(layoutPath, 'utf8');
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    for (const page of PAGES) {
        const srcPath = path.join(root, page.src);
        if (!fs.existsSync(srcPath)) {
            console.error(`✗ source not found: ${page.src}`);
            process.exit(1);
        }
        activeSrcDir = srcDirOf(page.src);
        // Reset the slugger so each page numbers its heading ids from scratch
        // (otherwise repeated headings across pages collect -1/-2 suffixes).
        resetHeadings();
        const content = marked.parse(fs.readFileSync(srcPath, 'utf8'));
        const html = render(layout, {
            title: page.title,
            description: SITE_DESCRIPTION,
            nav: buildNav(page),
            content,
            version,
        });
        fs.writeFileSync(path.join(outDir, page.out), html, 'utf8');
        console.log(`✓ ${page.src} → dist-site/${page.out}`);
    }

    fs.copyFileSync(logoSrc, path.join(outDir, 'logo.png'));
    console.log(`✓ copied logo.png\n✓ rendered ${PAGES.length} page(s) to dist-site/ for v${version}`);
};

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { hasScheme, srcDirOf, toRepoPath, rewriteLink, rewriteImage, render, buildNav, PAGES };
