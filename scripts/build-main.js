/**
 * Bundles the Electron main process (src/js/index.js) into dist/main/index.js,
 * the file package.json `main` points at.
 *
 * Only the app's own modules are bundled. Every package import stays a
 * runtime require, resolved from the node_modules electron-builder ships with
 * the app, so electron, electron-updater and the native addons
 * (onnxruntime-node, sharp) load exactly as they would unbundled.
 *
 * The output sits at dist/main/index.js — the same depth below the app root
 * as src/js/ — because src/js/appPaths.js resolves the root as `__dirname/../..`
 * and inside a bundle `__dirname` is the bundle's own directory.
 *
 * Usage: node scripts/build-main.js [--watch]
 */

const path = require('node:path');
const { build, context } = require('esbuild');
const { runIfMain } = require('./lib/run-if-main');

const ROOT = path.join(__dirname, '..');

const OPTIONS = {
    entryPoints: [path.join(ROOT, 'src', 'js', 'index.js')],
    outfile: path.join(ROOT, 'dist', 'main', 'index.js'),
    bundle: true,
    platform: 'node',
    // Electron 44 embeds Node 24.
    target: 'node24',
    format: 'cjs',
    packages: 'external',
    logLevel: 'info',
};

/**
 * @param {string[]} [argv]
 * @returns {Promise<void>}
 */
async function main(argv = process.argv.slice(2)) {
    if (argv.includes('--watch')) {
        const ctx = await context(OPTIONS);
        await ctx.watch();
        return;
    }
    await build(OPTIONS);
}

runIfMain(require.main, module, main);

module.exports = { OPTIONS, main };
