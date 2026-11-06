/**
 * Node video-frame extraction. The download, the probe and the decoder each stop
 * when they stall; no limit is placed on the clip itself. FFmpeg receives a local
 * filename only, never a server URL.
 */

import {
    validateVideoFrameRequest,
    validateVideoMediaUrl,
    videoFrameTimestampMs,
} from '../../core/platform/videoMedia';

const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DECODE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_WIDTH = 1_280;
const MAX_FRAME_HEIGHT = 720;
const MAX_PROBE_OUTPUT_BYTES = 1024;

const requireFs = (): typeof import('node:fs') => require('node:fs') as typeof import('node:fs');
const requireHttps = (): typeof import('node:https') => require('node:https') as typeof import('node:https');
const requireOs = (): typeof import('node:os') => require('node:os') as typeof import('node:os');
const requirePath = (): typeof import('node:path') => require('node:path') as typeof import('node:path');
const requireChildProcess = (): typeof import('node:child_process') =>
    require('node:child_process') as typeof import('node:child_process');

const probePathOf = (decoder: string): string =>
    requirePath().join(
        requirePath().dirname(decoder),
        requirePath().extname(decoder) === '.exe' ? 'ffprobe.exe' : 'ffprobe',
    );

const cancelledError = (): Error => new Error('Video extraction was cancelled');

/**
 * Calls `onAbort` once when `signal` aborts (at once when it already has) and returns the call that stops listening.
 */
const listenForAbort = (signal: AbortSignal | undefined, onAbort: () => void): (() => void) => {
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    return () => signal?.removeEventListener('abort', onAbort);
};

/**
 * Downloads an allowed media file without request credentials or redirect following,
 * streaming the body to `destination`. The socket idle timeout is
 * DOWNLOAD_IDLE_TIMEOUT_MS: a body that keeps arriving is never cut off. The promise
 * settles only after the write stream has closed, so the file is never open when
 * the caller removes it. An aborted `signal` fails the download with a cancellation error.
 */
const downloadVideo = async (url: URL, destination: string, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        let stopListening = (): void => {
            /* replaced once the abort listener is installed */
        };
        const connection: {
            request: import('node:http').ClientRequest | undefined;
            response: import('node:http').IncomingMessage | undefined;
            stream: import('node:fs').WriteStream | undefined;
            failure: Error | null;
        } = { request: undefined, response: undefined, stream: undefined, failure: null };
        const fail = (error: Error): void => {
            if (connection.failure) return;
            connection.failure = error;
            connection.request?.destroy(error);
            connection.response?.destroy?.(error);
            if (connection.stream) connection.stream.destroy();
            else {
                stopListening();
                reject(error);
            }
        };
        const openedRequest = requireHttps().request(
            url,
            {
                method: 'GET',
                headers: {},
                timeout: DOWNLOAD_IDLE_TIMEOUT_MS,
            },
            (receivedResponse) => {
                if (connection.failure) return;
                connection.response = receivedResponse;
                if (receivedResponse.statusCode !== 200) {
                    fail(new Error('Video download did not return HTTP 200'));
                    return;
                }
                const stream = requireFs().createWriteStream(destination, { flags: 'wx', mode: 0o600 });
                connection.stream = stream;
                let responseEnded = false;
                stream.on('error', (error) => fail(error));
                stream.on('drain', () => receivedResponse.resume());
                stream.once('close', () => {
                    stopListening();
                    if (connection.failure) reject(connection.failure);
                    else resolve();
                });
                receivedResponse.on('data', (chunk: Buffer) => {
                    if (connection.failure) return;
                    if (!stream.write(chunk)) receivedResponse.pause();
                });
                receivedResponse.once('aborted', () => fail(new Error('Video download was aborted')));
                receivedResponse.once('error', (error) => fail(error));
                receivedResponse.once('close', () => {
                    if (!responseEnded) fail(new Error('Video download closed before completion'));
                });
                receivedResponse.once('end', () => {
                    responseEnded = true;
                    stream.end();
                });
            },
        );
        connection.request = openedRequest;
        openedRequest.once('timeout', () => fail(new Error('Video download timed out')));
        openedRequest.once('error', (error) => fail(error));
        openedRequest.end();
        stopListening = listenForAbort(signal, () => fail(cancelledError()));
        // A failure that ran before this point (a synchronous request error) found no listener to stop.
        if (connection.failure) stopListening();
    });

type DecoderFrame = { output: string; timestamp: number };

/**
 * Reads the container duration in milliseconds, or `null` when the container reports none (`N/A`, empty, not a
 * positive number). A probe that exits non-zero or stalls rejects.
 */
const probeDuration = (probe: string, input: string, signal?: AbortSignal): Promise<number | null> =>
    new Promise((resolve, reject) => {
        let stopListening = (): void => {
            /* replaced once the abort listener is installed */
        };
        const child = requireChildProcess().spawn(
            probe,
            [
                '-threads',
                '1',
                '-protocol_whitelist',
                'file,pipe',
                '-v',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'default=noprint_wrappers=1:nokey=1',
                input,
            ],
            { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
        );
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let finished = false;
        const finish = (error: Error | null): void => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            stopListening();
            if (error) {
                if (!child.killed) child.kill('SIGKILL');
                reject(error);
            } else {
                const output = Buffer.concat(chunks, receivedBytes).toString('utf8').trim();
                const durationMs = /^\d+(?:\.\d+)?$/.test(output) ? Number(output) * 1_000 : Number.NaN;
                resolve(Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null);
            }
        };
        const timer = setTimeout(() => finish(new Error('Video probe timed out')), PROBE_TIMEOUT_MS);
        if (!child.stdout) {
            finish(new Error('Video probe returned no output stream'));
            return;
        }
        child.stdout.on('data', (chunk: Buffer) => {
            if (finished) return;
            receivedBytes += chunk.length;
            if (receivedBytes > MAX_PROBE_OUTPUT_BYTES) {
                finish(new Error('Video probe output exceeds the supported size'));
                return;
            }
            chunks.push(chunk);
        });
        child.stdout.once('error', (error) => finish(error));
        child.once('error', (error) => finish(error));
        child.once('close', (code) => finish(code === 0 ? null : new Error('Video probe failed')));
        stopListening = listenForAbort(signal, () => finish(cancelledError()));
        // An already aborted signal finished the work before this assignment found a listener to stop.
        if (finished) stopListening();
    });

const runDecoder = (
    decoder: string,
    input: string,
    frames: readonly DecoderFrame[],
    signal?: AbortSignal,
): Promise<void> =>
    new Promise((resolve, reject) => {
        let stopListening = (): void => {
            /* replaced once the abort listener is installed */
        };
        const args = [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-threads',
            '1',
            '-filter_threads',
            '1',
            '-protocol_whitelist',
            'file,pipe',
        ];
        for (const [index, { timestamp, output }] of frames.entries()) {
            args.push(
                '-ss',
                (timestamp / 1_000).toFixed(3),
                '-threads',
                '1',
                '-i',
                input,
                '-map',
                `${index}:v:0`,
                '-frames:v',
                '1',
                '-vf',
                `scale=${MAX_FRAME_WIDTH}:${MAX_FRAME_HEIGHT}:force_original_aspect_ratio=decrease`,
                '-threads',
                '1',
                '-c:v',
                'mjpeg',
                '-q:v',
                '3',
                output,
            );
        }
        const child = requireChildProcess().spawn(decoder, args, { stdio: 'ignore', windowsHide: true });
        let finished = false;
        const finish = (error: Error | null): void => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            clearInterval(outputSizeCheck);
            stopListening();
            if (error) {
                if (!child.killed) child.kill('SIGKILL');
                reject(error);
            } else resolve();
        };
        // One budget per requested frame: a heavy clip that needs more frames gets more time.
        const timer = setTimeout(() => {
            finish(new Error('Video decoder timed out'));
        }, DECODE_TIMEOUT_MS * frames.length);
        const outputSizeCheck = setInterval(() => {
            try {
                if (frames.some(({ output }) => requireFs().statSync(output).size > MAX_FRAME_BYTES)) {
                    finish(new Error('Video decoder produced an oversized JPEG frame'));
                }
            } catch (error) {
                if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
                    finish(error instanceof Error ? error : new Error('Video decoder output could not be read'));
                }
            }
        }, 25);
        child.once('error', (error) => finish(error));
        child.once('close', (code) => finish(code === 0 ? null : new Error('Video decoder failed')));
        stopListening = listenForAbort(signal, () => finish(cancelledError()));
        // An already aborted signal finished the work before this assignment found a listener to stop.
        if (finished) stopListening();
    });

const frameDataUrl = (path: string): string => {
    // Size-check and read through one fd so the file cannot change between the check and the read.
    const fs = requireFs();
    const fd = fs.openSync(path, 'r');
    try {
        if (fs.fstatSync(fd).size > MAX_FRAME_BYTES) {
            throw new Error('Video decoder produced an invalid JPEG frame');
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
            throw new Error('Video decoder produced an invalid JPEG frame');
        }
        return `data:image/jpeg;base64,${bytes.toString('base64')}`;
    } finally {
        fs.closeSync(fd);
    }
};

/**
 * Downloads one validated video to a private temporary directory and runs the
 * bundled decoder in a child process. Extraction has no rating or scoring rule. An aborted `signal` rejects before any
 * work, or ends the running download or decoder child (killed) and rejects.
 */
const extractNodeVideoFrames = async (
    rawUrl: string,
    durationMs: number,
    positions: readonly number[],
    decoderPath: () => string,
    signal?: AbortSignal,
): Promise<string[]> => {
    if (signal?.aborted) throw cancelledError();
    const url = validateVideoMediaUrl(rawUrl);
    validateVideoFrameRequest(durationMs, positions);
    const fs = requireFs();
    const path = requirePath();
    const directory = fs.mkdtempSync(path.join(requireOs().tmpdir(), 'gurushots-video-'));
    const input = path.join(directory, 'input.mp4');
    const outputs = positions.map((_, index) => path.join(directory, `frame-${index}.jpg`));
    try {
        await downloadVideo(url, input, signal);
        const decoder = decoderPath();
        const actualDurationMs = await probeDuration(probePathOf(decoder), input, signal);
        await runDecoder(
            decoder,
            input,
            outputs.map((output, index) => ({
                output,
                timestamp: videoFrameTimestampMs(durationMs, actualDurationMs, positions[index]!),
            })),
            signal,
        );
        return outputs.map(frameDataUrl);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
};

export {
    DECODE_TIMEOUT_MS,
    DOWNLOAD_IDLE_TIMEOUT_MS,
    MAX_FRAME_BYTES,
    MAX_PROBE_OUTPUT_BYTES,
    downloadVideo,
    extractNodeVideoFrames,
    probeDuration,
    runDecoder,
};
