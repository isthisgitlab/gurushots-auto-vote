import { isPlainObject } from '../../core/plainObject';
import { validateVideoFrameRequest, validateVideoMediaUrl } from '../../core/platform/videoMedia';

import type { CapacitorGlobals } from '../../core/types/capacitor';

const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const MAX_JPEG_BASE64_CHARS = Math.ceil(MAX_JPEG_BYTES / 3) * 4;

const invalidPayload = (): Error => new Error('Video media plugin returned an invalid payload');

/** One frame must be a JPEG data URL whose bytes start with the JPEG marker (FF D8) and fit the 2 MiB bound. */
const checkFrame = (frame: unknown): string => {
    if (typeof frame !== 'string' || !frame.startsWith(JPEG_PREFIX)) throw invalidPayload();
    const base64 = frame.slice(JPEG_PREFIX.length);
    if (base64.length > MAX_JPEG_BASE64_CHARS) throw new Error('Video frame JPEG is too large');
    let decoded: string;
    try {
        decoded = atob(base64);
    } catch {
        throw invalidPayload();
    }
    if (decoded.charCodeAt(0) !== 0xff || decoded.charCodeAt(1) !== 0xd8) throw invalidPayload();
    if (decoded.length > MAX_JPEG_BYTES) throw new Error('Video frame JPEG is too large');
    return frame;
};

const checkFrames = (response: unknown, count: number): string[] => {
    if (!isPlainObject(response) || !Array.isArray(response.frames) || response.frames.length !== count) {
        throw invalidPayload();
    }
    return response.frames.map(checkFrame);
};

/**
 * Asks the native `VideoMedia` plugin to download and decode the clip: the native side owns the no-cookie download,
 * the temp file and the frame decoding, and only bounded JPEG data URLs come back over the bridge. This is
 * deliberately a foreground WebView adapter. The headless platform has no video decoder.
 *
 * An abort stops the native job by id; the pending extraction then rejects from the native side.
 */
const extractWebviewVideoFrames = async (
    rawUrl: string,
    durationMs: number,
    positions: readonly number[],
    signal?: AbortSignal,
): Promise<string[]> => {
    const url = validateVideoMediaUrl(rawUrl);
    validateVideoFrameRequest(durationMs, positions);
    const plugin = (globalThis as CapacitorGlobals).Capacitor?.Plugins?.VideoMedia;
    if (!plugin) throw new Error('Video media plugin is unavailable');
    if (signal?.aborted) throw new Error('Video extraction was cancelled');

    const jobId = crypto.randomUUID();
    const onAbort = (): void => {
        // A failed cancel changes nothing: the extraction call below still settles from the native side.
        plugin.cancel({ jobId }).catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const response: unknown = await plugin.extractFrames({
            jobId,
            url: url.toString(),
            durationMs,
            positions: [...positions],
        });
        return checkFrames(response, positions.length);
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
};

export { extractWebviewVideoFrames };
