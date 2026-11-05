jest.unmock('node:fs');
jest.unmock('node:os');
jest.unmock('node:path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { invalid } from '../../helpers/invalid';

const request = jest.fn();
const spawn = jest.fn<ChildProcess, [string, string[], { stdio: 'ignore'; windowsHide: boolean }]>();
jest.mock('node:https', () => ({ request }));
jest.mock('node:child_process', () => ({ spawn }));

import { extractNodeVideoFrames } from '../../../src/ts/platforms/node/videoFrames';

const response = (statusCode: number, headers: Record<string, string> = {}): IncomingMessage => {
    const stream = new EventEmitter() as IncomingMessage;
    Object.assign(stream, { headers, resume: jest.fn(), statusCode });
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

describe('node video frame extraction', () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    test('downloads an allowed MP4, invokes an isolated child, returns ordered JPEG data URLs, and removes temp files', async () => {
        const res = response(200, { 'content-length': '9007199254740992' });
        requestFor(res);
        spawn.mockImplementationOnce(
            invalid((_decoder: string, args: string[]) => {
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
        const decoderArgs = spawn.mock.calls[0][1];
        expect(decoderArgs.filter((arg) => /^[0-9]+:v:0$/.test(arg))).toEqual(['0:v:0', '1:v:0', '2:v:0']);
    });

    test('rejects an HTTP refusal and removes its temporary directory', async () => {
        const res = response(302);
        requestFor(res);
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow('HTTP 200');
        expect(res.resume).not.toHaveBeenCalled();
    });

    test('rejects declared and streamed downloads that exceed the byte limit', async () => {
        const declared = response(200, { 'content-length': String(32 * 1024 * 1024 + 1) });
        requestFor(declared);
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow('supported size');

        const streamed = response(200);
        requestFor(streamed);
        setImmediate(() => streamed.emit('data', Buffer.alloc(32 * 1024 * 1024 + 1)));
        await expect(
            extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow('supported size');
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
        jest.useFakeTimers();
        const res = response(200);
        requestFor(res);
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(30_000);
        await rejected;
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
        spawn.mockImplementationOnce(
            invalid(() => {
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
        spawn.mockImplementationOnce(
            invalid((_decoder: string, args: string[]) => {
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
        spawn.mockImplementationOnce(
            invalid((_decoder: string, args: string[]) => {
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

    test('rejects a non-Error download write failure', async () => {
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
            throw 'disk unavailable';
        });
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await expect(extraction).rejects.toThrow('could not be written');
    });

    test('propagates an Error from the download write boundary', async () => {
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
            throw new Error('disk unavailable');
        });
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await expect(extraction).rejects.toThrow('disk unavailable');
    });

    test('continues after a size poll finds only bounded output', async () => {
        jest.useFakeTimers();
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { kill: jest.fn(), killed: false });
        spawn.mockImplementationOnce(
            invalid((_decoder: string, args: string[]) => {
                fs.writeFileSync(args.find((arg) => arg.endsWith('.jpg'))!, Buffer.from([0xff, 0xd8, 1]));
                return child;
            }),
        );
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(25);
        child.emit('close', 0);
        await expect(extraction).resolves.toEqual(['data:image/jpeg;base64,/9gB']);
    });

    test('rejects a non-Error frame-monitoring failure', async () => {
        jest.useFakeTimers();
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        const kill = jest.fn();
        Object.assign(child, { kill, killed: false });
        spawn.mockReturnValueOnce(child);
        jest.spyOn(fs, 'statSync').mockImplementation(() => {
            throw null;
        });
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('output could not be read');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(25);
        await rejected;
        expect(kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('kills a decoder that exceeds its aggregate deadline', async () => {
        jest.useFakeTimers();
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        const kill = jest.fn();
        Object.assign(child, { kill, killed: false });
        spawn.mockReturnValueOnce(child);
        jest.spyOn(fs, 'statSync').mockImplementation(() => {
            throw Object.assign(new Error('not generated yet'), { code: 'ENOENT' });
        });
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('timed out');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(30_000);
        await rejected;
        expect(kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('kills a decoder when a generated frame exceeds the size bound', async () => {
        jest.useFakeTimers();
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        const kill = jest.fn();
        Object.assign(child, { kill, killed: false });
        spawn.mockReturnValueOnce(child);
        jest.spyOn(fs, 'statSync').mockReturnValue({ size: 2 * 1024 * 1024 + 1 } as fs.Stats);
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('oversized JPEG');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(25);
        await rejected;
        expect(kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('kills the decoder and clears its timers when output monitoring fails', async () => {
        jest.useFakeTimers();
        const res = response(200, { 'content-length': '3' });
        requestFor(res);
        const child = new EventEmitter() as ChildProcess;
        const kill = jest.fn();
        Object.assign(child, { kill, killed: false });
        spawn.mockReturnValueOnce(child);
        jest.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => {
            if (String(file).endsWith('.jpg')) throw Object.assign(new Error('disk failed'), { code: 'EIO' });
            return fs.statSync(file);
        }) as typeof fs.statSync);
        const extraction = extractNodeVideoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2], () => '/decoder');
        const rejected = expect(extraction).rejects.toThrow('disk failed');
        res.emit('data', Buffer.from('mp4'));
        res.emit('end');
        await jest.advanceTimersByTimeAsync(0);
        expect(spawn).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(25);
        await rejected;
        expect(kill).toHaveBeenCalledWith('SIGKILL');
        expect(jest.getTimerCount()).toBe(0);
    });

    test('rejects an invalid media URL before opening a network request', async () => {
        await expect(
            extractNodeVideoFrames('https://example.test/clip.mp4', 1, [0.2], () => '/decoder'),
        ).rejects.toThrow('not an allowed HTTPS MP4');
        expect(request).not.toHaveBeenCalled();
    });
});
