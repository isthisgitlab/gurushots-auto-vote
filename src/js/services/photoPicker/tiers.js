/**
 * Photo picker — the ranking tiers: each candidate's tier values, the theme
 * comparison, the enrichment set, and the final sort that applies them. This
 * module owns the tier list.
 *
 * GOVERNING RULE: a theme match always beats popularity. Popularity signals
 * (achievements / votes / views / upload date) are last-resort tiebreaks that
 * apply ONLY among photos that all failed to match the theme. They must never
 * lift an off-theme photo above an on-theme one — a high-view sea photo losing
 * to a low-view farm photo in a farm challenge is the CORRECT outcome.
 *
 * The tier order below enforces that structurally: the match tiers are all
 * non-negative and are compared before the popularity tiers, so a photo with
 * any positive match cannot be outranked by a photo with none.
 *
 * Ranking tiers (lexicographic, all desc):
 *   1. Should-match count — how many of the user's Should Include Tags hit.
 *   2. Semantic score — cosine similarity between the challenge theme and the
 *      photo's labels, via the word-vector lexicon. FLOORED at
 *      SEMANTIC_MATCH_FLOOR: below it the value is forced to 0, because
 *      sub-floor cosine is indistinguishable from vector noise and must not be
 *      allowed to pre-empt a genuine lexical hit on tier 3.
 *   3. Semantic support — how many of the photo's labels are on theme, not
 *      just the single best one, capped at SEMANTIC_SUPPORT_CAP. Tier 2
 *      max-pools, so it cannot separate a photo the theme is ABOUT from one
 *      that merely carries a matching tag beside unrelated ones — and because
 *      the candidate fetch searches ONE resolved tag server-side, most of a
 *      fill's candidates carry that tag and tie on tier 2 by construction,
 *      which left popularity deciding. This tier reads the REST of the label
 *      set, and sits strictly BELOW tier 2 so it only ever orders photos
 *      already judged on theme — it can never lift a weaker match above a
 *      stronger one. It applies the same per-label floor as tier 2, so "on
 *      theme" means one thing in both.
 *   4. Tag-match score — how many of the photo's label word-stems overlap the
 *      challenge keywords (URL slug + title + welcome_message, light-stemmed,
 *      stopword-filtered).
 *   5. Stats known       \
 *   6. Votes              \  popularity — ONLY orders photos that tied at 0
 *   7. Achievements count /  across tiers 1-4, i.e. nothing matched the theme.
 *   8. Views             /
 *   9. Upload date      /
 *
 * NOTE on tier 5: get_photos_private returns votes=0 and no achievements for
 * every library photo, so the real values are fetched per photo from
 * get_image_data by services/photoStats.js, which marks each candidate
 * `statsKnown`. That fetch is budgeted, so a candidate set can be partially
 * enriched — and an unenriched photo still carries the endpoint's flat
 * `votes: 0`. Ranking it as if it had zero votes would let a mediocre enriched
 * photo beat a genuinely stronger unmeasured one, so "we don't know" is its own
 * tier ABOVE votes rather than a silent zero.
 *
 * NOTE on how often the popularity tiers decide: for an abstract title (e.g.
 * "Your Legacy") no label can match and the semantic score falls under
 * SEMANTIC_MATCH_FLOOR, so EVERY candidate ties at (0,0,0,0) and the tie group is
 * effectively the whole library. The popularity path is the majority path for
 * such challenges, not an edge case.
 */

/**
 * Below this the semantic tier is treated as "no match at all" (see
 * pickPhotosForChallenge). Expressed on the same 0..100 bucket scale as the tier
 * itself, so 43 means cosine 0.43.
 *
 * This is a measured value, not a guess. The lexicon's vectors are real
 * pretrained GloVe embeddings (mean-centered, cluster-retrofitted — see
 * scripts/fetch-embeddings.js), whose related and unrelated cosine
 * distributions genuinely overlap in the tails: corpus artifacts put a few
 * unrelated theme pairs (snake↔lamp via zodiac/lantern co-occurrence) near
 * 0.49, while a few honestly-related sibling pairs sit low. The floor is
 * placed by the pre-committed gate p99(unrelated) < FLOOR < p25(related),
 * which scripts/validate-lexicon.js re-derives from the real asset on every
 * build (measured at 0.448 < 0.455 < 0.476) and fails if the gap closes, so
 * this constant can never quietly drift out of the valid range.
 *
 * CALIBRATED FOR MAX-POOLING. The value is only meaningful for the pooling the
 * validator measured it under, and services/semantic/index.js now scores each
 * label independently and keeps the best rather than averaging the whole label
 * bag. Both distributions shifted up when that changed, so this moved 43 -> 46.
 * If the pooling changes again, re-run `pnpm verify:lexicon` and move this with
 * it — never one without the other.
 */
const SEMANTIC_MATCH_FLOOR = 46;

/**
 * How many on-theme labels the semantic SUPPORT tier counts before it stops
 * (see tier 3 in the file header).
 *
 * WHY A CAP AT ALL. Uncapped, this tier would reward a photo for carrying many
 * loosely-related labels over one carrying few strongly-related ones — the same
 * "measures how chatty the tagger was rather than how on-theme the photo is"
 * failure that made mean-pooling wrong in services/semantic/index.js, just
 * wearing a different hat. A photo's third corroborating label has already
 * settled "one lucky tag" versus "this photo is about the theme"; past that the
 * extra labels carry no information this tier can use.
 *
 * NOT A CALIBRATED CONSTANT, unlike SEMANTIC_MATCH_FLOOR — nothing statistical
 * depends on its exact value, and it is safe to move. The floor is what decides
 * whether a label counts at all, and it is NOT re-derived by this tier: the
 * per-label similarity being thresholded here is the same quantity, pooled the
 * same way, that scripts/validate-lexicon.js already gates the build on.
 */
const SEMANTIC_SUPPORT_CAP = 3;

// The "no semantic signal" tuple. Shared so the several early exits in
// semanticTiersOf cannot drift apart, and frozen because it is handed out by
// reference rather than copied.
const NO_SEMANTIC = Object.freeze({ semantic: 0, semanticSupport: 0 });

/**
 * Read one photo's semantic tiers (2 and 3) out of the scorer's map.
 *
 * The 0..1 similarity is bucketed to whole percent so tiny float differences
 * don't churn the order or make it non-deterministic; photos within the same
 * bucket fall through to the tiers below.
 *
 * Anything below SEMANTIC_MATCH_FLOOR is forced to 0 — NOT merely ranked low.
 * Sub-floor cosine is statistically indistinguishable from the noise between
 * two unrelated word vectors, and these tiers sit ABOVE the lexical `score`, so
 * without the floor a photo with pure vector drift would out-rank a photo with
 * a genuine keyword hit. The floor is what makes "nothing matched the theme" an
 * honest, testable state instead of a fuzzy one. Its value is not hand-picked:
 * scripts/validate-lexicon.js gates the build on p99(unrelated) < FLOOR <
 * p25(related) against the real lexicon.
 *
 * Two accepted value shapes. The scorer hands over a {score, support} record; a
 * bare number is the shape opts.semanticScores was documented with before the
 * support tier existed, and is still what callers and tests that build the map
 * by hand pass — it stays valid and simply contributes no support. Normalising
 * here is what keeps every caller in between shape-agnostic: the map is passed
 * through autoFill and joinChallenges untouched.
 *
 * @param {Map<string, {score: number, support: number}|number>|null} semanticScores
 * @param {string|number} id
 * @returns {{semantic: number, semanticSupport: number}}
 */
const semanticTiersOf = (semanticScores, id) => {
    if (!semanticScores) return NO_SEMANTIC;
    const entry = semanticScores.get(String(id));
    const raw = typeof entry === 'number' ? entry : entry && entry.score;
    if (!Number.isFinite(raw)) return NO_SEMANTIC;
    const bucket = Math.round(Math.max(0, Math.min(1, raw)) * 100);
    // Sub-floor: no label cleared the floor, so there is nothing to support
    // either. Returning zero for BOTH keeps a hand-built map that pairs a
    // sub-floor score with a support count from smuggling that count past the
    // floor and pre-empting a genuine lexical hit on the tier below.
    if (bucket < SEMANTIC_MATCH_FLOOR) return NO_SEMANTIC;
    const rawSupport = entry && entry.support;
    const semanticSupport = Number.isFinite(rawSupport)
        ? Math.max(0, Math.min(SEMANTIC_SUPPORT_CAP, Math.floor(rawSupport)))
        : 0;
    return { semantic: bucket, semanticSupport };
};

// Prefers the numeric count photoStats.js merges on (it stores only the count,
// never the full achievements array — those objects carry long descriptions and
// icon URLs and would bloat a persisted cache for a value only ever read as a
// length). Falls back to counting a raw `achievements` array so mocks, tests and
// any future payload that inlines the array keep working.
const achievementCountOf = (photo) => {
    if (Number.isFinite(photo.achievementCount) && photo.achievementCount >= 0) {
        return Math.floor(photo.achievementCount);
    }
    return Array.isArray(photo.achievements) ? photo.achievements.length : 0;
};

// Tier 5. True only when photoStats.js actually resolved this photo's real
// numbers; see the "NOTE on tier 5" in the file header for why unknown must not
// collapse into votes:0.
const statsKnownOf = (photo) => photo.statsKnown === true;

const votesOf = (photo) => (Number.isFinite(photo.votes) ? photo.votes : 0);

const viewsOf = (photo) => (Number.isFinite(photo.views) ? photo.views : 0);

const uploadDateOf = (photo) => (Number.isFinite(photo.upload_date) ? photo.upload_date : 0);

// The theme tiers, highest-priority first. A photo's standing on these is what
// the enrichment set is derived from — they are the tiers that a stat lookup
// can NEVER change, so anything they already separate is settled.
const compareTheme = (a, b) => {
    if (b.shouldMatchCount !== a.shouldMatchCount) return b.shouldMatchCount - a.shouldMatchCount;
    if (b.semantic !== a.semantic) return b.semantic - a.semantic;
    // Strictly below the max-pooled score above: two photos only reach this
    // comparison when the lexicon rated their BEST label identically, so the
    // question left is whether the rest of the label set agrees with the theme.
    if (b.semanticSupport !== a.semanticSupport) return b.semanticSupport - a.semanticSupport;
    return b.score - a.score;
};

const sameTheme = (a, b) => compareTheme(a, b) === 0;

/**
 * Did this candidate match the challenge theme AT ALL?
 *
 * Reads exactly the tiers compareTheme ranks on, and lives here beside them on
 * purpose: this module OWNS the tier list, and a caller that re-states it by
 * hand silently rots the moment a tier is added, renamed or reordered. The one
 * caller (logPopularityPick in services/autoFill/fillLogging.js) uses it to decide whether
 * a tie means "everything matched equally" or "nothing matched" — get that
 * backwards and the app tells a user their fill failed on the fills that
 * worked, which is the bug this predicate was extracted to stop recurring.
 *
 * Every theme tier is non-negative (that is what makes the governing rule
 * enforceable — see the file header), so "matched something" is exactly "any
 * tier is above zero".
 *
 * @param {{shouldMatchCount: number, semantic: number, semanticSupport: number, score: number}} entry
 * @returns {boolean}
 */
const hasThemeMatch = (entry) =>
    Boolean(entry) &&
    (entry.shouldMatchCount > 0 || entry.semantic > 0 || entry.semanticSupport > 0 || entry.score > 0);

/**
 * The candidates whose relative order the POPULARITY tiers will actually decide
 * — i.e. the ones worth spending a stat lookup on.
 *
 * This is deliberately NOT "everything sharing the best theme tuple". That is
 * only equivalent when slotsToFill === 1. Emergency fill passes
 * wantCount: slotsRemaining and manual fill-all does the same, so multi-slot
 * batches are routine: with one uniquely-best photo and fifty candidates tied
 * behind it, a global-maximum tie group returns a single photo, enrichment is
 * skipped, and every slot after the first is decided by exactly the flat-zero
 * popularity data this whole mechanism exists to replace.
 *
 * The boundary is the last slot. Candidates strictly ABOVE it are already in on
 * theme alone; candidates strictly BELOW it can never reach it. Only the ones
 * sharing the boundary's theme tuple are still competing, so only they matter.
 *
 * @param {Array<object>} scored - from buildScoredCandidates
 * @param {number} slotsToFill
 * @returns {Array<object>} the photo objects to enrich ([] when nothing is contested)
 */
const selectEnrichmentSet = (scored, slotsToFill) => {
    if (!Array.isArray(scored) || scored.length === 0) return [];
    if (!Number.isInteger(slotsToFill) || slotsToFill <= 0) return [];
    // Every candidate gets a slot — their order is irrelevant.
    if (scored.length <= slotsToFill) return [];

    const byTheme = scored.slice().sort(compareTheme);
    const boundary = byTheme[slotsToFill - 1];
    const contested = byTheme.filter((entry) => sameTheme(entry, boundary));
    // A unique occupant of the boundary slot is already settled on theme alone.
    return contested.length <= 1 ? [] : contested.map((entry) => entry.photo);
};

/**
 * Sort scored candidates and take the top `slotsToFill` ids.
 *
 * Match tiers first, popularity tiers last. Because every match tier is
 * non-negative, a photo that matched on ANY of them cannot be overtaken by a
 * photo that matched on none — the popularity tiers below are only ever
 * reached by photos that tied, which for an unmatched photo means tied at
 * zero. That is the governing rule ("a theme match always beats popularity")
 * and it is enforced by this ordering, so do not reorder these.
 *
 * @param {Array<object>} scored
 * @param {number} slotsToFill
 * @returns {Array<string>}
 */
const finalizePick = (scored, slotsToFill) => {
    if (!Array.isArray(scored) || scored.length === 0) return [];
    if (!Number.isInteger(slotsToFill) || slotsToFill <= 0) return [];
    const ranked = scored.slice().sort((a, b) => {
        const theme = compareTheme(a, b);
        if (theme !== 0) return theme;
        // Known-stat photos outrank unknown-stat ones: an unenriched photo still
        // carries get_photos_private's flat votes:0, which is missing data, not
        // a measurement of zero.
        if (b.statsKnown !== a.statsKnown) return b.statsKnown ? 1 : -1;
        if (b.votes !== a.votes) return b.votes - a.votes;
        if (b.achievementCount !== a.achievementCount) return b.achievementCount - a.achievementCount;
        if (b.views !== a.views) return b.views - a.views;
        return b.uploadDate - a.uploadDate;
    });
    return ranked.slice(0, slotsToFill).map((p) => p.id);
};

module.exports = {
    SEMANTIC_MATCH_FLOOR,
    SEMANTIC_SUPPORT_CAP,
    semanticTiersOf,
    achievementCountOf,
    statsKnownOf,
    votesOf,
    viewsOf,
    uploadDateOf,
    hasThemeMatch,
    selectEnrichmentSet,
    finalizePick,
};
