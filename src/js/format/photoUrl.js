// @ts-check
/**
 * GuruShots photo CDN URL builder.
 *
 * WHY THIS EXISTS: no API response carries a usable image URL for a challenge
 * entry. `member.ranking.entries[]` gives only `id` + `member_id` (both 32-char
 * md5 hex), and `get_image_data` — despite returning votes/views/achievements/
 * comments — has no URL field either. The only URLs the API hands back are
 * `guru_info.avatar` and `member.avatar`, and those reveal the shape the CDN
 * actually serves:
 *
 *     https://photos.gurushots.com/unsafe/500x500/<member_id>/3_<image_id>.jpg
 *
 * That same shape resolves for challenge entries and for challenge cover images
 * (`challenge.image.{member_id,id}`), so a thumbnail needs no new endpoint and
 * no extra request round-trip — it is pure client-side string building off data
 * the voting pass already holds.
 *
 * "unsafe" is not a warning: it is thumbor's own path segment for an
 * *unsigned* (no HMAC) transform request. It is what GuruShots' own web app
 * emits, and the origin accepts arbitrary WxH there, which is what lets one
 * entry render as both a 28px chip and a full-size preview without a second
 * source image.
 *
 * The `3_` prefix is the rendition the site itself links. Other renditions
 * (`1_`) also resolve, so this is pinned to a single constant rather than
 * guessed per call site.
 */

// Both ids are md5 hex in every observed payload. Validating rather than
// trusting is the point: these values come straight off the network, and they
// are interpolated into a URL path. Without this gate a hostile or corrupted
// `member_id` of `../../` would walk the path, and one containing `@` would
// turn the authority into a lookalike host — the same class of bug
// format/urlSafe.js exists to stop on the outbound side. A non-conforming id
// yields null (render nothing) instead of a broken or attacker-chosen request.
const ID_PATTERN = /^[0-9a-f]{32}$/i;

const PHOTO_CDN_ORIGIN = 'https://photos.gurushots.com';
const RENDITION_PREFIX = '3_';

// Upper bound on the requested square. The CDN will happily render enormous
// transforms; capping keeps a typo in a call site from asking the origin for a
// multi-megapixel resize on every row of a challenge list.
const MAX_EDGE_PX = 2000;
const DEFAULT_EDGE_PX = 200;

/**
 * Builds a CDN URL for one photo.
 *
 * @param {string} memberId - owning member id (32-char hex)
 * @param {string} imageId  - photo id (32-char hex)
 * @param {{size?: number, fit?: boolean}} [options]
 *   size: length of the square's edge in px (default 200, clamped to 2000).
 *   fit:  true uses thumbor's `fit-in`, which letterboxes the whole frame
 *         inside the box instead of centre-cropping it to fill. Cropping is
 *         right for a small chip; fitting is right for a preview, where the
 *         point is to see the composition the way it was submitted.
 * @returns {string|null} the URL, or null when either id is not well-formed.
 */
const buildPhotoUrl = (memberId, imageId, options = {}) => {
    if (!ID_PATTERN.test(String(memberId ?? '')) || !ID_PATTERN.test(String(imageId ?? ''))) {
        return null;
    }
    const { size = DEFAULT_EDGE_PX, fit = false } = options;
    // Rounded BEFORE the positivity check, not after: testing `size > 0` first
    // lets a fraction under 0.5 pass the guard and then round down to 0, asking
    // the CDN for a 0x0 transform. Every current caller passes a constant, so
    // this is a trap for the next one rather than a live bug.
    const requested = Number.isFinite(size) ? Math.round(size) : 0;
    const edge = requested > 0 ? Math.min(requested, MAX_EDGE_PX) : DEFAULT_EDGE_PX;
    const geometry = fit ? `fit-in/${edge}x${edge}` : `${edge}x${edge}`;
    return `${PHOTO_CDN_ORIGIN}/unsafe/${geometry}/${memberId}/${RENDITION_PREFIX}${imageId}.jpg`;
};

/**
 * Convenience wrapper for an entry out of `member.ranking.entries`.
 * Optional-chained throughout: a per-challenge API read that comes back shaped
 * differently must degrade to "no thumbnail", never throw into the renderer.
 *
 * @param {{id?: string, member_id?: string}|null|undefined} entry
 * @param {{size?: number, fit?: boolean}} [options]
 * @returns {string|null}
 */
const entryPhotoUrl = (entry, options = {}) => buildPhotoUrl(entry?.member_id ?? '', entry?.id ?? '', options);

module.exports = { buildPhotoUrl, entryPhotoUrl };
