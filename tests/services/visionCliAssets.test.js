jest.unmock('node:fs');
jest.unmock('node:path');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const tar = require('tar');

const mockSea = { getAsset: jest.fn() };
jest.mock('node:sea', () => mockSea, { virtual: true });
jest.mock('../../src/js/runtime', () => ({ getUserDataDir: jest.fn() }));

const runtime = require('../../src/js/runtime');
const { extractVisionCliAssets } = require('../../src/js/services/visionCliAssets');

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
        runtime.getUserDataDir.mockReturnValue(path.join(directory, 'userdata'));
        mockSea.getAsset.mockImplementation((name) => (name.endsWith('.sha256') ? digest : bytes));
        process.env.PATH = path.join(directory, 'empty-path');

        const result = extractVisionCliAssets();
        expect(fs.readFileSync(path.join(result.root, 'vision-model', 'config.json'), 'utf8')).toBe('{}');
        expect(fs.readFileSync(path.join(result.root, 'node_modules', 'example', 'index.js'), 'utf8')).toBe(
            'module.exports = 1',
        );
        expect(extractVisionCliAssets()).toEqual(result);
    } finally {
        process.env.PATH = originalPath;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('extraction failure paths', () => {
    let directory;
    let bytes;
    let digest;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-cli-assets-'));
        const source = path.join(directory, 'source');
        fs.mkdirSync(path.join(source, 'vision-model'), { recursive: true });
        fs.writeFileSync(path.join(source, 'vision-model', 'config.json'), '{}');
        const archive = path.join(directory, 'runtime.tar.gz');
        tar.c({ file: archive, cwd: source, gzip: true, sync: true }, ['vision-model']);
        bytes = fs.readFileSync(archive);
        digest = crypto.createHash('sha256').update(bytes).digest('hex');
        runtime.getUserDataDir.mockReturnValue(path.join(directory, 'userdata'));
    });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const staging = () => fs.readdirSync(path.join(directory, 'userdata', 'vision'));

    test('a new version removes finished older copies, but not recently used or unfinished ones', () => {
        mockSea.getAsset.mockImplementation((name) => (name.endsWith('.sha256') ? digest : bytes));
        const vision = path.join(directory, 'userdata', 'vision');
        const finished = (name, ageMs) => {
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
        mockSea.getAsset.mockImplementation((name) => (name.endsWith('.sha256') ? digest : bytes));
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
        mockSea.getAsset.mockImplementation((name) => (name.endsWith('.sha256') ? digest : bytes));
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
        mockSea.getAsset.mockImplementation((name) => (name.endsWith('.sha256') ? digest : bytes));
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw new Error('EACCES');
        });
        expect(() => extractVisionCliAssets()).toThrow('EACCES');
        expect(staging()).toEqual([]);
    });
});
