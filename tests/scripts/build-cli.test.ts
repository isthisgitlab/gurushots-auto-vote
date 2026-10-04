/**
 * Tests for scripts/build-cli.ts — the SEA CLI builder.
 *
 * Fully hermetic: esbuild and child_process are mocked (no bundling, tar,
 * strip, postject or codesign ever runs), fetch is stubbed, and every fs call
 * the script makes is intercepted against an in-memory set of "existing"
 * paths so nothing under the repo's dist/, build/ or .cache/ is touched.
 */

// tests/setup.ts globally mocks fs and path; this suite needs the real modules.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

jest.mock('esbuild', () => ({ build: jest.fn(() => Promise.resolve()) }));
jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('../../scripts/fetch-vision-model', () => ({
    ensureVisionModel: jest.fn().mockResolvedValue('/mock/vision-model'),
}));

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
const realReadFileSync = fs.readFileSync;
const realRenameSync = fs.renameSync;
import pathModule = require('node:path');
import crypto = require('node:crypto');
const path = jest.mocked(pathModule);
const { build } = jest.mocked(require('esbuild') as typeof esbuildModule);
const { execFileSync } = jest.mocked(require('node:child_process') as typeof node_child_processModule);
const { version } = require('../../package.json') as typeof package_jsonModule;

import buildCli = require('../../scripts/build-cli');
import type * as esbuildModule from 'esbuild';
import type * as node_child_processModule from 'node:child_process';
import type * as package_jsonModule from '../../package.json';
import type * as fetch_vision_modelModule from '../../scripts/fetch-vision-model';
import type * as node_osModule from 'node:os';
import type { PathLike } from 'node:fs';
import type { SeaConfig } from '../../scripts/build-cli';
import { invalid } from '../helpers/invalid';

const ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist');
const BUILD_DIR = path.join(ROOT, 'build', 'cli');
const NODE_CACHE_DIR = path.join(ROOT, '.cache', 'node-binaries');
const LEXICON = path.join(ROOT, 'src', 'assets', 'semantic-vectors.json');
const SEA_BLOB = path.join(BUILD_DIR, 'sea-prep.blob');
const POSTJECT = path.join(ROOT, 'node_modules', '.bin', 'postject');
const NODE_VER = process.versions.node;

const NODE_EXTRACT_DIR = path.join(ROOT, '.cache', 'node-extract');
// The build trees scripts/build-cli.ts writes into (NODE_CACHE_DIR, NODE_EXTRACT_DIR,
// the pnpm deploy dir, BUILD_DIR, DIST_DIR): the read spy treats a miss there as "no
// file" instead of reaching for whatever is really on disk. Keep in step with the
// script's path constants — a tree missing here lets the real on-disk file back in.
const BUILD_TREES = [
    DIST_DIR,
    BUILD_DIR,
    NODE_CACHE_DIR,
    NODE_EXTRACT_DIR,
    path.join(ROOT, '.cache', 'vision-cli-deploy'),
];
const NODE_DIST = `https://nodejs.org/dist/v${NODE_VER}`;
const NODE_TARBALL = Buffer.from('node tarball');
const NODE_TARBALL_SHA = crypto.createHash('sha256').update(NODE_TARBALL).digest('hex');
const TARBALL_NAMES = ['darwin', 'linux'].flatMap((plat) =>
    ['arm64', 'x64'].map((arch) => `node-v${NODE_VER}-${plat}-${arch}.${plat === 'darwin' ? 'tar.gz' : 'tar.xz'}`),
);
const SHASUMS = TARBALL_NAMES.map((name) => `${NODE_TARBALL_SHA}  ${name}\n`).join('');

const tarballName = (plat: string, arch: string) =>
    `node-v${NODE_VER}-${plat}-${arch}.${plat === 'darwin' ? 'tar.gz' : 'tar.xz'}`;
const tarballPath = (plat: string, arch: string) => path.join(NODE_CACHE_DIR, tarballName(plat, arch));
const extractDir = (plat: string, arch: string) => path.join(NODE_EXTRACT_DIR, `node-v${NODE_VER}-${plat}-${arch}`);
const nodeBinary = (plat: string, arch: string) => path.join(extractDir(plat, arch), 'bin', 'node');

// Serves SHASUMS256.txt plus each tarball download in turn (the last one repeats).
const stubNodeDist = ({ sums = SHASUMS, downloads = [NODE_TARBALL] }: { sums?: string; downloads?: Buffer[] } = {}) => {
    let served = 0;
    jest.mocked(global.fetch).mockImplementation(
        invalid(async (url: string) => {
            if (url.endsWith('/SHASUMS256.txt')) return { ok: true, text: async () => sums };
            const body = downloads[Math.min(served++, downloads.length - 1)];
            return { ok: true, arrayBuffer: async () => new Uint8Array(body).buffer };
        }),
    );
};

describe('build-cli', () => {
    let existing: Set<PathLike>;
    let files: Map<string, Buffer>;
    let exitSpy: jest.SpiedFunction<typeof process.exit>;
    let logSpy: jest.SpiedFunction<typeof console.log>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;
    let originalFetch: typeof global.fetch;

    // Stands in for `tar -x`: the extracted tree gains its bin/node.
    const stubTar = () =>
        execFileSync.mockImplementation(
            invalid((command: string, args: string[]) => {
                if (command !== 'tar') return;
                const baseName = path.basename(args[1]).replace(/\.tar\.(gz|xz)$/, '');
                existing.add(path.join(NODE_EXTRACT_DIR, baseName, 'bin', 'node'));
            }),
        );

    beforeEach(() => {
        existing = new Set();
        files = new Map();
        build.mockReset().mockResolvedValue(invalid(undefined));
        execFileSync.mockReset();
        jest.spyOn(fs, 'existsSync').mockImplementation((p) => existing.has(p));
        jest.spyOn(fs, 'mkdirSync').mockImplementation((p) => {
            existing.add(p);
        });
        jest.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
            existing.add(p);
            files.set(String(p), Buffer.from(data as Uint8Array | string));
        });
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            const contents = files.get(String(from));
            if (!contents) throw new Error(`ENOENT: no such file or directory, rename '${String(from)}'`);
            existing.delete(from);
            existing.add(to);
            files.set(String(to), contents);
        });
        jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {});
        jest.spyOn(fs, 'cpSync').mockImplementation(() => {});
        jest.spyOn(fs, 'rmSync').mockImplementation((p) => {
            existing.delete(p);
            files.delete(String(p));
        });
        // The script only reads from the repo's own build trees, so those come from the
        // in-memory set (a miss is a missing file) — a real 58 MB tarball sitting in
        // .cache/node-binaries can then never leak into a run. Every other path falls
        // through to the real fs, which the spy must keep serving: Jest itself reads
        // modules through it while a failing expectation resolves a stack frame.
        jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
            if (String(file).endsWith('vision-runtime.tar.gz')) return Buffer.from('test archive');
            const contents = files.get(String(file));
            if (contents) return contents;
            if (!BUILD_TREES.some((dir) => String(file).startsWith(dir))) return realReadFileSync(file, ...args);
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${String(file)}'`), {
                code: 'ENOENT',
            });
        });
        jest.spyOn(fs, 'chmodSync').mockImplementation(() => {});
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(invalid(() => undefined));
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        originalFetch = global.fetch;
        global.fetch = jest.fn();
        stubNodeDist();
        stubTar();
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
                entryPoints: [path.join(ROOT, 'src', 'ts', 'cli', 'cli.ts')],
                outfile: path.join(DIST_DIR, 'cli-bundled.js'),
                platform: 'node',
                format: 'cjs',
                external: ['electron', '@huggingface/transformers'],
            }),
        );
    });

    describe('generateSeaBlob', () => {
        const writtenConfig = () => JSON.parse(fs.writeFileSync.mock.calls[0][1] as string) as SeaConfig;

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
        const fetchedUrls = () => jest.mocked(global.fetch).mock.calls.map(([url]) => String(url));
        const extractCalls = () => execFileSync.mock.calls.filter(([command]) => command === 'tar');
        const tempTarball = (plat: string, arch: string) =>
            path.join(NODE_CACHE_DIR, `.${tarballName(plat, arch)}.${process.pid}.tmp`);

        test('downloads, verifies and extracts a darwin gzip tarball from the cache dir', async () => {
            await expect(buildCli.getOfficialNodeBinary('darwin', 'arm64')).resolves.toBe(
                nodeBinary('darwin', 'arm64'),
            );
            expect(fetchedUrls()).toEqual([
                `${NODE_DIST}/SHASUMS256.txt`,
                `${NODE_DIST}/${tarballName('darwin', 'arm64')}`,
            ]);
            expect(fs.mkdirSync).toHaveBeenCalledWith(NODE_CACHE_DIR, { recursive: true });
            expect(fs.writeFileSync).toHaveBeenCalledWith(tempTarball('darwin', 'arm64'), NODE_TARBALL);
            expect(fs.renameSync).toHaveBeenCalledWith(tempTarball('darwin', 'arm64'), tarballPath('darwin', 'arm64'));
            expect(fs.rmSync).toHaveBeenCalledWith(extractDir('darwin', 'arm64'), { recursive: true, force: true });
            expect(extractCalls()).toEqual([
                ['tar', ['-xzf', tarballPath('darwin', 'arm64'), '-C', NODE_EXTRACT_DIR], { stdio: 'inherit' }],
            ]);
        });

        test('extracts a linux xz tarball', async () => {
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).resolves.toBe(nodeBinary('linux', 'x64'));
            expect(extractCalls()).toEqual([
                ['tar', ['-xJf', tarballPath('linux', 'x64'), '-C', NODE_EXTRACT_DIR], { stdio: 'inherit' }],
            ]);
        });

        test('reuses a cached tarball whose hash matches, but still extracts fresh', async () => {
            existing.add(tarballPath('linux', 'x64'));
            files.set(tarballPath('linux', 'x64'), NODE_TARBALL);
            existing.add(nodeBinary('linux', 'x64'));
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).resolves.toBe(nodeBinary('linux', 'x64'));
            expect(fetchedUrls()).toEqual([`${NODE_DIST}/SHASUMS256.txt`]);
            expect(fs.writeFileSync).not.toHaveBeenCalled();
            expect(fs.renameSync).not.toHaveBeenCalled();
            expect(fs.rmSync).toHaveBeenCalledWith(extractDir('linux', 'x64'), { recursive: true, force: true });
            expect(extractCalls()).toHaveLength(1);
        });

        // Each override is scoped to the path under test and replaced wholesale (not
        // one-shot): the fs spies are process-wide, so an incidental call — Jest
        // resolving a stack frame — must neither eat a one-shot nor be blinded.
        // afterEach's restoreAllMocks puts the harness back.
        test('propagates a cache read failure that is not a missing file', async () => {
            const target = tarballPath('linux', 'x64');
            fs.readFileSync.mockImplementation((file, ...args) => {
                if (String(file) !== target) return realReadFileSync(file, ...args);
                throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            });
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).rejects.toThrow('permission denied');
            expect(execFileSync).not.toHaveBeenCalled();
        });

        test('a publish that cannot rename discards the temp tarball and caches nothing', async () => {
            const target = tarballPath('linux', 'x64');
            fs.renameSync.mockImplementation((from, to) => {
                if (String(to) !== target) return realRenameSync(from, to);
                throw Object.assign(new Error('rename blocked'), { code: 'EPERM' });
            });
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).rejects.toThrow('rename blocked');
            // The complete temp copy is gone and the cache name was never created.
            expect(fs.rmSync).toHaveBeenCalledWith(tempTarball('linux', 'x64'), { force: true });
            expect(existing.has(tempTarball('linux', 'x64'))).toBe(false);
            expect(existing.has(target)).toBe(false);
            expect(files.has(target)).toBe(false);
            expect(extractCalls()).toHaveLength(0);
        });

        test('a corrupt cached tarball is deleted and downloaded again', async () => {
            existing.add(tarballPath('linux', 'x64'));
            files.set(tarballPath('linux', 'x64'), Buffer.from('corrupted'));
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).resolves.toBe(nodeBinary('linux', 'x64'));
            expect(fs.rmSync).toHaveBeenCalledWith(tarballPath('linux', 'x64'), { force: true });
            expect(fetchedUrls()).toEqual([
                `${NODE_DIST}/SHASUMS256.txt`,
                `${NODE_DIST}/${tarballName('linux', 'x64')}`,
            ]);
            expect(files.get(tarballPath('linux', 'x64'))).toEqual(NODE_TARBALL);
        });

        test('a bad download is retried once and then accepted when the hash matches', async () => {
            stubNodeDist({ downloads: [Buffer.from('poisoned'), NODE_TARBALL] });
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).resolves.toBe(nodeBinary('linux', 'x64'));
            expect(fetchedUrls().filter((url) => url.endsWith('.tar.xz'))).toHaveLength(2);
            expect(extractCalls()).toHaveLength(1);
        });

        test('fails closed naming the URL, expected and actual hashes after two mismatches', async () => {
            const bad = Buffer.from('poisoned');
            const badSha = crypto.createHash('sha256').update(bad).digest('hex');
            stubNodeDist({ downloads: [bad] });
            const url = `${NODE_DIST}/${tarballName('linux', 'x64')}`;
            const failure = buildCli.getOfficialNodeBinary('linux', 'x64');
            await expect(failure).rejects.toThrow(url);
            await expect(failure).rejects.toThrow(`expected ${NODE_TARBALL_SHA}, got ${badSha}`);
            expect(fetchedUrls().filter((u) => u.endsWith('.tar.xz'))).toHaveLength(2);
            expect(files.has(tarballPath('linux', 'x64'))).toBe(false);
            expect(extractCalls()).toHaveLength(0);
        });

        test('throws when SHASUMS256.txt has no line for the tarball', async () => {
            stubNodeDist({ sums: `${NODE_TARBALL_SHA}  node-v0.0.0-other.tar.gz\n` });
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).rejects.toThrow(
                `No checksum for ${tarballName('linux', 'x64')}`,
            );
            expect(fetchedUrls()).toEqual([`${NODE_DIST}/SHASUMS256.txt`]);
        });

        test('throws on a failed SHASUMS256.txt download', async () => {
            jest.mocked(global.fetch).mockResolvedValue(invalid({ ok: false, status: 503 }));
            await expect(buildCli.getOfficialNodeBinary('linux', 'arm64')).rejects.toThrow('HTTP 503');
            expect(execFileSync).not.toHaveBeenCalled();
        });

        test('throws on a failed tarball download', async () => {
            jest.mocked(global.fetch).mockImplementation(
                invalid(async (url: string) =>
                    url.endsWith('/SHASUMS256.txt')
                        ? { ok: true, text: async () => SHASUMS }
                        : { ok: false, status: 404 },
                ),
            );
            await expect(buildCli.getOfficialNodeBinary('linux', 'arm64')).rejects.toThrow('HTTP 404');
            expect(execFileSync).not.toHaveBeenCalled();
        });

        test('throws when extraction does not produce the binary', async () => {
            execFileSync.mockReset();
            await expect(buildCli.getOfficialNodeBinary('linux', 'x64')).rejects.toThrow(
                `Extracted Node binary not found at ${nodeBinary('linux', 'x64')}`,
            );
        });
    });

    describe('buildPlatform', () => {
        test('darwin: preserves native addon symbols, injects with the Mach-O segment and ad-hoc signs', async () => {
            const out = path.join(BUILD_DIR, 'gurucli-vX-mac');
            await buildCli.buildPlatform(
                invalid({ output: 'gurucli-vX-mac', plat: 'darwin', arch: 'arm64' }),
                SEA_BLOB,
            );
            expect(fs.copyFileSync).toHaveBeenCalledWith(nodeBinary('darwin', 'arm64'), out);
            expect(fs.chmodSync).toHaveBeenCalledWith(out, 0o755);
            expect(execFileSync.mock.calls.filter(([command]) => command !== 'tar')).toEqual([
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
            const out = path.join(BUILD_DIR, 'gurucli-vX-linux');
            await buildCli.buildPlatform(invalid({ output: 'gurucli-vX-linux', plat: 'linux', arch: 'x64' }), SEA_BLOB);
            expect(execFileSync.mock.calls.filter(([command]) => command !== 'tar')).toEqual([
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
        let originalArgv: string[];

        beforeEach(() => {
            originalArgv = process.argv;
        });

        afterEach(() => {
            process.argv = originalArgv;
        });

        const builtOutputs = () => fs.copyFileSync.mock.calls.map(([, dest]) => path.basename(dest as string));

        test('builds every platform when no argument is given', async () => {
            process.argv = ['node', 'build-cli.ts'];
            await buildCli.main();
            expect(fs.mkdirSync).toHaveBeenCalledWith(DIST_DIR, { recursive: true });
            expect(fs.mkdirSync).toHaveBeenCalledWith(BUILD_DIR, { recursive: true });
            expect(builtOutputs()).toEqual(buildCli.platforms.map((p) => p.output));
            expect(logSpy).toHaveBeenCalledWith('🎉 CLI build completed');
            expect(exitSpy).not.toHaveBeenCalled();
        });

        test('builds only the requested platform', async () => {
            process.argv = ['node', 'build-cli.ts', 'gurucli-linux-arm'];
            await buildCli.main();
            expect(builtOutputs()).toEqual([`gurucli-v${version}-linux-arm`]);
            expect(exitSpy).not.toHaveBeenCalled();
        });

        test('--lite builds "-lite" binaries without preparing the visual runtime', async () => {
            const { ensureVisionModel } = jest.mocked(
                require('../../scripts/fetch-vision-model') as typeof fetch_vision_modelModule,
            );
            ensureVisionModel.mockClear();
            process.argv = ['node', 'build-cli.ts', 'gurucli-mac', '--lite'];
            await buildCli.main();
            expect(builtOutputs()).toEqual([`gurucli-v${version}-mac-lite`]);
            expect(ensureVisionModel).not.toHaveBeenCalled();
            expect(execFileSync).not.toHaveBeenCalledWith('pnpm', expect.anything(), expect.anything());
            expect(exitSpy).not.toHaveBeenCalled();
        });

        test('fails with exit 1 on an unknown platform', async () => {
            process.argv = ['node', 'build-cli.ts', 'gurucli-bogus'];
            await buildCli.main();
            expect(errorSpy).toHaveBeenCalledWith('❌ Build failed:', new Error('Unknown platform: gurucli-bogus'));
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(fs.copyFileSync).not.toHaveBeenCalled();
        });

        test('fails with exit 1 when bundling throws', async () => {
            process.argv = ['node', 'build-cli.ts'];
            build.mockRejectedValueOnce(new Error('esbuild exploded'));
            await buildCli.main();
            expect(errorSpy).toHaveBeenCalledWith('❌ Build failed:', new Error('esbuild exploded'));
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(execFileSync).not.toHaveBeenCalled();
        });
    });
});

describe('pruneVisionRuntime', () => {
    const os = require('node:os') as typeof node_osModule;
    let pnpmDir: string;
    const tree = (...parts: string[]) => path.join(pnpmDir, ...parts);
    const onnxBin = (...parts: string[]) =>
        tree('onnxruntime-node@1.0.0', 'node_modules', 'onnxruntime-node', 'bin', ...parts);

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
