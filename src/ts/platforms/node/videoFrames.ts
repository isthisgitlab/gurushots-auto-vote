/**
 * Node video-frame extraction. The media download and the decoder are both
 * bounded. FFmpeg receives a local filename only, never a server URL.
 */

import { validateVideoFrameRequest, validateVideoMediaUrl } from '../../core/platform/videoMedia';

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DECODE_TIMEOUT_MS = 30_000;
const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_WIDTH = 1_280;
const MAX_FRAME_HEIGHT = 720;
const MAX_DECODED_PIXELS = MAX_FRAME_WIDTH * MAX_FRAME_HEIGHT;

const requireFs = (): typeof import('node:fs') => require('node:fs') as typeof import('node:fs');
const requireHttps = (): typeof import('node:https') => require('node:https') as typeof import('node:https');
const requireOs = (): typeof import('node:os') => require('node:os') as typeof import('node:os');
const requirePath = (): typeof import('node:path') => require('node:path') as typeof import('node:path');
const requireChildProcess = (): typeof import('node:child_process') =>
    require('node:child_process') as typeof import('node:child_process');

const contentLength = (header: string | string[] | undefined): number | null => {
    if (typeof header !== 'string' || !/^[0-9]+$/.test(header)) return null;
    const bytes = Number(header);
    return Number.isSafeInteger(bytes) ? bytes : null;
};

/** Downloads an allowed MP4 without request credentials or redirect following. */
const downloadVideo = async (url: URL, destination: string): Promise<void> =>
    new Promise((resolve, reject) => {
        let response: import('node:http').IncomingMessage | undefined;
        const connection: {
            request: import('node:http').ClientRequest | undefined;
            deadline: ReturnType<typeof setTimeout> | undefined;
        } = { request: undefined, deadline: undefined };
        let settled = false;
        const finish = (error: Error | null): void => {
            if (settled) return;
            settled = true;
            if (connection.deadline !== undefined) clearTimeout(connection.deadline);
            if (error) {
                connection.request?.destroy(error);
                response?.destroy?.(error);
                reject(error);
            } else resolve();
        };
        const openedRequest = requireHttps().request(
            url,
            {
                method: 'GET',
                headers: {},
                timeout: DOWNLOAD_TIMEOUT_MS,
            },
            (receivedResponse) => {
                response = receivedResponse;
                if (response.statusCode !== 200) {
                    finish(new Error('Video download did not return HTTP 200'));
                    return;
                }
                const declaredBytes = contentLength(response.headers['content-length']);
                if (declaredBytes !== null && declaredBytes > MAX_VIDEO_BYTES) {
                    finish(new Error('Video download exceeds the supported size'));
                    return;
                }
                const chunks: Buffer[] = [];
                let receivedBytes = 0;
                response.on('data', (chunk: Buffer) => {
                    receivedBytes += chunk.length;
                    if (receivedBytes > MAX_VIDEO_BYTES) {
                        finish(new Error('Video download exceeds the supported size'));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.once('aborted', () => finish(new Error('Video download was aborted')));
                response.once('error', (error) => finish(error));
                response.once('close', () => {
                    if (!settled) finish(new Error('Video download closed before completion'));
                });
                response.once('end', () => {
                    try {
                        requireFs().writeFileSync(destination, Buffer.concat(chunks), { mode: 0o600 });
                        finish(null);
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error('Video download could not be written'));
                    }
                });
            },
        );
        connection.request = openedRequest;
        connection.deadline = setTimeout(() => finish(new Error('Video download timed out')), DOWNLOAD_TIMEOUT_MS);
        if (settled) clearTimeout(connection.deadline);
        openedRequest.once('timeout', () => finish(new Error('Video download timed out')));
        openedRequest.once('error', (error) => finish(error));
        openedRequest.end();
    });

type DecoderFrame = { output: string; timestamp: number };

const runDecoder = (decoder: string, input: string, frames: readonly DecoderFrame[]): Promise<void> =>
    new Promise((resolve, reject) => {
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
                '-max_pixels',
                String(MAX_DECODED_PIXELS),
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
            if (error) {
                if (!child.killed) child.kill('SIGKILL');
                reject(error);
            } else resolve();
        };
        const timer = setTimeout(() => {
            finish(new Error('Video decoder timed out'));
        }, DECODE_TIMEOUT_MS);
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
    });

const frameDataUrl = (path: string): string => {
    if (requireFs().statSync(path).size > MAX_FRAME_BYTES) {
        throw new Error('Video decoder produced an invalid JPEG frame');
    }
    const bytes = requireFs().readFileSync(path);
    if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new Error('Video decoder produced an invalid JPEG frame');
    }
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};

/**
 * Downloads one validated video to a private temporary directory and runs the
 * bundled decoder in a child process. Extraction has no rating or scoring rule.
 */
const extractNodeVideoFrames = async (
    rawUrl: string,
    durationMs: number,
    positions: readonly number[],
    decoderPath: () => string,
): Promise<string[]> => {
    const url = validateVideoMediaUrl(rawUrl);
    validateVideoFrameRequest(durationMs, positions);
    const fs = requireFs();
    const path = requirePath();
    const directory = fs.mkdtempSync(path.join(requireOs().tmpdir(), 'gurushots-video-'));
    const input = path.join(directory, 'input.mp4');
    const outputs = positions.map((_, index) => path.join(directory, `frame-${index}.jpg`));
    try {
        await downloadVideo(url, input);
        await runDecoder(
            decoderPath(),
            input,
            outputs.map((output, index) => ({ output, timestamp: durationMs * positions[index]! })),
        );
        return outputs.map(frameDataUrl);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
};

export {
    DECODE_TIMEOUT_MS,
    DOWNLOAD_TIMEOUT_MS,
    MAX_FRAME_BYTES,
    MAX_VIDEO_BYTES,
    downloadVideo,
    extractNodeVideoFrames,
    runDecoder,
};
