#!/usr/bin/env node

// Renders the project's Markdown docs into a small, self-contained static site
// for GitHub Pages. The READMEs and linked guides stay the source of truth — this script
// only transforms them into branded HTML that
// reuses the app's Tailwind + DaisyUI styling. Run `pnpm build:site` to also
// build the CSS; this file just emits the HTML and copies assets.
//
// The pure helpers (hasScheme/toRepoPath/rewriteLink/rewriteImage/badgeSvg/render/
// srcDirOf) are exported for unit tests; main() runs only when the file is
// executed directly (via runIfMain), so requiring it has no effect.
// main() takes the repo root / output dir / layout as overridable paths so the
// full render can be tested against a temp tree without touching dist-site/.

import fs from 'node:fs';
import path from 'node:path';
import { runIfMain } from './lib/run-if-main';
import type { Tokens } from 'marked';

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist-site');
const layoutPath = path.join(__dirname, 'site', 'layout.html');

const REPO = 'isthisgitlab/gurushots-auto-vote';
const GITHUB_BLOB = `https://github.com/${REPO}/blob/master`;
const SITE_DESCRIPTION =
    'Automated voting for GuruShots challenges — a shared engine shipped as a desktop GUI, a CLI, and an Android app.';

// Markdown source → output page. `nav` is the navbar label and `lang` groups
// pages by language. The navbar is generated per page from this list (see
// buildNav) so it cannot drift from the rendered pages. Keys are repo-relative
// POSIX paths so link rewriting can resolve against them; add a page here and
// links to it across the set resolve on-site.
type Lang = 'en' | 'lv';

interface Footer {
    source: string;
    privacy: string;
    note: string;
}

interface Badge {
    label: string;
    message: string;
    color: string;
}

interface SitePage {
    src: string;
    out: string;
    title: string;
    nav: string;
    lang: Lang;
    /** false keeps the page out of the navbar (it is linked from the footer instead) */
    inNav?: boolean;
}

const PAGES: SitePage[] = [
    { src: 'README.md', out: 'index.html', title: 'GuruShots Auto Vote', nav: 'Home', lang: 'en' },
    {
        src: 'docs/usage.md',
        out: 'usage.html',
        title: 'Usage — GuruShots Auto Vote',
        nav: 'Usage',
        lang: 'en',
    },
    {
        src: 'docs/scheduling.md',
        out: 'scheduling.html',
        title: 'Scheduling — GuruShots Auto Vote',
        nav: 'Scheduling',
        lang: 'en',
    },
    {
        src: 'README.lv.md',
        out: 'lv.html',
        title: 'GuruShots Auto Vote',
        nav: 'Sākums',
        lang: 'lv',
    },
    {
        src: 'docs/usage.lv.md',
        out: 'usage.lv.html',
        title: 'Lietošana — GuruShots Auto Vote',
        nav: 'Lietošana',
        lang: 'lv',
    },
    {
        src: 'docs/privacy.md',
        out: 'privacy.html',
        title: 'Website privacy — GuruShots Auto Vote',
        nav: 'Privacy',
        lang: 'en',
        inNav: false,
    },
    {
        src: 'docs/privacy.lv.md',
        out: 'privacy.lv.html',
        title: 'Vietnes privātums — GuruShots Auto Vote',
        nav: 'Privātums',
        lang: 'lv',
        inNav: false,
    },
];

// The site is bilingual: an English side (README, usage, scheduling) and a Latvian
// side (README.lv.md and usage.lv.md). Every page carries a switch to the OTHER
// language's entry page, labelled in the target language — so the Latvian guide
// shows "🇬🇧 English" (the way back) instead of a useless "Latviski". The footer
// strings and the privacy page the footer links to follow the page's language.
const LANGUAGES: Record<Lang, { entry: string; switchLabel: string; privacy: string; footer: Footer }> = {
    en: {
        entry: 'index.html',
        switchLabel: '🇬🇧 English',
        privacy: 'privacy.html',
        footer: {
            source: 'Source on GitHub',
            privacy: 'Website privacy',
            note: 'Rendered from the project README. Not affiliated with GuruShots.',
        },
    },
    lv: {
        entry: 'lv.html',
        switchLabel: '🇱🇻 Latviski',
        privacy: 'privacy.lv.html',
        footer: {
            source: 'Pirmkods vietnē GitHub',
            privacy: 'Vietnes privātums',
            note: 'Izveidots no projekta README faila. Nav saistīts ar GuruShots.',
        },
    },
};

// The README's remote badge images, by alt text. Each is drawn here as a static SVG and served from the site, so a
// built page never requests another host; any other remote image (a live build or coverage badge) is dropped and
// its alt text stays.
const BADGES: Record<string, Badge> = {
    License: { label: 'license', message: 'Apache-2.0', color: '#007ec6' },
};
const BADGE_DIR = 'badges';
const IMAGE_DIR = 'images';

const srcToOut = Object.fromEntries(PAGES.map((p) => [p.src, p.out]));

const navLink = (out: string, label: string, active: boolean) =>
    `<a href="./${out}" class="btn btn-ghost btn-sm${active ? ' btn-active' : ''}">${label}</a>`;

// Per-page navbar: the current language's pages (current one marked active),
// followed by a switch to the other language's entry page.
const buildNav = (page: SitePage) => {
    const links = PAGES.filter((p) => p.lang === page.lang && p.inNav !== false).map((p) =>
        navLink(p.out, p.nav, p.out === page.out),
    );
    const target = page.lang === 'en' ? 'lv' : 'en';
    links.push(navLink(LANGUAGES[target].entry, LANGUAGES[target].switchLabel, false));
    return links.join('\n');
};

const hasScheme = (url: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('//');

// POSIX directory of a repo-relative source path ('' for root-level files).
const srcDirOf = (src: string) => {
    const dir = path.posix.dirname(src.split(path.sep).join('/'));
    return dir === '.' ? '' : dir;
};

// Resolve `rel` (a link target) to a repo-relative path with no leading ./,
// interpreted relative to `srcDir` (the directory of the file the link is in).
const toRepoPath = (srcDir: string, rel: string) =>
    path.posix.normalize(path.posix.join(srcDir, rel)).replace(/^\.\//, '');

// Anchors and absolute/scheme URLs (http, mailto, bitcoin:, ethereum:, …) pass
// through. Relative links to a rendered page become its .html; any other
// repo-relative target (LICENSE, ../CONTRIBUTING.md, …) points at GitHub. Any
// ?query / #fragment suffix is preserved either way.
const rewriteLink = (href: string, srcDir: string) => {
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

const hasBadge = (alt: string) => Object.prototype.hasOwnProperty.call(BADGES, alt);

const badgeHref = (alt: string) => `./${BADGE_DIR}/${alt.toLowerCase()}.svg`;

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A flat two-part badge; the width follows the text length, which is close enough for these short fixed texts.
const badgeSvg = ({ label, message, color }: Badge) => {
    const widthOf = (text: string) => Math.ceil(text.length * 7) + 12;
    const labelWidth = widthOf(label);
    const messageWidth = widthOf(message);
    const name = escapeXml(`${label}: ${message}`);
    const text = (x: number, value: string) =>
        `<text x="${x}" y="14" fill="#fff" text-anchor="middle">${escapeXml(value)}</text>`;
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${labelWidth + messageWidth}" height="20" role="img" aria-label="${name}">`,
        `<title>${name}</title>`,
        `<rect width="${labelWidth}" height="20" fill="#555"/>`,
        `<rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${color}"/>`,
        '<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">',
        text(labelWidth / 2, label),
        text(labelWidth + messageWidth / 2, message),
        '</g></svg>',
    ].join('');
};

// Where an image is served from on the site, or null when it is dropped (the alt text stays). A relative image is
// copied into the site; a remote one is kept only as one of the static badges. The site never requests another host.
const rewriteImage = (src: string, alt: string, srcDir: string) => {
    if (!src || src.startsWith('#')) return null;
    if (hasScheme(src)) return hasBadge(alt) ? badgeHref(alt) : null;
    const repoPath = toRepoPath(srcDir, src);
    return /^\.\.(\/|$)/.test(repoPath) ? null : `./${IMAGE_DIR}/${repoPath}`;
};

const render = (template: string, tokens: Record<string, string>) => {
    let html = template;
    for (const [key, value] of Object.entries(tokens)) {
        // split/join (not String.replace) so `$` sequences in a value are literal.
        html = html.split(`{{${key}}}`).join(value);
    }
    return html;
};

/** The markdown renderer: `renderPage` turns one page's source into HTML; `localImages` collects the repo images the rendered pages use. */
const createMarkdownRenderer = async () => {
    const { Marked } = await import('marked');
    const { gfmHeadingId, resetHeadings } = await import('marked-gfm-heading-id');

    // Encapsulate the per-page source directory in a closure (not a module
    // global) so the synchronous walkTokens hook resolves links against the
    // page currently being rendered without leaking state between pages.
    let activeSrcDir = '';
    // Repo paths of the relative images the pages use, copied into the site afterwards.
    const localImages = new Set<string>();
    const marked = new Marked({ gfm: true });
    marked.use(gfmHeadingId());
    marked.use({
        walkTokens(token) {
            // The type tag names the token's shape; marked's union also carries a
            // generic token that the tag check cannot rule out.
            if (token.type === 'link') {
                const link = token as Tokens.Link;
                link.href = rewriteLink(link.href, activeSrcDir);
            } else if (token.type === 'image') {
                const image = token as Tokens.Image;
                const href = rewriteImage(image.href, image.text, activeSrcDir);
                if (href === null) {
                    // Dropped: the image becomes its alt text (a linked badge stays a text link).
                    Object.assign(token, { type: 'text', raw: image.text, text: image.text });
                } else {
                    image.href = href;
                    if (href.startsWith(`./${IMAGE_DIR}/`)) localImages.add(href.slice(`./${IMAGE_DIR}/`.length));
                }
            }
        },
    });

    const renderPage = (markdown: string, srcDir: string) => {
        activeSrcDir = srcDir;
        // Reset the slugger so each page numbers its heading ids from scratch
        // (otherwise repeated headings across pages collect -1/-2 suffixes).
        resetHeadings();
        // No async extension is registered, so parse returns synchronously; its
        // declared type only widens to Promise for the `async: true` option.
        return marked.parse(markdown) as string;
    };

    return { renderPage, localImages };
};

/** Copies the repo images the rendered pages reference into the site's image directory. */
const copyLocalImages = (images: Iterable<string>, rootDir: string, out: string) => {
    for (const image of images) {
        const imageSrc = path.join(rootDir, image);
        if (!fs.existsSync(imageSrc)) {
            console.error(`✗ image not found: ${image}`);
            process.exit(1);
        }
        fs.mkdirSync(path.dirname(path.join(out, IMAGE_DIR, image)), { recursive: true });
        fs.copyFileSync(imageSrc, path.join(out, IMAGE_DIR, image));
    }
};

const main = async ({ rootDir = root, out = outDir, layoutFile = layoutPath } = {}) => {
    const { renderPage, localImages } = await createMarkdownRenderer();

    const logoSrc = path.join(rootDir, 'src', 'assets', 'logo.png');
    if (!fs.existsSync(logoSrc)) {
        console.error(`✗ logo not found: ${path.relative(rootDir, logoSrc)}`);
        process.exit(1);
    }

    const layout = fs.readFileSync(layoutFile, 'utf8');
    const { version } = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version: string };

    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });

    for (const page of PAGES) {
        const srcPath = path.join(rootDir, page.src);
        if (!fs.existsSync(srcPath)) {
            console.error(`✗ source not found: ${page.src}`);
            process.exit(1);
        }
        const content = renderPage(fs.readFileSync(srcPath, 'utf8'), srcDirOf(page.src));
        const { footer, privacy } = LANGUAGES[page.lang];
        const html = render(layout, {
            lang: page.lang,
            title: page.title,
            description: SITE_DESCRIPTION,
            nav: buildNav(page),
            content,
            version,
            sourceLabel: footer.source,
            privacyHref: `./${privacy}`,
            privacyLabel: footer.privacy,
            footerNote: footer.note,
        });
        fs.writeFileSync(path.join(out, page.out), html, 'utf8');
        console.log(`✓ ${page.src} → dist-site/${page.out}`);
    }

    fs.mkdirSync(path.join(out, BADGE_DIR));
    for (const [alt, badge] of Object.entries(BADGES)) {
        fs.writeFileSync(path.join(out, badgeHref(alt)), badgeSvg(badge), 'utf8');
    }
    copyLocalImages(localImages, rootDir, out);

    fs.copyFileSync(logoSrc, path.join(out, 'logo.png'));
    console.log(`✓ copied logo.png\n✓ rendered ${PAGES.length} page(s) to dist-site/ for v${version}`);
};

const runCli = () =>
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });

runIfMain(require.main, module, runCli);

export {
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
};
