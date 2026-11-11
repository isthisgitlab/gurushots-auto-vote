// The renderer build itself: stage dist/'s documents and static assets, build
// (or watch) every entry's bundle, and stage the remote page tree.

import { build, context } from 'esbuild';
import type { BuildContext } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { removeVisionWebAssets, stageVisionWebAssets } from '../fetch-vision-model';
import {
    HEADLESS_FLAG_FILE,
    HEADLESS_FLAG_SOURCE,
    capacitorIndexHtml,
    headlessHtml,
    remoteHtml,
    remoteLoaderHtml,
    webHtml,
} from './documents';
import { LINK_VERSION } from '../../src/ts/core/remote/protocol';
import { DIST_DIR, rendererBundleDir, rendererStylesheetPath } from '../lib/build-paths';
import { commonOptions, entryPoints, isLite, isWatch, perEntryOptions } from './entries';
import type { EntryName } from './entries';

const NOTICES_ASSET_NAME = 'THIRD_PARTY_NOTICES.txt';
const bundleDir = rendererBundleDir(isLite);

const assembleStylesheet = (outputDir = DIST_DIR): void => {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(rendererStylesheetPath, path.join(outputDir, 'styles.css'));
};

const prepareAssembly = async (distDir: string, bundleSourceDir: string) => {
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });
    for (const name of Object.keys(entryPoints)) {
        const source = path.join(bundleSourceDir, `${name}-bundle.js`);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(distDir, `${name}-bundle.js`));
    }
    if (fs.existsSync(rendererStylesheetPath)) assembleStylesheet(distDir);
    if (isLite) removeVisionWebAssets(distDir);
    else await stageVisionWebAssets(distDir);

    // Emit the Capacitor entry point. Electron ignores it; the Android
    // WebView treats it as the app's root document.
    fs.writeFileSync(path.join(distDir, 'index.html'), capacitorIndexHtml);
    // Background service document (loaded by AutoVoteService's WebView).
    fs.writeFileSync(path.join(distDir, 'headless.html'), headlessHtml);
    fs.writeFileSync(path.join(distDir, HEADLESS_FLAG_FILE), HEADLESS_FLAG_SOURCE);
    // Web shell document (served by src/ts/shells/web/server.ts).
    fs.writeFileSync(path.join(distDir, 'web.html'), webHtml);
    // Remote phone page + loader documents.
    fs.writeFileSync(path.join(distDir, 'remote.html'), remoteHtml);
    fs.writeFileSync(path.join(distDir, 'remote-loader.html'), remoteLoaderHtml);
    // The app icon next to it: the server answers the browser's /favicon.ico
    // with this file. The same committed logo the Electron and Android builds
    // use as their icon.
    const logoSrc = path.join(__dirname, '..', '..', 'src', 'assets', 'logo.png');
    fs.copyFileSync(logoSrc, path.join(distDir, 'favicon.png'));

    // Ship the semantic-matching word-vector lexicon into the webDir so the
    // Android WebView (Capacitor page + headless service) can fetch() it at
    // runtime. It is a runtime asset — never imported into a bundle — so the
    // renderer/headless/capacitor size budgets stay untouched. Regenerate it
    // with `pnpm build:lexicon`; the committed src/assets copy ships in the
    // Electron asar and is embedded as a SEA asset for the CLI binary.
    const lexiconSrc = path.join(__dirname, '..', '..', 'src', 'assets', 'semantic-vectors.json');
    if (fs.existsSync(lexiconSrc)) {
        fs.copyFileSync(lexiconSrc, path.join(distDir, 'semantic-vectors.json'));
    }

    // The same for the third-party notices the licenses dialog fetch()es next to the document
    // (thirdPartyNotices.ts).
    const noticesSrc = path.join(__dirname, '..', '..', 'src', 'assets', NOTICES_ASSET_NAME);
    if (fs.existsSync(noticesSrc)) {
        fs.copyFileSync(noticesSrc, path.join(distDir, NOTICES_ASSET_NAME));
    }
};

const watchEntries = async () => {
    // Watch mode - create contexts for each entry point
    const contexts: { name: EntryName; ctx: BuildContext }[] = [];

    // Object.entries widens keys to string; entryPoints has exactly the EntryName keys.
    for (const [name, entry] of Object.entries(entryPoints) as [EntryName, string][]) {
        // Only build if entry file exists
        if (!fs.existsSync(entry)) {
            console.log(`⏭️  Skipping ${name} (file not found: ${entry})`);
            continue;
        }

        const ctx = await context({
            ...commonOptions,
            ...perEntryOptions[name],
            entryPoints: [entry],
            outfile: path.join(DIST_DIR, `${name}-bundle.js`),
        });

        contexts.push({ name, ctx });
    }

    if (contexts.length === 0) {
        console.log('⚠️  No React entry points found. Create pages in src/ts/react/pages/');
        return;
    }

    // Start watching all contexts
    for (const { name, ctx } of contexts) {
        await ctx.watch();
        console.log(`👀 Watching ${name}...`);
    }

    console.log('\n✅ Watch mode active. Press Ctrl+C to stop.\n');

    // Keep process alive
    process.on('SIGINT', async () => {
        console.log('\n🛑 Stopping watch mode...');
        for (const { ctx } of contexts) {
            await ctx.dispose();
        }
        process.exit(0);
    });
};

const buildEntries = async (outputDir = bundleDir) => {
    fs.mkdirSync(outputDir, { recursive: true });
    // Build mode - build each entry point
    let builtCount = 0;

    // Object.entries widens keys to string; entryPoints has exactly the EntryName keys.
    for (const [name, entry] of Object.entries(entryPoints) as [EntryName, string][]) {
        // Only build if entry file exists
        if (!fs.existsSync(entry)) {
            console.log(`⏭️  Skipping ${name} (file not found: ${entry})`);
            continue;
        }

        await build({
            ...commonOptions,
            ...perEntryOptions[name],
            entryPoints: [entry],
            outfile: path.join(outputDir, `${name}-bundle.js`),
        });

        console.log(`✅ Built ${name}-bundle.js`);
        builtCount++;
    }

    if (builtCount === 0) {
        console.log('⚠️  No React entry points found. Create pages in src/ts/react/pages/');
    } else {
        console.log(`\n🎉 React build completed! (${builtCount} bundles)`);
    }
};

// The remote page under dist/remote/v<LINK_VERSION>/ (HTML, bundle, CSS, notices): Capacitor's
// webDir carries it into the APK, so the Android remote mode loads its bundled page without
// the network. The directory is named by the link version, not the app version: one page
// serves every desktop that speaks the link. dist/remote/ is emptied first, so a build carries
// no folder an earlier build staged. Run after the bundles are built, never in watch mode.
const copyRemoteVersionDir = (distDir = DIST_DIR): void => {
    const loaderDir = path.join(distDir, 'remote');
    fs.rmSync(loaderDir, { recursive: true, force: true });
    const name = `v${LINK_VERSION}`;
    const target = path.join(loaderDir, name);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(distDir, 'remote.html'), path.join(target, 'index.html'));
    fs.copyFileSync(path.join(distDir, 'remote-bundle.js'), path.join(target, 'remote-bundle.js'));
    // The loader inside the same tree: the Android remote mode opens `/remote/index.html#k=<key>`
    // (the app's local server routes an extension-less path to the app's own document, so the
    // loader is always addressed by file name), and the pages it moves on to sit below it.
    fs.writeFileSync(path.join(loaderDir, 'index.html'), remoteLoaderHtml);
    fs.copyFileSync(path.join(distDir, 'remoteLoader-bundle.js'), path.join(loaderDir, 'remoteLoader-bundle.js'));
    for (const assetName of ['styles.css', NOTICES_ASSET_NAME]) {
        const source = path.join(distDir, assetName);
        if (fs.existsSync(source)) {
            fs.copyFileSync(source, path.join(target, assetName));
            // The loader is a published document too: its stylesheet and the notices sit beside it.
            fs.copyFileSync(source, path.join(loaderDir, assetName));
        } else
            console.log(
                `⏭️  remote/${name}: ${assetName} not built yet — run pnpm build:react to regenerate the remote page`,
            );
    }
    console.log(`✓ Staged the remote page under dist/remote/${name}/`);
};

async function buildRendererBundles() {
    console.log(`🔨 Building ${isLite ? 'lite ' : ''}React bundles...`);
    try {
        await buildEntries();
    } catch (error) {
        console.error('❌ Build failed:', error);
        process.exit(1);
    }
}

async function assembleRenderer(outputDir = DIST_DIR) {
    await prepareAssembly(outputDir, bundleDir);
    copyRemoteVersionDir(outputDir);
}

async function buildReact() {
    console.log(`🔨 Building ${isLite ? 'lite ' : ''}React bundles${isWatch ? ' (watch mode)' : ''}...`);

    try {
        if (isWatch) await watchEntries();
        else {
            await buildRendererBundles();
            await assembleRenderer();
        }
    } catch (error) {
        console.error('❌ Build failed:', error);
        process.exit(1);
    }
}

export {
    NOTICES_ASSET_NAME,
    assembleStylesheet,
    copyRemoteVersionDir,
    buildRendererBundles,
    assembleRenderer,
    buildReact,
};
