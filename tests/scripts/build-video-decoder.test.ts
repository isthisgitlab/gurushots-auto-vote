jest.unmock('node:path');

import type * as cryptoModule from 'node:crypto';
import type * as fsModule from 'node:fs';
import { invalid } from '../helpers/invalid';

const PINNED_DIGEST = '0a943b4fbd4d7e5c8513733e15668d1ff5671fb8d34fcd0ed0f89751349eae8b';
const files = new Map<string, Buffer>();
const directories = new Set<string>();
const mockExecFileSync = jest.fn<void, [string, string[], object]>();
const mockCreateHash = jest.fn<ReturnType<typeof cryptoModule.createHash>, [string]>();
const mockFs = {
    chmodSync: jest.fn(),
    copyFileSync: jest.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
        files.set(String(to), Buffer.from(files.get(String(from)) ?? ''));
    }),
    cpSync: jest.fn(),
    existsSync: jest.fn((file: fsModule.PathLike) => files.has(String(file)) || directories.has(String(file))),
    mkdirSync: jest.fn((directory: fsModule.PathLike) => directories.add(String(directory))),
    mkdtempSync: jest.fn(() => '/tmp/decoder-build'),
    readFileSync: jest.fn((file: fsModule.PathOrFileDescriptor) => {
        const data = files.get(String(file));
        if (data === undefined) throw Object.assign(new Error(`ENOENT: ${String(file)}`), { code: 'ENOENT' });
        return data;
    }),
    renameSync: jest.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
        const data = files.get(String(from));
        if (data === undefined) throw Object.assign(new Error(`ENOENT: ${String(from)}`), { code: 'ENOENT' });
        files.delete(String(from));
        files.set(String(to), data);
    }),
    rmSync: jest.fn((file: fsModule.PathLike) => {
        files.delete(String(file));
        directories.delete(String(file));
    }),
    writeFileSync: jest.fn((file: fsModule.PathOrFileDescriptor, data: string | Uint8Array) => {
        files.set(String(file), Buffer.from(data));
    }),
};

jest.mock('node:fs', () => ({ __esModule: true, default: mockFs, ...mockFs }));
jest.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));
jest.mock('node:os', () => ({ cpus: () => [{}, {}], tmpdir: () => '/tmp' }));
jest.mock('node:crypto', () => ({ createHash: mockCreateHash }));

import path = require('node:path');
import type * as videoDecoderModule from '../../scripts/build-video-decoder';
const decoder = require('../../scripts/build-video-decoder') as typeof videoDecoderModule;

const setHash = (): void => {
    mockCreateHash.mockImplementation(() => {
        const chunks: Buffer[] = [];
        const hash = {
            update: (data: string | Buffer) => {
                chunks.push(Buffer.from(data));
                return hash;
            },
            digest: () => (Buffer.concat(chunks).equals(Buffer.from('archive')) ? PINNED_DIGEST : 'bad-digest'),
        };
        return invalid<ReturnType<typeof cryptoModule.createHash>>(hash);
    });
};

describe('build-video-decoder', () => {
    beforeEach(() => {
        files.clear();
        directories.clear();
        jest.clearAllMocks();
        setHash();
        global.fetch = jest.fn();
    });

    afterEach(() => jest.restoreAllMocks());

    const primeCompiler = (): void => {
        const source = '/tmp/decoder-build/ffmpeg';
        files.set(decoder.SOURCE_ARCHIVE, Buffer.from('archive'));
        files.set(
            path.join(source, 'libavutil', 'encryption_info.c'),
            Buffer.from('void av_encryption_init_info_free while (info)'),
        );
        files.set(path.join(source, 'libavformat', 'mov.c'), Buffer.from('av_encryption_init_info_append_side_data'));
        files.set(path.join(source, 'COPYING.LGPLv2.1'), Buffer.from('LGPL'));
        files.set(path.join(source, decoder.DECODER_NAME), Buffer.from('decoder'));
    };

    test('uses a verified cached source without fetching', async () => {
        files.set(decoder.SOURCE_ARCHIVE, Buffer.from('archive'));
        await expect(decoder.ensureSourceArchive()).resolves.toBe(decoder.SOURCE_ARCHIVE);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('downloads, verifies, and atomically caches a missing source', async () => {
        jest.mocked(global.fetch).mockResolvedValue(new Response(Buffer.from('archive')));
        await expect(decoder.ensureSourceArchive()).resolves.toBe(decoder.SOURCE_ARCHIVE);
        expect(global.fetch).toHaveBeenCalledWith(decoder.FFMPEG_ARCHIVE_URL, { redirect: 'error' });
        expect(files.get(decoder.SOURCE_ARCHIVE)).toEqual(Buffer.from('archive'));
    });

    test('rejects a non-success or checksum-mismatched download', async () => {
        jest.mocked(global.fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
        await expect(decoder.downloadSourceArchive()).rejects.toThrow('HTTP 503');
        jest.mocked(global.fetch).mockResolvedValueOnce(new Response(Buffer.from('other')));
        await expect(decoder.ensureSourceArchive()).rejects.toThrow('Downloaded FFmpeg source checksum');
    });

    test('rejects a cached archive with the wrong digest', () => {
        files.set('/bad.tar.gz', Buffer.from('other'));
        expect(() => decoder.assertArchive('/bad.tar.gz')).toThrow(decoder.FFMPEG_REVISION);
    });

    test('refuses source that lacks a required upstream encryption fix', () => {
        primeCompiler();
        files.set(path.join('/tmp/decoder-build/ffmpeg', 'libavutil', 'encryption_info.c'), Buffer.from('missing fix'));
        expect(() => decoder.buildDecoder('/verified.tar.gz')).toThrow('lacks the required encryption metadata fixes');
    });

    test('uses only the native LGPL decoder configuration and refuses cross-target staging', async () => {
        expect(decoder.buildConfigureArgs()).toEqual(
            expect.arrayContaining(['--disable-gpl', '--disable-x86asm', '--enable-decoder=h264']),
        );
        expect(decoder.buildEnvironment().MACOSX_DEPLOYMENT_TARGET).toBe(
            process.platform === 'darwin' ? '11.0' : undefined,
        );
        const otherTarget = process.platform === 'darwin' ? 'linux-x64' : 'darwin-arm64';
        await expect(decoder.stageElectronVideoDecoder(otherTarget)).rejects.toThrow(otherTarget);
        expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    test('runs the compiler boundary and writes the decoder manifest from mocked source files', () => {
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        expect(mockExecFileSync).toHaveBeenCalledWith('tar', ['-xzf', '/verified.tar.gz', '-C', '/tmp/decoder-build'], {
            stdio: 'inherit',
        });
        expect(files.get(path.join(decoder.OUTPUT_DIR, decoder.DECODER_NAME))).toEqual(Buffer.from('decoder'));
        expect(files.get(path.join(decoder.OUTPUT_DIR, 'MANIFEST.json'))?.toString()).toContain(
            decoder.FFMPEG_REVISION,
        );
    });

    test('fails when the compiler does not produce the decoder executable', () => {
        primeCompiler();
        files.delete(path.join('/tmp/decoder-build/ffmpeg', decoder.DECODER_NAME));
        expect(() => decoder.buildDecoder('/verified.tar.gz')).toThrow('did not produce the decoder executable');
    });

    test('uses the Windows compiler path and static linker configuration', () => {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            primeCompiler();
            decoder.buildDecoder('/verified.tar.gz');
            expect(mockExecFileSync).toHaveBeenCalledWith(
                'bash',
                expect.arrayContaining([
                    '/tmp/decoder-build/ffmpeg/configure',
                    '--disable-x86asm',
                    '--extra-ldflags=-static',
                ]),
                expect.objectContaining({ cwd: '/tmp/decoder-build/ffmpeg' }),
            );
            expect(mockFs.chmodSync).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process, 'platform', descriptor);
        }
    });

    test('uses the Windows decoder filename when the script loads on Windows', () => {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            let windowsDecoder: typeof videoDecoderModule;
            jest.isolateModules(() => {
                windowsDecoder = require('../../scripts/build-video-decoder') as typeof videoDecoderModule;
            });
            expect(windowsDecoder!.DECODER_NAME).toBe('ffmpeg.exe');
        } finally {
            Object.defineProperty(process, 'platform', descriptor);
        }
    });

    test('records the macOS deployment target in the build output', () => {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        try {
            primeCompiler();
            decoder.buildDecoder('/verified.tar.gz');
            expect(files.get(path.join(decoder.OUTPUT_DIR, 'BUILD_CONFIG.txt'))?.toString()).toContain(
                'MACOSX_DEPLOYMENT_TARGET=11.0',
            );
            expect(files.get(path.join(decoder.OUTPUT_DIR, 'MANIFEST.json'))?.toString()).toContain('darwin-');
        } finally {
            Object.defineProperty(process, 'platform', descriptor);
        }
    });

    test('stages only the current target decoder after validating its manifest', async () => {
        primeCompiler();
        await expect(decoder.stageElectronVideoDecoder(`${process.platform}-${process.arch}`)).resolves.toBe(
            decoder.ELECTRON_STAGE_DIR,
        );
        expect(mockFs.cpSync).toHaveBeenCalledWith(decoder.OUTPUT_DIR, decoder.ELECTRON_STAGE_DIR, { recursive: true });
    });

    test('refuses staging when the built decoder manifest has a different target', async () => {
        primeCompiler();
        jest.spyOn(JSON, 'parse').mockReturnValue({ target: 'wrong-target' });
        await expect(decoder.stageElectronVideoDecoder(`${process.platform}-${process.arch}`)).rejects.toThrow(
            'Built decoder manifest does not match',
        );
        expect(mockFs.cpSync).not.toHaveBeenCalled();
    });

    test('runs both script entry paths with the mocked native compiler boundary', async () => {
        const argv = process.argv;
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            primeCompiler();
            process.argv = ['node', 'build-video-decoder.ts', `--stage=${process.platform}-${process.arch}`];
            await decoder.main();
            primeCompiler();
            process.argv = ['node', 'build-video-decoder.ts', '--stage'];
            await decoder.main();
            primeCompiler();
            process.argv = ['node', 'build-video-decoder.ts'];
            await decoder.main();
            expect(log).toHaveBeenCalledWith(expect.stringContaining('Staged video decoder'));
            expect(log).toHaveBeenCalledWith(expect.stringContaining('Built video decoder'));
        } finally {
            process.argv = argv;
        }
    });

    test('rejects an empty command-line stage target', async () => {
        const argv = process.argv;
        try {
            process.argv = ['node', 'build-video-decoder.ts', '--stage='];
            await expect(decoder.main()).rejects.toThrow('Decoder stage target is required');
        } finally {
            process.argv = argv;
        }
    });
});
