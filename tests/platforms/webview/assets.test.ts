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

    afterEach(() => {
        (globalThis as CapacitorGlobals).Capacitor = originalCapacitor;
    });

    test('is the native-bridge adapter: one extractFrames call, frames passed through in order', async () => {
        const frame = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0x01]).toString('base64')}`;
        const extractFrames = jest.fn<
            ReturnType<VideoMediaPlugin['extractFrames']>,
            Parameters<VideoMediaPlugin['extractFrames']>
        >(async () => ({ frames: [frame, frame] }));
        (globalThis as CapacitorGlobals).Capacitor = {
            Plugins: { VideoMedia: { extractFrames, cancel: jest.fn(async () => undefined) } },
        };

        await expect(
            createWebviewAssets().videoFrames('https://media.gurushots.com/clip.mp4', 10_000, [0.2, 0.8]),
        ).resolves.toEqual([frame, frame]);
        expect(extractFrames).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://media.gurushots.com/clip.mp4',
                durationMs: 10_000,
                positions: [0.2, 0.8],
            }),
        );
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
