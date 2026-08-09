/**
 * Shared challenge lookup for the active-challenges list.
 *
 * The GuruShots API is not consistent about the `id` type (number in some
 * payloads, string in others), so the ONLY safe comparison is
 * String-to-String. Every lookup site must go through this helper — a
 * strict `===` against `parseInt(...)` silently misses string ids and
 * accepts garbage suffixes (`parseInt('123abc')` → 123).
 *
 * This shares the lookup predicate only; callers keep their own
 * user-facing error wording ("not found" vs "no longer active" carry
 * different meanings).
 *
 * @param {Array<object>|null|undefined} challenges - candidate list (any falsy/non-array input is treated as empty)
 * @param {string|number} challengeId - id to find
 * @returns {object|null} the matching challenge, or null
 */
const findActiveChallenge = (challenges, challengeId) =>
    (Array.isArray(challenges) ? challenges : []).find((c) => String(c.id) === String(challengeId)) ?? null;

module.exports = { findActiveChallenge };
