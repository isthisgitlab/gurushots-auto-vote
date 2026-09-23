/**
 * Unit tests for scripts/build-react.js.
 *
 * The script runs buildReact() at require time (it is only ever invoked as
 * `node scripts/build-react.js [--watch]`), so each case stubs argv/env/exit,
 * requires it in an isolated module registry and flushes the async build.
 * esbuild and fs are fully mocked — no real bundle is built or watched and
 * nothing under dist/ is touched.
 */

const realPath = jest.requireActual('path');

jest.mock('path', () => jest.requireActual('path'));
// Shared instances (not per-registry factories) so the copies the script
// requires inside jest.isolateModules are the same objects asserted here.
const mockEsbuild = { build: jest.fn(), context: jest.fn() };
const mockFs = {
    existsSync: jest.fn(),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
    copyFileSync: jest.fn(),
};
jest.mock('esbuild', () => mockEsbuild);
jest.mock('fs', () => mockFs);

const esbuild = mockEsbuild;
const fs = mockFs;

const ROOT = realPath.join(__dirname, '..', '..');
const DIST = realPath.join(ROOT, 'dist');
const LEXICON = realPath.join(ROOT, 'src', 'assets', 'semantic-vectors.json');
const ENTRY_NAMES = ['login', 'app', 'logs', 'capacitor', 'headless', 'preload'];

const flush = async () => {
    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

describe('scripts/build-react.js', () => {
    const originalArgv = process.argv;
    const originalEnv = process.env.NODE_ENV;
    let logSpy;
    let errorSpy;
    let exitSpy;
    let onSpy;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
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

    const run = async (args = [], nodeEnv) => {
        process.argv = ['node', 'scripts/build-react.js', ...args];
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        jest.isolateModules(() => {
            require('../../scripts/build-react.js');
        });
        await flush();
    };

    const logged = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

    describe('build mode', () => {
        test('writes the HTML shells, copies the lexicon and builds every entry', async () => {
            await run([], 'production');

            expect(fs.mkdirSync).not.toHaveBeenCalled();
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                realPath.join(DIST, 'index.html'),
                expect.stringContaining('capacitor-bundle.js'),
            );
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                realPath.join(DIST, 'headless.html'),
                expect.stringContaining('window.__GS_HEADLESS__ = true'),
            );
            expect(fs.copyFileSync).toHaveBeenCalledWith(LEXICON, realPath.join(DIST, 'semantic-vectors.json'));

            expect(esbuild.build).toHaveBeenCalledTimes(ENTRY_NAMES.length);
            const outfiles = esbuild.build.mock.calls.map(([opts]) => realPath.basename(opts.outfile));
            expect(outfiles).toEqual(ENTRY_NAMES.map((n) => `${n}-bundle.js`));

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
            expect(appOpts.banner.js).toContain('__nodeModuleShims');

            // Capacitor entry must BUNDLE the Capacitor plugin packages.
            const capOpts = esbuild.build.mock.calls[3][0];
            expect(capOpts.external).not.toContain('@capacitor/core');

            // Preload is a CJS node bundle with only electron external.
            const preloadOpts = esbuild.build.mock.calls[5][0];
            expect(preloadOpts).toMatchObject({
                platform: 'node',
                format: 'cjs',
                external: ['electron'],
                banner: {},
            });

            expect(logged()).toContain('Building React bundles...');
            expect(logged()).toContain('React build completed! (6 bundles)');
            expect(exitSpy).not.toHaveBeenCalled();
        });

        test('creates dist/, skips missing entries and the lexicon, defaults NODE_ENV to development', async () => {
            fs.existsSync.mockImplementation((p) => p !== DIST && p !== LEXICON && !p.endsWith('Logs.jsx'));

            await run([], undefined);

            expect(fs.mkdirSync).toHaveBeenCalledWith(DIST, { recursive: true });
            expect(fs.copyFileSync).not.toHaveBeenCalled();
            expect(esbuild.build).toHaveBeenCalledTimes(ENTRY_NAMES.length - 1);
            const opts = esbuild.build.mock.calls[0][0];
            expect(opts.minify).toBe(false);
            expect(opts.sourcemap).toBe(true);
            expect(opts.define['process.env.NODE_ENV']).toBe('"development"');
            expect(logged()).toContain('Skipping logs');
            expect(logged()).toContain('(5 bundles)');
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
        const makeCtx = () => ({ watch: jest.fn().mockResolvedValue(), dispose: jest.fn().mockResolvedValue() });

        test('watches every entry and disposes all contexts on SIGINT', async () => {
            const contexts = [];
            esbuild.context.mockImplementation(async () => {
                const ctx = makeCtx();
                contexts.push(ctx);
                return ctx;
            });
            fs.existsSync.mockImplementation((p) => !p.endsWith('Logs.jsx'));

            await run(['--watch'], 'production');

            expect(esbuild.build).not.toHaveBeenCalled();
            expect(esbuild.context).toHaveBeenCalledTimes(ENTRY_NAMES.length - 1);
            contexts.forEach((ctx) => expect(ctx.watch).toHaveBeenCalledTimes(1));
            expect(logged()).toContain('Building React bundles (watch mode)...');
            expect(logged()).toContain('Skipping logs');
            expect(logged()).toContain('Watch mode active');

            expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
            const handler = onSpy.mock.calls.find(([evt]) => evt === 'SIGINT')[1];
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
