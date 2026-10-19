#!/usr/bin/env node

import { build, context } from 'esbuild';
import type { BuildContext, BuildOptions } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { removeVisionWebAssets, stageVisionWebAssets } from './fetch-vision-model';
import { NODE_BUILTINS, SHIM_BANNER } from './lib/browser-shims';
import { runIfMain } from './lib/run-if-main';

// Every remote image the renderer draws comes from the photo CDN (format/photoUrl.ts);
// no API-supplied avatar or cover URL is ever put in an <img>.
const PHOTO_HOST = 'https://photos.gurushots.com';
const GITHUB_API_HOST = 'https://api.github.com';
const NOTICES_ASSET_NAME = 'THIRD_PARTY_NOTICES.txt';

type CspDirectives = Record<string, string[]>;

const serializeCsp = (directives: CspDirectives) =>
    Object.entries(directives)
        .map(([name, sources]) => [name, ...sources].join(' '))
        .join('; ');

// The policy every document starts from. script-src 'self' (no 'unsafe-inline', no
// 'unsafe-eval') is the load-bearing line; style-src keeps 'unsafe-inline' for DaisyUI and
// inline element styles.
const baseCsp = (overrides: CspDirectives = {}): string =>
    serializeCsp({
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', PHOTO_HOST],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'none'"],
        ...overrides,
    });

// The two Android documents run the local vision model: onnxruntime-web compiles WebAssembly
// ('wasm-unsafe-eval' allows that without 'unsafe-eval'), the classifier fetches candidate
// photos from the photo CDN, and the update check reads the GitHub releases API.
const androidCsp = baseCsp({
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'connect-src': ["'self'", GITHUB_API_HOST, PHOTO_HOST],
});

const reactDir = path.join(__dirname, '..', 'src', 'ts', 'react');
const tsDir = path.join(__dirname, '..', 'src', 'ts');
const distDir = path.join(__dirname, '..', 'dist');

// Entry points for each page
const entryPoints = {
    login: path.join(reactDir, 'pages', 'Login.tsx'),
    app: path.join(reactDir, 'pages', 'App.tsx'),
    logs: path.join(reactDir, 'pages', 'Logs.tsx'),
    capacitor: path.join(reactDir, 'pages', 'Capacitor.tsx'),
    // Browser entry served by the web shell (`pnpm web`, src/ts/web/server.ts).
    web: path.join(reactDir, 'pages', 'Web.tsx'),
    // Android background service entry — runs in a bare WebView (no
    // Capacitor runtime) owned by AutoVoteService. Not a React page.
    headless: path.join(tsDir, 'headless', 'index.ts'),
    // Electron preload. Electron sandboxes preloads by default, and a
    // sandboxed preload's require() shim only resolves 'electron' + a few
    // builtins — NOT relative modules — so the shared channel manifest
    // (src/ts/ipc/manifest.ts) must be BUNDLED into the preload file the
    // BrowserWindows load (dist/preload.js).
    preload: path.join(tsDir, 'preload.ts'),
    // The Logs window's reduced preload (only the log-feed subset of the manifest).
    preloadLogs: path.join(tsDir, 'preloadLogs.ts'),
};

type EntryName = keyof typeof entryPoints;

type RendererDocument = {
    htmlAttrs: string;
    viewport: string;
    csp: string;
    bundle: string;
    themeColor?: string;
};

// A renderer page: the document head (viewport, CSP, styles, deferred bundle) and the safe-area-padded #root body.
const rendererHtml = ({ htmlAttrs, viewport, csp, bundle, themeColor }: RendererDocument): string =>
    `<!doctype html>
<html ${htmlAttrs}>
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="${viewport}" />${themeColor ? `\n        <meta name="theme-color" content="${themeColor}" />` : ''}
        <meta http-equiv="Content-Security-Policy" content="${csp}" />
        <title>GuruShots Auto Vote</title>
        <link href="styles.css" rel="stylesheet" />
        <script defer src="${bundle}"></script>
    </head>
    <body class="min-h-screen bg-base-200 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
        <div id="root"></div>
    </body>
</html>
`;

// Capacitor entry point. Capacitor copies dist/ wholesale into the
// Android WebView's web assets and loads index.html at app start.
// Electron loads its own src/html/*.html directly via loadFile() and
// ignores this index.html, so emitting it does not affect desktop.
// The bundle loaded here is capacitor-bundle.js, NOT app-bundle.js,
// so the bridge can install before React mounts.
const capacitorIndexHtml = rendererHtml({
    htmlAttrs: 'lang="en"',
    viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
    themeColor: '#960018',
    csp: androidCsp,
    bundle: 'capacitor-bundle.js',
});

// Web shell document, served at / by src/ts/web/server.ts. Same CSP as the
// Electron pages: script-src 'self' keeps injected inline script from running
// against the window.api surface.
const webHtml = rendererHtml({
    htmlAttrs: 'data-theme="light" lang="en"',
    viewport: 'width=device-width, initial-scale=1.0',
    csp: baseCsp(),
    bundle: 'web-bundle.js',
});

// Headless background document. Loaded by AutoVoteService in a bare
// WebView (no Capacitor). headless-flag.js sets the headless flag before the
// bundle executes so runtime.isHeadlessService() is true at module load, then
// the bundle installs window.GS.runOneCycle() for the service to call.
const HEADLESS_FLAG_FILE = 'headless-flag.js';
const HEADLESS_FLAG_SOURCE = 'window.__GS_HEADLESS__ = true;\n';
const headlessHtml = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="${androidCsp}" />
        <title>GuruShots Auto Vote — background</title>
        <script src="${HEADLESS_FLAG_FILE}"></script>
        <script defer src="headless-bundle.js"></script>
    </head>
    <body></body>
</html>
`;

// Check if watch mode is enabled
const isWatch = process.argv.includes('--watch');
// --lite: the Android webDir without the local vision model, its WASM runtime
// or the transformers code (services/visionVerifier.ts skips the check).
const isLite = process.argv.includes('--lite');

const commonOptions: BuildOptions = {
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    minify: process.env.NODE_ENV === 'production',
    sourcemap: process.env.NODE_ENV !== 'production',
    loader: {
        '.jsx': 'jsx',
        '.js': 'js',
    },
    alias: {
        '@': reactDir,
        react: 'preact/compat',
        'react-dom': 'preact/compat',
        'react-dom/client': 'preact/compat/client',
        'react/jsx-runtime': 'preact/jsx-runtime',
        'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
    },
    define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    },
};

// The CLI-only archive extractor is unreachable in renderer and WebView
// runtimes; leave its Node package out of their bundles.
const RENDERER_EXTERNALS = [
    ...NODE_BUILTINS,
    'electron',
    'electron-updater',
    'tar',
    ...(isLite ? ['@huggingface/transformers'] : []),
];
// Capacitor plugin packages must be BUNDLED (not externalized) on
// the Capacitor entry: they are pure browser code that registers
// proxies onto the native bridge. Externalizing them returns the
// require shim's empty object, so .Preferences.set(...) etc.
// throws "X is not a function" at runtime, surfacing as silent
// "Error saving settings" failures on Android.
// Electron entries can keep them externalized since Electron's
// isCapacitor() returns false and the require shim is never
// exercised in practice.
const CAPACITOR_EXTERNALS = [
    '@capacitor/core',
    '@capacitor/preferences',
    '@capawesome-team/capacitor-android-foreground-service',
];
const REQUIRE_SHIM = { js: SHIM_BANNER };
const perEntryOptions: Record<EntryName, BuildOptions> = {
    // Electron entries: externalize Capacitor packages too. Their
    // require shim returns an empty object that is never accessed
    // because runtime.isCapacitor() returns false on Electron.
    login: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
    app: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
    logs: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
    // Capacitor entry: bundle the Capacitor plugin packages so the
    // native bridge proxies (Preferences.set,
    // ForegroundService.startForegroundService, ...) actually work.
    capacitor: { external: RENDERER_EXTERNALS, banner: REQUIRE_SHIM },
    // Web entry: a browser tab behind the web shell, never Capacitor.
    web: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
    // Headless background entry: like the Electron entries, externalize
    // Capacitor packages — the headless cycle never touches them (it
    // uses the native AndroidHeadless* @JavascriptInterfaces), so the
    // require shim's empty object is never accessed.
    headless: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
    // Electron preload: CJS with only 'electron' external — exactly what
    // the sandboxed preload require shim can resolve. No banner shim and
    // no browser aliasing needed; the manifest it pulls in is pure data.
    preload: { platform: 'node', format: 'cjs', external: ['electron'], banner: {} },
    preloadLogs: { platform: 'node', format: 'cjs', external: ['electron'], banner: {} },
};

const prepareDist = async () => {
    // Create dist directory if it doesn't exist
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }
    if (isLite) removeVisionWebAssets(distDir);
    else await stageVisionWebAssets(distDir);

    // Emit the Capacitor entry point. Electron ignores it; the Android
    // WebView treats it as the app's root document.
    fs.writeFileSync(path.join(distDir, 'index.html'), capacitorIndexHtml);
    // Background service document (loaded by AutoVoteService's WebView).
    fs.writeFileSync(path.join(distDir, 'headless.html'), headlessHtml);
    fs.writeFileSync(path.join(distDir, HEADLESS_FLAG_FILE), HEADLESS_FLAG_SOURCE);
    // Web shell document (served by src/ts/web/server.ts).
    fs.writeFileSync(path.join(distDir, 'web.html'), webHtml);

    // Ship the semantic-matching word-vector lexicon into the webDir so the
    // Android WebView (Capacitor page + headless service) can fetch() it at
    // runtime. It is a runtime asset — never imported into a bundle — so the
    // renderer/headless/capacitor size budgets stay untouched. Regenerate it
    // with `pnpm build:lexicon`; the committed src/assets copy ships in the
    // Electron asar and is embedded as a SEA asset for the CLI binary.
    const lexiconSrc = path.join(__dirname, '..', 'src', 'assets', 'semantic-vectors.json');
    if (fs.existsSync(lexiconSrc)) {
        fs.copyFileSync(lexiconSrc, path.join(distDir, 'semantic-vectors.json'));
    }

    // The same for the third-party notices the licenses dialog fetch()es next to the document
    // (thirdPartyNotices.ts).
    const noticesSrc = path.join(__dirname, '..', 'src', 'assets', NOTICES_ASSET_NAME);
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
            outfile: path.join(distDir, `${name}-bundle.js`),
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

const buildEntries = async () => {
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
            outfile: path.join(distDir, `${name}-bundle.js`),
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

async function buildReact() {
    console.log(`🔨 Building ${isLite ? 'lite ' : ''}React bundles${isWatch ? ' (watch mode)' : ''}...`);

    await prepareDist();

    try {
        if (isWatch) await watchEntries();
        else await buildEntries();
    } catch (error) {
        console.error('❌ Build failed:', error);
        process.exit(1);
    }
}

runIfMain(require.main, module, buildReact);

export {
    PHOTO_HOST,
    NOTICES_ASSET_NAME,
    HEADLESS_FLAG_FILE,
    HEADLESS_FLAG_SOURCE,
    baseCsp,
    androidCsp,
    capacitorIndexHtml,
    headlessHtml,
    webHtml,
    buildReact,
};
