/**
 * Shared settings bounds, deliberately free of any dependency.
 *
 * settings/schema.ts owns validation but requires zod, and a CommonJS
 * `require('zod')` cannot be tree-shaken — so a module reachable from
 * app-bundle.js that pulled a bound from there dragged ~407 KB of zod into
 * the Electron renderer, which never validates anything (it goes through IPC
 * and never imports the settings facade). Keep this file dependency-free so
 * that stays true.
 *
 * Scope note: this buys nothing for capacitor-bundle.js or
 * headless-bundle.js. Both import the settings facade directly for real
 * getSetting/updateSetting work, and the facade requires schema.ts, so they
 * carry zod regardless of where a bound is imported from — which is why their
 * budgets are 175 KB / 120 KB rather than 40 KB. Routing more bounds through
 * this file will not shrink them; only decoupling the facade from the
 * validator would.
 */

// Maximum scheduled-fill trigger entries per challenge, for both the
// times-of-day list and the before-end offsets list. schema/scheduledFill.ts
// enforces it, the cadence/decision paths slice to it defensively, and the UI
// stops offering an "add" row at it.
const MAX_SCHEDULED_FILL_ENTRIES = 6;

// Longest a single voting pause may last, in minutes (12h). schema/votingPause.ts
// uses it as votingPauseDurationMinutes' upper bound and getVotingPauseState
// clamps to it on the decision side — deliberately the one bound the pause does
// NOT treat as an advisory escape hatch. A hand-edited oversized fill window
// merely means "always fill", but an oversized PAUSE window swallows every
// future cycle and stops voting for good, so the two must not share a policy.
// Keep this and the schema bound as the same constant so they can never drift
// apart.
const MAX_VOTING_PAUSE_MINUTES = 720;

// Longest a single tag may be, for the tag-list settings and for the photo search term the
// library listing accepts (the same free-text field the server matches tags with).
const MAX_TAG_LENGTH = 50;

// Most photos a Chosen Photos list may hold. Deliberately small: the list is a
// handful of hand-picked favourites, not a library mirror, and every id in it
// costs a membership check on each fill and join of the challenges it applies
// to. A photo can only be in one challenge, so a long shared list would mostly
// name photos that cannot be used there anyway.
const MAX_CHOSEN_PHOTOS = 20;

// Most ids one get-open-chosen-annotations request may ask about: the open list plus the upcoming rows Discover
// shows (at most 100). The renderer asks in requests of at most this many.
const MAX_ANNOTATED_IDS = 300;

// Most ids one suggest-photos request may exclude: the photos the Pick… modal's Auto has already shown (five per
// press). The modal starts over from the best when its list reaches this, so it never sends a longer one.
const MAX_SUGGEST_EXCLUDE = 1000;

// How many ids of photos left out of the listing (they have won a challenge) are reported with it.
const MAX_WON_IDS = 1000;

// The default batch a paged library read (get-library-photos with a `start`) counts before it stops:
// one page of the server's own walk.
const LIBRARY_BATCH_PHOTOS = 100;

// The most photos any one library read may ask to keep: one full walk, i.e. the walk's page cap
// (MAX_LIBRARY_PAGES in api/submissions.ts, 10 — doubled to 20 when the walk skips photos left out)
// times this default page of 100. A literal, because limits stays dependency-free and cannot import
// the page cap it is tied to; keep the two in step by hand.
const MAX_LIBRARY_KEEP_PHOTOS = 1000;

// The shape a photo id must have to be stored in a Chosen Photos list and to be
// listed by the library read: ids are opaque server tokens, so only the safe
// token characters (the mock ids fit) are accepted.
const CHOSEN_PHOTO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Furthest ahead, in hours (a week), that Discover may list challenges that have not started yet.
// The real list reaches weeks out, and every row costs a settings-only annotation read, so the
// window stays short. schema/general.ts uses it as discoverUpcomingHours' upper bound and the
// settings field offers it as its maximum.
const MAX_UPCOMING_HOURS = 168;

// How long, in seconds, a challenge whose start has passed is still treated as "starting now"
// while the open list has not shown it: Discover keeps its row, and cleanup keeps its chosen photos.
const UPCOMING_GRACE_SEC = 600;

// The hold, in seconds, between the app launching and an interrupted auto-vote session resuming by
// itself (schema/general.ts autovoteStartupDelay), so settings can be checked first. The default is
// here, not only in the schema, because the renderer must not import the zod schema (bundle size).
const DEFAULT_STARTUP_DELAY_SECONDS = 60;
const MAX_STARTUP_DELAY_SECONDS = 3600;

// The range an API request's timeout (seconds) and its retry count may be set to. A stored value outside it
// (hand-edited, or from an older build) is dropped for the default at load; the API client trusts what it reads.
const API_TIMEOUT_MIN_SEC = 1;
const API_TIMEOUT_MAX_SEC = 300;
const API_MAX_RETRIES_MAX = 10;

export {
    API_TIMEOUT_MIN_SEC,
    API_TIMEOUT_MAX_SEC,
    API_MAX_RETRIES_MAX,
    DEFAULT_STARTUP_DELAY_SECONDS,
    MAX_STARTUP_DELAY_SECONDS,
    UPCOMING_GRACE_SEC,
    MAX_SCHEDULED_FILL_ENTRIES,
    MAX_VOTING_PAUSE_MINUTES,
    MAX_TAG_LENGTH,
    MAX_CHOSEN_PHOTOS,
    MAX_ANNOTATED_IDS,
    MAX_SUGGEST_EXCLUDE,
    MAX_WON_IDS,
    LIBRARY_BATCH_PHOTOS,
    MAX_LIBRARY_KEEP_PHOTOS,
    CHOSEN_PHOTO_ID_RE,
    MAX_UPCOMING_HOURS,
};
