#!/usr/bin/env node

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import packageJson from '../package.json';
import { runIfMain } from './lib/run-if-main';
import { ensureVisionModel } from './fetch-vision-model';

const { version } = packageJson;

// Node SEA fuse sentinel — required by postject so Node knows where to find the embedded blob.
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// Pin to a specific Node version for reproducible bundle output. Bump when bumping engines.
const TARGET_NODE_VERSION = process.versions.node;

interface CliPlatform {
    input: string;
    output: string;
    plat: NodeJS.Platform;
    arch: NodeJS.Architecture;
}

// Node single-executable-application config (`node --experimental-sea-config`).
export interface SeaConfig {
    main: string;
    output: string;
    disableExperimentalSEAWarning: boolean;
    assets?: Record<string, string>;
}

const platforms: CliPlatform[] = [
    { input: 'gurucli-mac', output: `gurucli-v${version}-mac`, plat: 'darwin', arch: 'arm64' },
    { input: 'gurucli-linux', output: `gurucli-v${version}-linux`, plat: 'linux', arch: 'x64' },
    { input: 'gurucli-linux-arm', output: `gurucli-v${version}-linux-arm`, plat: 'linux', arch: 'arm64' },
];

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const BUILD_DIR = path.join(ROOT, 'build', 'cli');
const NODE_CACHE_DIR = path.join(ROOT, '.cache', 'node-binaries');
const NODE_EXTRACT_DIR = path.join(ROOT, '.cache', 'node-extract');

function ensureDir(p: string) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function bundleCli() {
    console.log('🔨 Bundling CLI with esbuild...');
    await build({
        entryPoints: [path.join(ROOT, 'src', 'ts', 'cli', 'cli.ts')],
        bundle: true,
        platform: 'node',
        target: 'node26',
        format: 'cjs',
        outfile: path.join(DIST_DIR, 'cli-bundled.js'),
        external: ['electron', '@huggingface/transformers'],
        minify: false,
        sourcemap: false,
        define: {
            'process.env.NODE_ENV': '"production"',
        },
    });
    console.log('✅ CLI bundled');
}

// Each CLI target is built on its native runner, so the embedded runtime only
// ever loads this host's onnxruntime-node binary; the package ships every
// OS/arch. transformers' Node build also inlines the web runtime it uses, so
// the standalone onnxruntime-web package is never loaded. Both are dropped
// from the archive that the SEA binary embeds.
function pruneVisionRuntime(
    pnpmDir: string,
    platform: NodeJS.Platform = process.platform,
    arch: NodeJS.Architecture = process.arch,
) {
    if (!fs.existsSync(pnpmDir)) return;
    const remove = (target: string) => fs.rmSync(target, { recursive: true, force: true });
    for (const entry of fs.readdirSync(pnpmDir)) {
        if (entry.startsWith('onnxruntime-web@')) {
            remove(path.join(pnpmDir, entry));
            continue;
        }
        const binRoot = path.join(pnpmDir, entry, 'node_modules', 'onnxruntime-node', 'bin');
        if (!entry.startsWith('onnxruntime-node@') || !fs.existsSync(binRoot)) continue;
        for (const napi of fs.readdirSync(binRoot)) {
            for (const os of fs.readdirSync(path.join(binRoot, napi))) {
                const osDir = path.join(binRoot, napi, os);
                if (os !== platform) {
                    remove(osDir);
                    continue;
                }
                for (const cpu of fs.readdirSync(osDir)) if (cpu !== arch) remove(path.join(osDir, cpu));
            }
        }
    }
}

async function prepareVisionRuntime() {
    const modelDir = await ensureVisionModel();
    const deployDir = path.join(ROOT, '.cache', 'vision-cli-deploy');
    fs.rmSync(deployDir, { recursive: true, force: true });
    execFileSync('pnpm', ['deploy', '--prod', '--ignore-scripts', deployDir], { cwd: ROOT, stdio: 'inherit' });
    pruneVisionRuntime(path.join(deployDir, 'node_modules', '.pnpm'));
    fs.cpSync(modelDir, path.join(deployDir, 'vision-model'), { recursive: true });
    const archive = path.join(BUILD_DIR, 'vision-runtime.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', deployDir, 'node_modules', 'vision-model'], { stdio: 'inherit' });
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(path.join(BUILD_DIR, 'vision-runtime.sha256'), digest);
    fs.rmSync(deployDir, { recursive: true, force: true });
}

function generateSeaBlob(nodeBinary = process.execPath, { lite = false } = {}) {
    console.log('📦 Generating SEA blob...');
    const seaConfigPath = path.join(BUILD_DIR, 'sea-config.json');
    const seaBlobPath = path.join(BUILD_DIR, 'sea-prep.blob');
    const seaConfig: SeaConfig = {
        main: path.join(DIST_DIR, 'cli-bundled.js'),
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
    };
    // Embed the semantic-matching word-vector lexicon as a SEA asset so the
    // single binary can resolve it via node:sea.getAsset() — it is a runtime
    // asset (loaded by src/ts/services/semantic/assets.ts), never bundled into
    // cli-bundled.js, so the JS-bundle budget is unaffected.
    const lexiconAsset = path.join(ROOT, 'src', 'assets', 'semantic-vectors.json');
    if (fs.existsSync(lexiconAsset)) {
        seaConfig.assets = { 'semantic-vectors.json': lexiconAsset };
    }
    if (!lite) {
        seaConfig.assets = {
            ...seaConfig.assets,
            'vision-runtime.tar.gz': path.join(BUILD_DIR, 'vision-runtime.tar.gz'),
            'vision-runtime.sha256': path.join(BUILD_DIR, 'vision-runtime.sha256'),
        };
    }
    fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
    execFileSync(nodeBinary, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });
    console.log('✅ SEA blob generated');
    return seaBlobPath;
}

const NODE_DIST_URL = `https://nodejs.org/dist/v${TARGET_NODE_VERSION}`;
const NODE_DOWNLOAD_ATTEMPTS = 2;

const sha256Hex = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

// Read the cached tarball in one step. A missing file is the normal "not cached
// yet" answer; any other errno (a permission problem, say) is a real failure and
// must not be mistaken for a cold cache.
function readCachedTarball(tarPath: string): Buffer | null {
    try {
        return fs.readFileSync(tarPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
    }
}

// Publish a download by renaming a per-process temp file from the same directory, so
// the published name only ever appears with a complete tarball behind it: no
// half-written cache file for a peer build to extract, and no existsSync/writeFileSync
// pair on the shared path to race on (CWE-367). The temp name is dot-prefixed so the
// CLI workflow's `node-v*.tar.*` cache glob cannot capture an orphan left behind by a
// killed build. This closes the partial-write window, not every race: a peer build
// whose own hash check fails still removes the published path, and extraction reads
// it by name.
function cacheTarball(tarPath: string, data: Buffer) {
    const tempPath = path.join(path.dirname(tarPath), `.${path.basename(tarPath)}.${process.pid}.tmp`);
    try {
        fs.writeFileSync(tempPath, data);
        fs.renameSync(tempPath, tarPath);
    } finally {
        fs.rmSync(tempPath, { force: true });
    }
}

async function fetchOk(url: string) {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    }
    return res;
}

// Always use the official nodejs.org Node binary rather than process.execPath.
// Local Homebrew (and some package-manager Node installs) are dynamically linked to host
// dylibs and produce non-portable binaries when used as the SEA injection target.
// Only the tarball is cached; it is checked against nodejs.org's SHASUMS256.txt on every
// build and extracted fresh, so a stale or tampered extracted directory is never trusted.
// This verifies integrity against nodejs.org's published sums (catches a corrupted/poisoned
// cache or download), not authenticity (no GPG).
async function getOfficialNodeBinary(plat: NodeJS.Platform, arch: NodeJS.Architecture) {
    const ver = TARGET_NODE_VERSION;
    const ext = plat === 'darwin' ? 'tar.gz' : 'tar.xz';
    const baseName = `node-v${ver}-${plat}-${arch}`;
    const tarName = `${baseName}.${ext}`;
    const tarUrl = `${NODE_DIST_URL}/${tarName}`;
    const tarPath = path.join(NODE_CACHE_DIR, tarName);
    const extractDir = path.join(NODE_EXTRACT_DIR, baseName);
    const binaryPath = path.join(extractDir, 'bin', 'node');

    ensureDir(NODE_CACHE_DIR);

    const sums = await (await fetchOk(`${NODE_DIST_URL}/SHASUMS256.txt`)).text();
    const expected = sums
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([, name]) => name === tarName)?.[0];
    if (!expected) {
        throw new Error(`No checksum for ${tarName} in ${NODE_DIST_URL}/SHASUMS256.txt`);
    }

    let actual = '';
    for (let attempt = 0; attempt < NODE_DOWNLOAD_ATTEMPTS && actual !== expected; attempt++) {
        let data = readCachedTarball(tarPath);
        if (!data) {
            console.log(`⬇️  Downloading ${tarName}...`);
            data = Buffer.from(await (await fetchOk(tarUrl)).arrayBuffer());
            cacheTarball(tarPath, data);
        }
        actual = sha256Hex(data);
        if (actual !== expected) fs.rmSync(tarPath, { force: true });
    }
    if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${tarUrl}: expected ${expected}, got ${actual}`);
    }

    console.log(`📂 Extracting ${tarName}...`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    ensureDir(NODE_EXTRACT_DIR);
    const flag = ext === 'tar.gz' ? '-xzf' : '-xJf';
    execFileSync('tar', [flag, tarPath, '-C', NODE_EXTRACT_DIR], { stdio: 'inherit' });

    if (!fs.existsSync(binaryPath)) {
        throw new Error(`Extracted Node binary not found at ${binaryPath}`);
    }
    return binaryPath;
}

async function buildPlatform({ output, plat, arch }: CliPlatform, seaBlobPath: string) {
    console.log(`🔧 Building ${output} (${plat}/${arch})...`);

    const sourceBinary = await getOfficialNodeBinary(plat, arch);
    const outputBinary = path.join(BUILD_DIR, output);
    fs.copyFileSync(sourceBinary, outputBinary);
    fs.chmodSync(outputBinary, 0o755);

    // Keep Node's exported N-API symbols: the embedded vision runtime loads
    // sharp and ONNX native addons from its self-extracted bundle. Stripping
    // the executable removes those symbols and causes dlopen to fail.

    // Invoke postject's local binary directly to avoid a runtime dependency on `pnpm` being
    // on PATH (the CLI build is called via `node --import tsx scripts/build-cli.ts`, which may not inherit
    // a pnpm-augmented PATH in every environment).
    const postjectBin = path.join(ROOT, 'node_modules', '.bin', 'postject');
    const postjectArgs = [outputBinary, 'NODE_SEA_BLOB', seaBlobPath, '--sentinel-fuse', SEA_FUSE, '--overwrite'];
    if (plat === 'darwin') {
        postjectArgs.push('--macho-segment-name', 'NODE_SEA');
    }
    execFileSync(postjectBin, postjectArgs, { stdio: 'inherit' });

    if (plat === 'darwin') {
        // Apple Silicon AMFI rejects unsigned binaries. postject invalidated the
        // nodejs.org signature; -f lets codesign overwrite it with ad-hoc.
        // No Developer ID / notarization — users still see the Gatekeeper prompt on
        // browser-downloaded binaries and bypass via xattr or right-click → Open.
        execFileSync('codesign', ['-f', '--sign', '-', outputBinary], { stdio: 'inherit' });
    }
    // UPX is intentionally skipped on all targets:
    //   - macOS arm64: UPX 5.1.x requires --force-macos for Mach-O, but the packed binary
    //     fails Apple Silicon AMFI even after ad-hoc resigning (Killed: 9).
    //   - Linux ELF: postject's section injection moves the program-header offset to a
    //     non-trivial location, which trips UPX's structural `bad e_phoff` check. The
    //     `-f` flag does NOT bypass this — it's a hard refusal, not a warning. Reproduced
    //     on UPX 5.1.1 with Node 26 darwin-arm64 and linux-arm64 binaries.
    // Revisit when postject ships an option for in-place section injection OR UPX adds
    // tolerance for moved program headers.

    console.log(`✅ Built ${output}`);
}

async function main() {
    const args = process.argv.slice(2);
    // --lite leaves the local vision model and its runtime out of the binary;
    // services/visionVerifier.ts then skips the visual check.
    const lite = args.includes('--lite');
    const platformArg = args.find((arg) => !arg.startsWith('--'));

    ensureDir(DIST_DIR);
    ensureDir(BUILD_DIR);

    try {
        const targets = platformArg ? platforms.filter((p) => p.input === platformArg) : platforms;
        if (platformArg && targets.length === 0) throw new Error(`Unknown platform: ${platformArg}`);
        await bundleCli();
        if (!lite) await prepareVisionRuntime();
        // Homebrew's Node can disable SEA; the official binary is also the
        // injection target, so generate the blob with that exact build.
        const hostNode = await getOfficialNodeBinary(process.platform, process.arch);
        const seaBlobPath = generateSeaBlob(hostNode, { lite });

        for (const t of targets) {
            await buildPlatform(lite ? { ...t, output: `${t.output}-lite` } : t, seaBlobPath);
        }

        console.log('🎉 CLI build completed');
    } catch (error) {
        console.error('❌ Build failed:', error);
        process.exit(1);
    }
}

runIfMain(require.main, module, main);

export {
    platforms,
    ensureDir,
    bundleCli,
    pruneVisionRuntime,
    prepareVisionRuntime,
    generateSeaBlob,
    getOfficialNodeBinary,
    buildPlatform,
    main,
};
