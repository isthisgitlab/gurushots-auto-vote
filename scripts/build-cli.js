#!/usr/bin/env node

const { build } = require('esbuild');
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const packageJson = require('../package.json');

const { version } = packageJson;

// Node SEA fuse sentinel — required by postject so Node knows where to find the embedded blob.
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// Pin to a specific Node version for reproducible bundle output. Bump when bumping engines.
const TARGET_NODE_VERSION = process.versions.node;

const platforms = [
    { input: 'gurucli-mac', output: `gurucli-v${version}-mac`, plat: 'darwin', arch: 'arm64' },
    { input: 'gurucli-linux', output: `gurucli-v${version}-linux`, plat: 'linux', arch: 'x64' },
    { input: 'gurucli-linux-arm', output: `gurucli-v${version}-linux-arm`, plat: 'linux', arch: 'arm64' },
];

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const BUILD_DIR = path.join(ROOT, 'build', 'cli');
const NODE_CACHE_DIR = path.join(ROOT, '.cache', 'node-binaries');

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function bundleCli() {
    console.log('🔨 Bundling CLI with esbuild...');
    await build({
        entryPoints: [path.join(ROOT, 'src', 'js', 'cli', 'cli.js')],
        bundle: true,
        platform: 'node',
        target: 'node26',
        format: 'cjs',
        outfile: path.join(DIST_DIR, 'cli-bundled.js'),
        external: ['electron'],
        minify: false,
        sourcemap: false,
        define: {
            'process.env.NODE_ENV': '"production"',
        },
    });
    console.log('✅ CLI bundled');
}

function generateSeaBlob() {
    console.log('📦 Generating SEA blob...');
    const seaConfigPath = path.join(DIST_DIR, 'sea-config.json');
    const seaBlobPath = path.join(DIST_DIR, 'sea-prep.blob');
    const seaConfig = {
        main: path.join(DIST_DIR, 'cli-bundled.js'),
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
    };
    fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
    execSync(`node --experimental-sea-config "${seaConfigPath}"`, { stdio: 'inherit' });
    console.log('✅ SEA blob generated');
    return seaBlobPath;
}

// Always download the official nodejs.org Node binary rather than using process.execPath.
// Local Homebrew (and some package-manager Node installs) are dynamically linked to host
// dylibs and produce non-portable binaries when used as the SEA injection target.
async function getOfficialNodeBinary(plat, arch) {
    const ver = TARGET_NODE_VERSION;
    const ext = plat === 'darwin' ? 'tar.gz' : 'tar.xz';
    const tarName = `node-v${ver}-${plat}-${arch}.${ext}`;
    const extractDir = path.join(NODE_CACHE_DIR, `node-v${ver}-${plat}-${arch}`);
    const binaryPath = path.join(extractDir, 'bin', 'node');

    if (fs.existsSync(binaryPath)) {
        return binaryPath;
    }

    ensureDir(NODE_CACHE_DIR);
    const tarPath = path.join(NODE_CACHE_DIR, tarName);

    if (!fs.existsSync(tarPath)) {
        const url = `https://nodejs.org/dist/v${ver}/${tarName}`;
        console.log(`⬇️  Downloading ${tarName}...`);
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(tarPath, buf);
    }

    console.log(`📂 Extracting ${tarName}...`);
    const flag = ext === 'tar.gz' ? '-xzf' : '-xJf';
    execSync(`tar ${flag} "${tarPath}" -C "${NODE_CACHE_DIR}"`, { stdio: 'inherit' });

    if (!fs.existsSync(binaryPath)) {
        throw new Error(`Extracted Node binary not found at ${binaryPath}`);
    }
    return binaryPath;
}

async function buildPlatform({ output, plat, arch }, seaBlobPath) {
    console.log(`🔧 Building ${output} (${plat}/${arch})...`);

    const sourceBinary = await getOfficialNodeBinary(plat, arch);
    const outputBinary = path.join(BUILD_DIR, output);
    fs.copyFileSync(sourceBinary, outputBinary);
    fs.chmodSync(outputBinary, 0o755);

    // Strip the existing signature on macOS before patching; postject's injection
    // invalidates it and the OS refuses to run unsigned-but-marked-signed binaries.
    if (plat === 'darwin') {
        execSync(`codesign --remove-signature "${outputBinary}"`, { stdio: 'inherit' });
    }

    const macFlag = plat === 'darwin' ? `--macho-segment-name NODE_SEA` : '';
    const postjectCmd = [
        'npx',
        '--no-install',
        'postject',
        `"${outputBinary}"`,
        'NODE_SEA_BLOB',
        `"${seaBlobPath}"`,
        '--sentinel-fuse',
        SEA_FUSE,
        macFlag,
        '--overwrite',
    ]
        .filter(Boolean)
        .join(' ');
    execSync(postjectCmd, { stdio: 'inherit' });

    // Ad-hoc re-sign on macOS. Matches the existing Electron build config
    // (hardenedRuntime: false, no Developer ID) — fine for sideloaded distribution.
    if (plat === 'darwin') {
        execSync(`codesign --sign - "${outputBinary}"`, { stdio: 'inherit' });
    }

    console.log(`✅ Built ${output}`);
}

async function main() {
    const platformArg = process.argv[2];

    ensureDir(DIST_DIR);
    ensureDir(BUILD_DIR);

    try {
        await bundleCli();
        const seaBlobPath = generateSeaBlob();

        const targets = platformArg ? platforms.filter((p) => p.input === platformArg) : platforms;

        if (platformArg && targets.length === 0) {
            throw new Error(`Unknown platform: ${platformArg}`);
        }

        for (const t of targets) {
            await buildPlatform(t, seaBlobPath);
        }

        console.log('🎉 CLI build completed');
    } catch (error) {
        console.error('❌ Build failed:', error);
        process.exit(1);
    }
}

main();
