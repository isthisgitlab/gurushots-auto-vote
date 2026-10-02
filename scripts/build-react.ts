#!/usr/bin/env node

import { build, context } from 'esbuild';
import type { BuildContext, BuildOptions } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { removeVisionWebAssets, stageVisionWebAssets } from './fetch-vision-model';

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
};

type EntryName = keyof typeof entryPoints;

// Capacitor entry point. Capacitor copies dist/ wholesale into the
// Android WebView's web assets and loads index.html at app start.
// Electron loads its own src/html/*.html directly via loadFile() and
// ignores this index.html, so emitting it does not affect desktop.
// The bundle loaded here is capacitor-bundle.js, NOT app-bundle.js,
// so the bridge can install before React mounts.
const capacitorIndexHtml = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no" />
        <meta name="theme-color" content="#960018" />
        <title>GuruShots Auto Vote</title>
        <link href="styles.css" rel="stylesheet" />
        <script defer src="capacitor-bundle.js"></script>
    </head>
    <body class="min-h-screen bg-base-200">
        <div id="root"></div>
    </body>
</html>
`;

// Web shell document, served at / by src/ts/web/server.ts. Same CSP as the
// Electron pages: script-src 'self' keeps injected inline script from running
// against the window.api surface.
const webHtml = `<!doctype html>
<html data-theme="light" lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'"
        />
        <title>GuruShots Auto Vote</title>
        <link href="styles.css" rel="stylesheet" />
        <script defer src="web-bundle.js"></script>
    </head>
    <body class="min-h-screen bg-base-200">
        <div id="root"></div>
    </body>
</html>
`;

// Headless background document. Loaded by AutoVoteService in a bare
// WebView (no Capacitor). It sets the headless flag before the bundle
// executes so runtime.isHeadlessService() is true at module load, then
// the bundle installs window.GS.runOneCycle() for the service to call.
const headlessHtml = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <title>GuruShots Auto Vote — background</title>
        <script>window.__GS_HEADLESS__ = true;</script>
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

// All renderer bundles run in a browser-context (Electron WebView
// or Capacitor WebView). They reach shared modules (runtime.ts,
// settings.ts, ForegroundServiceController, etc.) that lazy-require
// Node built-ins and electron — code paths the renderer never
// reaches at runtime (it goes through window.api / Capacitor.Plugins),
// but esbuild still tries to resolve at bundle time. Marking them
// external + emitting an inert require shim keeps every bundle
// green; the unreachable lazy requires become benign no-ops.
const NODE_BUILTINS_BARE = [
    'fs',
    'path',
    'os',
    'crypto',
    'stream',
    'events',
    'child_process',
    'http',
    'https',
    'url',
    'zlib',
    'util',
    'buffer',
    'assert',
    'net',
    'tls',
    'dns',
    'querystring',
    'string_decoder',
    'tty',
    'readline',
    'sea',
    'module',
];
// Externalize both bare and node:-prefixed forms — shared modules use the
// node: prefix (preferred since Node 22) but esbuild matches externals on
// exact specifier, so both spellings must be enumerated.
const NODE_BUILTINS = [...NODE_BUILTINS_BARE, ...NODE_BUILTINS_BARE.map((m) => `node:${m}`)];
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
// Two browser-shim banners. require() is faked because external
// imports leave runtime require() calls that the WebView cannot
// resolve. process is faked because logger.ts / runtime.ts read
// process.type / process.versions / process.platform at module
// load (before any isCapacitor() guard runs); without a stub the
// bundle ReferenceErrors before React mounts.
// Browser shims for Node globals that the bundled code touches at
// module load before any isCapacitor() guard can run. The require
// shim returns module-aware stubs (fs/path/os) with the small
// surface area logger.ts / runtime.ts / settings.ts actually call —
// each method either no-ops or returns a sensible neutral value
// (false for existsSync, joined string for path.join, etc.) so
// module init does not throw. All real fs work lives behind
// runtime.isCapacitor() guards or try/catch wrappers, so these
// stub methods are never reached by the actual app code on
// Capacitor — they just keep module init green.
const SHIM_BANNER = [
    'var __nodeModuleShims = {',
    '  fs: {',
    '    existsSync: function(){ return false; },',
    '    readFileSync: function(){ return ""; },',
    '    writeFileSync: function(){},',
    '    appendFileSync: function(){},',
    '    mkdirSync: function(){},',
    '    readdirSync: function(){ return []; },',
    '    statSync: function(){ return { size: 0, mtime: new Date() }; },',
    '    unlinkSync: function(){},',
    '    watch: function(){ return { close: function(){} }; }',
    '  },',
    '  path: {',
    '    join: function(){ return Array.prototype.join.call(arguments, "/"); },',
    '    resolve: function(){ return Array.prototype.join.call(arguments, "/"); },',
    '    dirname: function(p){ return String(p).split("/").slice(0,-1).join("/") || "/"; },',
    '    basename: function(p){ return String(p).split("/").pop(); },',
    '    extname: function(p){ var b = String(p).split("/").pop(); var i = b.lastIndexOf("."); return i < 0 ? "" : b.slice(i); },',
    '    sep: "/"',
    '  },',
    '  os: {',
    '    homedir: function(){ return "/"; },',
    '    platform: function(){ return "android"; },',
    '    tmpdir: function(){ return "/tmp"; }',
    '  }',
    '};',
    'var require = (typeof require !== "undefined") ? require : function(name){ return __nodeModuleShims[name.replace(/^node:/, "")] || {}; };',
    'var process = (typeof process !== "undefined") ? process : { env: {}, versions: {}, platform: "browser", type: "browser", pkg: undefined, argv: [], cwd: function(){ return "/"; }, on: function(){}, stdout: { isTTY: false, write: function(){} }, stderr: { isTTY: false, write: function(){} } };',
    'var __dirname = (typeof __dirname !== "undefined") ? __dirname : "/";',
    'var __filename = (typeof __filename !== "undefined") ? __filename : "/index.html";',
].join('');
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

buildReact();
