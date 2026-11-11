/**
 * Unit tests for scripts/build-react.ts.
 *
 * The script is invoked as `node --import tsx scripts/build-react.ts [--watch]` (gated by runIfMain), so
 * each case stubs argv/env/exit, requires it in an isolated module registry, calls buildReact() and
 * flushes the async build.
 * esbuild and fs are fully mocked — no real bundle is built or watched and
 * nothing under dist/ is touched.
 */

import type * as pathModule from 'node:path';
import type { BuildOptions } from 'esbuild';
import { invalid } from '../helpers/invalid';

const realPath = jest.requireActual<typeof pathModule>('path');

jest.mock('path', () => jest.requireActual<typeof import('path')>('path'));
// Shared instances (not per-registry factories) so the copies the script
// requires inside jest.isolateModules are the same objects asserted here.
const mockEsbuild = { build: jest.fn<Promise<unknown>, [BuildOptions]>(), context: jest.fn() };
const mockFs = {
    existsSync: jest.fn<boolean, [string]>(),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
    copyFileSync: jest.fn(),
    cpSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    rmSync: jest.fn(),
};
jest.mock('esbuild', () => mockEsbuild);
jest.mock('fs', () => mockFs);
const mockVisionAssets = {
    removeVisionWebAssets: jest.fn(),
    stageVisionWebAssets: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../../scripts/fetch-vision-model', () => mockVisionAssets);

const esbuild = mockEsbuild;
const fs = mockFs;

const ROOT = realPath.join(__dirname, '..', '..');
const DIST = realPath.join(ROOT, 'dist');
const FULL = realPath.join(ROOT, 'out', 'renderer', 'full', 'bundles');
const ASSEMBLY = realPath.join(ROOT, 'out', 'assembly');
const LEXICON = realPath.join(ROOT, 'src', 'assets', 'semantic-vectors.json');
const NOTICES = realPath.join(ROOT, 'src', 'assets', 'THIRD_PARTY_NOTICES.txt');
const LOGO = realPath.join(ROOT, 'src', 'assets', 'logo.png');
const ENTRY_NAMES = [
    'login',
    'app',
    'logs',
    'capacitor',
    'web',
    'remote',
    'remoteLoader',
    'headless',
    'preload',
    'preloadLogs',
];

const flush = async () => {
    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

describe('scripts/build-react.ts', () => {
    const originalArgv = process.argv;
    const originalEnv = process.env.NODE_ENV;
    let logSpy: jest.SpiedFunction<typeof console.log>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;
    let exitSpy: jest.SpiedFunction<typeof process.exit>;
    let onSpy: jest.SpiedFunction<typeof process.on>;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(invalid(() => {}));
        onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
        fs.existsSync.mockReturnValue(true);
        esbuild.build.mockResolvedValue({});
    });

    afterEach(() => {
        process.argv = originalArgv;
        if (originalEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalEnv;
        jest.restoreAllMocks();
    });

    const run = async (args: string[] = [], nodeEnv: string | undefined) => {
        process.argv = ['node', 'scripts/build-react.ts', ...args];
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        jest.isolateModules(() => {
            (require('../../scripts/build-react') as typeof import('../../scripts/build-react')).buildReact();
        });
        await flush();
    };

    const runMain = async (args: string[] = []) => {
        process.argv = ['node', 'scripts/build-react.ts', ...args];
        let result: unknown;
        jest.isolateModules(() => {
            result = (require('../../scripts/build-react') as typeof import('../../scripts/build-react')).main();
        });
        await result;
        await flush();
    };

    const logged = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

    test('requiring the script does not start a build', async () => {
        process.argv = ['node', 'scripts/build-react.ts'];
        jest.isolateModules(() => {
            require('../../scripts/build-react');
        });
        await flush();

        expect(esbuild.build).not.toHaveBeenCalled();
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('dispatches the bundle stage without compatibility assembly', async () => {
        await runMain(['--bundles']);

        expect(esbuild.build).toHaveBeenCalledTimes(ENTRY_NAMES.length);
        expect(fs.rmSync).not.toHaveBeenCalledWith(DIST, expect.anything());
    });

    test('dispatches the selected production assembly without rebundling', async () => {
        await runMain(['--assemble=production', '--lite']);

        expect(esbuild.build).not.toHaveBeenCalled();
        expect(fs.rmSync).toHaveBeenCalledWith(realPath.join(ASSEMBLY, 'lite'), { recursive: true, force: true });
        expect(fs.rmSync).not.toHaveBeenCalledWith(DIST, expect.anything());
    });

    test('dispatches the full production assembly without rebundling', async () => {
        await runMain(['--assemble=production']);

        expect(esbuild.build).not.toHaveBeenCalled();
        expect(fs.rmSync).toHaveBeenCalledWith(realPath.join(ASSEMBLY, 'full'), { recursive: true, force: true });
    });

    test('dispatches compatibility assembly to dist without rebundling', async () => {
        await runMain(['--assemble']);

        expect(esbuild.build).not.toHaveBeenCalled();
        expect(fs.rmSync).toHaveBeenCalledWith(DIST, { recursive: true, force: true });
    });

    test('defaults to the complete compatibility build', async () => {
        await runMain();

        expect(esbuild.build).toHaveBeenCalledTimes(ENTRY_NAMES.length);
        expect(fs.rmSync).toHaveBeenCalledWith(DIST, { recursive: true, force: true });
    });

    test('writes the remote version tree into an explicitly selected assembly destination', () => {
        const selected = realPath.join(ASSEMBLY, 'full');
        jest.isolateModules(() => {
            (require('../../scripts/build-react') as typeof import('../../scripts/build-react')).copyRemoteVersionDir(
                selected,
            );
        });

        expect(fs.rmSync).toHaveBeenCalledWith(realPath.join(selected, 'remote'), { recursive: true, force: true });
        expect(fs.copyFileSync).toHaveBeenCalledWith(
            realPath.join(selected, 'styles.css'),
            realPath.join(selected, 'remote', 'v1', 'styles.css'),
        );

        jest.isolateModules(() => {
            (require('../../scripts/build-react') as typeof import('../../scripts/build-react')).copyRemoteVersionDir();
        });

        expect(fs.rmSync).toHaveBeenCalledWith(realPath.join(DIST, 'remote'), { recursive: true, force: true });
    });

    describe('build mode', () => {
        test('writes the HTML shells, copies the lexicon and builds every entry', async () => {
            await run([], 'production');

            expect(fs.rmSync).toHaveBeenCalledWith(DIST, { recursive: true, force: true });
            expect(fs.mkdirSync).toHaveBeenCalledWith(FULL, { recursive: true });
            expect(fs.mkdirSync).toHaveBeenCalledWith(DIST, { recursive: true });
            expect(fs.rmSync).toHaveBeenCalledWith(realPath.join(DIST, 'remote'), { recursive: true, force: true });
            expect(fs.mkdirSync).toHaveBeenCalledWith(realPath.join(DIST, 'remote', 'v1'), { recursive: true });
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                realPath.join(DIST, 'index.html'),
                expect.stringContaining('capacitor-bundle.js'),
            );
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                realPath.join(DIST, 'headless.html'),
                expect.stringContaining('src="headless-flag.js"'),
            );
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                realPath.join(DIST, 'headless-flag.js'),
                'window.__GS_HEADLESS__ = true;\n',
            );
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                realPath.join(DIST, 'web.html'),
                expect.stringContaining('web-bundle.js'),
            );
            expect(fs.copyFileSync).toHaveBeenCalledWith(LEXICON, realPath.join(DIST, 'semantic-vectors.json'));
            expect(fs.copyFileSync).toHaveBeenCalledWith(NOTICES, realPath.join(DIST, 'THIRD_PARTY_NOTICES.txt'));
            expect(fs.copyFileSync).toHaveBeenCalledWith(LOGO, realPath.join(DIST, 'favicon.png'));

            // The remote page tree the APK carries: the versioned page and, beside it, the loader the
            // Android remote mode opens by file name (the app's local server answers a directory path
            // with the app's own document), with its bundle and the app stylesheet.
            const remoteDir = realPath.join(DIST, 'remote');
            expect(fs.copyFileSync).toHaveBeenCalledWith(
                realPath.join(DIST, 'remote.html'),
                realPath.join(remoteDir, 'v1', 'index.html'),
            );
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                realPath.join(remoteDir, 'index.html'),
                expect.stringContaining('remoteLoader-bundle.js'),
            );
            // The loader is published too, so the third-party notices sit beside it as beside each version's page.
            for (const name of ['remoteLoader-bundle.js', 'styles.css', 'THIRD_PARTY_NOTICES.txt']) {
                expect(fs.copyFileSync).toHaveBeenCalledWith(realPath.join(DIST, name), realPath.join(remoteDir, name));
            }
            expect(fs.copyFileSync).toHaveBeenCalledWith(
                realPath.join(DIST, 'THIRD_PARTY_NOTICES.txt'),
                realPath.join(remoteDir, 'v1', 'THIRD_PARTY_NOTICES.txt'),
            );
            expect(fs.copyFileSync).toHaveBeenCalledWith(
                realPath.join(DIST, 'styles.css'),
                realPath.join(remoteDir, 'v1', 'styles.css'),
            );

            expect(esbuild.build).toHaveBeenCalledTimes(ENTRY_NAMES.length);
            const outfiles = esbuild.build.mock.calls.map(([opts]) => realPath.basename(opts.outfile!));
            expect(outfiles).toEqual(ENTRY_NAMES.map((n) => `${n}-bundle.js`));
            expect(esbuild.build.mock.calls.map(([opts]) => opts.outfile)).toEqual(
                ENTRY_NAMES.map((name) => realPath.join(FULL, `${name}-bundle.js`)),
            );

            const appOpts = esbuild.build.mock.calls[1][0];
            expect(appOpts).toMatchObject({
                bundle: true,
                platform: 'browser',
                format: 'iife',
                minify: true,
                sourcemap: false,
                define: { 'process.env.NODE_ENV': '"production"' },
            });
            expect(appOpts.external).toEqual(expect.arrayContaining(['fs', 'node:fs', 'electron', '@capacitor/core']));
            expect(appOpts.banner!.js).toContain('__nodeModuleShims');

            // Capacitor entry must BUNDLE the Capacitor plugin packages.
            const capOpts = esbuild.build.mock.calls[3][0];
            expect(capOpts.external).not.toContain('@capacitor/core');

            // The web entry runs in a browser tab: Capacitor packages stay out.
            const webOpts = esbuild.build.mock.calls[4][0];
            expect(webOpts.external).toEqual(expect.arrayContaining(['node:fs', '@capacitor/core']));

            // Preload is a CJS node bundle with only electron external.
            const preloadOpts = esbuild.build.mock.calls[8][0];
            expect(preloadOpts).toMatchObject({
                platform: 'node',
                format: 'cjs',
                external: ['electron'],
                banner: {},
            });

            expect(logged()).toContain('Building React bundles...');
            // The Logs window's reduced preload is built the same way.
            expect(esbuild.build.mock.calls[9][0]).toMatchObject({
                entryPoints: [expect.stringMatching(/preloadLogs\.ts$/)],
                outfile: expect.stringMatching(/preloadLogs-bundle\.js$/),
                platform: 'node',
                format: 'cjs',
                external: ['electron'],
                banner: {},
            });

            expect(logged()).toContain('React build completed! (10 bundles)');
            expect(exitSpy).not.toHaveBeenCalled();
        });

        test('the full build stages the vision assets and bundles transformers', async () => {
            await run([], 'production');
            expect(mockVisionAssets.stageVisionWebAssets).toHaveBeenCalledWith(DIST);
            expect(mockVisionAssets.removeVisionWebAssets).not.toHaveBeenCalled();
            expect(esbuild.build.mock.calls[3][0].external).not.toContain('@huggingface/transformers');
        });

        test('--lite clears the vision assets and leaves transformers out of every bundle', async () => {
            await run(['--lite'], 'production');
            expect(mockVisionAssets.removeVisionWebAssets).toHaveBeenCalledWith(DIST);
            expect(mockVisionAssets.stageVisionWebAssets).not.toHaveBeenCalled();
            expect(esbuild.build.mock.calls[3][0].external).toContain('@huggingface/transformers');
            expect(esbuild.build.mock.calls[4][0].external).toContain('@huggingface/transformers');
            expect(logged()).toContain('Building lite React bundles...');
        });

        test.each([
            [undefined, 'true'],
            ['', 'true'],
            ['true', 'false'],
        ])('bakes the dirty flag into every bundle (GITHUB_ACTIONS=%p gives %s)', async (githubActions, expected) => {
            const saved = process.env.GITHUB_ACTIONS;
            if (githubActions === undefined) delete process.env.GITHUB_ACTIONS;
            else process.env.GITHUB_ACTIONS = githubActions;
            try {
                await run([], 'production');
            } finally {
                if (saved === undefined) delete process.env.GITHUB_ACTIONS;
                else process.env.GITHUB_ACTIONS = saved;
            }
            expect(esbuild.build).toHaveBeenCalledTimes(ENTRY_NAMES.length);
            expect(esbuild.build.mock.calls.map(([opts]) => opts.define!.__GS_DIRTY__)).toEqual(
                ENTRY_NAMES.map(() => expected),
            );
        });

        test('creates dist/, skips missing entries and the lexicon, defaults NODE_ENV to development', async () => {
            fs.existsSync.mockImplementation(
                (p) => p !== DIST && p !== LEXICON && p !== NOTICES && !p.endsWith('Logs.tsx'),
            );

            await run([], undefined);

            expect(fs.mkdirSync).toHaveBeenCalledWith(DIST, { recursive: true });
            expect(fs.copyFileSync).not.toHaveBeenCalledWith(LEXICON, realPath.join(DIST, 'semantic-vectors.json'));
            expect(fs.copyFileSync).not.toHaveBeenCalledWith(NOTICES, realPath.join(DIST, 'THIRD_PARTY_NOTICES.txt'));
            // The logo is a committed source file, not a generated artifact: copied whether or not the others exist.
            expect(fs.copyFileSync).toHaveBeenCalledWith(LOGO, realPath.join(DIST, 'favicon.png'));
            expect(esbuild.build).toHaveBeenCalledTimes(ENTRY_NAMES.length - 1);
            const opts = esbuild.build.mock.calls[0][0];
            expect(opts.minify).toBe(false);
            expect(opts.sourcemap).toBe(true);
            expect(opts.define!['process.env.NODE_ENV']).toBe('"development"');
            expect(logged()).toContain('Skipping logs');
            expect(logged()).toContain('(9 bundles)');
        });

        test('warns when no entry point exists', async () => {
            fs.existsSync.mockImplementation((p) => p === DIST);

            await run([], 'production');

            expect(esbuild.build).not.toHaveBeenCalled();
            expect(logged()).toContain('No React entry points found');
            expect(logged()).not.toContain('React build completed');
        });

        test('exits 1 when esbuild fails', async () => {
            const failure = new Error('boom');
            esbuild.build.mockRejectedValue(failure);

            await run([], 'production');

            expect(errorSpy).toHaveBeenCalledWith('❌ Build failed:', failure);
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });

    describe('watch mode', () => {
        const makeCtx = () => ({
            watch: jest.fn().mockResolvedValue(undefined),
            dispose: jest.fn().mockResolvedValue(undefined),
        });

        test('watches every entry and disposes all contexts on SIGINT', async () => {
            const contexts: ReturnType<typeof makeCtx>[] = [];
            esbuild.context.mockImplementation(async () => {
                const ctx = makeCtx();
                contexts.push(ctx);
                return ctx;
            });
            fs.existsSync.mockImplementation((p) => !p.endsWith('Logs.tsx'));

            await run(['--watch'], 'production');

            expect(esbuild.build).not.toHaveBeenCalled();
            expect(esbuild.context).toHaveBeenCalledTimes(ENTRY_NAMES.length - 1);
            contexts.forEach((ctx) => expect(ctx.watch).toHaveBeenCalledTimes(1));
            expect(logged()).toContain('Building React bundles (watch mode)...');
            expect(logged()).toContain('Skipping logs');
            expect(logged()).toContain('Watch mode active');

            expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
            const handler = onSpy.mock.calls.find(([evt]) => evt === 'SIGINT')![1];
            await handler();

            contexts.forEach((ctx) => expect(ctx.dispose).toHaveBeenCalledTimes(1));
            expect(logged()).toContain('Stopping watch mode');
            expect(exitSpy).toHaveBeenCalledWith(0);
        });

        test('warns and returns when no entry point exists', async () => {
            fs.existsSync.mockReturnValue(false);

            await run(['--watch'], 'production');

            expect(esbuild.context).not.toHaveBeenCalled();
            expect(logged()).toContain('No React entry points found');
            expect(onSpy).not.toHaveBeenCalledWith('SIGINT', expect.any(Function));
        });

        test('exits 1 when creating a watch context fails', async () => {
            esbuild.context.mockRejectedValue(new Error('ctx failed'));

            await run(['--watch'], 'production');

            expect(errorSpy).toHaveBeenCalledWith('❌ Build failed:', expect.any(Error));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
});
