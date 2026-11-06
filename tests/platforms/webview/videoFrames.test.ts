/**
 * The webview video adapter: validation through the core validators, one native extractFrames call under a fresh job
 * id, an abort that cancels that job, and a strict check of the payload that comes back over the bridge.
 */

import { invalid } from '../../helpers/invalid';
import { extractWebviewVideoFrames } from '../../../src/ts/platforms/webview/videoFrames';

import type { CapacitorGlobals, VideoMediaPlugin } from '../../../src/ts/core/types/capacitor';

type ExtractFrames = VideoMediaPlugin['extractFrames'];
type Cancel = VideoMediaPlugin['cancel'];

const URL_OK = 'https://media.gurushots.com/clip.mp4';
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const JPEG_PREFIX = 'data:image/jpeg;base64,';

const jpegDataUrl = (size = 3): string => {
    const bytes = Buffer.alloc(size);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    return `${JPEG_PREFIX}${bytes.toString('base64')}`;
};

const originalCapacitor = (globalThis as CapacitorGlobals).Capacitor;

let extractFrames: jest.MockedFunction<ExtractFrames>;
let cancel: jest.MockedFunction<Cancel>;

const install = (): void => {
    (globalThis as CapacitorGlobals).Capacitor = { Plugins: { VideoMedia: { extractFrames, cancel } } };
};

beforeEach(() => {
    extractFrames = jest.fn<ReturnType<ExtractFrames>, Parameters<ExtractFrames>>(async () => ({
        frames: [jpegDataUrl()],
    }));
    cancel = jest.fn<ReturnType<Cancel>, Parameters<Cancel>>(async () => undefined);
    install();
});

afterEach(() => {
    jest.restoreAllMocks();
    (globalThis as CapacitorGlobals).Capacitor = originalCapacitor;
});

describe('extractWebviewVideoFrames request', () => {
    test('sends one extractFrames call with a fresh random job id and the validated request', async () => {
        const randomUuid = jest
            .spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
            .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
        const positions = [0.5];

        await extractWebviewVideoFrames(`${URL_OK}?sig=abc`, 10_000, positions);
        await extractWebviewVideoFrames(URL_OK, 10_000, positions);

        expect(randomUuid).toHaveBeenCalledTimes(2);
        expect(extractFrames).toHaveBeenNthCalledWith(1, {
            jobId: '11111111-1111-4111-8111-111111111111',
            url: `${URL_OK}?sig=abc`,
            durationMs: 10_000,
            positions: [0.5],
        });
        expect(extractFrames.mock.calls[1]?.[0].jobId).toBe('22222222-2222-4222-8222-222222222222');
        // The plugin gets its own copy, never the caller's array.
        expect(extractFrames.mock.calls[0]?.[0].positions).not.toBe(positions);
        expect(cancel).not.toHaveBeenCalled();
    });

    test('returns the frames in the order the plugin answered', async () => {
        const first = jpegDataUrl(3);
        const second = jpegDataUrl(5);
        extractFrames.mockResolvedValueOnce({ frames: [first, second] });

        await expect(extractWebviewVideoFrames(URL_OK, 10_000, [0.2, 0.8])).resolves.toEqual([first, second]);
    });

    test.each([
        ['an URL off the allowed host', 'https://example.com/clip.mp4', 10_000, [0.5], 'allowed GuruShots media URL'],
        ['a duration out of range', URL_OK, 0, [0.5], 'duration is outside'],
        ['no positions', URL_OK, 10_000, [], 'At least one'],
        ['too many positions', URL_OK, 10_000, Array.from({ length: 9 }, () => 0.5), 'Too many'],
        ['a position out of range', URL_OK, 10_000, [1.5], 'between zero and one'],
    ])('rejects %s before calling the plugin', async (_label, url, duration, positions, message) => {
        await expect(extractWebviewVideoFrames(url, duration, positions)).rejects.toThrow(message);
        expect(extractFrames).not.toHaveBeenCalled();
    });

    test('rejects a missing native plugin', async () => {
        (globalThis as CapacitorGlobals).Capacitor = { Plugins: {} };
        await expect(extractWebviewVideoFrames(URL_OK, 10_000, [0.5])).rejects.toThrow('plugin is unavailable');

        (globalThis as CapacitorGlobals).Capacitor = undefined;
        await expect(extractWebviewVideoFrames(URL_OK, 10_000, [0.5])).rejects.toThrow('plugin is unavailable');
    });

    test('passes a native rejection through', async () => {
        extractFrames.mockRejectedValueOnce(new Error('Video extraction was cancelled'));
        await expect(extractWebviewVideoFrames(URL_OK, 10_000, [0.5])).rejects.toThrow('was cancelled');
    });
});

describe('extractWebviewVideoFrames abort', () => {
    test('an already-aborted signal rejects without calling the plugin', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(extractWebviewVideoFrames(URL_OK, 10_000, [0.5], controller.signal)).rejects.toThrow(
            'Video extraction was cancelled',
        );
        expect(extractFrames).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
    });

    test('an abort during the call cancels the native job by its id', async () => {
        const controller = new AbortController();
        let rejectCall: (error: Error) => void = () => undefined;
        extractFrames.mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    rejectCall = reject;
                }),
        );
        const result = extractWebviewVideoFrames(URL_OK, 10_000, [0.5], controller.signal);
        const settled = expect(result).rejects.toThrow('Video extraction was cancelled');

        controller.abort();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledWith({ jobId: extractFrames.mock.calls[0]?.[0].jobId });
        rejectCall(new Error('Video extraction was cancelled'));
        await settled;
    });

    test('a failed cancel changes nothing about how the extraction settles', async () => {
        const controller = new AbortController();
        cancel.mockRejectedValueOnce(new Error('bridge gone'));
        let rejectCall: (error: Error) => void = () => undefined;
        extractFrames.mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    rejectCall = reject;
                }),
        );
        const result = extractWebviewVideoFrames(URL_OK, 10_000, [0.5], controller.signal);
        const settled = expect(result).rejects.toThrow('timed out');

        controller.abort();
        await Promise.resolve();
        rejectCall(new Error('Video extraction timed out'));
        await settled;
    });

    test('removes the abort listener once the call settles, success or failure', async () => {
        const controller = new AbortController();
        const add = jest.spyOn(controller.signal, 'addEventListener');
        const remove = jest.spyOn(controller.signal, 'removeEventListener');

        await extractWebviewVideoFrames(URL_OK, 10_000, [0.5], controller.signal);
        extractFrames.mockRejectedValueOnce(new Error('native failure'));
        await expect(extractWebviewVideoFrames(URL_OK, 10_000, [0.5], controller.signal)).rejects.toThrow(
            'native failure',
        );

        expect(add).toHaveBeenCalledTimes(2);
        expect(remove).toHaveBeenCalledTimes(2);
        expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
        controller.abort();
        expect(cancel).not.toHaveBeenCalled();
    });
});

describe('extractWebviewVideoFrames payload', () => {
    const rejects = async (payload: unknown, message: string, positions: number[] = [0.5]): Promise<void> => {
        extractFrames.mockResolvedValueOnce(invalid<Awaited<ReturnType<ExtractFrames>>>(payload));
        await expect(extractWebviewVideoFrames(URL_OK, 10_000, positions)).rejects.toThrow(message);
    };

    test.each([
        ['null', null],
        ['a string', 'frames'],
        ['an array', []],
        ['an object without frames', {}],
        ['frames that are not an array', { frames: 'x' }],
        ['too few frames', { frames: [] }],
        ['too many frames', { frames: [jpegDataUrl(), jpegDataUrl()] }],
    ])('rejects %s', async (_label, payload) => {
        await rejects(payload, 'invalid payload');
    });

    test('rejects a count that differs from the number of positions', async () => {
        await rejects({ frames: [jpegDataUrl()] }, 'invalid payload', [0.2, 0.8]);
    });

    test.each([
        ['a non-string frame', 7],
        ['a frame that is not a JPEG data URL', 'data:image/png;base64,AAE='],
        ['a plain URL', 'https://example.com/a.jpg'],
        ['base64 that does not decode', `${JPEG_PREFIX}***`],
        ['an empty body', JPEG_PREFIX],
        ['bytes without the JPEG marker', `${JPEG_PREFIX}${Buffer.from([0x89, 0x50, 0x4e]).toString('base64')}`],
        ['a body whose second byte is wrong', `${JPEG_PREFIX}${Buffer.from([0xff, 0xd9, 0x00]).toString('base64')}`],
        ['a body of one byte', `${JPEG_PREFIX}${Buffer.from([0xff]).toString('base64')}`],
    ])('rejects %s', async (_label, frame) => {
        await rejects({ frames: [frame] }, 'invalid payload');
    });

    test('accepts a JPEG of exactly 2 MiB and rejects one byte more', async () => {
        const atLimit = jpegDataUrl(MAX_JPEG_BYTES);
        extractFrames.mockResolvedValueOnce({ frames: [atLimit] });
        await expect(extractWebviewVideoFrames(URL_OK, 10_000, [0.5])).resolves.toEqual([atLimit]);

        // 2 MiB + 1 byte still fits the base64 length bound, so only the decoded size catches it.
        await rejects({ frames: [jpegDataUrl(MAX_JPEG_BYTES + 1)] }, 'JPEG is too large');
    });

    test('rejects base64 longer than the bound before decoding it', async () => {
        const decode = jest.spyOn(globalThis, 'atob');
        await rejects({ frames: [`${JPEG_PREFIX}${'A'.repeat(2_796_205)}`] }, 'JPEG is too large');
        expect(decode).not.toHaveBeenCalled();
    });
});
