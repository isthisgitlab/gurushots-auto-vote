/**
 * Tests for scripts/build-cli.js — the SEA CLI builder.
 *
 * Fully hermetic: esbuild and child_process are mocked (no bundling, tar,
 * strip, postject or codesign ever runs), fetch is stubbed, and every fs call
 * the script makes is intercepted against an in-memory set of "existing"
 * paths so nothing under the repo's dist/, build/ or .cache/ is touched.
 */

// tests/setup.js globally mocks fs and path; this suite needs the real modules.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

jest.mock('esbuild', () => ({ build: jest.fn(() => Promise.resolve()) }));
jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('../../scripts/fetch-vision-model', () => ({
    ensureVisionModel: jest.fn().mockResolvedValue('/mock/vision-model'),
}));

const fs = require('node:fs');
const realReadFileSync = fs.readFileSync;
const path = require('node:path');
const { build } = require('esbuild');
const { execFileSync } = require('node:child_process');
const { version } = require('../../package.json');

const buildCli = require('../../scripts/build-cli');

const ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist');
const BUILD_DIR = path.join(ROOT, 'build', 'cli');
const NODE_CACHE_DIR = path.join(ROOT, '.cache', 'node-binaries');
const LEXICON = path.join(ROOT, 'src', 'assets', 'semantic-vectors.json');
const SEA_BLOB = path.join(BUILD_DIR, 'sea-prep.blob');
const POSTJECT = path.join(ROOT, 'node_modules', '.bin', 'postject');
const NODE_VER = process.versions.node;

const extractDir = (plat, arch) => path.join(NODE_CACHE_DIR, `node-v${NODE_VER}-${plat}-${arch}`);
const nodeBinary = (plat, arch) => path.join(extractDir(plat, arch), 'bin', 'node');

describe('build-cli', () => {
    let existing;
    let exitSpy;
    let logSpy;
    let errorSpy;
    let originalFetch;

    beforeEach(() => {
        existing = new Set();
        build.mockReset().mockResolvedValue(undefined);
        execFileSync.mockReset();
        jest.spyOn(fs, 'existsSync').mockImplementation((p) => existing.has(p));
        jest.spyOn(fs, 'mkdirSync').mockImplementation((p) => {
            existing.add(p);
        });
        jest.spyOn(fs, 'writeFileSync').mockImplementation((p) => {
            existing.add(p);
        });
        jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {});
        jest.spyOn(fs, 'cpSync').mockImplementation(() => {});
        jest.spyOn(fs, 'rmSync').mockImplementation(() => {});
        jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) =>
            String(file).endsWith('vision-runtime.tar.gz')
                ? Buffer.from('test archive')
                : realReadFileSync(file, ...args),
        );
        jest.spyOn(fs, 'chmodSync').mockImplementation(() => {});
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        originalFetch = global.fetch;
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        global.fetch = originalFetch;
    });

    test('requiring the module has no side effects', () => {
        jest.isolateModules(() => {
            require('../../scripts/build-cli');
        });
        expect(build).not.toHaveBeenCalled();
        expect(execFileSync).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    test('platform table carries the package version in each output name', () => {
        expect(buildCli.platforms.map((p) => p.output)).toEqual([
            `gurucli-v${version}-mac`,
            `gurucli-v${version}-linux`,
            `gurucli-v${version}-linux-arm`,
        ]);
    });

    describe('ensureDir', () => {
        test('creates a missing directory recursively', () => {
            buildCli.ensureDir('/x/y');
            expect(fs.mkdirSync).toHaveBeenCalledWith('/x/y', { recursive: true });
        });

        test('leaves an existing directory alone', () => {
            existing.add('/x/y');
            buildCli.ensureDir('/x/y');
            expect(fs.mkdirSync).not.toHaveBeenCalled();
        });
    });

    test('bundleCli runs esbuild with the CLI entry point', async () => {
        await buildCli.bundleCli();
        expect(build).toHaveBeenCalledWith(
            expect.objectContaining({
                entryPoints: [path.join(ROOT, 'src', 'js', 'cli', 'cli.js')],
                outfile: path.join(DIST_DIR, 'cli-bundled.js'),
                platform: 'node',
                format: 'cjs',
                external: ['electron', '@huggingface/transformers'],
            }),
        );
    });

    describe('generateSeaBlob', () => {
        const writtenConfig = () => JSON.parse(fs.writeFileSync.mock.calls[0][1]);

        test('embeds the lexicon asset when present', () => {
            existing.add(LEXICON);
            expect(buildCli.generateSeaBlob()).toBe(SEA_BLOB);
            expect(fs.writeFileSync.mock.calls[0][0]).toBe(path.join(BUILD_DIR, 'sea-config.json'));
            expect(writtenConfig()).toEqual({
                main: path.join(DIST_DIR, 'cli-bundled.js'),
                output: SEA_BLOB,
                disableExperimentalSEAWarning: true,
                assets: {
                    'semantic-vectors.json': LEXICON,
                    'vision-runtime.tar.gz': path.join(BUILD_DIR, 'vision-runtime.tar.gz'),
                    'vision-runtime.sha256': path.join(BUILD_DIR, 'vision-runtime.sha256'),
                },
            });
            expect(execFileSync).toHaveBeenCalledWith(
                process.execPath,
                ['--experimental-sea-config', path.join(BUILD_DIR, 'sea-config.json')],
                { stdio: 'inherit' },
            );
        });

        test('still embeds the visual runtime when the lexicon is absent', () => {
            buildCli.generateSeaBlob();
            expect(writtenConfig().assets).toEqual({
                'vision-runtime.tar.gz': path.join(BUILD_DIR, 'vision-runtime.tar.gz'),
                'vision-runtime.sha256': path.join(BUILD_DIR, 'vision-runtime.sha256'),
            });
        });

        test('a lite blob embeds no visual runtime', () => {
            existing.add(LEXICON);
            buildCli.generateSeaBlob(process.execPath, { lite: true });
            expect(writtenConfig().assets).toEqual({ 'semantic-vectors.json': LEXICON });
        });
    });

    describe('getOfficialNodeBinary', () => {
        test('returns a cached binary without downloading or extracting', async () => {
            existing.add(nodeBinary('darwin', 'arm64'));
            await expect(buildCli.getOfficialNodeBinary('darwin', 'arm64')).resolves.toBe(
                nodeBinary('darwin', 'arm64'),
            );
            expect(global.fetch).not.toHaveBeenCalled();
            expect(execFileSync).not.toHaveBeenCalled();
        });

        test('extracts an already-downloaded darwin tarball with gzip', async () => {
            const tarPath = path.join(NODE_CACHE_DIR, `node-v${NODE_VER}-darwin-arm64.tar.gz`);
            existing.add(tarPath);
            execFileSync.mockImplementation(() => existing.add(nodeBinary('darwin', 'arm64')));
            await expect(buildCli.getOfficialNodeBinary('darwin', 'arm64')).resolves.toBe(
                nodeBinary('darwin', 'arm64'),
            );
            expect(global.fetch).not.toHaveBeenCalled();
            expect(fs.mkdirSync).toHaveBeenCalledWith(NODE_CACHE_DIR, { recursive: true });
            expect(execFileSync).toHaveBeenCalledWith('tar', ['-xzf', tarPath, '-C', NODE_CACHE_DIR], {
                stdio: 'inherit',
            });
        });

        test('downloads and extracts a linux xz tarball', async () => {
            const tarName = `node-v${NODE_VER}-linux-x64.tar.xz`;
            const tarPath = path.join(NODE_CACHE_DIR, tarName);
            global.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
            execFileSync.mockImplementation(() => existing.add(nodeBinary('linux', 'x64')));
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).resolves.toBe(nodeBinary('linux', 'x64'));
            expect(global.fetch).toHaveBeenCalledWith(`https://nodejs.org/dist/v${NODE_VER}/${tarName}`);
            expect(fs.writeFileSync).toHaveBeenCalledWith(tarPath, Buffer.from([1, 2, 3]));
            expect(execFileSync).toHaveBeenCalledWith('tar', ['-xJf', tarPath, '-C', NODE_CACHE_DIR], {
                stdio: 'inherit',
            });
        });

        test('throws on a failed download', async () => {
            global.fetch.mockResolvedValue({ ok: false, status: 404 });
            await expect(buildCli.getOfficialNodeBinary('linux', 'arm64')).rejects.toThrow('HTTP 404');
            expect(execFileSync).not.toHaveBeenCalled();
        });

        test('throws when extraction does not produce the binary', async () => {
            existing.add(path.join(NODE_CACHE_DIR, `node-v${NODE_VER}-linux-x64.tar.xz`));
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).rejects.toThrow(
                `Extracted Node binary not found at ${nodeBinary('linux', 'x64')}`,
            );
        });
    });

    describe('buildPlatform', () => {
        test('darwin: preserves native addon symbols, injects with the Mach-O segment and ad-hoc signs', async () => {
            existing.add(nodeBinary('darwin', 'arm64'));
            const out = path.join(BUILD_DIR, 'gurucli-vX-mac');
            await buildCli.buildPlatform({ output: 'gurucli-vX-mac', plat: 'darwin', arch: 'arm64' }, SEA_BLOB);
            expect(fs.copyFileSync).toHaveBeenCalledWith(nodeBinary('darwin', 'arm64'), out);
            expect(fs.chmodSync).toHaveBeenCalledWith(out, 0o755);
            expect(execFileSync.mock.calls).toEqual([
                [
                    POSTJECT,
                    [
                        out,
                        'NODE_SEA_BLOB',
                        SEA_BLOB,
                        '--sentinel-fuse',
                        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
                        '--overwrite',
                        '--macho-segment-name',
                        'NODE_SEA',
                    ],
                    { stdio: 'inherit' },
                ],
                ['codesign', ['-f', '--sign', '-', out], { stdio: 'inherit' }],
            ]);
        });

        test('linux: preserves native addon symbols, no Mach-O segment or codesign', async () => {
            existing.add(nodeBinary('linux', 'x64'));
            const out = path.join(BUILD_DIR, 'gurucli-vX-linux');
            await buildCli.buildPlatform({ output: 'gurucli-vX-linux', plat: 'linux', arch: 'x64' }, SEA_BLOB);
            expect(execFileSync.mock.calls).toEqual([
                [
                    POSTJECT,
                    [
                        out,
                        'NODE_SEA_BLOB',
                        SEA_BLOB,
                        '--sentinel-fuse',
                        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
                        '--overwrite',
                    ],
                    { stdio: 'inherit' },
                ],
            ]);
        });
    });

    describe('main', () => {
        let originalArgv;

        beforeEach(() => {
            originalArgv = process.argv;
            for (const { plat, arch } of buildCli.platforms) existing.add(nodeBinary(plat, arch));
        });

        afterEach(() => {
            process.argv = originalArgv;
        });

        const builtOutputs = () => fs.copyFileSync.mock.calls.map(([, dest]) => path.basename(dest));

        test('builds every platform when no argument is given', async () => {
            process.argv = ['node', 'build-cli.js'];
            await buildCli.main();
            expect(fs.mkdirSync).toHaveBeenCalledWith(DIST_DIR, { recursive: true });
            expect(fs.mkdirSync).toHaveBeenCalledWith(BUILD_DIR, { recursive: true });
            expect(builtOutputs()).toEqual(buildCli.platforms.map((p) => p.output));
            expect(logSpy).toHaveBeenCalledWith('🎉 CLI build completed');
            expect(exitSpy).not.toHaveBeenCalled();
        });

        test('builds only the requested platform', async () => {
            process.argv = ['node', 'build-cli.js', 'gurucli-linux-arm'];
            await buildCli.main();
            expect(builtOutputs()).toEqual([`gurucli-v${version}-linux-arm`]);
            expect(exitSpy).not.toHaveBeenCalled();
        });

        test('--lite builds "-lite" binaries without preparing the visual runtime', async () => {
            const { ensureVisionModel } = require('../../scripts/fetch-vision-model');
            ensureVisionModel.mockClear();
            process.argv = ['node', 'build-cli.js', 'gurucli-mac', '--lite'];
            await buildCli.main();
            expect(builtOutputs()).toEqual([`gurucli-v${version}-mac-lite`]);
            expect(ensureVisionModel).not.toHaveBeenCalled();
            expect(execFileSync).not.toHaveBeenCalledWith('pnpm', expect.anything(), expect.anything());
            expect(exitSpy).not.toHaveBeenCalled();
        });

        test('fails with exit 1 on an unknown platform', async () => {
            process.argv = ['node', 'build-cli.js', 'gurucli-bogus'];
            await buildCli.main();
            expect(errorSpy).toHaveBeenCalledWith('❌ Build failed:', new Error('Unknown platform: gurucli-bogus'));
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(fs.copyFileSync).not.toHaveBeenCalled();
        });

        test('fails with exit 1 when bundling throws', async () => {
            process.argv = ['node', 'build-cli.js'];
            build.mockRejectedValueOnce(new Error('esbuild exploded'));
            await buildCli.main();
            expect(errorSpy).toHaveBeenCalledWith('❌ Build failed:', new Error('esbuild exploded'));
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(execFileSync).not.toHaveBeenCalled();
        });
    });
});

describe('pruneVisionRuntime', () => {
    const os = require('node:os');
    let pnpmDir;
    const tree = (...parts) => path.join(pnpmDir, ...parts);
    const onnxBin = (...parts) => tree('onnxruntime-node@1.0.0', 'node_modules', 'onnxruntime-node', 'bin', ...parts);

    beforeEach(() => {
        jest.restoreAllMocks();
        pnpmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-prune-'));
        for (const target of ['darwin/arm64', 'darwin/x64', 'linux/x64', 'win32/x64']) {
            fs.mkdirSync(onnxBin('napi-v6', target), { recursive: true });
        }
        fs.mkdirSync(tree('onnxruntime-web@1.0.0', 'node_modules', 'onnxruntime-web'), { recursive: true });
        fs.mkdirSync(tree('onnxruntime-node@2.0.0-no-bin'), { recursive: true });
        fs.mkdirSync(tree('sharp@1.0.0'), { recursive: true });
    });
    afterEach(() => fs.rmSync(pnpmDir, { recursive: true, force: true }));

    test('keeps only the host onnxruntime binary and drops the unused web runtime', () => {
        buildCli.pruneVisionRuntime(pnpmDir, 'darwin', 'arm64');
        expect(fs.readdirSync(pnpmDir).sort()).toEqual([
            'onnxruntime-node@1.0.0',
            'onnxruntime-node@2.0.0-no-bin',
            'sharp@1.0.0',
        ]);
        expect(fs.readdirSync(onnxBin('napi-v6'))).toEqual(['darwin']);
        expect(fs.readdirSync(onnxBin('napi-v6', 'darwin'))).toEqual(['arm64']);
    });

    test('defaults to the build host and tolerates a missing store', () => {
        buildCli.pruneVisionRuntime(pnpmDir);
        expect(fs.readdirSync(onnxBin('napi-v6'))).toEqual(
            ['darwin', 'linux', 'win32'].filter((platform) => platform === process.platform),
        );
        expect(() => buildCli.pruneVisionRuntime(path.join(pnpmDir, 'missing'))).not.toThrow();
    });
});
