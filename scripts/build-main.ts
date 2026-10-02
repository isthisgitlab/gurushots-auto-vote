/**
 * Bundles the Electron main process (src/ts/index.ts) into out/main/app.js,
 * behind the out/main/index.js loader that package.json `main` points at.
 *
 * Only the app's own modules are bundled. Every package import stays a
 * runtime require, resolved from the node_modules electron-builder ships with
 * the app, so electron, electron-updater and the native addons
 * (onnxruntime-node, sharp) load exactly as they would unbundled.
 *
 * The output sits in out/main/ — the same depth below the app root
 * as src/ts/ — because src/ts/appPaths.ts resolves the root as `__dirname/../..`
 * and inside a bundle `__dirname` is the bundle's own directory. It stays out
 * of dist/, which is Capacitor's webDir and ships inside the Android APK.
 *
 * A linked source map rides along, so a main-process stack trace (in the
 * terminal or in a user's log file) points at src/ts rather than at the
 * bundle. Node maps only files it compiles after source maps are switched on,
 * so the loader switches them on and then requires the bundle.
 *
 * Usage: node --import tsx scripts/build-main.ts [--watch]
 */

import fs from 'node:fs';
import path from 'node:path';
import { build, context } from 'esbuild';
import type { BuildOptions } from 'esbuild';
import { runIfMain } from './lib/run-if-main';

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out', 'main');
const LOADER = path.join(OUT_DIR, 'index.js');
const LOADER_SOURCE = "process.setSourceMapsEnabled(true);\nrequire('./app.js');\n";

const OPTIONS: BuildOptions = {
    entryPoints: [path.join(ROOT, 'src', 'ts', 'index.ts')],
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

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
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

export { OPTIONS, LOADER, LOADER_SOURCE, main };
