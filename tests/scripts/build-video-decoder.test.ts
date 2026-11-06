jest.unmock('node:path');

import type * as cryptoModule from 'node:crypto';
import type * as fsModule from 'node:fs';
import { invalid } from '../helpers/invalid';
import { isArrayOf, isShape, isString, nullable, parseJsonAs } from '../helpers/parseJson';

const PINNED_DIGEST = '0a943b4fbd4d7e5c8513733e15668d1ff5671fb8d34fcd0ed0f89751349eae8b';
const LICENSE_DIGEST = '246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30';
const files = new Map<string, Buffer>();
const directories = new Set<string>();
const mockExecFileSync = jest.fn<void, [string, string[], object]>();
const mockCreateHash = jest.fn<ReturnType<typeof cryptoModule.createHash>, [string]>();
const mockDatabaseExec = jest.fn<void, [string]>();
const mockDatabaseClose = jest.fn<void, []>();
type SQLiteDatabase = { close: () => void; exec: (sql: string) => void };
const mockDatabase = jest.fn<SQLiteDatabase, [string]>();
let mockWriterLocked = false;

const resetMockDatabase = (): void => {
    mockWriterLocked = false;
    mockDatabaseExec.mockReset();
    mockDatabaseClose.mockReset();
    mockDatabase.mockReset();
    mockDatabase.mockImplementation(() => {
        let ownsWriterLock = false;
        return invalid<SQLiteDatabase>({
            exec: (sql: string) => {
                mockDatabaseExec(sql);
                if (mockWriterLocked) throw Object.assign(new Error('database is locked'), { errcode: 5 });
                mockWriterLocked = true;
                ownsWriterLock = true;
            },
            close: () => {
                mockDatabaseClose();
                if (ownsWriterLock) mockWriterLocked = false;
            },
        });
    });
};
const mockFs = {
    chmodSync: jest.fn(),
    copyFileSync: jest.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
        files.set(String(to), Buffer.from(files.get(String(from)) ?? ''));
    }),
    cpSync: jest.fn(),
    existsSync: jest.fn((file: fsModule.PathLike) => files.has(String(file)) || directories.has(String(file))),
    mkdirSync: jest.fn((directory: fsModule.PathLike, options?: fsModule.MakeDirectoryOptions) => {
        const value = String(directory);
        if (directories.has(value) && !options?.recursive) {
            throw Object.assign(new Error(`EEXIST: ${value}`), { code: 'EEXIST' });
        }
        directories.add(value);
    }),
    mkdtempSync: jest.fn((prefix: string) => {
        const directory = prefix.includes('.next-') ? '/tmp/decoder-distribution' : '/tmp/decoder-build';
        directories.add(directory);
        return directory;
    }),
    readFileSync: jest.fn((file: fsModule.PathOrFileDescriptor, encoding?: BufferEncoding | null) => {
        const data = files.get(String(file));
        if (data === undefined) throw Object.assign(new Error(`ENOENT: ${String(file)}`), { code: 'ENOENT' });
        return encoding === null || encoding === undefined ? data : data.toString(encoding);
    }),
    renameSync: jest.fn((from: fsModule.PathLike, to: fsModule.PathLike) => {
        const source = String(from);
        const target = String(to);
        if (directories.has(source)) {
            directories.delete(source);
            directories.add(target);
            for (const directory of [...directories]) {
                if (directory.startsWith(`${source}/`)) {
                    directories.delete(directory);
                    directories.add(`${target}${directory.slice(source.length)}`);
                }
            }
            for (const [file, data] of [...files]) {
                if (file.startsWith(`${source}/`)) {
                    files.delete(file);
                    files.set(`${target}${file.slice(source.length)}`, data);
                }
            }
            return;
        }
        const data = files.get(source);
        if (data === undefined) throw Object.assign(new Error(`ENOENT: ${String(from)}`), { code: 'ENOENT' });
        files.delete(source);
        files.set(target, data);
    }),
    rmSync: jest.fn((file: fsModule.PathLike) => {
        const value = String(file);
        for (const path of [...files.keys()]) if (path === value || path.startsWith(`${value}/`)) files.delete(path);
        for (const directory of [...directories]) {
            if (directory === value || directory.startsWith(`${value}/`)) directories.delete(directory);
        }
    }),
    statSync: jest.fn(() => ({ mode: 0o755, mtimeMs: Date.now() }) as fsModule.Stats),
    writeFileSync: jest.fn((file: fsModule.PathOrFileDescriptor, data: string | Uint8Array) => {
        files.set(String(file), Buffer.from(data));
    }),
};

jest.mock('node:fs', () => ({ __esModule: true, default: mockFs, ...mockFs }));
jest.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));
jest.mock('node:os', () => ({ cpus: () => [{}, {}], tmpdir: () => '/tmp' }));
jest.mock('node:crypto', () => ({ createHash: mockCreateHash }));
jest.mock('node:sqlite', () => ({ Database: mockDatabase }));

import path = require('node:path');
import type * as buildNoticesModule from '../../scripts/build-notices';
import type * as videoDecoderModule from '../../scripts/build-video-decoder';
const buildNotices = require('../../scripts/build-notices') as typeof buildNoticesModule;
const decoder = require('../../scripts/build-video-decoder') as typeof videoDecoderModule;
const realChildProcess = jest.requireActual('node:child_process') as typeof import('node:child_process');
const realFs = jest.requireActual('node:fs') as typeof fsModule;
const realOs = jest.requireActual('node:os') as typeof import('node:os');

type LockProcess = {
    child: import('node:child_process').ChildProcess;
    error: Error | null;
    exit: { code: number | null; signal: NodeJS.Signals | null } | null;
    output: string;
};

const lockProcessProgram = `
const decoder = require(process.argv[1]);
const lockFile = process.argv[2];
const { Database } = require('node:sqlite');
const exec = Database.prototype.exec;
Database.prototype.exec = function(sql) {
    try {
        return exec.call(this, sql);
    } catch (error) {
        if (error && typeof error === 'object' && error.errcode === 5) process.stdout.write('blocked\\n');
        throw error;
    }
};
let release = null;
const acquire = async () => {
    release = await decoder.acquirePreparationLock(lockFile);
    process.stdout.write('acquired\\n');
};
const releaseLock = () => {
    if (release === null) throw new Error('Lock is not held');
    release();
    release = null;
    process.stdout.write('released\\n');
};
let commands = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
    for (const command of input.split('\\n')) {
        if (!command) continue;
        commands = commands.then(async () => {
            if (command === 'acquire') return acquire();
            if (command === 'release') return releaseLock();
            if (command === 'exit') {
                if (release !== null) releaseLock();
                process.exit(0);
            }
            throw new Error(\`Unknown command: \${command}\`);
        });
    }
    commands.catch((error) => {
        console.error(error);
        process.exit(1);
    });
});
acquire().catch((error) => {
    console.error(error);
    process.exit(1);
});
`;

const startLockProcess = (lockFile: string): LockProcess => {
    const child = realChildProcess.spawn(
        process.execPath,
        [
            '--import',
            'tsx',
            '-e',
            lockProcessProgram,
            path.join(process.cwd(), 'scripts/build-video-decoder.ts'),
            lockFile,
        ],
        { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lockProcess: LockProcess = { child, error: null, exit: null, output: '' };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
        lockProcess.output += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        lockProcess.output += chunk;
    });
    child.on('error', (error) => {
        lockProcess.error = error;
    });
    child.on('exit', (code, signal) => {
        lockProcess.exit = { code, signal };
    });
    return lockProcess;
};

const waitForLockProcess = async (lockProcess: LockProcess, text: string, occurrences = 1): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (lockProcess.output.split(text).length - 1 < occurrences) {
        if (lockProcess.error) throw lockProcess.error;
        if (lockProcess.exit) throw new Error(`Lock process exited before writing ${text}: ${lockProcess.output}`);
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock process output: ${lockProcess.output}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
};

const waitForLockProcessExit = async (lockProcess: LockProcess): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!lockProcess.exit) {
        if (lockProcess.error) throw lockProcess.error;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock process exit: ${lockProcess.output}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
};

const sendLockProcessCommand = (lockProcess: LockProcess, command: string): void => {
    if (!lockProcess.child.stdin) throw new Error('Lock process does not accept commands');
    lockProcess.child.stdin.write(`${command}\n`);
};

const terminateLockProcess = async (lockProcess: LockProcess | undefined): Promise<void> => {
    if (!lockProcess || lockProcess.exit) return;
    lockProcess.child.kill('SIGTERM');
    await waitForLockProcessExit(lockProcess);
};

type CachedDecoderManifest = {
    binary: string;
    binarySha256: string;
    probe: string;
    probeSha256: string;
    buildConfig: string[];
    macosDeploymentTarget: string | null;
    license: string;
    sourceArchive: string;
    sourceRevision: string;
    sourceSha256: string;
    target: string;
};

type CachedManifestMutation = {
    label: string;
    current: (manifest: CachedDecoderManifest) => unknown;
    mutate: (manifest: CachedDecoderManifest) => void;
};

const isCachedDecoderManifest = isShape<CachedDecoderManifest>({
    binary: isString,
    binarySha256: isString,
    probe: isString,
    probeSha256: isString,
    buildConfig: isArrayOf(isString),
    macosDeploymentTarget: nullable(isString),
    license: isString,
    sourceArchive: isString,
    sourceRevision: isString,
    sourceSha256: isString,
    target: isString,
});

const cachedManifest = (targetDecoder: typeof videoDecoderModule = decoder): CachedDecoderManifest =>
    parseJsonAs(files.get(path.join(targetDecoder.OUTPUT_DIR, 'MANIFEST.json'))!.toString(), isCachedDecoderManifest);

const setHash = (): void => {
    mockCreateHash.mockImplementation(() => {
        const chunks: Buffer[] = [];
        const hash = {
            update: (data: string | Buffer) => {
                chunks.push(Buffer.from(data));
                return hash;
            },
            digest: () => {
                const bytes = Buffer.concat(chunks);
                if (bytes.equals(Buffer.from('archive'))) return PINNED_DIGEST;
                if (bytes.equals(Buffer.from('LGPL'))) return LICENSE_DIGEST;
                return 'bad-digest';
            },
        };
        return invalid<ReturnType<typeof cryptoModule.createHash>>(hash);
    });
};

describe('build-video-decoder', () => {
    beforeEach(() => {
        files.clear();
        directories.clear();
        jest.clearAllMocks();
        resetMockDatabase();
        setHash();
        global.fetch = jest.fn();
    });

    afterEach(() => jest.restoreAllMocks());

    const primeCompiler = (targetDecoder: typeof videoDecoderModule = decoder): void => {
        const source = '/tmp/decoder-build/ffmpeg';
        files.set(targetDecoder.SOURCE_ARCHIVE, Buffer.from('archive'));
        files.set('/verified.tar.gz', Buffer.from('archive'));
        files.set(
            path.join(source, 'libavutil', 'encryption_info.c'),
            Buffer.from('void av_encryption_init_info_free while (info)'),
        );
        files.set(path.join(source, 'libavformat', 'mov.c'), Buffer.from('av_encryption_init_info_append_side_data'));
        files.set(path.join(source, 'COPYING.LGPLv2.1'), Buffer.from('LGPL'));
        files.set(path.join(source, targetDecoder.DECODER_NAME), Buffer.from('decoder'));
        files.set(path.join(source, targetDecoder.PROBE_NAME), Buffer.from('probe'));
    };

    test('uses a verified cached source without fetching', async () => {
        files.set(decoder.SOURCE_ARCHIVE, Buffer.from('archive'));
        await expect(decoder.ensureSourceArchive()).resolves.toBe(decoder.SOURCE_ARCHIVE);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('downloads, verifies, and atomically caches a missing source', async () => {
        jest.mocked(global.fetch).mockResolvedValue(new Response(Buffer.from('archive')));
        await expect(decoder.ensureSourceArchive()).resolves.toBe(decoder.SOURCE_ARCHIVE);
        expect(global.fetch).toHaveBeenCalledWith(
            decoder.FFMPEG_ARCHIVE_URL,
            expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
        );
        expect(files.get(decoder.SOURCE_ARCHIVE)).toEqual(Buffer.from('archive'));
    });

    test('streams a normal source archive', async () => {
        jest.mocked(global.fetch).mockResolvedValue(new Response(Buffer.from('archive')));

        await expect(decoder.downloadSourceArchive()).resolves.toEqual(Buffer.from('archive'));
    });

    test('rejects declared and received oversized archives and cancels the reader', async () => {
        const reader = {
            cancel: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
            read: jest.fn<Promise<ReadableStreamReadResult<Uint8Array>>, []>(),
            releaseLock: jest.fn(),
        };
        const response = (contentLength: string | null): Response =>
            invalid<Response>({
                body: invalid<ReadableStream<Uint8Array>>({
                    getReader: () => invalid<ReadableStreamDefaultReader<Uint8Array>>(reader),
                }),
                headers: new Headers(contentLength === null ? undefined : { 'content-length': contentLength }),
                ok: true,
                status: 200,
            });

        jest.mocked(global.fetch).mockResolvedValueOnce(response(String(decoder.MAX_SOURCE_ARCHIVE_BYTES + 1)));
        await expect(decoder.downloadSourceArchive()).rejects.toThrow('exceeds the supported size');
        expect(reader.cancel).toHaveBeenCalledTimes(1);

        reader.cancel.mockClear();
        reader.read.mockResolvedValueOnce({
            done: false,
            value: invalid<Uint8Array>({ byteLength: decoder.MAX_SOURCE_ARCHIVE_BYTES + 1 }),
        });
        jest.mocked(global.fetch).mockResolvedValueOnce(response(null));
        await expect(decoder.downloadSourceArchive()).rejects.toThrow('exceeds the supported size');
        expect(reader.cancel).toHaveBeenCalledTimes(1);
    });

    test('rejects an absent source body and preserves a download failure when cancellation fails', async () => {
        jest.mocked(global.fetch).mockResolvedValueOnce(new Response(null));
        await expect(decoder.downloadSourceArchive()).rejects.toThrow('returned no body');

        const reader = {
            cancel: jest.fn<Promise<void>, []>().mockRejectedValue(new Error('cancel failed')),
            read: jest.fn<Promise<ReadableStreamReadResult<Uint8Array>>, []>(),
            releaseLock: jest.fn(),
        };
        reader.read.mockResolvedValueOnce({
            done: false,
            value: invalid<Uint8Array>({ byteLength: decoder.MAX_SOURCE_ARCHIVE_BYTES + 1 }),
        });
        jest.mocked(global.fetch).mockResolvedValueOnce(
            invalid<Response>({
                body: invalid<ReadableStream<Uint8Array>>({
                    getReader: () => invalid<ReadableStreamDefaultReader<Uint8Array>>(reader),
                }),
                headers: new Headers(),
                ok: true,
                status: 200,
            }),
        );

        await expect(decoder.downloadSourceArchive()).rejects.toThrow('exceeds the supported size');
        expect(reader.cancel).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).toHaveBeenCalledTimes(1);
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

    test('renders the FFmpeg and FFprobe LGPL disclosure with the pinned source and configuration', () => {
        const notice = buildNotices
            .renderRuntimesSection({
                readText: () => 'license text',
                onnxruntimeVersion: 'test-node',
                onnxruntimeWebVersion: 'test-web',
            })
            .join('\n');

        expect(notice).toContain('FFmpeg and FFprobe');
        expect(notice).toContain(decoder.FFMPEG_ARCHIVE_URL);
        expect(notice).toContain(decoder.FFMPEG_REVISION);
        expect(notice).toContain('--enable-ffprobe');
    });

    test('runs the compiler boundary and writes the decoder manifest from mocked source files', () => {
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        expect(mockExecFileSync).toHaveBeenCalledWith('tar', ['-xzf', '/verified.tar.gz', '-C', '/tmp/decoder-build'], {
            stdio: 'inherit',
        });
        expect(mockExecFileSync).toHaveBeenCalledWith(
            'make',
            ['-j', '1'],
            expect.objectContaining({ cwd: '/tmp/decoder-build/ffmpeg' }),
        );
        expect(files.get(path.join(decoder.OUTPUT_DIR, decoder.DECODER_NAME))).toEqual(Buffer.from('decoder'));
        expect(files.get(path.join(decoder.OUTPUT_DIR, 'MANIFEST.json'))?.toString()).toContain(
            decoder.FFMPEG_REVISION,
        );
        expect(files.get(path.join(decoder.OUTPUT_DIR, decoder.PROBE_NAME))).toEqual(Buffer.from('probe'));
    });

    test('fails when the compiler does not produce either required executable', () => {
        primeCompiler();
        files.delete(path.join('/tmp/decoder-build/ffmpeg', decoder.DECODER_NAME));
        expect(() => decoder.buildDecoder('/verified.tar.gz')).toThrow('did not produce the decoder executable');
        primeCompiler();
        files.delete(path.join('/tmp/decoder-build/ffmpeg', decoder.PROBE_NAME));
        expect(() => decoder.buildDecoder('/verified.tar.gz')).toThrow('did not produce the probe executable');
    });

    test.each([true, false])('handles failed publication with a previous distribution: %s', (hasPrevious) => {
        primeCompiler();
        if (hasPrevious) decoder.buildDecoder('/verified.tar.gz');
        primeCompiler();
        const rename = mockFs.renameSync.getMockImplementation()!;
        if (hasPrevious) mockFs.renameSync.mockImplementationOnce(rename);
        mockFs.renameSync.mockImplementationOnce(() => {
            throw new Error('publish failed');
        });

        expect(() => decoder.buildDecoder('/verified.tar.gz')).toThrow('publish failed');
        expect(files.get(path.join(decoder.OUTPUT_DIR, decoder.DECODER_NAME))).toEqual(
            hasPrevious ? Buffer.from('decoder') : undefined,
        );
    });

    test('reuses only a cached decoder whose target, source, configuration, and both executables verify', async () => {
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        mockExecFileSync.mockClear();

        await expect(decoder.prepareVideoDecoder()).resolves.toBe(decoder.OUTPUT_DIR);
        expect(mockExecFileSync).not.toHaveBeenCalled();

        files.delete(path.join(decoder.OUTPUT_DIR, decoder.PROBE_NAME));
        primeCompiler();
        await expect(decoder.prepareVideoDecoder()).resolves.toBe(decoder.OUTPUT_DIR);
        expect(mockExecFileSync).toHaveBeenCalled();
    });

    test('prepares one complete distribution for concurrent callers and reuses its winner', async () => {
        primeCompiler();
        const first = decoder.prepareVideoDecoder();
        const second = decoder.prepareVideoDecoder();

        await expect(Promise.all([first, second])).resolves.toEqual([decoder.OUTPUT_DIR, decoder.OUTPUT_DIR]);
        expect(mockExecFileSync.mock.calls.filter(([command]) => command === 'make')).toHaveLength(1);
        expect(files.get(path.join(decoder.OUTPUT_DIR, decoder.DECODER_NAME))).toEqual(Buffer.from('decoder'));
        expect(files.get(path.join(decoder.OUTPUT_DIR, decoder.PROBE_NAME))).toEqual(Buffer.from('probe'));
        expect(mockDatabaseClose).toHaveBeenCalledTimes(3);
    });

    test('releases the preparation transaction after a failed build and allows the next build to recover', async () => {
        primeCompiler();
        files.delete(path.join('/tmp/decoder-build/ffmpeg', decoder.DECODER_NAME));

        await expect(decoder.prepareVideoDecoder()).rejects.toThrow('did not produce the decoder executable');
        expect(mockDatabaseClose).toHaveBeenCalledTimes(1);

        primeCompiler();
        await expect(decoder.prepareVideoDecoder()).resolves.toBe(decoder.OUTPUT_DIR);
    });

    test('retries only SQLite busy failures and closes failed connections before retrying', async () => {
        jest.useFakeTimers();
        const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
        mockDatabaseExec.mockImplementationOnce(() => {
            throw busy;
        });
        try {
            const pending = decoder.acquirePreparationLock('/tmp/retry.sqlite');
            expect(mockDatabaseClose).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(25);
            const release = await pending;
            release();

            expect(mockDatabase).toHaveBeenCalledTimes(2);
            expect(mockDatabaseClose).toHaveBeenCalledTimes(2);
        } finally {
            jest.clearAllTimers();
            jest.useRealTimers();
        }
    });

    test('times out only SQLite busy failures and keeps the SQLite cause', async () => {
        jest.useFakeTimers();
        const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
        mockDatabaseExec.mockImplementation(() => {
            throw busy;
        });
        const now = jest.spyOn(Date, 'now').mockReturnValue(0);
        try {
            const pending = decoder.acquirePreparationLock('/tmp/timeout.sqlite');
            const rejected = expect(pending).rejects.toMatchObject({ cause: busy });
            now.mockReturnValue(30 * 60 * 1000);
            await jest.advanceTimersByTimeAsync(25);
            await rejected;
            expect(mockDatabaseClose).toHaveBeenCalledTimes(2);
        } finally {
            jest.clearAllTimers();
            jest.useRealTimers();
        }
    });

    test.each([Object.assign(new Error('disk failure'), { errcode: 14 }), null])(
        'does not retry a non-contention SQLite failure: %s',
        async (failure) => {
            mockDatabaseExec.mockImplementationOnce(() => {
                throw failure;
            });

            await expect(decoder.acquirePreparationLock('/tmp/failure.sqlite')).rejects.toBe(failure);
            expect(mockDatabase).toHaveBeenCalledTimes(1);
            expect(mockDatabaseClose).toHaveBeenCalledTimes(1);
        },
    );

    test('does not retain a connection when opening the SQLite database fails', async () => {
        const failure = new Error('permission denied');
        mockDatabase.mockImplementationOnce(() => {
            throw failure;
        });

        await expect(decoder.acquirePreparationLock('/tmp/denied.sqlite')).rejects.toBe(failure);
        expect(mockDatabaseClose).not.toHaveBeenCalled();
    });

    test('uses the SQLite OS lock across processes, including release and crash recovery', async () => {
        const temporaryRoot = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'gurushots-decoder-lock-'));
        const lockFile = path.join(temporaryRoot, 'decoder.prepare.sqlite');
        const legacyDirectory = path.join(temporaryRoot, 'decoder.prepare.lock');
        let first: LockProcess | undefined;
        let second: LockProcess | undefined;
        realFs.mkdirSync(legacyDirectory);
        realFs.writeFileSync(path.join(legacyDirectory, 'owner'), '');
        try {
            first = startLockProcess(lockFile);
            await waitForLockProcess(first, 'acquired');

            second = startLockProcess(lockFile);
            await waitForLockProcess(second, 'blocked');
            expect(second.output).not.toContain('acquired');

            sendLockProcessCommand(first, 'release');
            await waitForLockProcess(second, 'acquired');

            realFs.writeFileSync(path.join(legacyDirectory, 'owner'), '12345-');
            expect(second.child.kill('SIGKILL')).toBe(true);
            await waitForLockProcessExit(second);

            sendLockProcessCommand(first, 'acquire');
            await waitForLockProcess(first, 'acquired', 2);
            sendLockProcessCommand(first, 'exit');
            await waitForLockProcessExit(first);
        } finally {
            try {
                await terminateLockProcess(first);
            } finally {
                try {
                    await terminateLockProcess(second);
                } finally {
                    realFs.rmSync(temporaryRoot, { force: true, recursive: true });
                }
            }
        }
    });

    const cacheManifestMutations: readonly CachedManifestMutation[] = [
        {
            label: 'target',
            current: (manifest) => manifest.target,
            mutate: (manifest) => {
                manifest.target = 'other-target';
            },
        },
        {
            label: 'source revision',
            current: (manifest) => manifest.sourceRevision,
            mutate: (manifest) => {
                manifest.sourceRevision = 'other-revision';
            },
        },
        {
            label: 'source digest',
            current: (manifest) => manifest.sourceSha256,
            mutate: (manifest) => {
                manifest.sourceSha256 = 'other-digest';
            },
        },
        {
            label: 'source archive',
            current: (manifest) => manifest.sourceArchive,
            mutate: (manifest) => {
                manifest.sourceArchive = 'other.tar.gz';
            },
        },
        {
            label: 'license',
            current: (manifest) => manifest.license,
            mutate: (manifest) => {
                manifest.license = 'other-license';
            },
        },
        {
            label: 'macOS deployment target',
            current: (manifest) => manifest.macosDeploymentTarget,
            mutate: (manifest) => {
                manifest.macosDeploymentTarget = 'other-target';
            },
        },
        {
            label: 'build configuration',
            current: (manifest) => manifest.buildConfig,
            mutate: (manifest) => {
                manifest.buildConfig = [];
            },
        },
        {
            label: 'decoder digest',
            current: (manifest) => manifest.binarySha256,
            mutate: (manifest) => {
                manifest.binarySha256 = 'other-digest';
            },
        },
        {
            label: 'probe digest',
            current: (manifest) => manifest.probeSha256,
            mutate: (manifest) => {
                manifest.probeSha256 = 'other-digest';
            },
        },
    ];

    test.each(cacheManifestMutations)('rejects a cached decoder with a mismatched $label', ({ current, mutate }) => {
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        const manifestPath = path.join(decoder.OUTPUT_DIR, 'MANIFEST.json');
        const manifest = cachedManifest();
        const original = current(manifest);
        mutate(manifest);
        expect(current(manifest)).not.toEqual(original);
        files.set(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

        expect(decoder.cacheManifestIsValid()).toBe(false);
    });

    test.each([
        ['manifest', path.join(decoder.OUTPUT_DIR, 'MANIFEST.json')],
        ['probe', path.join(decoder.OUTPUT_DIR, decoder.PROBE_NAME)],
        ['source archive', path.join(decoder.OUTPUT_DIR, `ffmpeg-${decoder.FFMPEG_REVISION}.tar.gz`)],
        ['license', path.join(decoder.OUTPUT_DIR, 'LICENSE.txt')],
        ['build configuration', path.join(decoder.OUTPUT_DIR, 'BUILD_CONFIG.txt')],
    ])('rejects an incomplete cached decoder missing its %s', (_label, file) => {
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        files.delete(file);

        expect(decoder.cacheManifestIsValid()).toBe(false);
    });

    test.each(['probe', 'probeSha256', 'sourceArchive', 'license', 'macosDeploymentTarget'])(
        'rejects a manifest missing %s',
        (field) => {
            primeCompiler();
            decoder.buildDecoder('/verified.tar.gz');
            const manifest: Record<string, unknown> = { ...cachedManifest() };
            delete manifest[field];
            files.set(
                path.join(decoder.OUTPUT_DIR, 'MANIFEST.json'),
                Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
            );

            expect(decoder.cacheManifestIsValid()).toBe(false);
        },
    );

    test.each(['probe', 'probeSha256'])('rejects non-string %s metadata', (field) => {
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        const manifest: Record<string, unknown> = { ...cachedManifest(), [field]: 1 };
        files.set(
            path.join(decoder.OUTPUT_DIR, 'MANIFEST.json'),
            Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
        );

        expect(decoder.cacheManifestIsValid()).toBe(false);
    });

    test('rejects a cached source archive whose bytes do not match the pinned digest', () => {
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        files.set(path.join(decoder.OUTPUT_DIR, `ffmpeg-${decoder.FFMPEG_REVISION}.tar.gz`), Buffer.from('other'));

        expect(decoder.cacheManifestIsValid()).toBe(false);
    });

    test.each([
        ['license', 'LICENSE.txt'],
        ['build configuration', 'BUILD_CONFIG.txt'],
    ])('rejects a cached %s whose contents are incomplete', (_label, file) => {
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        files.set(path.join(decoder.OUTPUT_DIR, file), Buffer.alloc(0));

        expect(decoder.cacheManifestIsValid()).toBe(false);
    });

    test('rejects a cache whose nonempty license was replaced', () => {
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        files.set(path.join(decoder.OUTPUT_DIR, 'LICENSE.txt'), Buffer.from('replaced license'));

        expect(decoder.cacheManifestIsValid()).toBe(false);
    });

    test('rejects a Unix cache whose bundled executable mode is absent', () => {
        if (process.platform === 'win32') return;
        primeCompiler();
        decoder.buildDecoder('/verified.tar.gz');
        mockFs.statSync
            .mockReturnValueOnce({ mode: 0o755 } as fsModule.Stats)
            .mockReturnValueOnce({ mode: 0o644 } as fsModule.Stats);

        expect(decoder.cacheManifestIsValid()).toBe(false);
    });

    test('accepts a Windows cache without Unix executable modes', () => {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            primeCompiler();
            decoder.buildDecoder('/verified.tar.gz');

            expect(decoder.cacheManifestIsValid()).toBe(true);
        } finally {
            Object.defineProperty(process, 'platform', descriptor);
        }
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

    test.each(['darwin', 'linux'] as const)(
        'accepts only a cache with the correct macOS deployment target on %s',
        (platform) => {
            const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
            Object.defineProperty(process, 'platform', { value: platform });
            try {
                let platformDecoder: typeof videoDecoderModule;
                jest.isolateModules(() => {
                    platformDecoder = require('../../scripts/build-video-decoder') as typeof videoDecoderModule;
                });
                primeCompiler(platformDecoder!);
                platformDecoder!.buildDecoder('/verified.tar.gz');
                const manifest = cachedManifest(platformDecoder!);

                expect(platformDecoder!.cacheManifestIsValid()).toBe(true);
                manifest.macosDeploymentTarget = platform === 'darwin' ? null : '11.0';
                files.set(
                    path.join(platformDecoder!.OUTPUT_DIR, 'MANIFEST.json'),
                    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
                );

                expect(platformDecoder!.cacheManifestIsValid()).toBe(false);
            } finally {
                Object.defineProperty(process, 'platform', descriptor);
            }
        },
    );

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
            primeCompiler();
            process.argv = ['node', 'build-video-decoder.ts', '--prepare'];
            await decoder.main();
            expect(log).toHaveBeenCalledWith(expect.stringContaining('Staged video decoder'));
            expect(log).toHaveBeenCalledWith(expect.stringContaining('Built video decoder'));
            expect(log).toHaveBeenCalledWith(expect.stringContaining('Prepared video decoder'));
        } finally {
            process.argv = argv;
        }
    });

    test('warns and continues only for an optional prepare failure', async () => {
        const argv = process.argv;
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            process.argv = ['node', 'build-video-decoder.ts', '--prepare'];
            await expect(decoder.main()).resolves.toBeUndefined();
            expect(warning).toHaveBeenCalledWith(decoder.PREPARE_WARNING);
        } finally {
            process.argv = argv;
        }
    });

    test('keeps ordinary builds and staging failures strict', async () => {
        const argv = process.argv;
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            process.argv = ['node', 'build-video-decoder.ts'];
            await expect(decoder.main()).rejects.toThrow();
            process.argv = ['node', 'build-video-decoder.ts', '--stage'];
            await expect(decoder.main()).rejects.toThrow();
            expect(warning).not.toHaveBeenCalled();
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
