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
import childProcess = require('node:child_process');

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

    test('a vision directory an older CLI left world-readable is restricted to the owner', () => {
        mockSea.getAsset.mockImplementation(assets);
        const vision = path.join(directory, 'userdata', 'vision');
        fs.mkdirSync(vision, { recursive: true, mode: 0o755 });
        fs.chmodSync(vision, 0o755);
        extractVisionCliAssets();
        expect(fs.statSync(vision).mode & 0o777).toBe(0o700);
    });

    test('on Windows the directory mode is left alone', () => {
        mockSea.getAsset.mockImplementation(assets);
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const chmod = jest.spyOn(fs, 'chmodSync');
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            extractVisionCliAssets();
        } finally {
            Object.defineProperty(process, 'platform', platform);
        }
        expect(chmod).not.toHaveBeenCalled();
    });

    test('a copy whose node_modules became a file is refused and removed', () => {
        mockSea.getAsset.mockImplementation(assets);
        const { root } = extractVisionCliAssets();
        fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(root, 'node_modules'), 'not a directory');
        expect(() => extractVisionCliAssets()).toThrow('Vision runtime failed its integrity check');
        expect(staging()).toEqual([]);
    });

    test('a hashing error that is not a missing file (too many open files) is rethrown and the copy is kept', () => {
        mockSea.getAsset.mockImplementation(assets);
        const { root } = extractVisionCliAssets();
        const open = fs.openSync;
        jest.spyOn(fs, 'openSync').mockImplementation(((file: fsModule.PathLike, ...rest: never[]) => {
            if (String(file).endsWith('index.js')) throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
            return (open as (...args: unknown[]) => unknown)(file, ...rest);
        }) as typeof fs.openSync);
        expect(() => extractVisionCliAssets()).toThrow('EMFILE');
        jest.restoreAllMocks();
        expect(fs.existsSync(path.join(root, 'node_modules', 'example', 'index.js'))).toBe(true);
        expect(extractVisionCliAssets().root).toBe(root);
    });

    test.each([
        ['a string', 'unreadable'],
        ['an error with no code', new Error('odd')],
    ])('a hashing failure that is %s carries no missing-file code: it is rethrown, the copy kept', (_label, thrown) => {
        mockSea.getAsset.mockImplementation(assets);
        const { root } = extractVisionCliAssets();
        jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
            throw thrown;
        });
        expect(() => extractVisionCliAssets()).toThrow();
        jest.restoreAllMocks();
        expect(fs.existsSync(root)).toBe(true);
    });

    test('a file swapped for a symlink after the listing is refused, and the copy is kept', () => {
        mockSea.getAsset.mockImplementation(assets);
        const { root } = extractVisionCliAssets();
        const file = path.join(root, 'node_modules', 'example', 'index.js');
        const target = path.join(root, 'node_modules', 'example', 'other.js');
        fs.writeFileSync(target, 'module.exports = 1');
        const list = fs.readdirSync;
        let swapped = false;
        jest.spyOn(fs, 'readdirSync').mockImplementation(((dir: fsModule.PathLike, ...rest: never[]) => {
            const entries = (list as (...args: unknown[]) => unknown)(dir, ...rest);
            if (String(dir).endsWith('example') && !swapped) {
                swapped = true;
                fs.rmSync(file);
                fs.symlinkSync(target, file);
            }
            return entries;
        }) as typeof fs.readdirSync);
        expect(() => extractVisionCliAssets()).toThrow(/ELOOP/);
        jest.restoreAllMocks();
        expect(fs.existsSync(root)).toBe(true);
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

// scripts/build-cli.ts archives the runtime with the system tar (bsdtar on macOS, GNU tar on Linux), and the binary
// re-hashes what node-tar extracts from it, so the archive must come from that tool.
const systemTar = childProcess.spawnSync('tar', ['--version']);
(systemTar.status === 0 ? describe : describe.skip)(
    'an archive made by the system tar, as the CLI build makes it',
    () => {
        let directory: string;
        beforeEach(() => {
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-system-tar-'));
        });
        afterEach(() => {
            jest.restoreAllMocks();
            fs.rmSync(directory, { recursive: true, force: true });
        });

        test('extracts to the digest the build embedded, symlinks and hardlinks included', () => {
            const source = path.join(directory, 'source');
            const pkg = path.join(source, 'node_modules', '.pnpm', 'example@1.0.0', 'node_modules', 'example');
            fs.mkdirSync(pkg, { recursive: true });
            fs.mkdirSync(path.join(source, 'vision-model'), { recursive: true });
            fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = 1');
            fs.writeFileSync(path.join(pkg, 'addon.node'), 'native');
            fs.linkSync(path.join(pkg, 'addon.node'), path.join(pkg, 'addon-copy.node'));
            fs.symlinkSync('.pnpm/example@1.0.0/node_modules/example', path.join(source, 'node_modules', 'example'));
            fs.writeFileSync(path.join(source, 'vision-model', 'config.json'), '{}');
            const archive = path.join(directory, 'runtime.tar.gz');
            childProcess.execFileSync('tar', ['-czf', archive, '-C', source, 'node_modules', 'vision-model'], {
                env: { ...process.env, COPYFILE_DISABLE: '1' },
            });
            const bytes = fs.readFileSync(archive);
            const digest = crypto.createHash('sha256').update(bytes).digest('hex');
            const codeDigest = digestVisionRuntime(source);
            runtime.getUserDataDir.mockReturnValue(path.join(directory, 'userdata'));
            mockSea.getAsset.mockImplementation((name) =>
                name === 'vision-runtime.code.sha256' ? codeDigest : name.endsWith('.sha256') ? digest : bytes,
            );

            const { root } = extractVisionCliAssets();

            expect(digestVisionRuntime(root)).toBe(codeDigest);
            expect(fs.readlinkSync(path.join(root, 'node_modules', 'example'))).toBe(
                '.pnpm/example@1.0.0/node_modules/example',
            );
            expect(fs.readFileSync(path.join(root, 'node_modules', 'example', 'addon-copy.node'), 'utf8')).toBe(
                'native',
            );
        });
    },
);
