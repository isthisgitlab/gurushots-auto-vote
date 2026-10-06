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

// The shape a photo id must have to be stored in a Chosen Photos list and to be
// listed by the library read: ids are opaque server tokens, so only the safe
// token characters (the mock ids fit) are accepted.
const CHOSEN_PHOTO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export { MAX_SCHEDULED_FILL_ENTRIES, MAX_VOTING_PAUSE_MINUTES, MAX_TAG_LENGTH, MAX_CHOSEN_PHOTOS, CHOSEN_PHOTO_ID_RE };
