// The esbuild inputs: the bundle entry points, the options every bundle shares,
// and the per-entry externals — which packages each runtime keeps out of its bundle.

import type { BuildOptions } from 'esbuild';
import path from 'node:path';
import { NODE_BUILTINS, SHIM_BANNER } from '../lib/browser-shims';

const reactDir = path.join(__dirname, '..', '..', 'src', 'ts', 'react');
const shellsDir = path.join(__dirname, '..', '..', 'src', 'ts', 'shells');

// Entry points for each page
const entryPoints = {
    login: path.join(reactDir, 'pages', 'Login.tsx'),
    app: path.join(reactDir, 'pages', 'App.tsx'),
    logs: path.join(reactDir, 'pages', 'Logs.tsx'),
    capacitor: path.join(shellsDir, 'capacitor', 'page.tsx'),
    // Browser entry served by the web shell (`pnpm web`, src/ts/shells/web/server.ts).
    web: path.join(shellsDir, 'web', 'page.tsx'),
    // Remote phone page (the Pages site's /remote/<version>/ and the Android remote mode).
    remote: path.join(shellsDir, 'remote', 'page.tsx'),
    // The thin /remote/ loader: reads the desktop's version from hello, then moves on.
    remoteLoader: path.join(shellsDir, 'remote', 'loader.tsx'),
    // Android background service entry — runs in a bare WebView (no
    // Capacitor runtime) owned by AutoVoteService. Not a React page.
    headless: path.join(shellsDir, 'headless', 'index.ts'),
    // Electron preload. Electron sandboxes preloads by default, and a
    // sandboxed preload's require() shim only resolves 'electron' + a few
    // builtins — NOT relative modules — so the shared channel manifest
    // (src/ts/core/ipc/manifest.ts) must be BUNDLED into the preload file the
    // BrowserWindows load (dist/preload.js).
    preload: path.join(shellsDir, 'electron', 'preload.ts'),
    // The Logs window's reduced preload (only the log-feed subset of the manifest).
    preloadLogs: path.join(shellsDir, 'electron', 'preloadLogs.ts'),
};

type EntryName = keyof typeof entryPoints;

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
// Electron entries can keep them externalized since the Capacitor
// global is absent on Electron, so the Capacitor-only modules'
// guards refuse them and the require shim is never exercised.
const CAPACITOR_EXTERNALS = [
    '@capacitor/core',
    '@capacitor/preferences',
    '@capawesome-team/capacitor-android-foreground-service',
];
// The remote host is reachable from AutovoteContext, which the web and capacitor bundles
// both include, so esbuild would inline the trystero chain into them. On those kinds the
// host never runs, so the external is never awaited: externalize the whole trystero package
// chain and the two bundles stay their current size. The electron and remote entries bundle
// it — they are the two kinds that actually join the pairing room.
// The relay modules trystero.ts loads at call time go the same way (esbuild matches the wildcard
// against the import specifier, `./relayCodec` and so on).
const TRYSTERO_EXTERNALS = [
    'trystero',
    '@trystero-p2p/nostr',
    '@trystero-p2p/core',
    '*/relayCodec',
    '*/relayLink',
    '*/relaySockets',
    '*/hybridTransport',
];
const REQUIRE_SHIM = { js: SHIM_BANNER };
const perEntryOptions: Record<EntryName, BuildOptions> = {
    // Electron entries: externalize Capacitor packages too. Their
    // require shim returns an empty object that is never accessed
    // because the Capacitor global is absent on Electron.
    login: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
    app: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
    logs: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
    // Capacitor entry: bundle the Capacitor plugin packages so the
    // native bridge proxies (Preferences.set,
    // ForegroundService.startForegroundService, ...) actually work.
    capacitor: { external: [...RENDERER_EXTERNALS, ...TRYSTERO_EXTERNALS], banner: REQUIRE_SHIM },
    // Web entry: a browser tab behind the web shell, never Capacitor.
    web: {
        external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS, ...TRYSTERO_EXTERNALS],
        banner: REQUIRE_SHIM,
    },
    // Remote phone page and loader: they join the pairing room, so trystero is bundled.
    remote: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
    remoteLoader: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
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

export { entryPoints, isWatch, isLite, commonOptions, perEntryOptions };
export type { EntryName };
