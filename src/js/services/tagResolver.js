/**
 * GuruShots Auto Voter - Challenge term -> real tag resolution
 *
 * Turns the terms auto-fill derives from a challenge into tags that the
 * member's library actually carries, so the server-side photo search has
 * something it can match.
 *
 * WHY THIS EXISTS: get_photos_private?search= matches a tag EXACTLY, and a
 * challenge title is rarely a tag. "Stairs" stems to "stair"; the library's tag
 * is "staircase"; the exact search returns nothing and auto-fill falls back to
 * an unfiltered library walk ranked by popularity — an off-theme submission.
 * search_autocomplete matches a SUBSTRING and answers "stair" -> ["staircase"],
 * which closes exactly that gap. See api/tags.js for the endpoint contract.
 *
 * TWO GUARDS, because a substring match is blunt:
 *
 *   BACKOFF is bounded. "stairs" itself resolves to nothing (no tag CONTAINS
 *   "stairs"), so a term that misses is retried a character shorter, but only
 *   MAX_BACKOFF_STEPS times and never below the server's own 3-char ceiling.
 *   Each extra step is both a round-trip and a looser match, so the cheap,
 *   precise probes happen first and the loose ones are capped.
 *
 *   VALIDATION is mandatory for anything the backoff produced. Truncation gets
 *   noisy fast — "fac" answers ["face","factory","manufacturing"], and filling
 *   a "Faces" challenge from a factory photo is the same class of bug this
 *   module exists to fix. A candidate is kept only when it is a lexical match
 *   for the term (it simply IS the word, modulo stemming) or the shipped
 *   word-vector lexicon puts it on theme at or above SEMANTIC_MATCH_FLOOR.
 *
 * Everything here degrades to [] rather than throwing: the caller treats an
 * empty result as "no resolution available" and proceeds exactly as it did
 * before this module existed.
 */

const { buildThemeKeywords, matches, stem, tokenise, SEMANTIC_MATCH_FLOOR } = require('./photoPicker');
const lexicon = require('./semantic/lexicon');

// The server returns nothing under 3 characters, so backing off past it only
// burns round-trips. Two steps covers the realistic gap between a stemmed title
// word and a tag ("stairs"->"stair", "lighthouses"->"lighthouse") without
// walking a long word down to a meaningless prefix.
const MAX_BACKOFF_STEPS = 2;
// Must match MIN_AUTOCOMPLETE_CHARS in api/tags.js — both encode the same server
// behavior (nothing is returned below three characters). Kept local rather than
// imported because business logic does not reach into src/js/api/*; if one
// moves, move the other.
const MIN_TERM_LENGTH = 3;

// Resolution is a narrowing step, not a broadening one: more terms means more
// single-page searches on a path that can run close to a deadline, and the
// union of several loose tags is how an off-theme photo sneaks back in.
const MAX_RESOLVED_TAGS = 3;

/**
 * Is `tag` simply the word `term` already, allowing for stemming?
 *
 * A tag that survives this needs no semantic vetting — matching "face" to the
 * tag "face" (or "faces") is the trivially correct answer, and requiring the
 * lexicon to confirm it would reject perfectly good tags whenever a word is
 * out of vocabulary.
 *
 * @param {string} tag
 * @param {string} term
 * @returns {boolean}
 */
const isLexicalMatch = (tag, term) => {
    const termStem = stem(term);
    // keepStopwords: a tag is the member's own vocabulary, not challenge
    // boilerplate — "body part" must keep both words.
    return tokenise(tag, { keepStopwords: true }).some((tagStem) => matches(tagStem, termStem));
};

/**
 * Best cosine between the challenge theme and a candidate tag, on the same
 * 0..100 bucket scale as SEMANTIC_MATCH_FLOOR.
 *
 * Mirrors services/semantic/index.js: the tag is embedded as ONE label (its
 * words mean one thing together), then compared with the mean-pooled challenge
 * keywords. Returns null when either side is out of vocabulary — "no signal",
 * which is not the same as a measured zero.
 *
 * CAVEAT ON THE FLOOR: scripts/validate-lexicon.js measures
 * p99(unrelated) < FLOOR < p25(related) over VISION-LABEL-shaped pairs, not over
 * member tag names. The two distributions are close enough to share a threshold
 * — a tag and a label are both short concrete nouns from the same vocabulary —
 * but the statistical guarantee is borrowed, not independently proven here. It
 * is the conservative direction to borrow in: a tag that fails this check is
 * merely not used to narrow the search, and the fill proceeds as it would have
 * without resolution at all.
 *
 * @param {Float64Array|null} challengeVec
 * @param {string} tag
 * @returns {number|null}
 */
const themeBucketOf = (challengeVec, tag) => {
    if (!challengeVec) return null;
    const tokens = tokenise(tag, { keepStopwords: true });
    if (tokens.length === 0) return null;
    const tagVec = lexicon.embed(tokens);
    if (!tagVec) return null;
    const sim = lexicon.cosine(challengeVec, tagVec);
    if (!Number.isFinite(sim)) return null;
    return Math.round(Math.max(0, Math.min(1, sim)) * 100);
};

/**
 * Resolve derived search terms into tags the member's library actually uses.
 *
 * @param {Array<string>} terms - terms from buildSearchTerms (already stemmed)
 * @param {object} challenge - the challenge, for theme validation
 * @param {object} deps
 * @param {string} deps.token
 * @param {string} deps.memberId - member id or user_name (never an email)
 * @param {(token: string, term: string, memberId: string) => Promise<Array<string>>} deps.searchTagAutocomplete
 * @param {object} [deps.logger]
 * @param {string} [deps.logLabel]
 * @returns {Promise<Array<string>>} resolved tags (<= MAX_RESOLVED_TAGS), or []
 *   when nothing survived — caller then behaves exactly as before.
 */
const resolveTermsToTags = async (terms, challenge, deps) => {
    const { token, memberId, searchTagAutocomplete, logger, logLabel = 'autoFill', ignoreWords = null } = deps || {};
    if (!Array.isArray(terms) || terms.length === 0) return [];
    if (!token || !memberId || typeof searchTagAutocomplete !== 'function') return [];

    // Load once up front. If the asset is unavailable the challengeVec stays
    // null and themeBucketOf returns null for everything, which leaves ONLY the
    // lexical branch live — a deliberate tightening, not a silent pass-through.
    let challengeVec = null;
    try {
        if (await lexicon.isAvailable()) {
            challengeVec = lexicon.embed(buildThemeKeywords(challenge, ignoreWords));
        }
    } catch {
        // Lexicon problems must never break a fill; lexical matching still works.
    }

    const usable = terms.filter((term) => typeof term === 'string' && term.length >= MIN_TERM_LENGTH);
    if (usable.length === 0) return [];

    // One backoff CHAIN per term, chains run concurrently.
    //
    // Within a term the probes must stay ordered — each is a looser fallback for
    // the one before, and firing them together would both waste calls and make
    // the winner ambiguous. Across terms there is no such dependency, and this
    // whole path only runs on a fill that has ALREADY missed, close to a
    // deadline. Sequential chains would stack to SEARCH_TERMS_CAP x
    // (MAX_BACKOFF_STEPS + 1) round-trips end to end; this bounds the wall clock
    // to the slowest single chain, the same reasoning that parallelises
    // searchUnion in autoFill.js.
    const chains = await Promise.all(
        usable.map(async (term) => {
            for (let step = 0; step <= MAX_BACKOFF_STEPS; step++) {
                const probe = term.slice(0, term.length - step);
                if (probe.length < MIN_TERM_LENGTH) break;

                let items;
                try {
                    items = await searchTagAutocomplete(token, probe, memberId);
                } catch {
                    // api/tags.js already resolves [] on failure; this is belt-and-
                    // braces for an injected dep that rejects. Treat as a miss.
                    items = [];
                }
                if (!Array.isArray(items) || items.length === 0) continue;

                // The server answered. A shorter probe can only be looser, so this
                // chain is done either way — continuing would spend round-trips to
                // widen a match we are about to judge off-theme.
                return { term, probe, items };
            }
            return null;
        }),
    );

    // Accept in TERM order, not completion order, so the result is deterministic
    // regardless of which request happened to land first.
    const resolved = [];
    const seen = new Set();
    for (const chain of chains) {
        if (!chain) continue;
        const { term, probe, items } = chain;
        let acceptedHere = 0;
        for (const tag of items) {
            if (typeof tag !== 'string' || tag === '' || seen.has(tag)) continue;

            const lexical = isLexicalMatch(tag, term);
            const bucket = lexical ? null : themeBucketOf(challengeVec, tag);
            const onTheme = bucket !== null && bucket >= SEMANTIC_MATCH_FLOOR;
            if (!lexical && !onTheme) continue;

            seen.add(tag);
            resolved.push(tag);
            acceptedHere++;
            if (resolved.length >= MAX_RESOLVED_TAGS) break;
        }
        if (logger && acceptedHere > 0 && probe !== term) {
            logger
                .withCategory(logLabel)
                .debug(`${logLabel}: term "${term}" resolved via shortened probe "${probe}"`, null);
        }
        if (resolved.length >= MAX_RESOLVED_TAGS) break;
    }

    return resolved;
};

module.exports = {
    resolveTermsToTags,
    MAX_BACKOFF_STEPS,
    MAX_RESOLVED_TAGS,
    // exported for unit tests
    isLexicalMatch,
};
