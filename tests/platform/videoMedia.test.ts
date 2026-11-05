import {
    MAX_VIDEO_DURATION_MS,
    validateVideoFrameRequest,
    validateVideoMediaUrl,
} from '../../src/ts/core/platform/videoMedia';

describe('video media validation', () => {
    test('accepts the fixed HTTPS MP4 origin and valid frame request', () => {
        expect(validateVideoMediaUrl('https://media.gurushots.com/path/clip.MP4?x=1').href).toContain('/path/clip.MP4');
        expect(() => validateVideoFrameRequest(MAX_VIDEO_DURATION_MS, [0, 0.2, 0.5, 0.8, 1])).not.toThrow();
    });

    test.each([
        'not a URL',
        'http://media.gurushots.com/clip.mp4',
        'https://other.example/clip.mp4',
        'https://media.gurushots.com:444/clip.mp4',
        'https://user@media.gurushots.com/clip.mp4',
        'https://media.gurushots.com/clip.jpg',
    ])('rejects an untrusted media URL: %s', (url) => {
        expect(() => validateVideoMediaUrl(url)).toThrow();
    });

    test.each([
        [0, [0.2]],
        [MAX_VIDEO_DURATION_MS + 1, [0.2]],
        [1.5, [0.2]],
        [10, []],
        [10, [-0.1]],
        [10, [1.1]],
        [10, [Number.NaN]],
    ])('rejects an unsupported frame request', (duration, positions) => {
        expect(() => validateVideoFrameRequest(duration, positions)).toThrow();
    });
});
