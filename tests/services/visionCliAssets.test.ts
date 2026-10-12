// The real fs, as a marked partial mock: the rename-failure cases spy on it, and
// visionCliAssets.ts must see that spy through its namespace import. `default`
// keeps packages that default-import fs (tar) on the real module.
jest.mock('node:fs', () => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, default: fs, ...fs };
});
jest.unmock('node:path');

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import os = require('node:os');
import pathModule = require('node:path');
const path = jest.mocked(pathModule);
import crypto = require('node:crypto');
import tar = require('tar');

const mockSea = { getAsset: jest.fn<string | Buffer, [key: string, encoding?: string]>() };
jest.mock('node:sea', () => mockSea, { virtual: true });
jest.mock('../../src/ts/runtime', () => ({ getUserDataDir: jest.fn() }));

import runtimeModule = require('../../src/ts/runtime');
const runtime = jest.mocked(runtimeModule);
import type * as visionCliAssetsModule from '../../src/ts/services/visionCliAssets';
const { extractVisionCliAssets, digestVisionRuntime } =
    require('../../src/ts/services/visionCliAssets') as typeof visionCliAssetsModule;

test('first extraction uses only bundled JavaScript with no system tar', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-cli-assets-'));
    const originalPath = process.env.PATH;
    try {
        const source = path.join(directory, 'source');
        fs.mkdirSync(path.join(source, 'node_modules', '.pnpm', 'example'), { recursive: true });
        fs.mkdirSync(path.join(source, 'vision-model'), { recursive: true });
        fs.writeFileSync(path.join(source, 'node_modules', '.pnpm', 'example', 'index.js'), 'module.exports = 1');
        fs.symlinkSync('.pnpm/example', path.join(source, 'node_modules', 'example'));
        fs.writeFileSync(path.join(source, 'vision-model', 'config.json'), '{}');
        const archive = path.join(directory, 'runtime.tar.gz');
        tar.c({ file: archive, cwd: source, gzip: true, sync: true }, ['node_modules', 'vision-model']);
        const bytes = fs.readFileSync(archive);
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        const codeDigest = digestVisionRuntime(source);
        runtime.getUserDataDir.mockReturnValue(path.join(directory, 'userdata'));
        mockSea.getAsset.mockImplementation((name) =>
            name === 'vision-runtime.code.sha256' ? codeDigest : name.endsWith('.sha256') ? digest : bytes,
        );
        process.env.PATH = path.join(directory, 'empty-path');

        const result = extractVisionCliAssets();
        expect(fs.readFileSync(path.join(result.root, 'vision-model', 'config.json'), 'utf8')).toBe('{}');
        expect(fs.readFileSync(path.join(result.root, 'node_modules', 'example', 'index.js'), 'utf8')).toBe(
            'module.exports = 1',
        );
        expect(extractVisionCliAssets()).toEqual(result);
        expect(fs.statSync(path.join(directory, 'userdata', 'vision')).mode & 0o777).toBe(0o700);
    } finally {
        process.env.PATH = originalPath;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('extraction failure paths', () => {
    let directory: string;
    let bytes: Buffer;
    let digest: string;
    let codeDigest: string;
    const assets = (name: string) =>
        name === 'vision-runtime.code.sha256' ? codeDigest : name.endsWith('.sha256') ? digest : bytes;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-cli-assets-'));
        const source = path.join(directory, 'source');
        fs.mkdirSync(path.join(source, 'vision-model'), { recursive: true });
        fs.mkdirSync(path.join(source, 'node_modules', 'example'), { recursive: true });
        fs.writeFileSync(path.join(source, 'vision-model', 'config.json'), '{}');
        fs.writeFileSync(path.join(source, 'node_modules', 'example', 'index.js'), 'module.exports = 1');
        const archive = path.join(directory, 'runtime.tar.gz');
        tar.c({ file: archive, cwd: source, gzip: true, sync: true }, ['node_modules', 'vision-model']);
        bytes = fs.readFileSync(archive);
        digest = crypto.createHash('sha256').update(bytes).digest('hex');
        codeDigest = digestVisionRuntime(source);
        runtime.getUserDataDir.mockReturnValue(path.join(directory, 'userdata'));
    });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const staging = () => fs.readdirSync(path.join(directory, 'userdata', 'vision'));

    test('a new version removes finished older copies, but not recently used or unfinished ones', () => {
        mockSea.getAsset.mockImplementation(assets);
        const vision = path.join(directory, 'userdata', 'vision');
        const finished = (name: string, ageMs: number) => {
            fs.mkdirSync(path.join(vision, name), { recursive: true });
            const marker = path.join(vision, name, '.ready');
            fs.writeFileSync(marker, name);
            const at = new Date(Date.now() - ageMs);
            fs.utimesSync(marker, at, at);
        };
        finished('old-version', 2 * 60 * 60 * 1000);
        finished('running-version', 5 * 60 * 1000);
        fs.mkdirSync(path.join(vision, 'other-version.4242'), { recursive: true });

        const result = extractVisionCliAssets();
        expect(staging().sort()).toEqual([path.basename(result.root), 'other-version.4242', 'running-version'].sort());
    });

    test('every call marks the copy in use', () => {
        mockSea.getAsset.mockImplementation(assets);
        const { root } = extractVisionCliAssets();
        const marker = path.join(root, '.ready');
        const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
        fs.utimesSync(marker, past, past);
        extractVisionCliAssets();
        expect(Date.now() - fs.statSync(marker).mtimeMs).toBeLessThan(60 * 1000);
    });

    test('a tampered embedded archive is refused and leaves no staging files', () => {
        mockSea.getAsset.mockImplementation((name) => (name.endsWith('.sha256') ? '0'.repeat(64) : bytes));
        expect(() => extractVisionCliAssets()).toThrow('Embedded vision runtime checksum mismatch');
        expect(staging()).toEqual([]);
    });

    test('a concurrent process that finished first wins the rename race', () => {
        mockSea.getAsset.mockImplementation(assets);
        const rename = fs.renameSync;
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            rename(from, to);
            throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' });
        });
        const result = extractVisionCliAssets();
        expect(fs.readFileSync(path.join(result.root, '.ready'), 'utf8')).toBe(digest);
        expect(staging()).toEqual([path.basename(result.root)]);
    });

    test('a rename failure with no finished copy is reported', () => {
        mockSea.getAsset.mockImplementation(assets);
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw new Error('EACCES');
        });
        expect(() => extractVisionCliAssets()).toThrow('EACCES');
        expect(staging()).toEqual([]);
    });

    test('a copy edited after extraction is refused and removed, then extracted again clean', () => {
        mockSea.getAsset.mockImplementation(assets);
        const { root } = extractVisionCliAssets();
        fs.writeFileSync(path.join(root, 'node_modules', 'example', 'index.js'), 'process.exit(1)');
        expect(() => extractVisionCliAssets()).toThrow('Vision runtime failed its integrity check');
        expect(staging()).toEqual([]);
        const again = extractVisionCliAssets();
        expect(fs.readFileSync(path.join(again.root, 'node_modules', 'example', 'index.js'), 'utf8')).toBe(
            'module.exports = 1',
        );
    });

    test('a copy missing its node_modules is refused and removed', () => {
        mockSea.getAsset.mockImplementation(assets);
        const { root } = extractVisionCliAssets();
        fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
        expect(() => extractVisionCliAssets()).toThrow('Vision runtime failed its integrity check');
        expect(staging()).toEqual([]);
    });

    test('a digest stored beside the extracted files is never consulted', () => {
        mockSea.getAsset.mockImplementation(assets);
        const { root } = extractVisionCliAssets();
        fs.writeFileSync(path.join(root, 'node_modules', 'example', 'index.js'), 'process.exit(1)');
        fs.writeFileSync(path.join(root, 'vision-runtime.code.sha256'), digestVisionRuntime(root));
        expect(() => extractVisionCliAssets()).toThrow('Vision runtime failed its integrity check');
    });
});

describe('digestVisionRuntime', () => {
    let directory: string;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-digest-'));
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    const tree = (root: string, files: Array<[string, string]>, link?: string) => {
        for (const [name, content] of files) {
            fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
            fs.writeFileSync(path.join(root, name), content);
        }
        if (link) fs.symlinkSync(link, path.join(root, 'node_modules', 'link'));
    };

    test('does not depend on the order files were written, or on anything outside node_modules', () => {
        tree(path.join(directory, 'a'), [
            ['node_modules/x/a.node', '1'],
            ['node_modules/x/b.js', '2'],
        ]);
        tree(path.join(directory, 'b'), [
            ['vision-model/model.onnx', 'model weights'],
            ['node_modules/x/b.js', '2'],
            ['node_modules/x/a.node', '1'],
        ]);
        expect(digestVisionRuntime(path.join(directory, 'a'))).toBe(digestVisionRuntime(path.join(directory, 'b')));
    });

    test.each([
        ['a file changes', [['node_modules/x/a.node', '9']] as Array<[string, string]>, undefined],
        ['a file is renamed', [['node_modules/x/c.node', '1']] as Array<[string, string]>, undefined],
        ['a symlink is added', [['node_modules/x/a.node', '1']] as Array<[string, string]>, 'x/a.node'],
    ])('changes when %s', (_label, files, link) => {
        const base = path.join(directory, 'base');
        tree(base, [['node_modules/x/a.node', '1']]);
        const changed = path.join(directory, 'changed');
        tree(changed, files, link);
        expect(digestVisionRuntime(changed)).not.toBe(digestVisionRuntime(base));
    });

    test('changes when a symlink points elsewhere', () => {
        const one = path.join(directory, 'one');
        const two = path.join(directory, 'two');
        tree(one, [['node_modules/x/a.node', '1']], 'x/a.node');
        tree(two, [['node_modules/x/a.node', '1']], 'x');
        expect(digestVisionRuntime(one)).not.toBe(digestVisionRuntime(two));
    });
});
