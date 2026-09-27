/**
 * Tests for scripts/build-main.ts — the Electron main-process bundle. esbuild
 * is mocked, so nothing is written to dist/.
 */

// tests/setup.js globally mocks path; the depth check needs the real module.
jest.unmock('path');
jest.unmock('node:path');

const mockWatch = jest.fn(() => Promise.resolve());
jest.mock('esbuild', () => ({
    build: jest.fn(() => Promise.resolve()),
    context: jest.fn(() => Promise.resolve({ watch: mockWatch })),
}));

const path = require('node:path');
const { build, context } = require('esbuild');
const fs = require('node:fs');
const { OPTIONS, LOADER, LOADER_SOURCE, main } = require('../../scripts/build-main');
const { main: packageMain } = require('../../package.json');

const ROOT = path.join(__dirname, '..', '..');

beforeEach(() => jest.clearAllMocks());

test('bundles src/js/index.ts next to the loader package.json `main` points at', () => {
    expect(OPTIONS.entryPoints).toEqual([path.join(ROOT, 'src', 'js', 'index.ts')]);
    expect(path.relative(ROOT, LOADER)).toBe(path.normalize(packageMain));
    expect(path.dirname(OPTIONS.outfile)).toBe(path.dirname(LOADER));
});

test('emits the bundle at the same depth below the app root as src/js (appPaths relies on it)', () => {
    const depth = (dir) => path.relative(ROOT, dir).split(path.sep).length;
    expect(depth(path.dirname(OPTIONS.outfile))).toBe(depth(path.join(ROOT, 'src', 'js')));
});

test('keeps every package import a runtime require', () => {
    expect(OPTIONS).toMatchObject({ bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
});

test("stays out of dist/, Capacitor's webDir that ships in the APK", () => {
    const { webDir } = require('../../capacitor.config.json');
    expect(path.relative(path.join(ROOT, webDir), OPTIONS.outfile).startsWith('..')).toBe(true);
});

test('maps stack traces back to src/js: the loader enables source maps, then requires the bundle', () => {
    expect(OPTIONS.sourcemap).toBe('linked');
    expect(LOADER_SOURCE).toBe(
        `process.setSourceMapsEnabled(true);\nrequire('./${path.basename(OPTIONS.outfile)}');\n`,
    );
});

test('builds once by default, writing the loader first', async () => {
    await main([]);
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(LOADER), { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(LOADER, LOADER_SOURCE);
    expect(build).toHaveBeenCalledWith(OPTIONS);
    expect(context).not.toHaveBeenCalled();
});

test('--watch rebuilds on change instead', async () => {
    await main(['--watch']);
    expect(context).toHaveBeenCalledWith(OPTIONS);
    expect(mockWatch).toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
});

test('reads its flags from the command line by default', async () => {
    const argv = process.argv;
    process.argv = ['node', 'build-main.ts'];
    try {
        await main();
    } finally {
        process.argv = argv;
    }
    expect(build).toHaveBeenCalledWith(OPTIONS);
});
