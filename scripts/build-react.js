#!/usr/bin/env node

const { build, context } = require('esbuild');
const path = require('path');
const fs = require('fs');

const reactDir = path.join(__dirname, '..', 'src', 'js', 'react');
const distDir = path.join(__dirname, '..', 'dist');

// Entry points for each page
const entryPoints = {
    login: path.join(reactDir, 'pages', 'Login.jsx'),
    app: path.join(reactDir, 'pages', 'App.jsx'),
    logs: path.join(reactDir, 'pages', 'Logs.jsx'),
    capacitor: path.join(reactDir, 'pages', 'Capacitor.jsx'),
};

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
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <title>GuruShots Auto Vote</title>
        <link href="styles.css" rel="stylesheet" />
        <script defer src="capacitor-bundle.js"></script>
    </head>
    <body class="min-h-screen bg-base-200">
        <div id="root"></div>
    </body>
</html>
`;

// Check if watch mode is enabled
const isWatch = process.argv.includes('--watch');

async function buildReact() {
    console.log(`🔨 Building React bundles${isWatch ? ' (watch mode)' : ''}...`);

    // Create dist directory if it doesn't exist
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    // Emit the Capacitor entry point. Electron ignores it; the Android
    // WebView treats it as the app's root document.
    fs.writeFileSync(path.join(distDir, 'index.html'), capacitorIndexHtml);

    const commonOptions = {
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        jsx: 'automatic',
        minify: process.env.NODE_ENV === 'production',
        sourcemap: process.env.NODE_ENV !== 'production',
        loader: {
            '.jsx': 'jsx',
            '.js': 'js',
        },
        alias: {
            '@': reactDir,
        },
        define: {
            'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
        },
    };

    // All renderer bundles run in a browser-context (Electron WebView
    // or Capacitor WebView). They reach shared modules (runtime.js,
    // settings.js, ForegroundServiceController, etc.) that lazy-require
    // Node built-ins and electron — code paths the renderer never
    // reaches at runtime (it goes through window.api / Capacitor.Plugins),
    // but esbuild still tries to resolve at bundle time. Marking them
    // external + emitting an inert require shim keeps every bundle
    // green; the unreachable lazy requires become benign no-ops.
    const NODE_BUILTINS = [
        'fs', 'path', 'os', 'crypto', 'stream', 'events', 'child_process',
        'http', 'https', 'url', 'zlib', 'util', 'buffer', 'assert', 'net',
        'tls', 'dns', 'querystring', 'string_decoder', 'tty', 'readline',
    ];
    const RENDERER_EXTERNALS = [
        ...NODE_BUILTINS,
        'electron',
        'electron-updater',
        'node-cron',
    ];
    // Capacitor plugin packages must be BUNDLED (not externalized) on
    // the Capacitor entry: they are pure browser code that registers
    // proxies onto the native bridge. Externalizing them returns the
    // require shim's empty object, so .Preferences.set(...) etc.
    // throws "X is not a function" at runtime — which is what was
    // causing "Error saving settings" silent failures on Android.
    // Electron entries can keep them externalized since Electron's
    // isCapacitor() returns false and the require shim is never
    // exercised in practice.
    const CAPACITOR_EXTERNALS = [
        '@capacitor/core',
        '@capacitor/preferences',
        '@capacitor/filesystem',
        '@capacitor/local-notifications',
        '@capawesome-team/capacitor-android-foreground-service',
    ];
    // Two browser-shim banners. require() is faked because external
    // imports leave runtime require() calls that the WebView cannot
    // resolve. process is faked because logger.js / runtime.js read
    // process.type / process.versions / process.platform at module
    // load (before any isCapacitor() guard runs); without a stub the
    // bundle ReferenceErrors before React mounts.
    // Browser shims for Node globals that the bundled code touches at
    // module load before any isCapacitor() guard can run. The require
    // shim returns module-aware stubs (fs/path/os) with the small
    // surface area logger.js / runtime.js / settings.js actually call —
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
        'var require = (typeof require !== "undefined") ? require : function(name){ return __nodeModuleShims[name] || {}; };',
        'var process = (typeof process !== "undefined") ? process : { env: {}, versions: {}, platform: "browser", type: "browser", pkg: undefined, argv: [], cwd: function(){ return "/"; }, on: function(){}, stdout: { isTTY: false, write: function(){} }, stderr: { isTTY: false, write: function(){} } };',
        'var __dirname = (typeof __dirname !== "undefined") ? __dirname : "/";',
        'var __filename = (typeof __filename !== "undefined") ? __filename : "/index.html";',
    ].join('');
    const REQUIRE_SHIM = { js: SHIM_BANNER };
    const perEntryOptions = {
        // Electron entries: externalize Capacitor packages too. Their
        // require shim returns an empty object that is never accessed
        // because runtime.isCapacitor() returns false on Electron.
        login: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
        app: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
        logs: { external: [...RENDERER_EXTERNALS, ...CAPACITOR_EXTERNALS], banner: REQUIRE_SHIM },
        // Capacitor entry: bundle the Capacitor plugin packages so the
        // native bridge proxies (Preferences.set, Filesystem.writeFile,
        // ForegroundService.startForegroundService, ...) actually work.
        capacitor: { external: RENDERER_EXTERNALS, banner: REQUIRE_SHIM },
    };

    try {
        if (isWatch) {
            // Watch mode - create contexts for each entry point
            const contexts = [];

            for (const [name, entry] of Object.entries(entryPoints)) {
                // Only build if entry file exists
                if (!fs.existsSync(entry)) {
                    console.log(`⏭️  Skipping ${name} (file not found: ${entry})`);
                    continue;
                }

                const ctx = await context({
                    ...commonOptions,
                    ...(perEntryOptions[name] || {}),
                    entryPoints: [entry],
                    outfile: path.join(distDir, `${name}-bundle.js`),
                });

                contexts.push({ name, ctx });
            }

            if (contexts.length === 0) {
                console.log('⚠️  No React entry points found. Create pages in src/js/react/pages/');
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
        } else {
            // Build mode - build each entry point
            let builtCount = 0;

            for (const [name, entry] of Object.entries(entryPoints)) {
                // Only build if entry file exists
                if (!fs.existsSync(entry)) {
                    console.log(`⏭️  Skipping ${name} (file not found: ${entry})`);
                    continue;
                }

                await build({
                    ...commonOptions,
                    ...(perEntryOptions[name] || {}),
                    entryPoints: [entry],
                    outfile: path.join(distDir, `${name}-bundle.js`),
                });

                console.log(`✅ Built ${name}-bundle.js`);
                builtCount++;
            }

            if (builtCount === 0) {
                console.log('⚠️  No React entry points found. Create pages in src/js/react/pages/');
            } else {
                console.log(`\n🎉 React build completed! (${builtCount} bundles)`);
            }
        }
    } catch (error) {
        console.error('❌ Build failed:', error);
        process.exit(1);
    }
}

buildReact();
