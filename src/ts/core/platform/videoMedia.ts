/** The only video CDN that a Snap session may ask this app to download. */
const VIDEO_MEDIA_HOST = 'media.gurushots.com';
const MAX_VIDEO_FRAME_POSITIONS = 8;

/**
 * Parses and validates the server media URL before any platform downloads it.
 * The extractor never follows a redirect, so this also fixes the only allowed
 * destination before the native or Node transport opens a connection.
 */
const validateVideoMediaUrl = (rawUrl: string): URL => {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('Video media URL is invalid');
    }
    if (
        url.protocol !== 'https:' ||
        url.hostname !== VIDEO_MEDIA_HOST ||
        (url.port !== '' && url.port !== '443') ||
        url.username !== '' ||
        url.password !== ''
    ) {
        throw new Error('Video media URL is not an allowed GuruShots media URL');
    }
    return url;
};

/** Validates the server duration and each fractional frame position at the platform boundary. */
const validateVideoFrameRequest = (durationMs: number, positions: readonly number[]): void => {
    if (!Number.isInteger(durationMs) || durationMs < 1) {
        throw new Error('Video duration is outside the supported range');
    }
    if (positions.length === 0) throw new Error('At least one video frame position is required');
    if (positions.length > MAX_VIDEO_FRAME_POSITIONS) throw new Error('Too many video frame positions');
    for (const position of positions) {
        if (!Number.isFinite(position) || position < 0 || position > 1) {
            throw new Error('Video frame position must be between zero and one');
        }
    }
};

/**
 * Clamps a fractional seek to the shorter of the server and decoded durations without seeking exactly to end of
 * file. A clip whose container reports no duration (`null`) is sought by the server duration alone.
 */
const videoFrameTimestampMs = (serverDurationMs: number, actualDurationMs: number | null, position: number): number => {
    const durationMs = actualDurationMs === null ? serverDurationMs : Math.min(serverDurationMs, actualDurationMs);
    return Math.min(durationMs * position, Math.max(0, durationMs - 1));
};

export { VIDEO_MEDIA_HOST, validateVideoFrameRequest, validateVideoMediaUrl, videoFrameTimestampMs };
