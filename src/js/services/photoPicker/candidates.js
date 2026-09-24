/**
 * Photo picker — candidate filtering and scoring: the hard filters
 * (must-include tags, letter prefix), the negated-subject exclusion, the
 * per-photo tier record, and the one-call pick.
 */

const { MIN_USER_TAG_STEM_LENGTH, tokeniseTagList } = require('./stemming');
const { detectLetterPrefix, excludedSubjectOf, photoShowsExcluded } = require('./title');
const { buildChallengeKeywords } = require('./keywords');
const { wholeLabelStems, labelWordStems, photoMatchesAllStems, countShouldMatches, scorePhoto } = require('./labels');
const {
    semanticTiersOf,
    achievementCountOf,
    statsKnownOf,
    votesOf,
    viewsOf,
    uploadDateOf,
    finalizePick,
} = require('./tiers');

// Same "never throws" contract as resolveSemanticScores: a buggy callback must
// not turn a fill that would succeed into a crash.
const notifyFallback = (opts, info) => {
    if (typeof opts.onFallback !== 'function') return;
    try {
        opts.onFallback(info);
    } catch {
        // Deliberately swallowed — the callback is observability-only.
    }
};

/**
 * Picks photos to submit to a challenge.
 *
 * @param {object} challenge - challenge object (url, title, welcome_message all optional)
 * @param {Array<object>} eligiblePhotos - candidates from getEligiblePhotos
 * @param {number} slotsToFill - how many photos to return at most
 * @param {{mustIncludeTags?: string[], shouldIncludeTags?: string[], fillWithoutTagMatch?: boolean, semanticScores?: Map<string, {score: number, support: number}|number>, onFallback?: function}} [opts]
 *   mustIncludeTags: hard filter — keep only photos whose labels match
 *   every distinct tag stem (ALL semantics). Tags are deduped to stems
 *   first, so "larch, larches" collapses to one requirement. A photo
 *   matching a strict subset of the tags is excluded. Empty/missing = no
 *   filter.
 *   shouldIncludeTags: soft boost — photos with more matching tags rank
 *   above photos with fewer, before the existing keyword/quality tiers.
 *   fillWithoutTagMatch: when a HARD filter matches NOTHING, fall back to the
 *   unfiltered set rather than returning [] (so a slot isn't left empty). A hard
 *   filter is the must-include tags (no photo carries every required tag) and/or
 *   the letter-challenge filter derived from the title (no photo has a label
 *   beginning with the challenge's letter); the two compose with AND. Defaults to
 *   true; pass false to keep the slot empty until a fully matching photo exists.
 *   The fallback is all-or-nothing: if any photo satisfies every hard filter,
 *   only those are used and the fallback does not kick in.
 *   semanticScores: optional Map<photoId, {score, support}> from the semantic
 *   matcher — `score` the best-label similarity in 0..1, `support` how many of
 *   the photo's labels cleared the same floor. When present it adds two ranking
 *   tiers (just below the explicit should-tag preference, above the lexical
 *   keyword score) so on-theme photos a substring match misses still rank up,
 *   and so a photo the theme is ABOUT outranks one merely carrying a matching
 *   tag. A bare `number` value is also accepted — the shape documented here
 *   before the support tier existed — and scores with no support. Omit the map
 *   (the default) and ranking is byte-for-byte the lexical-only behavior.
 *   onFallback: optional callback invoked as
 *   onFallback({letterPrefix, mustStems, excludedStems}) when a hard filter
 *   eliminated every photo and the picker relaxed to the unfiltered set (i.e. an
 *   off-theme photo is about to be picked). `excludedStems` is non-empty when
 *   the relaxed filter was a negated title ("No Humans": every candidate's
 *   labels showed the negated subject). Injected
 *   side-channel so this function stays pure — callers use it to log the
 *   fallback where a user can see it. Exceptions it throws are swallowed;
 *   omitting it changes nothing. Not called when fillWithoutTagMatch is false
 *   (the picker returns [] instead of relaxing).
 * @returns {Array<string>} ordered list of photo ids; length <= slotsToFill
 */
const pickPhotosForChallenge = (challenge, eligiblePhotos, slotsToFill, opts = {}) => {
    if (!Number.isInteger(slotsToFill) || slotsToFill <= 0) return [];
    const scored = buildScoredCandidates(challenge, eligiblePhotos, opts);
    return finalizePick(scored, slotsToFill);
};

/**
 * Apply the hard filters (must-include tags, letter prefix) to stemmed photos.
 *
 * When they eliminate everything, relax to the unfiltered set so the slot still
 * gets filled (off-theme best performer) — unless the caller opted out with
 * fillWithoutTagMatch:false, or no hard filter was set at all.
 *
 * @returns {Array<object>|null} the surviving stemmed photos, or null for "pick nothing"
 */
const applyHardFilters = (withStems, mustStems, letterPrefix, opts) => {
    let filtered = withStems;
    if (mustStems.length > 0) {
        filtered = filtered.filter(({ wordStems }) => photoMatchesAllStems(wordStems, mustStems));
    }
    if (letterPrefix) {
        filtered = filtered.filter(({ wholeStems }) =>
            wholeStems.some((s) => s.length >= MIN_USER_TAG_STEM_LENGTH && s[0] === letterPrefix),
        );
    }
    if (filtered.length > 0) return filtered;
    const hadHardFilter = mustStems.length > 0 || Boolean(letterPrefix);
    if (!hadHardFilter || opts.fillWithoutTagMatch === false) return null;
    notifyFallback(opts, { letterPrefix, mustStems, excludedStems: [] });
    return withStems;
};

/**
 * A negated title ("No Humans") excludes photos whose labels show the negated
 * subject. Same all-or-nothing fallback as the hard filters: only when EVERY
 * remaining photo shows it does the picker relax (or return null under
 * fillWithoutTagMatch:false). A photo with no labels cannot be judged and is kept.
 *
 * @returns {Array<object>|null} the surviving stemmed photos, or null for "pick nothing"
 */
const applyExcludedSubjectFilter = (filtered, challenge, opts) => {
    const excluded = excludedSubjectOf(challenge, opts.ignoreWords || null);
    if (!excluded) return filtered;
    const kept = filtered.filter(({ wordStems }) => !photoShowsExcluded(wordStems, excluded));
    if (kept.length > 0) return kept;
    if (opts.fillWithoutTagMatch === false) return null;
    notifyFallback(opts, { letterPrefix: null, mustStems: [], excludedStems: excluded.stems });
    return filtered;
};

/**
 * Filter + score candidates, WITHOUT sorting or slicing.
 *
 * Separate from pickPhotosForChallenge so one fill can score once and then both
 * (a) work out which photos need stat enrichment and (b) produce the final
 * ranking, instead of running this loop twice. The stemming/matching inside is
 * deliberately cost-bounded (see MAX_STEMS_PER_PHOTO and friends) because it is
 * the hot loop of every fill on every scheduler cycle — including the
 * battery-constrained Android headless service.
 *
 * @param {object} challenge
 * @param {Array<object>} eligiblePhotos
 * @param {object} [opts] - same shape as pickPhotosForChallenge's opts
 * @returns {Array<object>} scored entries (unsorted); [] when nothing qualifies
 */
const buildScoredCandidates = (challenge, eligiblePhotos, opts = {}) => {
    if (!Array.isArray(eligiblePhotos) || eligiblePhotos.length === 0) return [];

    const allowed = eligiblePhotos.filter((p) => p && p.permission && p.permission.allowed === true && p.id);
    if (allowed.length === 0) return [];

    const mustStems = tokeniseTagList(opts.mustIncludeTags);
    const shouldStems = tokeniseTagList(opts.shouldIncludeTags);

    // Letter challenges ("Begins With L", "C is for…") add a hard filter: keep
    // only photos with a label beginning with that letter. The MIN_USER_TAG_STEM_LENGTH floor
    // stops generic 2-char vision labels ("in", "at", "on") from spuriously
    // satisfying an I/A/O challenge. Multi-word labels match on the first char of
    // the whole label string — the natural reading of "begins with".
    const letterPrefix = detectLetterPrefix(challenge?.title);

    // Stem each photo's labels once, in BOTH representations, and carry them
    // through the filters and the scoring rather than recomputing.
    //   wordStems  — word-level, for every match (must / should / keyword score)
    //   wholeStems — one stem per whole label, for the letter filter ONLY
    // Wiring a matcher to wholeStems would reintroduce the "sea life" bug; wiring
    // the letter filter to wordStems would let "Ocean Life" satisfy "Begins With L"
    // on its second word. They are not interchangeable — see their definitions.
    const withStems = allowed.map((photo) => ({
        photo,
        wordStems: labelWordStems(photo),
        wholeStems: wholeLabelStems(photo),
    }));
    const hardFiltered = applyHardFilters(withStems, mustStems, letterPrefix, opts);
    if (!hardFiltered) return [];
    const filtered = applyExcludedSubjectFilter(hardFiltered, challenge, opts);
    if (!filtered) return [];

    // Optional semantic tiers — see semanticTiersOf. No map (the default) → both
    // are 0 for every photo → they are inert and the sort is identical to the
    // lexical-only behavior.
    const semanticScores = opts.semanticScores instanceof Map ? opts.semanticScores : null;

    const keywords = buildChallengeKeywords(challenge, opts.ignoreWords || null);
    return filtered.map(({ photo, wordStems }) => {
        const { semantic, semanticSupport } = semanticTiersOf(semanticScores, photo.id);
        return {
            id: photo.id,
            photo,
            shouldMatchCount: countShouldMatches(wordStems, shouldStems),
            semantic,
            semanticSupport,
            score: scorePhoto(photo, keywords, wordStems),
            statsKnown: statsKnownOf(photo),
            achievementCount: achievementCountOf(photo),
            votes: votesOf(photo),
            views: viewsOf(photo),
            uploadDate: uploadDateOf(photo),
        };
    });
};

module.exports = {
    pickPhotosForChallenge,
    buildScoredCandidates,
};
