/** The only video CDN that a Snap session may ask this app to download. */
const VIDEO_MEDIA_HOST = 'media.gurushots.com';
const MAX_VIDEO_DURATION_MS = 120_000;

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
        url.password !== '' ||
        !url.pathname.toLowerCase().endsWith('.mp4')
    ) {
        throw new Error('Video media URL is not an allowed HTTPS MP4');
    }
    return url;
};

/** Validates duration and each fractional frame position at the platform boundary. */
const validateVideoFrameRequest = (durationMs: number, positions: readonly number[]): void => {
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > MAX_VIDEO_DURATION_MS) {
        throw new Error('Video duration is outside the supported range');
    }
    if (positions.length === 0) throw new Error('At least one video frame position is required');
    for (const position of positions) {
        if (!Number.isFinite(position) || position < 0 || position > 1) {
            throw new Error('Video frame position must be between zero and one');
        }
    }
};

export { MAX_VIDEO_DURATION_MS, VIDEO_MEDIA_HOST, validateVideoFrameRequest, validateVideoMediaUrl };
