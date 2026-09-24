/**
 * GuruShots Auto Voter - Mock photo library fixtures
 *
 * The member's challenge-eligible library that the mock submissions and tag
 * endpoints (mock/endpoints/submissions.js, mock/endpoints/tags.js) serve.
 */

// The mock library's label sets, hoisted so the tag vocabulary below is DERIVED
// from them instead of hand-maintained alongside them — a second list that must
// be kept in sync is a list that eventually is not, and the whole point of the
// mock is that searching "flow" finds no photos while autocomplete turns it
// into "flower", which only holds while the two agree.
const MOCK_PHOTO_LABELS = {
    photo_pink_flower_001: ['Pink', 'Flower', 'Petal', 'Plant'],
    photo_nature_landscape_002: ['Nature', 'Landscape', 'Tree', 'Sky'],
    photo_urban_003: ['Architecture', 'Building', 'Urban'],
    photo_recent_004: ['Portrait', 'Person'],
    photo_pink_petal_005: ['Pink', 'Petal', 'Macro'],
    photo_animal_006: ['Animal', 'Wildlife', 'Bird'],
    photo_blocked_007: ['Pink', 'Flower'],
    photo_old_008: ['Misc'],
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
 * The library listing (/rest/get_photos_private items) as of `now`: eight
 * photos with the fields the picker uses (id, labels, votes, views,
 * upload_date, permission) and varied labels so the tag-match picker has
 * something to differentiate. (The live endpoint returns votes=0 for library
 * photos and a populated views count, so views carry per-photo varied values
 * here too.)
 *
 * @param {number} now - epoch seconds the upload dates are relative to
 * @returns {Array<object>}
 */
const buildLibraryPhotos = (now) => [
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
];

/**
 * Per-photo records (/rest/get_image_data), keyed by photo id. The vote
 * counts deliberately disagree with the library listing's (which the live
 * API would have reported as 0), so mock mode actually exercises the
 * enrichment tier instead of ranking identically either way. `photo_old_008`
 * is the important case: oldest, lowest views, but by far the most votes and
 * achievements — it should win a no-theme-match fill.
 *
 * Built fresh per call so a caller mutating a returned `achievements` array
 * never leaks into the next read.
 *
 * @returns {Record<string, {votes:number, views:number, achievements:string[]}>}
 */
const buildImageStats = () => ({
    photo_pink_flower_001: { votes: 3120, views: 1820, achievements: ['top_100'] },
    photo_nature_landscape_002: { votes: 1780, views: 1110, achievements: [] },
    photo_urban_003: { votes: 890, views: 640, achievements: [] },
    photo_recent_004: { votes: 240, views: 95, achievements: [] },
    photo_pink_petal_005: { votes: 4010, views: 2230, achievements: ['top_50', 'top_100'] },
    photo_animal_006: { votes: 1560, views: 980, achievements: ['top_100'] },
    photo_blocked_007: { votes: 9990, views: 5000, achievements: ['elite'] },
    photo_old_008: { votes: 12400, views: 70, achievements: ['elite', 'top_30', 'top_50', 'top_100'] },
});

module.exports = { MOCK_LIBRARY_TAGS, buildLibraryPhotos, buildImageStats };
