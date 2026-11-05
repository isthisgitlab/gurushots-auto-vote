/** @jest-environment @happy-dom/jest-environment */
/**
 * The webview family's assets member: the readJson composition over the
 * shared fetchAsset reader, the native video bridge, and the vision model.
 */

import { invalid } from '../../helpers/invalid';
import { createWebviewAssets } from '../../../src/ts/platforms/webview/assets';

import type { CapacitorGlobals, VideoMediaPlugin } from '../../../src/ts/core/types/capacitor';

const realFetch = globalThis.fetch;
const mockTransformers = { env: {}, pipeline: jest.fn() };
jest.mock('@huggingface/transformers', () => mockTransformers);

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('videoFrames', () => {
    const originalCapacitor = (globalThis as CapacitorGlobals).Capacitor;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;

    let revokeObjectUrl: jest.MockedFunction<typeof URL.revokeObjectURL>;
    let seekTimes: number[];
    let presentationTimes: number[];
    let drawTimes: number[];
    let lifecycle: string[];
    let video: HTMLVideoElement;
    let canvas: HTMLCanvasElement;

    const installMediaDom = (frameDataUrl = 'data:image/jpeg;base64,AAE=', width = 2560, height = 1440): void => {
        seekTimes = [];
        presentationTimes = [];
        drawTimes = [];
        lifecycle = [];
        let frameCallback: VideoFrameRequestCallback | null = null;
        video = document.createElement('video');
        canvas = document.createElement('canvas');
        Object.defineProperties(video, {
            videoWidth: { configurable: true, value: width },
            videoHeight: { configurable: true, value: height },
            load: {
                configurable: true,
                writable: true,
                value: jest.fn(() => {
                    if (video.getAttribute('src'))
                        queueMicrotask(() => video.dispatchEvent(new Event('loadedmetadata')));
                }),
            },
            currentTime: {
                configurable: true,
                set: (value: number) => {
                    lifecycle.push('seek');
                    seekTimes.push(value);
                    const callback = frameCallback;
                    if (callback) {
                        queueMicrotask(() => {
                            presentationTimes.push(value);
                            callback(0, invalid<VideoFrameCallbackMetadata>({ mediaTime: value }));
                        });
                    }
                    queueMicrotask(() => video.dispatchEvent(new Event('seeked')));
                },
            },
            requestVideoFrameCallback: {
                configurable: true,
                value: jest.fn((callback: VideoFrameRequestCallback) => {
                    lifecycle.push('request-frame');
                    frameCallback = callback;
                    return 1;
                }),
            },
            cancelVideoFrameCallback: { configurable: true, value: jest.fn() },
        });
        Object.defineProperties(canvas, {
            getContext: {
                configurable: true,
                value: jest.fn(() => ({ drawImage: jest.fn(() => drawTimes.push(seekTimes.at(-1) ?? 0)) })),
            },
            toDataURL: { configurable: true, value: jest.fn(() => frameDataUrl) },
        });
        jest.spyOn(document, 'createElement').mockImplementation(
            invalid<typeof document.createElement>(
                jest.fn((tagName: string) => (tagName === 'video' ? video : canvas)),
            ),
        );
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:video') });
        revokeObjectUrl = jest.fn();
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    };

    beforeEach(() => {
        (globalThis as CapacitorGlobals).Capacitor = {
            Plugins: { VideoMedia: { download: jest.fn(async () => ({ base64: 'AAE=' })) } },
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectUrl });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectUrl });
        (globalThis as CapacitorGlobals).Capacitor = originalCapacitor;
    });

    test('downloads through the native bridge, seeks in requested order, and releases every DOM resource', async () => {
        installMediaDom();

        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 10_000, [0.2, 0.5, 0.8]),
        ).resolves.toEqual([
            'data:image/jpeg;base64,AAE=',
            'data:image/jpeg;base64,AAE=',
            'data:image/jpeg;base64,AAE=',
        ]);

        expect((globalThis as CapacitorGlobals).Capacitor?.Plugins?.VideoMedia?.download).toHaveBeenCalledWith({
            url: 'https://media.gurushots.com/clip.mp4',
        });
        expect(seekTimes).toEqual([2, 5, 8]);
        expect(presentationTimes).toEqual([2, 5, 8]);
        expect(drawTimes).toEqual([2, 5, 8]);
        expect(lifecycle).toEqual(['request-frame', 'seek', 'request-frame', 'seek', 'request-frame', 'seek']);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(video.parentElement).toBeNull();
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');
    });

    test('rejects before a native request when the core video boundary rejects the request', async () => {
        await expect(
            createWebviewAssets().videoFrames('http://media.gurushots.com/clip.mp4', 10_000, [0.2]),
        ).rejects.toThrow('allowed HTTPS MP4');
        expect((globalThis as CapacitorGlobals).Capacitor?.Plugins?.VideoMedia?.download).not.toHaveBeenCalled();
    });

    test('rejects a missing native plugin', async () => {
        (globalThis as CapacitorGlobals).Capacitor = { Plugins: {} };
        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('plugin is unavailable');
    });

    test('rejects an invalid native payload before creating media resources', async () => {
        (globalThis as CapacitorGlobals).Capacitor = {
            Plugins: {
                VideoMedia: { download: invalid<VideoMediaPlugin['download']>(jest.fn(async () => ({ base64: 1 }))) },
            },
        };
        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('invalid payload');
    });

    test('rejects an empty or oversized native base64 payload before creating media resources', async () => {
        for (const base64 of ['', 'A'.repeat(44_739_245)]) {
            (globalThis as CapacitorGlobals).Capacitor = {
                Plugins: { VideoMedia: { download: jest.fn(async () => ({ base64 })) } },
            };
            await expect(
                createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
            ).rejects.toThrow('payload is outside the supported range');
        }
    });

    test('cleans up the Blob URL when video decoding fails', async () => {
        installMediaDom();
        video.load = jest.fn(() => queueMicrotask(() => video.dispatchEvent(new Event('error'))));

        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('decoding failed');
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');
        expect(canvas.width).toBe(300);
        expect(canvas.height).toBe(150);
    });

    test('cleans up after a synchronous media load failure and a bounded metadata wait', async () => {
        installMediaDom();
        video.load = jest.fn(() => {
            throw new Error('load failed');
        });
        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('load failed');
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');

        installMediaDom();
        video.load = jest.fn();
        jest.useFakeTimers();
        try {
            const result = createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]);
            const expected = expect(result).rejects.toThrow('decoding timed out');
            await jest.advanceTimersByTimeAsync(0);
            await jest.advanceTimersByTimeAsync(10_000);
            await expected;
        } finally {
            jest.useRealTimers();
        }
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');
    });

    test('keeps a synchronously ready video ready when load throws afterwards', async () => {
        installMediaDom();
        const originalLoad = video.load;
        video.load = jest
            .fn()
            .mockImplementationOnce(() => {
                video.dispatchEvent(new Event('loadedmetadata'));
                throw new Error('after metadata');
            })
            .mockImplementation(originalLoad);

        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).resolves.toEqual(['data:image/jpeg;base64,AAE=']);
    });

    test('bounds a seek that does not present a frame', async () => {
        installMediaDom();
        Object.defineProperty(video, 'requestVideoFrameCallback', {
            configurable: true,
            value: jest.fn(() => 7),
        });
        jest.useFakeTimers();
        try {
            const result = createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]);
            const expected = expect(result).rejects.toThrow('decoding timed out');
            await jest.advanceTimersByTimeAsync(0);
            await jest.advanceTimersByTimeAsync(10_000);
            await expected;
        } finally {
            jest.useRealTimers();
        }
        expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');
    });

    test('rejects invalid dimensions and an invalid JPEG data URL', async () => {
        installMediaDom(undefined, 0);
        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('frame dimensions are invalid');

        installMediaDom('data:image/png;base64,AAE=');
        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('JPEG is too large');
    });

    test('refuses missing frame presentation callbacks', async () => {
        installMediaDom();
        Object.defineProperty(video, 'requestVideoFrameCallback', { configurable: true, value: undefined });
        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('presentation callbacks are unavailable');

        installMediaDom();
        Object.defineProperty(video, 'cancelVideoFrameCallback', { configurable: true, value: undefined });
        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('presentation callbacks are unavailable');
    });

    test('retries a stale frame presentation and cleans up a seek-setter failure', async () => {
        installMediaDom();
        let callbackCount = 0;
        Object.defineProperty(video, 'requestVideoFrameCallback', {
            configurable: true,
            value: jest.fn((callback: VideoFrameRequestCallback) => {
                const mediaTime = callbackCount++ === 0 ? 0 : 2;
                queueMicrotask(() => callback(0, invalid<VideoFrameCallbackMetadata>({ mediaTime })));
                return callbackCount;
            }),
        });
        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 10_000, [0.2]),
        ).resolves.toEqual(['data:image/jpeg;base64,AAE=']);
        expect(callbackCount).toBe(2);

        installMediaDom();
        Object.defineProperty(video, 'currentTime', {
            configurable: true,
            set: () => {
                throw new Error('seek failed');
            },
        });
        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('seek failed');
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');
    });

    test('ignores a stale presentation after a seek error and closes the pending callback', async () => {
        installMediaDom();
        let frameCallback: VideoFrameRequestCallback;
        Object.defineProperty(video, 'requestVideoFrameCallback', {
            configurable: true,
            value: jest.fn((callback: VideoFrameRequestCallback) => {
                frameCallback = callback;
                return 7;
            }),
        });
        Object.defineProperty(video, 'cancelVideoFrameCallback', {
            configurable: true,
            value: jest.fn(() => frameCallback(0, invalid<VideoFrameCallbackMetadata>({ mediaTime: 1 }))),
        });
        Object.defineProperty(video, 'currentTime', {
            configurable: true,
            set: () => {
                video.dispatchEvent(new Event('error'));
                throw new Error('after seek error');
            },
        });

        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('decoding failed');
        expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');
    });

    test('rejects a synchronous frame-registration error before a callback ID exists', async () => {
        installMediaDom();
        Object.defineProperty(video, 'requestVideoFrameCallback', {
            configurable: true,
            value: jest.fn(() => {
                video.dispatchEvent(new Event('error'));
                return 7;
            }),
        });

        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('decoding failed');
        expect(video.cancelVideoFrameCallback).not.toHaveBeenCalled();
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');
    });

    test('rejects an unavailable frame canvas and releases the Blob URL', async () => {
        installMediaDom();
        Object.defineProperty(canvas, 'getContext', { configurable: true, value: jest.fn(() => null) });

        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('canvas is unavailable');
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');
    });

    test('rejects a decoded JPEG that exceeds the output bound and still releases the canvas', async () => {
        installMediaDom(`data:image/jpeg;base64,${'A'.repeat(2_796_205)}`);

        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 1, [0.2]),
        ).rejects.toThrow('JPEG is too large');
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:video');
    });
});

describe('readJson', () => {
    test('it parses the fetched text', async () => {
        globalThis.fetch = invalid<typeof fetch>(
            jest.fn(async () => ({ ok: true, status: 200, text: async () => '{"a":1}' })),
        );
        await expect(createWebviewAssets().readJson('semantic-vectors.json')).resolves.toEqual({ a: 1 });
    });
});

describe('visionModel', () => {
    test('the model lives in the web root, and inference runs on the wasm backend', () => {
        const model = createWebviewAssets().visionModel;
        expect(model.location()).toBe('./');
        expect(model.device).toBe('wasm');
    });

    test('bundled is the model config fetch: ok true, a miss and a failed fetch are not', async () => {
        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: true, status: 200 })));
        await expect(createWebviewAssets().visionModel.bundled()).resolves.toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledWith('vision-model/config.json');

        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => ({ ok: false, status: 404 })));
        await expect(createWebviewAssets().visionModel.bundled()).resolves.toBe(false);

        globalThis.fetch = invalid<typeof fetch>(jest.fn(async () => Promise.reject(new Error('offline'))));
        await expect(createWebviewAssets().visionModel.bundled()).resolves.toBe(false);
    });

    test('loadTransformers imports the package', async () => {
        const loaded = await createWebviewAssets().visionModel.loadTransformers();
        expect(loaded.pipeline).toBe(mockTransformers.pipeline);
    });
});
