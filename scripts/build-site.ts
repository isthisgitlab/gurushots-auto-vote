#!/usr/bin/env node

// Renders the project's Markdown docs into a small, self-contained static site
// for GitHub Pages. The READMEs and linked guides stay the source of truth — this script
// only transforms them into branded HTML that
// reuses the app's Tailwind + DaisyUI styling. Run `pnpm build:site` to also
// build the CSS; this file just emits the HTML and copies assets.
//
// The site's content and the pure helpers (hasScheme/toRepoPath/rewriteLink/
// rewriteImage/badgeSvg/render/srcDirOf, exported for unit tests) live in
// build-site/pages.ts; the current remote-access site tree (the /remote/ launcher and v2 page) lives in
// build-site/remote.ts — re-exported here. main() runs only when the file is executed directly (via runIfMain),
// so requiring it has no effect.
// main() takes the repo root / output dir / layout as overridable paths so the
// full render can be tested against a temp tree without touching dist-site/.

import fs from 'node:fs';
import path from 'node:path';
import type { Tokens } from 'marked';
import { runIfMain } from './lib/run-if-main';
import {
    BADGE_DIR,
    BADGES,
    IMAGE_DIR,
    LANGUAGES,
    PAGES,
    SITE_DESCRIPTION,
    badgeHref,
    badgeSvg,
    buildNav,
    hasScheme,
    render,
    rewriteImage,
    rewriteLink,
    srcDirOf,
    toRepoPath,
} from './build-site/pages';
import { buildRemoteSite } from './build-site/remote';

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist-site');
const layoutPath = path.join(__dirname, 'site', 'layout.html');

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

const main = async ({
    rootDir = root,
    out = outDir,
    layoutFile = layoutPath,
    remoteDist,
}: {
    rootDir?: string;
    out?: string;
    layoutFile?: string;
    remoteDist?: string;
} = {}) => {
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

    buildRemoteSite(out, remoteDist);
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

export { buildRemoteSite } from './build-site/remote';
