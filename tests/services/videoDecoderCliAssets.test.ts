jest.mock('node:fs', () => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, default: fs, ...fs };
});
jest.unmock('node:path');

import crypto = require('node:crypto');
import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import os = require('node:os');
import pathModule = require('node:path');
const path = jest.mocked(pathModule);
import tar = require('tar');

const mockSea = { getAsset: jest.fn<string | Buffer, [key: string, encoding?: string]>() };
jest.mock('node:sea', () => mockSea, { virtual: true });

import { platform } from '../../src/ts/core/platform/port';
import { installTestPlatform } from '../helpers/platform';
import type * as videoDecoderCliAssetsModule from '../../src/ts/shells/cli/videoDecoderCliAssets';
const { extractVideoDecoderCliAssets } =
    require('../../src/ts/shells/cli/videoDecoderCliAssets') as typeof videoDecoderCliAssetsModule;

type DecoderAssets = {
    archive: Buffer;
    archiveDigest: string;
    manifestDigest: string;
};

const digest = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

const useUserDataDir = (directory: string): void => {
    installTestPlatform({ paths: { ...platform().paths, getUserDataDir: () => directory } });
};

const createAssets = (
    directory: string,
    binaryName?: string,
    manifestOverrides: Record<string, unknown> = {},
): DecoderAssets => {
    const source = path.join(directory, 'source');
    const executable = binaryName ?? (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const probeExecutable = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    const binary = Buffer.from('small bundled video decoder');
    const probe = Buffer.from('small bundled video probe');
    const manifest = Buffer.from(
        `${JSON.stringify({ binary: executable, binarySha256: digest(binary), probe: probeExecutable, probeSha256: digest(probe), target: `${process.platform}-${process.arch}`, ...manifestOverrides })}\n`,
    );
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, executable), binary, { mode: 0o700 });
    fs.writeFileSync(path.join(source, probeExecutable), probe, { mode: 0o700 });
    fs.writeFileSync(path.join(source, 'MANIFEST.json'), manifest);
    const archive = path.join(directory, 'decoder.tar.gz');
    tar.c({ file: archive, cwd: source, gzip: true, sync: true }, [executable, probeExecutable, 'MANIFEST.json']);
    const archiveBytes = fs.readFileSync(archive);
    return { archive: archiveBytes, archiveDigest: digest(archiveBytes), manifestDigest: digest(manifest) };
};

const installAssets = (assets: DecoderAssets): void => {
    mockSea.getAsset.mockImplementation((name) => {
        if (name === 'video-decoder.tar.gz') return assets.archive;
        if (name === 'video-decoder.sha256') return assets.archiveDigest;
        if (name === 'video-decoder.manifest.sha256') return assets.manifestDigest;
        throw new Error(`Unexpected SEA asset: ${name}`);
    });
};

describe('videoDecoderCliAssets', () => {
    let directory: string;
    let assets: DecoderAssets;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-decoder-cli-assets-'));
        assets = createAssets(directory);
        installAssets(assets);
        useUserDataDir(path.join(directory, 'userdata'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const cacheRoot = (): string =>
        path.join(directory, 'userdata', 'video-decoder', assets.archiveDigest.slice(0, 20));

    test('extracts a verified archive once without a system decoder or tar command', () => {
        const originalPath = process.env.PATH;
        process.env.PATH = path.join(directory, 'empty-path');
        try {
            const result = extractVideoDecoderCliAssets();
            expect(fs.readFileSync(result.decoderPath)).toEqual(Buffer.from('small bundled video decoder'));
            expect(extractVideoDecoderCliAssets()).toEqual(result);
            expect(fs.readFileSync(path.join(cacheRoot(), '.ready'), 'utf8')).toBe(assets.archiveDigest);
            expect(fs.statSync(path.join(directory, 'userdata', 'video-decoder')).mode & 0o777).toBe(0o700);
        } finally {
            process.env.PATH = originalPath;
        }
    });

    test('replaces a cache when its binary and writable manifest are altered together', () => {
        const first = extractVideoDecoderCliAssets();
        const binary = Buffer.from('altered decoder');
        const manifest = Buffer.from(
            `${JSON.stringify({ binary: path.basename(first.decoderPath), binarySha256: digest(binary), probe: path.basename(first.probePath), probeSha256: digest(fs.readFileSync(first.probePath)) })}\n`,
        );
        fs.writeFileSync(first.decoderPath, binary);
        fs.writeFileSync(path.join(cacheRoot(), 'MANIFEST.json'), manifest);
        expect(extractVideoDecoderCliAssets().decoderPath).toBe(first.decoderPath);
        expect(fs.readFileSync(first.decoderPath)).toEqual(Buffer.from('small bundled video decoder'));
    });

    test('replaces a cache with an altered completion marker', () => {
        const first = extractVideoDecoderCliAssets();
        fs.writeFileSync(path.join(cacheRoot(), '.ready'), 'wrong archive');
        expect(extractVideoDecoderCliAssets()).toEqual(first);
        expect(fs.readFileSync(path.join(cacheRoot(), '.ready'), 'utf8')).toBe(assets.archiveDigest);
    });

    test('rejects an embedded manifest with an unexpected decoder filename', () => {
        assets = createAssets(directory, 'unexpected-decoder');
        installAssets(assets);
        expect(() => extractVideoDecoderCliAssets()).toThrow('executable name is invalid');
    });

    test('rejects an embedded manifest without a decoder checksum', () => {
        assets = createAssets(directory, undefined, { binarySha256: null });
        installAssets(assets);
        expect(() => extractVideoDecoderCliAssets()).toThrow('manifest is invalid');
    });

    test('rejects an embedded manifest whose decoder checksum is corrupt', () => {
        assets = createAssets(directory, undefined, { binarySha256: '0'.repeat(64) });
        installAssets(assets);
        expect(() => extractVideoDecoderCliAssets()).toThrow('decoder checksum mismatch');
    });

    test('rejects an embedded manifest whose probe checksum is corrupt', () => {
        assets = createAssets(directory, undefined, { probeSha256: '0'.repeat(64) });
        installAssets(assets);
        expect(() => extractVideoDecoderCliAssets()).toThrow('probe checksum mismatch');
    });

    test('replaces a cache root that is not a directory', () => {
        fs.mkdirSync(path.dirname(cacheRoot()), { recursive: true });
        fs.writeFileSync(cacheRoot(), 'not a cache directory');
        expect(extractVideoDecoderCliAssets().decoderPath).toMatch(/ffmpeg(?:\.exe)?$/);
        expect(fs.statSync(cacheRoot()).isDirectory()).toBe(true);
    });

    test('replaces a cached decoder symlink instead of following it', () => {
        const first = extractVideoDecoderCliAssets();
        const target = path.join(directory, 'outside-decoder');
        fs.writeFileSync(target, 'outside');
        fs.rmSync(first.decoderPath);
        fs.symlinkSync(target, first.decoderPath);
        expect(extractVideoDecoderCliAssets().decoderPath).toBe(first.decoderPath);
        expect(fs.readFileSync(first.decoderPath)).toEqual(Buffer.from('small bundled video decoder'));
    });

    test('refuses a tampered embedded archive and removes temporary files', () => {
        mockSea.getAsset.mockImplementation((name) => {
            if (name === 'video-decoder.tar.gz') return assets.archive;
            if (name === 'video-decoder.sha256') return '0'.repeat(64);
            return assets.manifestDigest;
        });
        expect(() => extractVideoDecoderCliAssets()).toThrow('Embedded video decoder archive checksum mismatch');
        expect(fs.readdirSync(path.join(directory, 'userdata', 'video-decoder'))).toEqual([]);
    });

    test('uses a complete concurrent cache after a rename race', () => {
        const rename = fs.renameSync;
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            rename(from, to);
            throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        });
        expect(extractVideoDecoderCliAssets().decoderPath).toMatch(/ffmpeg(?:\.exe)?$/);
    });

    test('surfaces a failed cache race and removes its temporary extraction', () => {
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw new Error('cache race failed');
        });
        expect(() => extractVideoDecoderCliAssets()).toThrow('cache race failed');
        expect(fs.readdirSync(path.join(directory, 'userdata', 'video-decoder'))).toEqual([]);
    });

    test('keeps an operational cache read failure visible', () => {
        extractVideoDecoderCliAssets();
        jest.spyOn(fs, 'openSync').mockImplementation(() => {
            throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
        });
        expect(() => extractVideoDecoderCliAssets()).toThrow('EMFILE');
        expect(fs.existsSync(cacheRoot())).toBe(true);
    });

    test('uses the Windows filename and does not apply POSIX modes', () => {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            assets = createAssets(directory);
            installAssets(assets);
            const chmod = jest.spyOn(fs, 'chmodSync');
            expect(extractVideoDecoderCliAssets().decoderPath).toMatch(/ffmpeg\.exe$/);
            expect(chmod).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process, 'platform', descriptor);
        }
    });
});
