/**
 * Shared settings bounds, deliberately free of any dependency.
 *
 * settings/schema.js owns validation but requires zod, and a CommonJS
 * `require('zod')` cannot be tree-shaken — so a module reachable from
 * app-bundle.js that pulled a bound from there dragged ~407 KB of zod into
 * the Electron renderer, which never validates anything (it goes through IPC
 * and never imports the settings facade). Keep this file dependency-free so
 * that stays true.
 *
 * Scope note: this buys nothing for capacitor-bundle.js or
 * headless-bundle.js. Both import the settings facade directly for real
 * getSetting/updateSetting work, and the facade requires schema.js, so they
 * carry zod regardless of where a bound is imported from — which is why their
 * budgets are 175 KB / 120 KB rather than 40 KB. Routing more bounds through
 * this file will not shrink them; only decoupling the facade from the
 * validator would.
 */

// Maximum scheduled-fill trigger entries per challenge, for both the
// times-of-day list and the before-end offsets list. schema.js enforces it,
// the cadence/decision paths slice to it defensively, and the UI stops
// offering an "add" row at it.
const MAX_SCHEDULED_FILL_ENTRIES = 6;

// Longest a single voting pause may last, in minutes (12h). schema.js uses it
// as votingPauseDurationMinutes' upper bound and getVotingPauseState clamps to
// it on the decision side — deliberately the one bound the pause does NOT treat
// as an advisory escape hatch. A hand-edited oversized fill window merely means
// "always fill", but an oversized PAUSE window swallows every future cycle and
// stops voting for good, so the two must not share a policy. Keep this and the
// schema bound as the same constant so they can never drift apart.
const MAX_VOTING_PAUSE_MINUTES = 720;

module.exports = { MAX_SCHEDULED_FILL_ENTRIES, MAX_VOTING_PAUSE_MINUTES };
