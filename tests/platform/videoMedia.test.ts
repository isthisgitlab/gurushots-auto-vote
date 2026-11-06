import {
    validateVideoFrameRequest,
    validateVideoMediaUrl,
    videoFrameTimestampMs,
} from '../../src/ts/core/platform/videoMedia';

describe('video media validation', () => {
    test('accepts the fixed HTTPS origin and valid frame request', () => {
        expect(validateVideoMediaUrl('https://media.gurushots.com/path/clip.MP4?x=1').href).toContain('/path/clip.MP4');
        expect(() => validateVideoFrameRequest(120_000, [0, 0.2, 0.5, 0.8, 1])).not.toThrow();
        expect(() =>
            validateVideoFrameRequest(
                10,
                Array.from({ length: 8 }, () => 0.5),
            ),
        ).not.toThrow();
    });

    test.each(['https://media.gurushots.com/path/clip.mov', 'https://media.gurushots.com/path/clip'])(
        'accepts a path without an MP4 suffix: %s',
        (url) => {
            expect(validateVideoMediaUrl(url).hostname).toBe('media.gurushots.com');
        },
    );

    test('accepts a clip longer than the former 120 s limit', () => {
        expect(() => validateVideoFrameRequest(7_200_000, [0.2, 0.5, 0.8])).not.toThrow();
    });

    test('names the failure when the origin is not allowed', () => {
        expect(() => validateVideoMediaUrl('https://other.example/clip.mp4')).toThrow(
            'Video media URL is not an allowed GuruShots media URL',
        );
    });

    test.each([
        'not a URL',
        'http://media.gurushots.com/clip.mp4',
        'https://other.example/clip.mp4',
        'https://media.gurushots.com:444/clip.mp4',
        'https://user@media.gurushots.com/clip.mp4',
        'https://user:password@media.gurushots.com/clip.mp4',
    ])('rejects an untrusted media URL: %s', (url) => {
        expect(() => validateVideoMediaUrl(url)).toThrow();
    });

    test.each([
        [0, [0.2]],
        [1.5, [0.2]],
        [10, []],
        [10, [-0.1]],
        [10, [1.1]],
        [10, [Number.NaN]],
        [10, Array.from({ length: 9 }, () => 0.5)],
    ])('rejects an unsupported frame request', (duration, positions) => {
        expect(() => validateVideoFrameRequest(duration, positions)).toThrow();
    });

    test('uses the shorter decoded duration and does not seek exactly to its end', () => {
        expect(videoFrameTimestampMs(10_000, 2_000, 0.5)).toBe(1_000);
        expect(videoFrameTimestampMs(10_000, 2_000, 1)).toBe(1_999);
        expect(videoFrameTimestampMs(1_000, 2_000, 1)).toBe(999);
    });

    test('uses the server duration when the container reports none', () => {
        expect(videoFrameTimestampMs(10_000, null, 0.5)).toBe(5_000);
        expect(videoFrameTimestampMs(10_000, null, 1)).toBe(9_999);
    });

    test('seeks inside a clip longer than the former 120 s limit', () => {
        expect(videoFrameTimestampMs(300_000, 300_000, 0.5)).toBe(150_000);
    });
});
