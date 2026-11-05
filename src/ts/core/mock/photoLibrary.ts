/**
 * GuruShots Auto Voter - Mock photo library fixtures
 *
 * The member's challenge-eligible library that the mock submissions and tag
 * endpoints (mock/endpoints/submissions.ts, mock/endpoints/tags.ts) serve.
 */

import type { LibraryPhoto } from '../types/gurushots';

// The mock library's label sets, hoisted so the tag vocabulary below is DERIVED
// from them instead of hand-maintained alongside them — a second list that must
// be kept in sync is a list that eventually is not, and the whole point of the
// mock is that searching "flow" finds no photos while autocomplete turns it
// into "flower", which only holds while the two agree.
/**
 * A photo id in the server's own shape: 32 hex characters. The suggestion
 * fixtures (SUGGESTED_PHOTO_IDS, and the cap-padding pool in
 * mock/endpoints/join.ts) must carry this shape, because a suggested id is
 * filtered by it before anything matches the picker against the library.
 *
 * @param n - distinguishing counter; `cafe` prefix keeps fixtures recognizable
 */
const hexPhotoId = (n: number): string => `cafe${String(n).padStart(28, '0')}`;

/**
 * The three library photos the suggestion fixture for the open challenge
 * (900001 in mock/endpoints/join.ts) points at: a picker join must be able to
 * match every suggested id it is handed against the library.
 */
const SUGGESTED_PHOTO_IDS = [hexPhotoId(1), hexPhotoId(2), hexPhotoId(3)];

const MOCK_PHOTO_LABELS = {
    photo_pink_flower_001: ['Pink', 'Flower', 'Petal', 'Plant'],
    photo_nature_landscape_002: ['Nature', 'Landscape', 'Tree', 'Sky'],
    photo_urban_003: ['Architecture', 'Building', 'Urban'],
    photo_recent_004: ['Portrait', 'Person'],
    photo_pink_petal_005: ['Pink', 'Petal', 'Macro'],
    photo_animal_006: ['Animal', 'Wildlife', 'Bird'],
    photo_blocked_007: ['Pink', 'Flower'],
    photo_old_008: ['Misc'],
    photo_won_009: ['Trophy'],
    [hexPhotoId(1)]: ['Sunset', 'Harbor'],
    [hexPhotoId(2)]: ['Forest', 'Moss'],
    [hexPhotoId(3)]: ['Neon', 'Night'],
};

// Every distinct tag the mock library carries, lowercased — what
// searchTagAutocomplete matches inside.
const MOCK_LIBRARY_TAGS = Array.from(
    new Set(
        Object.values(MOCK_PHOTO_LABELS)
            .flat()
            .map((label) => String(label).toLowerCase()),
    ),
).sort();

/**
 * The library listing (/rest/get_photos_private items) as of `now`: twelve
 * photos with the fields the picker uses (id, labels, votes, views,
 * upload_date, permission) and varied labels so the tag-match picker has
 * something to differentiate. The three hex-id photos at the end are what the
 * open challenge's suggestion fixture points at. (The live endpoint returns
 * votes=0 for library photos and a populated views count, so views carry
 * per-photo varied values here too.)
 *
 * @param now - epoch seconds the upload dates are relative to
 */
const buildLibraryPhotos = (
    now: number,
): Array<LibraryPhoto & { labels: string[]; votes: number; upload_date: number }> => [
    {
        id: 'photo_pink_flower_001',
        labels: MOCK_PHOTO_LABELS.photo_pink_flower_001,
        votes: 312,
        views: 1820,
        upload_date: now - 86400 * 2,
        permission: { allowed: true, message: null },
    },
    {
        id: 'photo_nature_landscape_002',
        labels: MOCK_PHOTO_LABELS.photo_nature_landscape_002,
        votes: 178,
        views: 1110,
        upload_date: now - 86400 * 5,
        permission: { allowed: true, message: null },
    },
    {
        id: 'photo_urban_003',
        labels: MOCK_PHOTO_LABELS.photo_urban_003,
        votes: 89,
        views: 640,
        upload_date: now - 86400 * 7,
        permission: { allowed: true, message: null },
    },
    {
        id: 'photo_recent_004',
        labels: MOCK_PHOTO_LABELS.photo_recent_004,
        votes: 24,
        views: 95,
        upload_date: now - 3600,
        permission: { allowed: true, message: null },
    },
    {
        id: 'photo_pink_petal_005',
        labels: MOCK_PHOTO_LABELS.photo_pink_petal_005,
        votes: 401,
        views: 2230,
        upload_date: now - 86400 * 4,
        permission: { allowed: true, message: null },
    },
    {
        id: 'photo_animal_006',
        labels: MOCK_PHOTO_LABELS.photo_animal_006,
        votes: 156,
        views: 980,
        upload_date: now - 86400 * 10,
        permission: { allowed: true, message: null },
    },
    {
        id: 'photo_blocked_007',
        labels: MOCK_PHOTO_LABELS.photo_blocked_007,
        votes: 999,
        views: 5000,
        upload_date: now - 86400 * 1,
        permission: { allowed: false, message: 'Already used in another challenge' },
    },
    {
        id: 'photo_old_008',
        labels: MOCK_PHOTO_LABELS.photo_old_008,
        votes: 12,
        views: 70,
        upload_date: now - 86400 * 30,
        permission: { allowed: true, message: null },
    },
    {
        id: 'photo_won_009',
        labels: MOCK_PHOTO_LABELS.photo_won_009,
        votes: 640,
        views: 3100,
        upload_date: now - 86400 * 20,
        // The server's own wording, HTML included: a photo that has won a challenge cannot enter another.
        permission: {
            allowed: false,
            message: "This image <b>has won a challenge</b><br/><span>it can't participate in another</span>",
        },
    },
    {
        id: SUGGESTED_PHOTO_IDS[0],
        labels: MOCK_PHOTO_LABELS[SUGGESTED_PHOTO_IDS[0]],
        votes: 210,
        views: 1340,
        upload_date: now - 86400 * 3,
        permission: { allowed: true, message: null },
    },
    {
        id: SUGGESTED_PHOTO_IDS[1],
        labels: MOCK_PHOTO_LABELS[SUGGESTED_PHOTO_IDS[1]],
        votes: 165,
        views: 1020,
        upload_date: now - 86400 * 6,
        permission: { allowed: true, message: null },
    },
    {
        id: SUGGESTED_PHOTO_IDS[2],
        labels: MOCK_PHOTO_LABELS[SUGGESTED_PHOTO_IDS[2]],
        votes: 96,
        views: 730,
        upload_date: now - 86400 * 9,
        permission: { allowed: true, message: null },
    },
];

/**
 * Per-photo records (/rest/get_image_data), keyed by photo id. The vote
 * counts deliberately disagree with the library listing's (which the live
 * API would have reported as 0), so mock mode actually exercises the
 * enrichment tier instead of ranking identically either way. `photo_old_008`
 * is the important case: oldest, lowest views, but by far the most votes and
 * achievements — it should win a no-theme-match fill. Every entry carries the
 * likes and Guru-picks counts the picker's Show stats display reads.
 *
 * Built fresh per call so a caller mutating a returned `achievements` array
 * never leaks into the next read.
 */
const buildImageStats = (): Record<
    string,
    { votes: number; views: number; likes: number; guru_picks: number; achievements: string[] }
> => ({
    photo_pink_flower_001: { votes: 3120, views: 1820, likes: 214, guru_picks: 4, achievements: ['top_100'] },
    photo_nature_landscape_002: { votes: 1780, views: 1110, likes: 96, guru_picks: 0, achievements: [] },
    photo_urban_003: { votes: 890, views: 640, likes: 31, guru_picks: 1, achievements: [] },
    photo_recent_004: { votes: 240, views: 95, likes: 3, guru_picks: 0, achievements: [] },
    photo_pink_petal_005: {
        votes: 4010,
        views: 2230,
        likes: 486,
        guru_picks: 7,
        achievements: ['top_50', 'top_100'],
    },
    photo_animal_006: { votes: 1560, views: 980, likes: 88, guru_picks: 2, achievements: ['top_100'] },
    photo_blocked_007: { votes: 9990, views: 5000, likes: 1201, guru_picks: 12, achievements: ['elite'] },
    photo_old_008: {
        votes: 12400,
        views: 70,
        likes: 24,
        guru_picks: 1,
        achievements: ['elite', 'top_30', 'top_50', 'top_100'],
    },
    photo_won_009: { votes: 6400, views: 3100, likes: 655, guru_picks: 9, achievements: ['winner'] },
    [SUGGESTED_PHOTO_IDS[0]]: { votes: 2100, views: 1340, likes: 140, guru_picks: 3, achievements: ['top_100'] },
    [SUGGESTED_PHOTO_IDS[1]]: { votes: 1650, views: 1020, likes: 77, guru_picks: 0, achievements: [] },
    [SUGGESTED_PHOTO_IDS[2]]: { votes: 960, views: 730, likes: 15, guru_picks: 1, achievements: [] },
});

export { MOCK_LIBRARY_TAGS, SUGGESTED_PHOTO_IDS, buildImageStats, buildLibraryPhotos, hexPhotoId };
