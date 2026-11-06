import { isPlainObject } from '../../core/plainObject';
import {
    validateVideoFrameRequest,
    validateVideoMediaUrl,
    videoFrameTimestampMs,
} from '../../core/platform/videoMedia';

import type { CapacitorGlobals } from '../../core/types/capacitor';

const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_WAIT_MS = 10_000;
const MAX_FRAME_DIMENSION = 1280;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const MAX_VIDEO_BASE64_CHARS = Math.ceil(MAX_VIDEO_BYTES / 3) * 4;
const MAX_JPEG_BASE64_CHARS = Math.ceil(MAX_JPEG_BYTES / 3) * 4;

const waitForVideoEvent = (
    video: HTMLVideoElement,
    eventName: 'loadedmetadata' | 'seeked',
    start: () => void,
): Promise<void> =>
    new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            video.removeEventListener(eventName, success);
            video.removeEventListener('error', failure);
            callback();
        };
        const success = (): void => finish(resolve);
        const failure = (): void => finish(() => reject(new Error('Video frame decoding failed')));
        const timeout = setTimeout(
            () => finish(() => reject(new Error('Video frame decoding timed out'))),
            MAX_FRAME_WAIT_MS,
        );
        video.addEventListener(eventName, success, { once: true });
        video.addEventListener('error', failure, { once: true });
        try {
            start();
        } catch (error) {
            finish(() => reject(error));
        }
    });

/** Registers before seeking, then waits for both seek completion and the target frame presentation. */
const seekAndWaitForPresentedFrame = (video: HTMLVideoElement, seconds: number): Promise<void> => {
    if (typeof video.requestVideoFrameCallback !== 'function' || typeof video.cancelVideoFrameCallback !== 'function') {
        throw new Error('Video frame presentation callbacks are unavailable');
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let seeked = false;
        let presented = false;
        let callbackId: number | null = null;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            callback();
        };
        const completeWhenReady = (): void => {
            if (seeked && presented) finish(resolve);
        };
        const onSeeked = (): void => {
            seeked = true;
            completeWhenReady();
        };
        const onError = (): void => finish(() => reject(new Error('Video frame decoding failed')));
        const requestFrame = (): void => {
            callbackId = video.requestVideoFrameCallback((_now, metadata) => {
                if (Math.abs(metadata.mediaTime - seconds) <= 0.25) {
                    presented = true;
                    completeWhenReady();
                } else if (!settled) {
                    requestFrame();
                }
            });
        };
        const timeout = setTimeout(
            () => finish(() => reject(new Error('Video frame decoding timed out'))),
            MAX_FRAME_WAIT_MS,
        );
        video.addEventListener('seeked', onSeeked, { once: true });
        video.addEventListener('error', onError, { once: true });
        requestFrame();
        try {
            video.currentTime = seconds;
        } catch (error) {
            finish(() => reject(error));
        }
    });
};

const bytesFromBase64 = (base64: string): ArrayBuffer => {
    if (base64.length === 0 || base64.length > MAX_VIDEO_BASE64_CHARS) {
        throw new Error('Video media payload is outside the supported range');
    }
    const decoded = atob(base64);
    const buffer = new ArrayBuffer(decoded.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return buffer;
};

const dimensionsForFrame = (video: HTMLVideoElement): { width: number; height: number } => {
    if (
        !Number.isInteger(video.videoWidth) ||
        !Number.isInteger(video.videoHeight) ||
        video.videoWidth < 1 ||
        video.videoHeight < 1
    ) {
        throw new Error('Video frame dimensions are invalid');
    }
    const scale = Math.min(1, MAX_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
    return {
        width: Math.max(1, Math.floor(video.videoWidth * scale)),
        height: Math.max(1, Math.floor(video.videoHeight * scale)),
    };
};

const extractFrame = async (video: HTMLVideoElement, seconds: number): Promise<string> => {
    await seekAndWaitForPresentedFrame(video, seconds);
    const { width, height } = dimensionsForFrame(video);
    const canvas = document.createElement('canvas');
    try {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Video frame canvas is unavailable');
        context.drawImage(video, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg');
        if (!dataUrl.startsWith(JPEG_PREFIX) || dataUrl.length - JPEG_PREFIX.length > MAX_JPEG_BASE64_CHARS) {
            throw new Error('Video frame JPEG is too large');
        }
        return dataUrl;
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
};

/**
 * Downloads validated video bytes through the native no-cookie bridge, then
 * extracts ordered JPEG frames from a local Blob URL. This is deliberately a
 * foreground WebView adapter. The headless platform has no video decoder.
 */
const extractWebviewVideoFrames = async (
    rawUrl: string,
    durationMs: number,
    positions: readonly number[],
): Promise<string[]> => {
    const url = validateVideoMediaUrl(rawUrl);
    validateVideoFrameRequest(durationMs, positions);
    const plugin = (globalThis as CapacitorGlobals).Capacitor?.Plugins?.VideoMedia;
    if (!plugin) throw new Error('Video media plugin is unavailable');

    const response: unknown = await plugin.download({ url: url.toString() });
    if (!isPlainObject(response) || typeof response.base64 !== 'string') {
        throw new Error('Video media plugin returned an invalid payload');
    }
    const blobUrl = URL.createObjectURL(new Blob([bytesFromBase64(response.base64)], { type: 'video/mp4' }));
    const video = document.createElement('video');
    try {
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.width = 1;
        video.height = 1;
        video.style.position = 'fixed';
        video.style.left = '-10000px';
        video.style.top = '-10000px';
        document.body.append(video);
        await waitForVideoEvent(video, 'loadedmetadata', () => {
            video.src = blobUrl;
            video.load();
        });
        const frames: string[] = [];
        for (const position of positions) {
            frames.push(
                await extractFrame(video, videoFrameTimestampMs(durationMs, video.duration * 1_000, position) / 1_000),
            );
        }
        return frames;
    } finally {
        video.removeAttribute('src');
        try {
            video.load();
        } finally {
            video.remove();
            URL.revokeObjectURL(blobUrl);
        }
    }
};

export { extractWebviewVideoFrames };
