jest.unmock('node:fs');
jest.unmock('node:os');
jest.unmock('node:path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { invalid } from '../../helpers/invalid';

const request = jest.fn();
const spawn = jest.fn<
    ChildProcess,
    [string, string[], { stdio: 'ignore' | ['ignore', 'pipe', 'ignore']; windowsHide: boolean }]
>();
jest.mock('node:https', () => ({ request }));
jest.mock('node:child_process', () => ({ spawn }));

import {
    MAX_VIDEO_BYTES,
    downloadVideo,
    extractNodeVideoFrames,
    probeDuration,
    runDecoder,
} from '../../../src/ts/platforms/node/videoFrames';

const probeChild = (output = '1'): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    Object.assign(child, { kill: jest.fn(), killed: true, stdout });
    queueMicrotask(() => {
        stdout.emit('data', Buffer.from(output));
        child.emit('close', 0);
    });
    return child;
};

const controlledProbeChild = (
    withStdout = true,
): { child: ChildProcess; stdout: EventEmitter; kill: jest.MockedFunction<() => void> } => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    const kill = jest.fn<void, []>();
    Object.assign(child, { kill, killed: false, ...(withStdout ? { stdout } : {}) });
    return { child, stdout, kill };
};

const response = (statusCode: number, headers: Record<string, string> = {}): IncomingMessage => {
    const stream = new EventEmitter() as IncomingMessage;
    Object.assign(stream, { headers, pause: jest.fn(), resume: jest.fn(), statusCode });
    return stream;
};

const requestFor = (res: IncomingMessage): ClientRequest => {
    const req = new EventEmitter() as ClientRequest;
    Object.assign(req, { destroy: jest.fn(), end: jest.fn() });
    request.mockImplementationOnce(
        invalid((_url: URL, _options: object, callback: (value: IncomingMessage) => void) => {
            callback(res);
            return req;
        }),
    );
    return req;
};

const MEDIA_URL = new URL('https://media.gurushots.com/clip.mp4');
const directories: string[] = [];

const temporaryDirectory = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frames-test-'));
    directories.push(directory);
    return directory;
};

const UNTIL_LIMIT_NS = 4_000_000_000n;

/**
 * Lets real file I/O progress for up to 4 s of real time (under Jest's 5 s test timeout). setImmediate and
 * hrtime stay real under the fake timers used here (FAKE_TIMERS leaves both).
 */
const until = async (condition: () => boolean): Promise<void> => {
    const start = process.hrtime.bigint();
    while (!condition() && process.hrtime.bigint() - start < UNTIL_LIMIT_NS) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(condition()).toBe(true);
};

/** Records every write stream the download opens, calling through to the real one. */
const captureStreams = (): fs.WriteStream[] => {
    const streams: fs.WriteStream[] = [];
    const createWriteStream = fs.createWriteStream;
    jest.spyOn(fs, 'createWriteStream').mockImplementation(((...args: Parameters<typeof fs.createWriteStream>) => {
        const stream = createWriteStream(...args);
        streams.push(stream);
        return stream;
    }) as typeof fs.createWriteStream);
    return streams;
};

const FAKE_TIMERS: Parameters<typeof jest.useFakeTimers>[0] = {
    doNotFake: ['hrtime', 'nextTick', 'setImmediate'],
};

describe('node video frame extraction', () => {
    afterEach(() => {
        jest.useRealTimers();
        for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
        jest.restoreAllMocks();
        request.mockReset();
        spawn.mockReset();
        jest.clearAllMocks();
    });

    test('downloads an allowed MP4, invokes an isolated child, returns ordered JPEG data URLs, and removes temp files', async () => {
        const res = response(200, { 'content-length': '9007199254740992' });
        requestFor(res);
        spawn.mockImplementation(
            invalid((_decoder: string, args: string[]) => {
                if (!args.some((arg) => arg.endsWith('.jpg'))) return probeChild('10');
                const child = new EventEmitter() as ChildProcess;
                Object.assign(child, { kill: jest.fn(), killed: true });
                setImmediate(() => {
                    for (const output of args.filter((arg) => arg.endsWith('.jpg')))
                        fs.writeFileSync(output, Buffer.from([0xff, 0xd8, 1]));
                    child.emit('close', 0);
                });
                return child;
            }),
        );
        setImmediate(() => {
            res.emit('data', Buffer.from('mp4'));
            res.emit('end');
            res.emit('close');
        });

        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 10_000, [0.2, 0.5, 0.8], () => '/decoder'),
        ).resolves.toEqual([
            'data:image/jpeg;base64,/9gB',
            'data:image/jpeg;base64,/9gB',
            'data:image/jpeg;base64,/9gB',
        ]);
        expect(request).toHaveBeenCalledWith(
            expect.any(URL),
            expect.objectContaining({ headers: {}, method: 'GET', timeout: 30_000 }),
            expect.any(Function),
        );
        expect(spawn).toHaveBeenCalledWith(
            '/decoder',
            expect.arrayContaining(['-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'file,pipe']),
            { stdio: 'ignore', windowsHide: true },
        );
        const decoderArgs = spawn.mock.calls[1][1];
        expect(decoderArgs.filter((arg) => /^[0-9]+:v:0$/.test(arg))).toEqual(['0:v:0', '1:v:0', '2:v:0']);
    });

    test('rejects an HTTP refusal and removes its temporary directory', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(302);
        requestFor(res);
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow('HTTP 200');
        expect(res.resume).not.toHaveBeenCalled();
    });

    test('rejects a declared download over the byte limit before creating any file', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const declared = response(200, { 'content-length': String(MAX_VIDEO_BYTES + 1) });
        requestFor(declared);
        const makeDirectory = jest.spyOn(fs, 'mkdtempSync');
        const streams = captureStreams();
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow(
            `Video download exceeds the supported size (${MAX_VIDEO_BYTES + 1} of ${MAX_VIDEO_BYTES} bytes)`,
        );
        expect(streams).toHaveLength(0);
        expect(fs.existsSync(String(makeDirectory.mock.results[0]!.value))).toBe(false);
    });

    test('rejects a streamed download over the byte limit only after its file is closed', async () => {
        const res = response(200);
        const destroy = jest.fn();
        Object.assign(res, { destroy });
        requestFor(res);
        const streams = captureStreams();
        const destination = path.join(temporaryDirectory(), 'input.mp4');
        const download = downloadVideo(MEDIA_URL, destination, 30_000, 4);
        const stream = streams[0]!;
        res.emit('data', Buffer.from('abc'));
        await until(() => stream.bytesWritten === 3);
        res.emit('data', Buffer.from('de'));
        let closedAtRejection: boolean | undefined;
        await expect(
            download.catch((error: unknown) => {
                closedAtRejection = stream.closed;
                throw error;
            }),
        ).rejects.toThrow('Video download exceeds the supported size (5 of 4 bytes)');
        expect(closedAtRejection).toBe(true);
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['aborted', (res: IncomingMessage) => res.emit('aborted'), 'aborted'],
        ['closed early', (res: IncomingMessage) => res.emit('close'), 'closed before completion'],
        ['response error', (res: IncomingMessage) => res.emit('error', new Error('read failed')), 'read failed'],
    ])('rejects a %s response and cleans up', async (_label, emit, message) => {
        const res = response(200);
        requestFor(res);
        setImmediate(() => emit(res));
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow(message);
    });

    test('keeps the response-abort result when the request later errors', async () => {
        const res = response(200);
        const req = requestFor(res);
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        res.emit('aborted');
        req.emit('error', new Error('request failed after abort'));
        await expect(extraction).rejects.toThrow('aborted');
    });

    test('rejects a download when its request deadline expires', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(200);
        requestFor(res);
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('exceeded its 30 s deadline');
        await jest.advanceTimersByTimeAsync(30_000);
        await rejected;
    });

    test('gives a long clip its own length as the download deadline', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        requestFor(response(200));
        const extraction = extractNodeVideoFrames(
            'https://media.gurushots.com/clip.mp4',
            120_000,
            [0.2],
            () => '/decoder',
        );
        let settled = false;
        extraction.then(
            () => (settled = true),
            () => (settled = true),
        );
        const rejected = expect(extraction).rejects.toThrow('exceeded its 120 s deadline');
        await jest.advanceTimersByTimeAsync(30_000);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(90_000);
        await rejected;
    });

    test('keeps a 30 second deadline for a clip shorter than 30 seconds', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        requestFor(response(200));
        const extraction = extractNodeVideoFrames(
            'https://media.gurushots.com/clip.mp4',
            10_000,
            [0.2],
            () => '/decoder',
        );
        const rejected = expect(extraction).rejects.toThrow('exceeded its 30 s deadline');
        await jest.advanceTimersByTimeAsync(30_000);
        await rejected;
    });

    test('does not let a steady flow of data defeat the overall deadline', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(200);
        requestFor(res);
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('exceeded its 30 s deadline');
        for (let tick = 0; tick < 3; tick += 1) {
            res.emit('data', Buffer.from('x'));
            await jest.advanceTimersByTimeAsync(10_000);
        }
        await rejected;
    });

    test('does not reject on the overall deadline once every byte has arrived', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(200);
        requestFor(res);
        const streams = captureStreams();
        const download = downloadVideo(MEDIA_URL, path.join(temporaryDirectory(), 'input.mp4'), 30_000);
        const stream = streams[0]!;
        const endStream = stream.end.bind(stream);
        jest.spyOn(stream, 'end').mockImplementation(() => stream);
        let settled = false;
        download.then(
            () => (settled = true),
            () => (settled = true),
        );
        res.emit('data', Buffer.from('abc'));
        res.emit('end');
        await jest.advanceTimersByTimeAsync(30_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stream.destroyed).toBe(false);
        expect(settled).toBe(false);
        endStream();
        res.emit('close');
        await download;
    });

    test('ignores a response that arrives after the download already failed', async () => {
        let deliver: (value: IncomingMessage) => void = () => {};
        const req = new EventEmitter() as ClientRequest;
        Object.assign(req, { destroy: jest.fn(), end: jest.fn() });
        request.mockImplementationOnce(
            invalid((_url: URL, _options: object, callback: (value: IncomingMessage) => void) => {
                deliver = callback;
                return req;
            }),
        );
        const streams = captureStreams();
        const download = downloadVideo(MEDIA_URL, path.join(temporaryDirectory(), 'input.mp4'), 30_000);
        req.emit('timeout');
        await expect(download).rejects.toThrow('timed out');
        deliver(response(200));
        expect(streams).toHaveLength(0);
    });

    test('ignores data that arrives after the download already failed', async () => {
        const res = response(200);
        requestFor(res);
        const streams = captureStreams();
        const download = downloadVideo(MEDIA_URL, path.join(temporaryDirectory(), 'input.mp4'), 30_000);
        const write = jest.spyOn(streams[0]!, 'write');
        res.emit('aborted');
        res.emit('data', Buffer.from('late'));
        await expect(download).rejects.toThrow('aborted');
        expect(write).not.toHaveBeenCalled();
    });

    test('writes every chunk to a private file and resolves once it is closed', async () => {
        const res = response(200);
        requestFor(res);
        const destination = path.join(temporaryDirectory(), 'input.mp4');
        const download = downloadVideo(MEDIA_URL, destination, 30_000);
        for (const part of ['ab', 'cd', 'ef']) res.emit('data', Buffer.from(part));
        res.emit('end');
        res.emit('close');
        await download;
        expect(fs.readFileSync(destination, 'utf8')).toBe('abcdef');
        if (process.platform !== 'win32') expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    });

    test('pauses the response while the file is behind and resumes it on drain', async () => {
        const res = response(200);
        requestFor(res);
        const destination = path.join(temporaryDirectory(), 'input.mp4');
        const download = downloadVideo(MEDIA_URL, destination, 30_000);
        res.emit('data', Buffer.alloc(64 * 1024, 1));
        expect(res.pause).toHaveBeenCalledTimes(1);
        await until(() => jest.mocked(res.resume).mock.calls.length > 0);
        res.emit('end');
        await download;
        expect(fs.statSync(destination).size).toBe(64 * 1024);
    });

    test('rejects a file the write stream cannot create, after the stream has closed', async () => {
        const res = response(200);
        requestFor(res);
        const streams = captureStreams();
        const destination = path.join(temporaryDirectory(), 'input.mp4');
        fs.writeFileSync(destination, 'already here');
        const download = downloadVideo(MEDIA_URL, destination, 30_000);
        const stream = streams[0]!;
        let closedAtRejection: boolean | undefined;
        await expect(
            download.catch((error: unknown) => {
                closedAtRejection = stream.closed;
                throw error;
            }),
        ).rejects.toThrow('EEXIST');
        expect(closedAtRejection).toBe(true);
        expect(fs.readFileSync(destination, 'utf8')).toBe('already here');
    });

    test('rejects a download when its request emits timeout', async () => {
        const res = response(200);
        const req = requestFor(res);
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        req.emit('timeout');
        await expect(extraction).rejects.toThrow('timed out');
    });

    test.each([
        [
            'a child error',
            (child: ChildProcess) => {
                child.emit('error', new Error('decoder start failed'));
                child.emit('close', 1);
            },
            'decoder start failed',
        ],
        ['a non-zero exit', (child: ChildProcess) => child.emit('close', 1), 'decoder failed'],
    ])('rejects %s from the isolated decoder', async (_label, emit, message) => {
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        spawn.mockImplementation(
            invalid((_executable: string, args: string[]) => {
                if (!args.some((arg) => arg.endsWith('.jpg'))) return probeChild();
                const child = new EventEmitter() as ChildProcess;
                Object.assign(child, { kill: jest.fn(), killed: true });
                setImmediate(() => emit(child));
                return child;
            }),
        );
        setImmediate(() => {
            res.emit('data', Buffer.from('mp4'));
            res.emit('end');
        });
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow(message);
    });

    test('rejects an invalid JPEG emitted by the decoder', async () => {
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        spawn.mockImplementation(
            invalid((_decoder: string, args: string[]) => {
                if (!args.some((arg) => arg.endsWith('.jpg'))) return probeChild();
                const child = new EventEmitter() as ChildProcess;
                Object.assign(child, { kill: jest.fn() });
                setImmediate(() => {
                    fs.writeFileSync(args.find((arg) => arg.endsWith('.jpg'))!, 'not a jpeg');
                    child.emit('close', 0);
                });
                return child;
            }),
        );
        setImmediate(() => {
            res.emit('data', Buffer.from('mp4'));
            res.emit('end');
        });
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow('invalid JPEG');
    });

    test('rejects a JPEG-shaped frame that exceeds the final size bound', async () => {
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const statSync = fs.statSync;
        jest.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => {
            if (String(file).endsWith('.jpg')) return { size: 2 * 1024 * 1024 + 1 } as fs.Stats;
            return statSync(file);
        }) as typeof fs.statSync);
        spawn.mockImplementation(
            invalid((_decoder: string, args: string[]) => {
                if (!args.some((arg) => arg.endsWith('.jpg'))) return probeChild();
                const child = new EventEmitter() as ChildProcess;
                Object.assign(child, { kill: jest.fn() });
                setImmediate(() => {
                    fs.writeFileSync(args.find((arg) => arg.endsWith('.jpg'))!, Buffer.from([0xff, 0xd8, 1]));
                    child.emit('close', 0);
                });
                return child;
            }),
        );
        setImmediate(() => {
            res.emit('data', Buffer.from('mp4'));
            res.emit('end');
        });
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow('invalid JPEG');
    });

    test('continues after a size poll finds only bounded output', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { kill: jest.fn(), killed: false });
        spawn.mockImplementation(
            invalid((_decoder: string, args: string[]) => {
                if (!args.some((arg) => arg.endsWith('.jpg'))) return probeChild();
                fs.writeFileSync(args.find((arg) => arg.endsWith('.jpg'))!, Buffer.from([0xff, 0xd8, 1]));
                return child;
            }),
        );
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await until(() => spawn.mock.calls.length > 0);
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(25);
        child.emit('close', 0);
        await expect(extraction).resolves.toEqual(['data:image/jpeg;base64,/9gB']);
    });

    test('rejects a non-Error frame-monitoring failure', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        const kill = jest.fn();
        Object.assign(child, { kill, killed: false });
        spawn.mockImplementation(
            invalid((_executable: string, args: string[]) =>
                args.some((arg) => arg.endsWith('.jpg')) ? child : probeChild(),
            ),
        );
        jest.spyOn(fs, 'statSync').mockImplementation(() => {
            throw null;
        });
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('output could not be read');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await until(() => spawn.mock.calls.length > 0);
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(25);
        await rejected;
        expect(kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('kills a decoder that exceeds its aggregate deadline', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        const kill = jest.fn();
        Object.assign(child, { kill, killed: false });
        spawn.mockImplementation(
            invalid((_executable: string, args: string[]) =>
                args.some((arg) => arg.endsWith('.jpg')) ? child : probeChild(),
            ),
        );
        jest.spyOn(fs, 'statSync').mockImplementation(() => {
            throw Object.assign(new Error('not generated yet'), { code: 'ENOENT' });
        });
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('timed out');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await until(() => spawn.mock.calls.length > 0);
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(30_000);
        await rejected;
        expect(kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('kills a decoder when a generated frame exceeds the size bound', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        const kill = jest.fn();
        Object.assign(child, { kill, killed: false });
        spawn.mockImplementation(
            invalid((_executable: string, args: string[]) =>
                args.some((arg) => arg.endsWith('.jpg')) ? child : probeChild(),
            ),
        );
        jest.spyOn(fs, 'statSync').mockReturnValue({ size: 2 * 1024 * 1024 + 1 } as fs.Stats);
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('oversized JPEG');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await until(() => spawn.mock.calls.length > 0);
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(25);
        await rejected;
        expect(kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('kills the decoder and clears its timers when output monitoring fails', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        const kill = jest.fn();
        Object.assign(child, { kill, killed: false });
        spawn.mockImplementation(
            invalid((_executable: string, args: string[]) =>
                args.some((arg) => arg.endsWith('.jpg')) ? child : probeChild(),
            ),
        );
        jest.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => {
            if (String(file).endsWith('.jpg')) throw Object.assign(new Error('disk failed'), { code: 'EIO' });
            return fs.statSync(file);
        }) as typeof fs.statSync);
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('disk failed');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await until(() => spawn.mock.calls.length > 0);
        await jest.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(25);
        await rejected;
        expect(kill).toHaveBeenCalledWith('SIGKILL');
        expect(jest.getTimerCount()).toBe(0);
    });

    test('clamps frame seeks to a shorter probed duration before end of file', async () => {
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        spawn.mockImplementation(
            invalid((_executable: string, args: string[]) => {
                if (!args.some((arg) => arg.endsWith('.jpg'))) return probeChild('2');
                const child = new EventEmitter() as ChildProcess;
                Object.assign(child, { kill: jest.fn(), killed: true });
                setImmediate(() => {
                    fs.writeFileSync(args.find((arg) => arg.endsWith('.jpg'))!, Buffer.from([0xff, 0xd8, 1]));
                    child.emit('close', 0);
                });
                return child;
            }),
        );
        setImmediate(() => {
            res.emit('data', Buffer.from('mp4'));
            res.emit('end');
        });

        await extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 10_000, [1], () => '/decoder.exe');

        expect(spawn.mock.calls[0][0]).toBe('/ffprobe.exe');
        expect(spawn.mock.calls[0][1]).toEqual(
            expect.arrayContaining([
                '-threads',
                '1',
                '-protocol_whitelist',
                'file,pipe',
                '-show_entries',
                'format=duration',
                '-max_pixels',
                '921600',
            ]),
        );
        expect(spawn.mock.calls[1][1]).toContain('1.999');
    });

    test('rejects malformed structured probe output', async () => {
        spawn.mockImplementation(invalid(() => probeChild('not-a-duration')));

        await expect(probeDuration('/ffprobe', '/input.mp4')).rejects.toThrow('invalid duration');
    });

    test.each(['0', '120.001', '9'.repeat(400)])(
        'rejects an out-of-range structured probe duration: %s',
        async (output) => {
            spawn.mockImplementation(invalid(() => probeChild(output)));

            await expect(probeDuration('/ffprobe', '/input.mp4')).rejects.toThrow('invalid duration');
        },
    );

    test.each([
        ['has no output stream', (_probe: ReturnType<typeof controlledProbeChild>) => {}, 'returned no output stream'],
        [
            'reports a child error',
            (probe: ReturnType<typeof controlledProbeChild>) =>
                probe.child.emit('error', new Error('probe start failed')),
            'probe start failed',
        ],
        [
            'reports a stdout error',
            (probe: ReturnType<typeof controlledProbeChild>) =>
                probe.stdout.emit('error', new Error('probe read failed')),
            'probe read failed',
        ],
        [
            'reports a non-zero exit',
            (probe: ReturnType<typeof controlledProbeChild>) => probe.child.emit('close', 1),
            'probe failed',
        ],
        [
            'exceeds the output limit',
            (probe: ReturnType<typeof controlledProbeChild>) => probe.stdout.emit('data', Buffer.alloc(1_025)),
            'probe output exceeds',
        ],
    ])('rejects when the probe %s', async (_label, emit, message) => {
        const probe = controlledProbeChild(_label !== 'has no output stream');
        spawn.mockImplementation(invalid(() => probe.child));
        const result = probeDuration('/ffprobe', '/input.mp4');
        emit(probe);
        probe.child.emit('close', 1);

        await expect(result).rejects.toThrow(message);
        expect(probe.kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('terminates a probe that exceeds its decoder timeout', async () => {
        jest.useFakeTimers();
        const probe = controlledProbeChild();
        spawn.mockImplementation(invalid(() => probe.child));
        const result = probeDuration('/ffprobe', '/input.mp4');
        const rejected = expect(result).rejects.toThrow('probe timed out');

        await jest.advanceTimersByTimeAsync(30_000);
        await rejected;
        expect(probe.kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('does not kill an already-killed probe after an error', async () => {
        const { child, kill } = controlledProbeChild();
        Object.assign(child, { killed: true });
        spawn.mockReturnValueOnce(child);
        const result = probeDuration('/ffprobe', '/input.mp4');
        child.emit('error', new Error('probe stopped'));
        await expect(result).rejects.toThrow('probe stopped');
        expect(kill).not.toHaveBeenCalled();
    });

    test('ignores stdout data that arrives after a completed probe', async () => {
        const probe = controlledProbeChild();
        spawn.mockImplementation(invalid(() => probe.child));
        const result = probeDuration('/ffprobe', '/input.mp4');
        probe.stdout.emit('data', Buffer.from('1'));
        probe.child.emit('close', 0);

        await expect(result).resolves.toBe(1_000);
        probe.stdout.emit('data', Buffer.alloc(1_025));
        expect(probe.kill).not.toHaveBeenCalled();
    });

    test('streams a body larger than 32 MiB through a real response lifecycle', async () => {
        const size = 40 * 1024 * 1024;
        const chunk = Buffer.alloc(1024 * 1024, 7);
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'content-length': String(size) });
            let sent = 0;
            const pump = (): void => {
                while (sent < size) {
                    sent += chunk.length;
                    if (!res.write(chunk)) {
                        res.once('drain', pump);
                        return;
                    }
                }
                res.end();
            };
            pump();
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('test server has no port');
        request.mockImplementationOnce(
            invalid((url: URL, options: { timeout: number }, callback: (value: IncomingMessage) => void) =>
                http.request(
                    {
                        host: '127.0.0.1',
                        port: address.port,
                        path: url.pathname,
                        method: 'GET',
                        headers: {},
                        timeout: options.timeout,
                    },
                    callback,
                ),
            ),
        );
        const destination = path.join(temporaryDirectory(), 'input.mp4');
        try {
            await downloadVideo(new URL('https://media.gurushots.com/clip.mp4'), destination, 30_000);
            expect(fs.statSync(destination).size).toBe(size);
            if (process.platform !== 'win32') expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test('rejects an invalid media URL before opening a network request', async () => {
        await expect(
            extractNodeVideoFrames('https://example.test/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow('not an allowed HTTPS MP4');
        expect(request).not.toHaveBeenCalled();
    });
});

describe('node video frame extraction with an abort signal', () => {
    const CANCELLED = 'Video extraction was cancelled';

    afterEach(() => {
        jest.useRealTimers();
        for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
        jest.restoreAllMocks();
        request.mockReset();
        spawn.mockReset();
        jest.clearAllMocks();
    });

    const abortedSignal = (): AbortSignal => {
        const controller = new AbortController();
        controller.abort();
        return controller.signal;
    };

    const silentRequest = (): ClientRequest => {
        const req = new EventEmitter() as ClientRequest;
        Object.assign(req, { destroy: jest.fn(), end: jest.fn() });
        request.mockImplementationOnce(invalid(() => req));
        return req;
    };

    const stoppedListening = (signal: AbortSignal) => jest.spyOn(signal, 'removeEventListener');

    test('an already aborted extraction rejects before any work', async () => {
        const makeDirectory = jest.spyOn(fs, 'mkdtempSync');
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder', abortedSignal()),
        ).rejects.toThrow(CANCELLED);
        expect(makeDirectory).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
    });

    describe('download', () => {
        test('an abort before the response destroys the request and rejects', async () => {
            const req = silentRequest();
            const controller = new AbortController();
            const removed = stoppedListening(controller.signal);
            const download = downloadVideo(
                MEDIA_URL,
                path.join(temporaryDirectory(), 'input.mp4'),
                30_000,
                undefined,
                controller.signal,
            );
            controller.abort();

            await expect(download).rejects.toThrow(CANCELLED);
            expect(req.destroy).toHaveBeenCalledWith(expect.objectContaining({ message: CANCELLED }));
            expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
        });

        test('a signal that is already aborted fails the download at once', async () => {
            const req = silentRequest();
            await expect(
                downloadVideo(
                    MEDIA_URL,
                    path.join(temporaryDirectory(), 'input.mp4'),
                    30_000,
                    undefined,
                    abortedSignal(),
                ),
            ).rejects.toThrow(CANCELLED);
            expect(req.destroy).toHaveBeenCalledTimes(1);
        });

        test('an abort mid-stream destroys the response and rejects once the file is closed', async () => {
            const res = response(200);
            Object.assign(res, { destroy: jest.fn() });
            requestFor(res);
            const streams = captureStreams();
            const controller = new AbortController();
            const removed = stoppedListening(controller.signal);
            const download = downloadVideo(
                MEDIA_URL,
                path.join(temporaryDirectory(), 'input.mp4'),
                30_000,
                undefined,
                controller.signal,
            );
            res.emit('data', Buffer.from('ab'));
            controller.abort();
            let closedAtRejection: boolean | undefined;

            await expect(
                download.catch((error: unknown) => {
                    closedAtRejection = streams[0]!.closed;
                    throw error;
                }),
            ).rejects.toThrow(CANCELLED);
            expect(closedAtRejection).toBe(true);
            expect(res.destroy).toHaveBeenCalledTimes(1);
            expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
        });

        test('stops listening for the abort once the download completes', async () => {
            const res = response(200);
            requestFor(res);
            const controller = new AbortController();
            const removed = stoppedListening(controller.signal);
            const download = downloadVideo(
                MEDIA_URL,
                path.join(temporaryDirectory(), 'input.mp4'),
                30_000,
                undefined,
                controller.signal,
            );
            res.emit('data', Buffer.from('abc'));
            res.emit('end');
            res.emit('close');
            await download;

            expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
        });
    });

    describe('probe', () => {
        test('an abort kills the probe child and rejects', async () => {
            const probe = controlledProbeChild();
            spawn.mockReturnValueOnce(probe.child);
            const controller = new AbortController();
            const removed = stoppedListening(controller.signal);
            const result = probeDuration('/ffprobe', '/input.mp4', controller.signal);
            controller.abort();

            await expect(result).rejects.toThrow(CANCELLED);
            expect(probe.kill).toHaveBeenCalledWith('SIGKILL');
            expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
        });

        test('a signal that is already aborted kills the probe child at once', async () => {
            const probe = controlledProbeChild();
            spawn.mockReturnValueOnce(probe.child);

            await expect(probeDuration('/ffprobe', '/input.mp4', abortedSignal())).rejects.toThrow(CANCELLED);
            expect(probe.kill).toHaveBeenCalledWith('SIGKILL');
        });

        test('stops listening for the abort once the probe completes', async () => {
            const probe = controlledProbeChild();
            spawn.mockReturnValueOnce(probe.child);
            const controller = new AbortController();
            const removed = stoppedListening(controller.signal);
            const result = probeDuration('/ffprobe', '/input.mp4', controller.signal);
            probe.stdout.emit('data', Buffer.from('1'));
            probe.child.emit('close', 0);

            await expect(result).resolves.toBe(1_000);
            expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
        });
    });

    describe('decoder', () => {
        const frames = [{ output: '/tmp/frame-0.jpg', timestamp: 0 }];
        const decoderChild = () => {
            const child = new EventEmitter() as ChildProcess;
            const kill = jest.fn<void, []>();
            Object.assign(child, { kill, killed: false });
            spawn.mockReturnValueOnce(child);
            return { child, kill };
        };

        test('an abort kills the decoder child, clears its timers and rejects', async () => {
            jest.useFakeTimers(FAKE_TIMERS);
            const { kill } = decoderChild();
            const controller = new AbortController();
            const removed = stoppedListening(controller.signal);
            const result = runDecoder('/decoder', '/input.mp4', frames, controller.signal);
            controller.abort();

            await expect(result).rejects.toThrow(CANCELLED);
            expect(kill).toHaveBeenCalledWith('SIGKILL');
            expect(jest.getTimerCount()).toBe(0);
            expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
        });

        test('a signal that is already aborted kills the decoder child at once', async () => {
            jest.useFakeTimers(FAKE_TIMERS);
            const { kill } = decoderChild();

            await expect(runDecoder('/decoder', '/input.mp4', frames, abortedSignal())).rejects.toThrow(CANCELLED);
            expect(kill).toHaveBeenCalledWith('SIGKILL');
            expect(jest.getTimerCount()).toBe(0);
        });

        test('stops listening for the abort once the decoder completes', async () => {
            jest.useFakeTimers(FAKE_TIMERS);
            const { child, kill } = decoderChild();
            const controller = new AbortController();
            const removed = stoppedListening(controller.signal);
            const result = runDecoder('/decoder', '/input.mp4', frames, controller.signal);
            child.emit('close', 0);

            await expect(result).resolves.toBeUndefined();
            expect(kill).not.toHaveBeenCalled();
            expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
        });
    });

    test('an abort while the decoder runs kills its child and removes the temporary directory', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        const kill = jest.fn();
        Object.assign(child, { kill, killed: false });
        spawn.mockImplementation(
            invalid((_executable: string, args: string[]) =>
                args.some((arg) => arg.endsWith('.jpg')) ? child : probeChild(),
            ),
        );
        const makeDirectory = jest.spyOn(fs, 'mkdtempSync');
        const controller = new AbortController();
        const extraction = extractNodeVideoFrames(
            'https://media.gurushots.com/clip.mp4',
            1,
            [0.2],
            () => '/decoder',
            controller.signal,
        );
        const rejected = expect(extraction).rejects.toThrow(CANCELLED);
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await until(() => spawn.mock.calls.length > 0);
        await jest.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(kill).not.toHaveBeenCalled();

        controller.abort();
        await rejected;

        expect(kill).toHaveBeenCalledWith('SIGKILL');
        expect(fs.existsSync(String(makeDirectory.mock.results[0]!.value))).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });
});
