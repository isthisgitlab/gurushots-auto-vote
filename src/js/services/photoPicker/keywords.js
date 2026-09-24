/**
 * Photo picker — the challenge-side word lists: lexical keywords, the pooled
 * semantic theme, the image model's subject words, and the server-side search
 * terms auto-fill narrows the library with.
 */

const { MIN_USER_TAG_STEM_LENGTH, stem, rawTokenise, tokenise } = require('./stemming');
const {
    abstractTitleWords,
    withoutAbstract,
    titleSubject,
    NEGATION_MARKER_STEMS,
    parseNegation,
    dropNegated,
    detectLetterPrefix,
} = require('./title');

// Keyword count is bounded for the same reason the per-photo stem count is (see
// MAX_STEMS_PER_PHOTO): these keywords are the inner loop of every scorePhoto
// call AND become the vecCache key in semantic/index.js, whose MAX_CACHE bounds
// the number of entries but not the size of one. A challenge's real subject is a
// few nouns; a welcome_message can be arbitrarily long prose.
const MAX_CHALLENGE_KEYWORDS = 48;

const buildChallengeKeywords = (challenge, ignoreWords = null) => {
    const opts = { ignoreWords };
    // The WHOLE title, series prefix included — unlike buildThemeKeywords, which
    // pools its keywords into one vector and so must drop everything that is not
    // the subject. Here each keyword is matched on its own, so a series word is
    // at worst weak evidence, and keeping it means "Mountains: A Tribute" still
    // scores a mountain photo even though the subject heuristic reads the tail.
    //
    // A negated subject ("No Humans") is removed from all three sources: the url
    // slug and the welcome_message repeat it, and a keyword here ranks photos UP.
    const negation = parseNegation(challenge?.title, ignoreWords);
    const title = negation.active ? negation.positiveTitle : challenge?.title;
    const fromTitle = tokenise(title, opts);
    const fromUrl = tokenise(challenge?.url, opts);
    const fromWelcome = tokenise(challenge?.welcome_message, opts);
    // A title word judged not-the-subject ("fun" in "Balloon Fun") is dropped
    // from every source: the slug and the prose repeat it, and here it would
    // score every photo vision-labelled "Fun" as on theme.
    const abstract = abstractTitleWords(fromTitle);
    const all = dropNegated([...fromTitle, ...fromUrl, ...fromWelcome], negation).filter((s) => !abstract.has(s));
    // title + url first, so if the cap bites it is the long welcome_message prose
    // that gets dropped, never the title — which is where the subject actually is.
    return Array.from(new Set(all)).slice(0, MAX_CHALLENGE_KEYWORDS);
};

/**
 * The challenge's SUBJECT words — url + title only, no welcome_message.
 *
 * FOR THE SEMANTIC TIER ONLY. That tier mean-pools its keywords into a single
 * theme vector, and a welcome_message is prose: the live "Stairs" challenge
 * reads "Stairs are both practical and ornamental... made of wood or stone...
 * with people on them", which contributes thirteen words that are examples of
 * VARIATION, not the subject. Averaging them in drags the theme vector off the
 * subject and toward generic scene description — measured against the shipped
 * lexicon, the similarity between that challenge and the tag "staircase" falls
 * from 0.94 to 0.25, i.e. from a confident match to below the floor. The effect
 * is the challenge-side twin of the label-bag dilution documented in
 * services/semantic/index.js.
 *
 * The lexical tier keeps using buildChallengeKeywords: there each keyword is
 * matched independently, so extra words can only add weak evidence — they
 * cannot drag a vector around. Only pooling is fragile to them.
 *
 * TITLE FIRST, url only as a fallback. The two normally agree (the slug is the
 * title, slugified), but on a SERIES challenge the slug is recycled and can name
 * the previous run's subject: the live "Color Hunt: Green" ships
 * url="color-hunt-blue1", so pooling url+title put the wrong colour — blue — in
 * the theme for a green challenge. The title is the authored, current field;
 * the slug is a URL that happens to look like words.
 *
 * Returns [] when url+title carry no subject, and deliberately does NOT fall
 * back to the welcome_message. An empty result here is informative: every
 * stopword-surviving word has been stripped, which is what a meta-challenge
 * ("Guru of The Week") looks like. Handing such a challenge the body prose
 * instead would rebuild exactly the diluted vector this function exists to
 * avoid, and would score photos against marketing copy. With [] the semantic
 * tier goes inert and the honest signals — lexical match, then popularity —
 * decide, which is the right answer for a challenge with no visual subject.
 *
 * @param {object} challenge
 * @returns {string[]}
 */
const buildThemeKeywords = (challenge, ignoreWords = null) => {
    const opts = { ignoreWords };
    // A negated subject must not become the theme (see parseNegation): pooling
    // "human" for "No Humans" pulls the vector straight at photos of people.
    const negation = parseNegation(challenge?.title, ignoreWords);
    const title = negation.active ? negation.positiveTitle : challenge?.title;
    // Pooling is where an abstract word hurts most — "fun" averaged into
    // "balloon" drags the theme toward parties and laughter — so only the
    // subject words are pooled (see abstractTitleWords).
    const fromTitle = withoutAbstract(dropNegated(tokenise(titleSubject(title, ignoreWords), opts), negation));
    if (fromTitle.length > 0) return Array.from(new Set(fromTitle)).slice(0, MAX_CHALLENGE_KEYWORDS);
    // Title said nothing usable — the slug is the only signal left, and with no
    // title to contradict it there is nothing for a stale one to poison.
    const fromUrl = withoutAbstract(dropNegated(tokenise(challenge?.url, opts), negation));
    return Array.from(new Set(fromUrl)).slice(0, MAX_CHALLENGE_KEYWORDS);
};

/**
 * The challenge's subject as readable words, for the image model's prompt:
 * the title subject buildThemeKeywords starts from (series prefix and negated
 * words removed), but unstemmed — "leaves", not "leav". Empty for a title with
 * no visual subject ("Guru of The Week").
 *
 * abstractTitleWords is deliberately NOT applied: the word vectors read some
 * nouns as abstract ("leaves" as the verb), and dropping it turned "Glorious
 * Green Leaves" into "a photo of green". The image model handles a qualifier
 * like "fun" in "balloon fun" fine; it does not handle a missing subject.
 *
 * @param {object} challenge
 * @param {Iterable<string>|null} [ignoreWords]
 * @returns {string[]}
 */
const visualSubjectWords = (challenge, ignoreWords = null) => {
    const negation = parseNegation(challenge?.title, ignoreWords);
    const title = negation.active ? negation.positiveTitle : challenge?.title;
    const negated = new Set(negation.stems);
    const words = rawTokenise(titleSubject(title, ignoreWords), { ignoreWords }).filter(
        (word) => !negated.has(stem(word)) && !NEGATION_MARKER_STEMS.has(stem(word)),
    );
    return Array.from(new Set(words));
};

// Trailing '-ing' marks a participle ("running", "leading"). Length-guarded the
// same way the stemmer's own '-ing' branch is, so short words that merely end in
// those letters ("king", "ring", "wing" — all plausible subjects) are not caught.
const isParticiple = (word) => word.length > 5 && word.endsWith('ing');

// Issue at most a few server-side searches per fill: a title rarely has more
// than two or three subject nouns, and tag lists are short. The cap bounds the
// extra requests the union fetch makes.
const SEARCH_TERMS_CAP = 3;

/**
 * Derive the ordered list of server-side `search` terms for a challenge, used
 * by auto-fill to narrow the eligible library to on-theme photos before
 * ranking. Precedence: Must Include Tags → Should Include Tags → challenge
 * title.
 *
 * Tags are taken close to as the user typed them (real words the GuruShots
 * search index can match), only lower-cased/trimmed and length-floored like
 * tokeniseTagList. The title path reuses `tokenise` (stopword-filtered + light
 * stemming), so "Let's See Hats" collapses to ["hat"]. Deduped and capped to
 * SEARCH_TERMS_CAP. Returns [] when nothing usable is derivable (abstract
 * title, no tags) — the caller then fetches the unfiltered library.
 *
 * @param {object} challenge - challenge object (title optional)
 * @param {{mustIncludeTags?: string[], shouldIncludeTags?: string[]}} [opts]
 * @returns {string[]} ordered, deduped search terms; length <= SEARCH_TERMS_CAP
 */
const buildSearchTerms = (challenge, opts = {}) => {
    const { mustIncludeTags, shouldIncludeTags, ignoreWords = null } = opts || {};
    const fromTags = (tags) =>
        Array.isArray(tags)
            ? tags
                  .filter((t) => typeof t === 'string')
                  .map((t) => t.trim().toLowerCase())
                  .filter((t) => t.length >= MIN_USER_TAG_STEM_LENGTH)
            : [];

    let terms = fromTags(mustIncludeTags);
    if (terms.length === 0) terms = fromTags(shouldIncludeTags);
    // Letter challenges ("Begins With L") have no usable server-search term — the
    // GuruShots search index can't express "label starts with L" — so skip title
    // tokenisation and leave terms empty; the caller then fetches the full library
    // and the client-side letter filter in pickPhotosForChallenge narrows it. A
    // non-letter title still tokenises as before.
    if (terms.length === 0 && !detectLetterPrefix(challenge?.title)) {
        // Subject segment only: on a series title the prefix ("Color Hunt") is
        // never a tag, so searching it spends a round-trip to find nothing and
        // burns one of the SEARCH_TERMS_CAP slots the real subject needs.
        //
        // HEAD-NOUN FIRST. An English title puts its subject last and its
        // qualifiers in front — "Epic Lighthouses", "Dramatic Storms", "Melodic
        // Instruments" — so reversing makes the subject the first term tried and
        // the last one the cap would drop. That matters because the cap is small:
        // "Color Hunt: Blue & Orange" used to yield [color, hunt, blue] and lose
        // "orange" entirely.
        //
        // Never search a negated subject: "No Humans" searching "human" would
        // fetch exactly the photos the challenge forbids.
        const negation = parseNegation(challenge?.title, ignoreWords);
        const title = negation.active ? negation.positiveTitle : challenge?.title;
        const words = rawTokenise(titleSubject(title, ignoreWords), { ignoreWords });
        // A participle is a modifier, never the subject: "Leading with Lines" is
        // about lines, "Cats and Dogs Running" is about cats and dogs. Sink them
        // behind the nouns, then read the nouns right-to-left.
        //
        // Last of all go the words that mean an idea rather than a thing:
        // head-noun-first reads "Balloon Fun" as a kind of fun and would
        // search "fun" first. Demoted, not dropped — a library tagged only
        // "fun" still has something to find once the subject misses.
        const abstract = abstractTitleWords(words);
        const participles = words.filter((w) => isParticiple(w) && !abstract.has(w));
        const heads = words.filter((w) => !isParticiple(w) && !abstract.has(w)).reverse();
        const ideas = words.filter((w) => abstract.has(w)).reverse();
        terms = dropNegated([...heads, ...participles, ...ideas].map(stem), negation);
    }
    return Array.from(new Set(terms)).slice(0, SEARCH_TERMS_CAP);
};

module.exports = {
    buildChallengeKeywords,
    buildThemeKeywords,
    visualSubjectWords,
    buildSearchTerms,
};
