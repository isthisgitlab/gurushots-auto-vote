/**
 * The seek-time clamp the Android extractor repeats natively. The table below is pinned verbatim in
 * VideoFrameExtractorTest.clampsTimestampsLikeTheCoreRule (android/app/src/test/…), so the two implementations
 * cannot drift: change both together.
 */

import { videoFrameTimestampMs } from '../../../src/ts/core/platform/videoMedia';

// server ms, decoded ms, position, expected ms
const TABLE: readonly (readonly [number, number, number, number])[] = [
    [10_000, 10_000, 0, 0],
    [10_000, 10_000, 0.25, 2_500],
    [10_000, 10_000, 0.5, 5_000],
    [10_000, 10_000, 0.75, 7_500],
    [10_000, 10_000, 1, 9_999],
    [10_000, 2_000, 1, 1_999],
    [10_000, 2_000, 0.5, 1_000],
    [2_000, 10_000, 0.5, 1_000],
    [2_000, 10_000, 1, 1_999],
    [1, 1, 1, 0],
    [1, 1, 0.5, 0],
    [2, 2, 0.5, 1],
    [120_000, 120_000, 1, 119_999],
];

describe('videoFrameTimestampMs shared table', () => {
    test.each(TABLE)('server %i ms, decoded %i ms, position %f gives %f ms', (server, actual, position, expected) => {
        expect(videoFrameTimestampMs(server, actual, position)).toBe(expected);
    });
});
