/**
 * Bundles the Electron main process (src/js/index.js) into out/main/app.js,
 * behind the out/main/index.js loader that package.json `main` points at.
 *
 * Only the app's own modules are bundled. Every package import stays a
 * runtime require, resolved from the node_modules electron-builder ships with
 * the app, so electron, electron-updater and the native addons
 * (onnxruntime-node, sharp) load exactly as they would unbundled.
 *
 * The output sits in out/main/ — the same depth below the app root
 * as src/js/ — because src/js/appPaths.ts resolves the root as `__dirname/../..`
 * and inside a bundle `__dirname` is the bundle's own directory. It stays out
 * of dist/, which is Capacitor's webDir and ships inside the Android APK.
 *
 * A linked source map rides along, so a main-process stack trace (in the
 * terminal or in a user's log file) points at src/js rather than at the
 * bundle. Node maps only files it compiles after source maps are switched on,
 * so the loader switches them on and then requires the bundle.
 *
 * Usage: node scripts/build-main.js [--watch]
 */

const fs = require('node:fs');
const path = require('node:path');
const { build, context } = require('esbuild');
const { runIfMain } = require('./lib/run-if-main');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out', 'main');
const LOADER = path.join(OUT_DIR, 'index.js');
const LOADER_SOURCE = "process.setSourceMapsEnabled(true);\nrequire('./app.js');\n";

const OPTIONS = {
    entryPoints: [path.join(ROOT, 'src', 'js', 'index.js')],
    outfile: path.join(OUT_DIR, 'app.js'),
    bundle: true,
    platform: 'node',
    // Electron 44 embeds Node 24.
    target: 'node24',
    format: 'cjs',
    packages: 'external',
    sourcemap: 'linked',
    logLevel: 'info',
};

/**
 * @param {string[]} [argv]
 * @returns {Promise<void>}
 */
async function main(argv = process.argv.slice(2)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(LOADER, LOADER_SOURCE);
    if (argv.includes('--watch')) {
        const ctx = await context(OPTIONS);
        await ctx.watch();
        return;
    }
    await build(OPTIONS);
}

runIfMain(require.main, module, main);

module.exports = { OPTIONS, LOADER, LOADER_SOURCE, main };
