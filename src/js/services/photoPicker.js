/**
 * GuruShots Auto Voter - Photo Picker
 *
 * Pure ranking function used by the auto-fill flow to choose which of
 * the user's eligible photos to submit into a challenge.
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

const STOPWORDS = new Set([
    // Articles, prepositions, conjunctions, copulas
    'in',
    'of',
    'the',
    'a',
    'an',
    'and',
    'or',
    'with',
    'on',
    'for',
    'to',
    'at',
    'from',
    'by',
    'about',
    'as',
    'if',
    'so',
    'no',
    'not',
    'is',
    'it',
    'this',
    'that',
    'these',
    'those',
    // Pronouns
    'my',
    'me',
    'mine',
    'we',
    'us',
    'our',
    'ours',
    'you',
    'your',
    'yours',
    'he',
    'she',
    'they',
    'them',
    'their',
    // Auxiliary verbs
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'should',
    'could',
    'can',
    // Quantifiers
    'all',
    'any',
    'some',
    'more',
    'most',
    'less',
    'few',
    'many',
    'much',
    // Photography / GuruShots vocabulary that doesn't help match labels
    'shots',
    'shot',
    'photo',
    'photos',
    'photography',
    'photographer',
    'image',
    'images',
    'picture',
    'pictures',
    'pic',
    'pics',
    'gurushots',
    'challenge',
    'challenges',
    'contest',
    'contests',
    // Reward / level copy from welcome messages
    'reward',
    'rewards',
    'prize',
    'prizes',
    'win',
    'wins',
    'winner',
    'winners',
    'level',
    'levels',
    'badge',
    'badges',
    'point',
    'points',
    'coin',
    'coins',
    'allstar',
    'elite',
    'premier',
    'popular',
    'skilled',
    'guru',
    'gurus',
    'earn',
    'earns',
    'earned',
    'earning',
    'participation',
    'participate',
    // Recurring-award / cadence words. "Photographer of the Week", "Guru of The
    // Week" name a CONTEST PERIOD, never a visual subject, and left in they are
    // the whole theme — a challenge whose only keyword is "week" scores random
    // photos at 0.48 purely on vector noise, which then outranks the user's own
    // best photo on a challenge nothing can legitimately match.
    'week',
    'weekly',
    'month',
    'monthly',
    'year',
    'yearly',
    'daily',
    // Welcome-message boilerplate verbs
    'capture',
    'captured',
    'capturing',
    'submit',
    'submitted',
    'submission',
    'enter',
    'entered',
    'entering',
    'entry',
    'entries',
    'join',
    'joined',
    'joining',
    // Title-imperative verbs ("Let's See Hats", "Show us your...",
    // "Share your best..."). These carry no subject signal and would
    // otherwise leak into the keyword scorer and the derived search terms.
    'let',
    'lets',
    'see',
    'seen',
    'show',
    'shows',
    'showing',
    'shown',
    'share',
    'shares',
    'sharing',
    'shared',
    // Welcome-message boilerplate adjectives / fillers
    'good',
    'luck',
    'great',
    'best',
    'better',
    'nice',
    // Abstract head-nouns. These are real nouns, but they name no visual
    // subject — in a title the MODIFIER carries all the signal and the head
    // noun carries none ("The Farm Life" is about farms; "Sea Life" is about
    // the sea). Leaving them in was the root of the Farm-Life-picks-Sea-Life
    // bug: "life" both drove a server-side search that pulled in sea-life
    // photos AND scored those photos as a keyword match.
    //
    // Only the challenge side strips these (tokenise filters before it stems,
    // so entries are raw words). A user who TYPES "sea life" as a tag means it
    // literally, and tokeniseTagList / label tokenisation both pass
    // keepStopwords:true to honour that.
    //
    // NOT included: "mood", "style", "vibe". They are weaker cases than the
    // above and stripping them would break the legitimate niche challenge
    // whose entire subject is that word (see the "Mood" case in
    // tests/services/photoPicker.test.js).
    'life',
    'lives',
    'living',
    'world',
    'worlds',
    'time',
    'times',
    'moment',
    'moments',
    'thing',
    'things',
    'day',
    'days',
    'story',
    'stories',
    'tale',
    'tales',
]);

const isPureDigit = (token) => /^\d+$/.test(token);

// Bases that take '-es' rather than a bare '-s'. 'ss' is listed explicitly
// because a single trailing 's' is ambiguous — 'glass'+es vs 'hous'+e+s — and
// only the doubled form is reliably a sibilant base ('glasses'→'glass' while
// 'houses'→'house').
const SIBILANT_ES_RE = /(?:x|z|ch|sh|ss)$/;

/**
 * Light suffix stemmer covering the common inflected forms that show
 * up in challenge text vs. vision labels: plurals (flowers→flower),
 * gerunds (jumping→jump), past tense (jumped→jump), 'ies' nouns
 * (categories→category). Keeps the algorithm dependency-free; the residue it
 * leaves ('runn' from 'running') is absorbed by the bounded-prefix branch of
 * matches(), which is what the MAX_STEM_PREFIX_DELTA allowance exists for.
 *
 * SIBILANT RULE (see SIBILANT_ES_RE): '-es' is only a plural SUFFIX after a
 * sibilant — box→boxes, dish→dishes, church→churches, glass→glasses. A word
 * that already ends in '-e' just takes '-s' (face→faces, tree→trees,
 * lighthouse→lighthouses), so stripping a blanket two characters there ate a
 * real letter and produced a non-word: 'faces'→'fac', 'trees'→'tre',
 * 'lighthouses'→'lighthous'. That was not cosmetic. Those stems are what the
 * auto-fill search term and the semantic lexicon key are BOTH derived from, so
 * a "Lighthouses" challenge searched the exact tag 'lighthous' (no such tag —
 * zero candidates, fell back to the whole library) AND missed the lexicon,
 * which has 'lighthouse' but no 'lighthous'. Both failures disappear with the
 * correct stem.
 */
const stem = (word) => {
    if (typeof word !== 'string' || word.length < 4) return word || '';
    const w = word;
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    // length > 4, not > 5: at 5 this rule was skipped entirely and the word fell
    // through to the '-es' branch, so "skies" stemmed to "ski" (and, once the
    // sibilant rule landed, "skie") — never "sky". A "Dramatic Skies" challenge
    // therefore could not match a "Sky" label at all. Every 5-letter '-ies' word
    // is a y-plural (skies, flies, cries, tries, spies); the '-ie' + s words that
    // this rule genuinely mis-stems (movies, cookies) are all 6+ and were already
    // mis-stemmed before, so widening to 5 adds no new failure.
    if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith('es')) {
        // Drop the whole '-es' only when what precedes it is a sibilant, i.e.
        // the base could not have taken a bare '-s'. Otherwise the base ends
        // in '-e' and only the '-s' is inflection. 'buses'→'buse' is the known
        // residue of not having a dictionary; the bounded-prefix branch of
        // matches() absorbs it exactly as it absorbs 'runn'.
        const base = w.slice(0, -2);
        return SIBILANT_ES_RE.test(base) ? base : w.slice(0, -1);
    }
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
};

// Every string tokenise() sees is untrusted: challenge title / url /
// welcome_message and photo labels all come from the GuruShots API. Truncating
// AFTER tokenising would still pay the full lowercase + tag-strip + regex-split +
// per-token stem cost on an arbitrarily long input, so bound the input itself —
// this is the single choke point through which all untrusted text reaches the
// matcher and the embedding cache. Real titles and labels are a handful of words;
// 4096 chars is far above anything legitimate and well under anything painful.
const MAX_TOKENISE_CHARS = 4096;

// keepStopwords skips the photography-noise stopword list. Challenge text
// is full of boilerplate ("shots", "best", "good luck") that drowns out the
// real subject, so the keyword path filters it. But a user who explicitly
// types those words as a tag means them literally — honor the input.
const toIgnoreSet = (words) => {
    if (words instanceof Set) return words.size > 0 ? words : null;
    if (!Array.isArray(words) || words.length === 0) return null;
    const out = new Set();
    for (const word of words) {
        if (typeof word !== 'string') continue;
        const normalised = word.trim().toLowerCase();
        if (normalised !== '') out.add(normalised);
    }
    return out.size > 0 ? out : null;
};

const rawTokenise = (text, { keepStopwords = false, ignoreWords = null } = {}) => {
    if (typeof text !== 'string' || text.length === 0) return [];
    // Matched against the RAW word, before stemming — same as STOPWORDS — so a
    // user writing "captivating" catches it without having to know that the
    // stemmer turns it into "captivat".
    const ignore = toIgnoreSet(ignoreWords);
    return text
        .slice(0, MAX_TOKENISE_CHARS)
        .toLowerCase()
        .replace(/<[^>]*>/g, ' ')
        .split(/[^a-z0-9]+/)
        .map((t) => t.replace(/\d+$/, ''))
        .filter(
            (t) =>
                t.length > 1 &&
                !isPureDigit(t) &&
                (keepStopwords || !STOPWORDS.has(t)) &&
                !(ignore !== null && ignore.has(t)),
        );
};

// The surface words above, stemmed. Split from rawTokenise because term
// ORDERING needs to see the original spelling — the stemmer erases the '-ing'
// that marks a participle (see buildSearchTerms).
const tokenise = (text, opts) => rawTokenise(text, opts).map(stem);

// Trailing '-ing' marks a participle ("running", "leading"). Length-guarded the
// same way the stemmer's own '-ing' branch is, so short words that merely end in
// those letters ("king", "ring", "wing" — all plausible subjects) are not caught.
const isParticiple = (word) => word.length > 5 && word.endsWith('ing');

// Series titles name the run, then the actual subject: "Color Hunt: Green",
// "Screen Stars: Mountains", "Guru Picks: Portraits". Everything before the
// separator is the series, so the subject is what follows it.
//
// Colon, the two long dashes, and a SPACE-DELIMITED hyphen. A BARE hyphen is
// still not a separator — it shows up inside ordinary titles and compound words
// ("Black-and-White", "Close-Up") far too often to treat as structure, and
// getting that wrong would silently discard a real subject. The spacing is what
// separates the two cases: a compound joins its parts with no spaces, so " - "
// is structural punctuation while "-" is orthography.
//
// That distinction is load-bearing, not cosmetic. The live series actually
// ships "Screen Stars - Tropic Paradise" with a plain hyphen — the example
// above was written with a colon the real titles do not use. Without this
// branch the whole title became the theme, "stars" entered the pooled theme
// vector, and the semantic tier ranked a Milky Way photo (0.657) over a genuine
// tropical one (0.598) — pre-empting the lexical tier, where the tropical photo
// actually won 2-1.
//
// Falls back to the whole title when the tail carries no usable word, so
// "Mountains: A Tribute" keeps "mountains" instead of collapsing to nothing.
const SERIES_SEPARATOR_RE = /[:\u2013\u2014]|\s-\s/;
const titleSubject = (title, ignoreWords) => {
    if (typeof title !== 'string') return '';
    const match = SERIES_SEPARATOR_RE.exec(title);
    if (!match) return title;
    // Skip the WHOLE match, not one character: the spaced-hyphen branch is three
    // characters wide. A fixed +1 would leave "- Tropic Paradise" as the tail —
    // harmless for tokenise(), which strips punctuation anyway, but it would hand
    // buildSearchTerms a leading stray and is simply wrong.
    const tail = title.slice(match.index + match[0].length);
    return tokenise(tail, { ignoreWords }).length > 0 ? tail : title;
};

// Negated titles name what must NOT be in the photo: "No Humans", "Without
// People", "People-Free". 'no'/'not' are stopwords, so before this existed
// "No Humans" tokenised to ["human"] and every tier — theme vector, lexical
// keywords, server search — actively ranked photos OF people first, the exact
// inverse of the brief. A negated subject is therefore stripped from every
// positive keyword source and turned into an exclusion filter instead (see
// buildScoredCandidates).
//
// Only a segment that STARTS with the negation counts ("No Humans", "Color
// Hunt: No Red"), plus the hyphenated "X-free" compound. A bare "free" is not
// matched ("Wild and Free", "Born Free" are subjects, not absences).
const NEGATION_LEAD_RE = /^\s*(?:no|without|non|zero)(?:\s+|-)(.+)$/i;
const FREE_SUFFIX_RE = /\b([a-z]+)-free\b/gi;
// The marker words themselves are not stopwords (only no/not are), so once a
// negation is recognised they must also leave the keyword sources — otherwise
// the url slug "without-people" would hand the theme the word "without".
const NEGATION_MARKER_STEMS = new Set(['no', 'not', 'without', 'non', 'zero', 'free']);
// Stock phrases that open with "no" but are not an absence: "No Place Like
// Home", "No Limits", "No Fear". Such a segment is left as an ordinary subject.
const NEGATION_IDIOM_WORDS = new Set(['like', 'matter', 'limit', 'limits', 'doubt', 'way', 'end', 'fear', 'regret']);
const SERIES_SPLIT_RE = new RegExp(SERIES_SEPARATOR_RE.source, 'g');

const NO_NEGATION = Object.freeze({ positiveTitle: '', stems: Object.freeze([]), active: false });

/**
 * Split a title into its positive text and the stems it says to leave out.
 *
 * @param {string} title
 * @param {Iterable<string>|null} [ignoreWords]
 * @returns {{positiveTitle: string, stems: string[], active: boolean}}
 */
const parseNegation = (title, ignoreWords = null) => {
    if (typeof title !== 'string' || title === '') return NO_NEGATION;
    const stems = new Set();
    const addWords = (text) => {
        const words = rawTokenise(text, { ignoreWords });
        for (const word of words) stems.add(stem(word));
        return words.length > 0;
    };
    const bounded = title.slice(0, MAX_TOKENISE_CHARS);
    // Rejoined with ': ' so titleSubject still sees the series structure of
    // whatever survives.
    const segments = bounded.split(SERIES_SPLIT_RE).map((segment) => {
        const match = NEGATION_LEAD_RE.exec(segment);
        if (!match) return segment;
        if (rawTokenise(match[1], { keepStopwords: true }).some((w) => NEGATION_IDIOM_WORDS.has(w))) return segment;
        return addWords(match[1]) ? '' : segment;
    });
    const positiveTitle = segments.join(': ').replace(FREE_SUFFIX_RE, (whole, word) => (addWords(word) ? ' ' : whole));
    if (stems.size === 0) return { positiveTitle: title, stems: [], active: false };
    return { positiveTitle, stems: Array.from(stems), active: true };
};

// Remove negated subjects and the negation markers from a keyword list.
const dropNegated = (keywords, negation) => {
    if (!negation.active) return keywords;
    const negated = new Set(negation.stems);
    return keywords.filter((k) => !negated.has(k) && !NEGATION_MARKER_STEMS.has(k));
};

// "No People" / "No Humans" is by far the commonest negated brief, and the
// vision labels on a photo of a person rarely say "human": they say "Man",
// "Girl", "Portrait", "Crowd". The word-vector lexicon cannot stand in here —
// measured against "humans" it rates "Animal" (0.54) and "Nature" (0.50) above
// the match floor while "Man" (0.44), "Woman" (0.41) and "Crowd" (0.10) fall
// under it — so the people concept is spelled out. Compared by EXACT stem, not
// matches(): the prefix branch would let "man" catch "mango"/"mane".
const PEOPLE_LABEL_STEMS = new Set(
    [
        'human',
        'person',
        'people',
        'man',
        'men',
        'woman',
        'women',
        'child',
        'children',
        'kid',
        'boy',
        'girl',
        'baby',
        'toddler',
        'teen',
        'teenager',
        'adult',
        'face',
        'portrait',
        'selfie',
        'crowd',
        'bride',
        'groom',
        'family',
        'couple',
        'lady',
        'gentleman',
        'pedestrian',
        'tourist',
    ].map((w) => stem(w)),
);

/**
 * What the challenge title says to leave out, in the shape the exclusion filter
 * reads, or null when the title negates nothing.
 *
 * @param {object} challenge
 * @param {Iterable<string>|null} [ignoreWords]
 * @returns {{stems: string[], concept: Set<string>|null}|null}
 */
const excludedSubjectOf = (challenge, ignoreWords = null) => {
    const { stems, active } = parseNegation(challenge?.title, ignoreWords);
    if (!active) return null;
    return { stems, concept: stems.some((s) => PEOPLE_LABEL_STEMS.has(s)) ? PEOPLE_LABEL_STEMS : null };
};

const photoShowsExcluded = (labelStems, excluded) =>
    labelStems.some(
        (labelStem) =>
            (excluded.concept !== null && excluded.concept.has(labelStem)) ||
            excluded.stems.some((s) => matches(labelStem, s)),
    );

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
    const all = dropNegated([...fromTitle, ...fromUrl, ...fromWelcome], negation);
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
    const fromTitle = dropNegated(tokenise(titleSubject(title, ignoreWords), opts), negation);
    if (fromTitle.length > 0) return Array.from(new Set(fromTitle)).slice(0, MAX_CHALLENGE_KEYWORDS);
    // Title said nothing usable — the slug is the only signal left, and with no
    // title to contradict it there is nothing for a stale one to poison.
    return Array.from(new Set(dropNegated(tokenise(challenge?.url, opts), negation))).slice(0, MAX_CHALLENGE_KEYWORDS);
};

// Minimum stem length for the fuzzy (prefix) branch of matches(). Below this a
// stem may only match by exact equality.
const MIN_FUZZY_STEM_LENGTH = 3;
// How much longer the longer stem may be for the prefix branch to still count.
// The stemmer is deliberately light and leaves short residues ("running" →
// "runn"), so a delta of 2 absorbs that without licensing unrelated words that
// merely share an opening.
const MAX_STEM_PREFIX_DELTA = 2;

/**
 * Does a photo's label word-stem mean the same thing as a challenge keyword /
 * user tag stem?
 *
 * Two stems match when they are equal, or when one is a PREFIX of the other and
 * the length difference is at most MAX_STEM_PREFIX_DELTA — enough to absorb
 * stemmer residue ("runn"/"run", "flower"/"flowers") and nothing more.
 *
 * This replaced a bidirectional substring test (`a.includes(b) || b.includes(a)`),
 * which compared characters rather than words and produced cross-theme nonsense:
 * "art"→"heart", "cat"→"catamaran", "ice"→"office", "sea"→"seagull",
 * "bud"→"buddha", and — the bug that prompted this — the keyword "life"
 * matching the label "Sea Life" in a challenge titled "The Farm Life".
 *
 * KNOWN COST, ACCEPTED: prefix-only cannot see head-final compounds, so
 * "flower" no longer matches "sunflower", nor "fish"/"goldfish" or
 * "bird"/"bluebird". Suffix matching was considered and REJECTED: at any length
 * floor low enough to catch "goldfish" (4) it also admits "rain"→"train",
 * "rain"→"brain" and "hair"→"chair", which is worse than what it fixes.
 * Character comparison simply cannot express "is a kind of" — the word-vector
 * lexicon (pretrained GloVe embeddings, with the curated clusters in
 * scripts/lexicon-concepts.json retrofitted in) can, so those compounds get
 * caught by the semantic tier instead.
 */
const matches = (labelStem, keywordStem) => {
    if (labelStem === keywordStem) return true;
    const [shorter, longer] =
        labelStem.length <= keywordStem.length ? [labelStem, keywordStem] : [keywordStem, labelStem];
    if (shorter.length < MIN_FUZZY_STEM_LENGTH) return false;
    if (longer.length - shorter.length > MAX_STEM_PREFIX_DELTA) return false;
    return longer.startsWith(shorter);
};

// User-typed tags are filtered by length to avoid the bidirectional-substring
// trick in `matches()` producing surprising hits — e.g. a tag stem `"pi"`
// would otherwise match a label `"spiral"`. The challenge-keyword path
// keeps its 2-char floor (set by `tokenise`) because keywords come from
// curated challenge text where short tokens like "sky" or "cat" should match.
const MIN_USER_TAG_STEM_LENGTH = 3;

/**
 * Normalise a user-entered tag list (array of strings) into the same stem
 * space used for challenge keywords, so must/should rules compare like
 * with like against `photo.labels`. Unlike the keyword path, stopwords are
 * kept (a user typing "shot" means it), but stems shorter than
 * MIN_USER_TAG_STEM_LENGTH are dropped to avoid spurious substring matches.
 * Empty/non-array input → [].
 */
const tokeniseTagList = (tags) => {
    if (!Array.isArray(tags) || tags.length === 0) return [];
    const joined = tags.filter((t) => typeof t === 'string').join(' ');
    const stems = tokenise(joined, { keepStopwords: true }).filter((s) => s.length >= MIN_USER_TAG_STEM_LENGTH);
    return Array.from(new Set(stems));
};

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

// Issue at most a few server-side searches per fill: a title rarely has more
// than two or three subject nouns, and tag lists are short. The cap bounds the
// extra requests the union fetch makes.
const SEARCH_TERMS_CAP = 3;

// Detect a "letter challenge" title — "Begins With L", "Starts with the letter A",
// "Things That Start With B" (interior "Start With" matches via the leading \b),
// plus the "X is for" family below ("C is for…", "A is for Apple").
// Returns the lone target letter (lowercased) or null.
//
// SCOPE: the begins/starts-with, "X is for" and "The Letter X" families are
// handled. A bare "L Words" intentionally returns null and keeps today's
// behavior.
//
// SECURITY: `title` is an untrusted string from the GuruShots API. We cap its
// length before matching (ReDoS defense-in-depth, though neither pattern has
// nested quantifiers) and the captured value is a single [a-z] char used ONLY in
// a first-character equality check downstream — never interpolated into a query,
// template, or eval.
//
// The trailing (?![\w-]) (instead of \b) forces the captured letter to be a
// standalone token: "Begins With Love" → null (next char is a word char) and
// "Begins With L-A" → null (next char is '-'); "Begins With L" / "...L." → 'l'.
const LETTER_CHALLENGE_RE =
    /\b(?:begin(?:s|ning)?|start(?:s|ing)?)\s+with\s+(?:the\s+)?(?:letter\s+)?([a-z])(?![\w-])/i;
// "C is for…", "A is for Apple". The (?:^|\s) guard forces the letter to be a
// standalone leading token: "What is for dinner" / "This is for you" → null
// (the single letter before "is" is the tail of a word), and "Q&A is for
// everyone" → null ('&' is neither start-of-string nor whitespace). The
// trailing \b rejects "for" as a prefix of a longer word ("...is forever").
// (?:^|\s) is deliberately a consuming group rather than a lookbehind
// (?<![\w-]): it additionally rejects punctuation-adjacent false positives,
// and only m[1] is read so the consumed whitespace is irrelevant.
const LETTER_IS_FOR_RE = /(?:^|\s)([a-z])\s+is\s+for\b/i;
// "The Letter 'G'", "The Letter G", "Letter G: Green Things" — the form
// GuruShots actually ships, which names the letter instead of describing the
// rule. Without this the title tokenises to the subject noun "letter" and the
// fill chases correspondence (mail, notes, signage) instead of G-subjects.
//
// The letter must be QUOTED or TERMINAL within its segment (end of title, or
// followed by a separator). That deliberate narrowness is what keeps the
// article "a" out: "A Letter a Day" has a bare single char mid-title, which is
// far more often an article than a theme, so it stays null. The cost is that
// "Letter B Challenge" also stays null — an unquoted letter with a trailing
// word is not distinguishable from that article case by shape alone.
//
// Quote pairs are matched by open-class/close-class rather than a backreference
// because the curly pairs differ on each side (U+2018/U+2019, U+201C/U+201D);
// a mismatched pair is accepted since this parses messy titles, not validates.
const LETTER_NAMED_RE = /\bletters?\s*:?\s*(?:['"‘“]\s*([a-z])\s*['"’”]|([a-z])(?=\s*(?:[-–—:;,.!?|]|$)))/i;
const detectLetterPrefix = (title) => {
    if (typeof title !== 'string' || title.length > 200) return null;
    const m = title.match(LETTER_CHALLENGE_RE) || title.match(LETTER_IS_FOR_RE) || title.match(LETTER_NAMED_RE);
    if (!m) return null;
    // Each pattern captures the letter in a different group (LETTER_NAMED_RE has
    // one per quoted/bare branch, only one of which participates), so read the
    // first group that actually matched rather than hard-coding an index.
    const letter = m.slice(1).find((g) => typeof g === 'string' && g.length === 1);
    return letter ? letter.toLowerCase() : null;
};

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
        const participles = words.filter(isParticiple);
        const heads = words.filter((w) => !isParticiple(w)).reverse();
        terms = dropNegated([...heads, ...participles].map(stem), negation);
    }
    return Array.from(new Set(terms)).slice(0, SEARCH_TERMS_CAP);
};

// Bounds on tokenised label data. Photo labels are untrusted strings from the
// GuruShots API, and splitting them into words (rather than keeping one stem per
// label) multiplies how many stems a single photo can contribute. Those stems
// feed the O(stems x keywords) match loops AND the semantic embedding cache key
// (see semantic/index.js, which JSON.stringifies the token array — its MAX_CACHE
// bounds the entry COUNT, not the entry SIZE). Cap both fan-outs, mirroring the
// SEARCH_TERMS_CAP / 200-char caps used elsewhere in this file. Real vision
// labels are 1-3 words; these ceilings are far above anything legitimate.
const MAX_WORDS_PER_LABEL = 12;
const MAX_STEMS_PER_PHOTO = 64;
// Bounds the number of labels iterated at all, so a photo carrying thousands of
// duplicate labels cannot force unbounded tokenise() work: the MAX_STEMS_PER_PHOTO
// early-exit only fires when the deduping Set actually GROWS, so repeated labels
// would otherwise be tokenised in full, one after another, without ever tripping it.
const MAX_LABELS_PER_PHOTO = 64;

/**
 * Whole-label stems: one stem per label, the label stemmed as a single string
 * ("Sea Life" -> "sea life").
 *
 * USED ONLY BY THE LETTER-CHALLENGE FILTER. "Begins With L" reads the first
 * character of the WHOLE label — the natural reading of "begins with" — which is
 * a deliberate decision (see pickPhotosForChallenge). Do not reach for this
 * anywhere else: comparing a whole-label stem against a single-word keyword is
 * exactly the bug this module was fixed for ("sea life" matching "life"). For
 * matching, use labelWordStems.
 */
const wholeLabelStems = (photo) => {
    if (!Array.isArray(photo?.labels)) return [];
    return (
        photo.labels
            .slice(0, MAX_LABELS_PER_PHOTO)
            // Same untrusted-input guard as labelWordStems. Without the type check a
            // null label would stem to the literal string "null" and could satisfy a
            // "Begins With N" challenge; an unbounded label would be stemmed in full.
            .filter((l) => typeof l === 'string' || typeof l === 'number')
            .map((l) => stem(String(l).slice(0, MAX_TOKENISE_CHARS).toLowerCase()))
            .filter(Boolean)
    );
};

/**
 * Label word-stems: every label split into words, stemmed, deduped across the
 * whole photo ("Sea Life" -> ["sea", "life"]).
 *
 * THIS IS THE MATCHING REPRESENTATION — used by scorePhoto, photoMatchesAllStems
 * and countShouldMatches. It puts labels in the same word-level space that user
 * tags have always used (tokeniseTagList already splits "golden hour" into
 * ["golden","hour"]); labels being the odd one out was the root of the
 * Farm-Life-picks-Sea-Life bug.
 *
 * Stopwords are KEPT: a label is not challenge boilerplate, and a user's
 * must-tag "sea life" has to be able to match the label "Sea Life" on both
 * words. Deduping matters — a photo carrying both "Sea" and "Sea Life" must not
 * count "sea" twice.
 */
const labelWordStems = (photo) => {
    if (!Array.isArray(photo?.labels)) return [];
    const out = new Set();
    for (const label of photo.labels.slice(0, MAX_LABELS_PER_PHOTO)) {
        if (typeof label !== 'string' && typeof label !== 'number') continue;
        const words = tokenise(String(label), { keepStopwords: true }).slice(0, MAX_WORDS_PER_LABEL);
        for (const word of words) {
            out.add(word);
            if (out.size >= MAX_STEMS_PER_PHOTO) return Array.from(out);
        }
    }
    return Array.from(out);
};

/**
 * Label word-stems grouped PER LABEL, bounded exactly like labelWordStems
 * ("Sea Life" stays [["sea","life"]] rather than collapsing into the photo's
 * flat stem bag).
 *
 * EXISTS FOR THE SEMANTIC TIER. Vision labels are an unordered bag in which
 * only one or two entries are ever on theme; mean-pooling the whole bag into a
 * single vector asks "is this entire scene about the theme", which a 24-label
 * photo can never answer yes to. Scoring each label separately and keeping the
 * best asks "does ANY label mean this", which is the question the tier is for.
 * See getSemanticScores for the measured effect.
 *
 * Duplicate labels collapse (same stem sequence) so a repeated label cannot pay
 * the embedding cost twice, and groups are truncated to keep the total stem
 * count at or under MAX_STEMS_PER_PHOTO — the same ceiling the flat helper
 * enforces, so a photo cannot cost more work here than there.
 */
const labelStemGroups = (photo) => {
    if (!Array.isArray(photo?.labels)) return [];
    const groups = [];
    const seen = new Set();
    let stems = 0;
    for (const label of photo.labels.slice(0, MAX_LABELS_PER_PHOTO)) {
        if (typeof label !== 'string' && typeof label !== 'number') continue;
        const words = tokenise(String(label), { keepStopwords: true }).slice(0, MAX_WORDS_PER_LABEL);
        if (words.length === 0) continue;
        const key = words.join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        // Trim the boundary label rather than letting it straddle the ceiling:
        // checking only after pushing a whole label could overshoot by up to
        // MAX_WORDS_PER_LABEL - 1 stems.
        const room = MAX_STEMS_PER_PHOTO - stems;
        groups.push(words.length > room ? words.slice(0, room) : words);
        stems += Math.min(words.length, room);
        if (stems >= MAX_STEMS_PER_PHOTO) break;
    }
    return groups;
};

// ALL (AND) semantics: a photo qualifies only when every target stem is
// matched by at least one of the photo's label stems. With no labels the
// inner `some` is always false, so a photo with no labels can never match.
// Precondition: targetStems is non-empty — the only caller skips this filter
// when there are no required tags, so the vacuous-true `[].every(...)` case
// (which would pass every photo) is never reached.
const photoMatchesAllStems = (labelStems, targetStems) =>
    targetStems.every((target) => labelStems.some((labelStem) => matches(labelStem, target)));

const countShouldMatches = (labelStems, shouldStems) => {
    if (shouldStems.length === 0 || labelStems.length === 0) return 0;
    let matched = 0;
    for (const target of shouldStems) {
        for (const labelStem of labelStems) {
            if (matches(labelStem, target)) {
                matched++;
                break;
            }
        }
    }
    return matched;
};

const scorePhoto = (photo, keywords, precomputedLabelStems = null) => {
    if (keywords.length === 0) return 0;
    const labelStems = precomputedLabelStems || labelWordStems(photo);
    if (labelStems.length === 0) return 0;
    let score = 0;
    for (const labelStem of labelStems) {
        if (!labelStem) continue;
        for (const keywordStem of keywords) {
            if (matches(labelStem, keywordStem)) {
                score++;
                break;
            }
        }
    }
    return score;
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

// Tier 4. True only when photoStats.js actually resolved this photo's real
// numbers; see the "NOTE on tier 4" in the file header for why unknown must not
// collapse into votes:0.
const statsKnownOf = (photo) => photo.statsKnown === true;

const votesOf = (photo) => (Number.isFinite(photo.votes) ? photo.votes : 0);

const viewsOf = (photo) => (Number.isFinite(photo.views) ? photo.views : 0);

const uploadDateOf = (photo) => (Number.isFinite(photo.upload_date) ? photo.upload_date : 0);

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

const pickPhotosForChallenge = (challenge, eligiblePhotos, slotsToFill, opts = {}) => {
    if (!Number.isInteger(slotsToFill) || slotsToFill <= 0) return [];
    const scored = buildScoredCandidates(challenge, eligiblePhotos, opts);
    return finalizePick(scored, slotsToFill);
};

/**
 * Filter + score candidates, WITHOUT sorting or slicing.
 *
 * Split out of pickPhotosForChallenge so one fill can score once and then both
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
    let filtered = withStems;
    if (mustStems.length > 0) {
        filtered = filtered.filter(({ wordStems }) => photoMatchesAllStems(wordStems, mustStems));
    }
    if (letterPrefix) {
        filtered = filtered.filter(({ wholeStems }) =>
            wholeStems.some((s) => s.length >= MIN_USER_TAG_STEM_LENGTH && s[0] === letterPrefix),
        );
    }
    if (filtered.length === 0) {
        // A hard filter (must-tags and/or the letter filter) eliminated
        // everything. Unless the caller opted out, relax to the unfiltered set so
        // the slot still gets filled (off-theme best performer).
        const hadHardFilter = mustStems.length > 0 || Boolean(letterPrefix);
        if (hadHardFilter && opts.fillWithoutTagMatch !== false) {
            filtered = withStems;
            notifyFallback(opts, { letterPrefix, mustStems, excludedStems: [] });
        } else {
            return [];
        }
    }

    // A negated title ("No Humans") excludes photos whose labels show the
    // negated subject. Same all-or-nothing fallback as the hard filters above:
    // only when EVERY remaining photo shows it does the picker relax (or return
    // [] under fillWithoutTagMatch:false). A photo with no labels cannot be
    // judged and is kept.
    const excluded = excludedSubjectOf(challenge, opts.ignoreWords || null);
    if (excluded) {
        const kept = filtered.filter(({ wordStems }) => !photoShowsExcluded(wordStems, excluded));
        if (kept.length > 0) {
            filtered = kept;
        } else if (opts.fillWithoutTagMatch === false) {
            return [];
        } else {
            notifyFallback(opts, { letterPrefix: null, mustStems: [], excludedStems: excluded.stems });
        }
    }

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
 * caller (logPopularityPick in services/autoFill.js) uses it to decide whether
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
    pickPhotosForChallenge,
    buildScoredCandidates,
    selectEnrichmentSet,
    finalizePick,
    hasThemeMatch,
    buildSearchTerms,
    detectLetterPrefix,
    parseNegation,
    labelWordStems,
    labelStemGroups,
    SEMANTIC_MATCH_FLOOR,
    SEMANTIC_SUPPORT_CAP,
    // exported for unit tests
    tokenise,
    stem,
    matches,
    buildChallengeKeywords,
    buildThemeKeywords,
    scorePhoto,
    tokeniseTagList,
    wholeLabelStems,
    STOPWORDS,
};
