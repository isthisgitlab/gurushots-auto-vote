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
 *   3. Tag-match score — how many of the photo's label word-stems overlap the
 *      challenge keywords (URL slug + title + welcome_message, light-stemmed,
 *      stopword-filtered).
 *   4. Achievements count \
 *   5. Votes                > popularity — ONLY orders photos that tied at 0
 *   6. Views               /  across tiers 1-3, i.e. nothing matched the theme.
 *   7. Upload date        /
 *
 * NOTE on votes: the live get_photos_private endpoint returns votes=0 for every
 * library photo, so tier 5 rarely fires against the real API; it is kept for the
 * case where a populated value is available (and for mocks/tests).
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

/**
 * Light suffix stemmer covering the common inflected forms that show
 * up in challenge text vs. vision labels: plurals (flowers→flower),
 * gerunds (jumping→jump), past tense (jumped→jump), 'ies' nouns
 * (categories→category). Keeps the algorithm dependency-free; pairs
 * with bidirectional substring matching to handle leftover variation
 * like 'runn' (from running) vs 'run'.
 */
const stem = (word) => {
    if (typeof word !== 'string' || word.length < 4) return word || '';
    const w = word;
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
};

// keepStopwords skips the photography-noise stopword list. Challenge text
// is full of boilerplate ("shots", "best", "good luck") that drowns out the
// real subject, so the keyword path filters it. But a user who explicitly
// types those words as a tag means them literally — honor the input.
const tokenise = (text, { keepStopwords = false } = {}) => {
    if (typeof text !== 'string' || text.length === 0) return [];
    return text
        .toLowerCase()
        .replace(/<[^>]*>/g, ' ')
        .split(/[^a-z0-9]+/)
        .map((t) => t.replace(/\d+$/, ''))
        .filter((t) => t.length > 1 && !isPureDigit(t) && (keepStopwords || !STOPWORDS.has(t)))
        .map(stem);
};

const buildChallengeKeywords = (challenge) => {
    const fromUrl = tokenise(challenge?.url);
    const fromTitle = tokenise(challenge?.title);
    const fromWelcome = tokenise(challenge?.welcome_message);
    const all = [...fromUrl, ...fromTitle, ...fromWelcome];
    return Array.from(new Set(all));
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
 * lexicon can, so those compounds live in scripts/lexicon-concepts.json and get
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
 * itself, so 40 means cosine 0.40.
 *
 * This is a measured value, not a guess. The lexicon's word vectors are seeded
 * pseudo-random, so two UNRELATED concepts still land at some non-zero cosine;
 * with the shipped lexicon config that noise band reaches ~0.28 at its maximum,
 * while genuinely related concepts (siblings under a shared parent) start around
 * ~0.56. The floor sits in the gap. scripts/validate-lexicon.js re-derives both
 * distributions from the real asset on every build and fails if the gap closes,
 * so this constant can never quietly drift out of the valid range.
 */
const SEMANTIC_MATCH_FLOOR = 40;

// Issue at most a few server-side searches per fill: a title rarely has more
// than two or three subject nouns, and tag lists are short. The cap bounds the
// extra requests the union fetch makes.
const SEARCH_TERMS_CAP = 3;

// Detect a "letter challenge" title — "Begins With L", "Starts with the letter A",
// "Things That Start With B" (interior "Start With" matches via the leading \b).
// Returns the lone target letter (lowercased) or null.
//
// SCOPE: only the begins/starts-with family is handled. Titles like "Letter L",
// "L Words", or "B Is For…" intentionally return null and keep today's behavior.
//
// SECURITY: `title` is an untrusted string from the GuruShots API. We cap its
// length before matching (ReDoS defense-in-depth, though the pattern has no
// nested quantifiers) and the captured value is a single [a-z] char used ONLY in
// a first-character equality check downstream — never interpolated into a query,
// template, or eval.
//
// The trailing (?![\w-]) (instead of \b) forces the captured letter to be a
// standalone token: "Begins With Love" → null (next char is a word char) and
// "Begins With L-A" → null (next char is '-'); "Begins With L" / "...L." → 'l'.
const LETTER_CHALLENGE_RE =
    /\b(?:begin(?:s|ning)?|start(?:s|ing)?)\s+with\s+(?:the\s+)?(?:letter\s+)?([a-z])(?![\w-])/i;
const detectLetterPrefix = (title) => {
    if (typeof title !== 'string' || title.length > 200) return null;
    const m = title.match(LETTER_CHALLENGE_RE);
    return m ? m[1].toLowerCase() : null;
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
    const { mustIncludeTags, shouldIncludeTags } = opts || {};
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
        terms = tokenise(challenge?.title);
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
    return photo.labels.map((l) => stem(String(l).toLowerCase())).filter(Boolean);
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
    for (const label of photo.labels) {
        if (typeof label !== 'string' && typeof label !== 'number') continue;
        const words = tokenise(String(label), { keepStopwords: true }).slice(0, MAX_WORDS_PER_LABEL);
        for (const word of words) {
            out.add(word);
            if (out.size >= MAX_STEMS_PER_PHOTO) return Array.from(out);
        }
    }
    return Array.from(out);
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

const achievementCountOf = (photo) => (Array.isArray(photo.achievements) ? photo.achievements.length : 0);

const votesOf = (photo) => (Number.isFinite(photo.votes) ? photo.votes : 0);

const viewsOf = (photo) => (Number.isFinite(photo.views) ? photo.views : 0);

const uploadDateOf = (photo) => (Number.isFinite(photo.upload_date) ? photo.upload_date : 0);

/**
 * Picks photos to submit to a challenge.
 *
 * @param {object} challenge - challenge object (url, title, welcome_message all optional)
 * @param {Array<object>} eligiblePhotos - candidates from getEligiblePhotos
 * @param {number} slotsToFill - how many photos to return at most
 * @param {{mustIncludeTags?: string[], shouldIncludeTags?: string[], fillWithoutTagMatch?: boolean, semanticScores?: Map<string, number>}} [opts]
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
 *   semanticScores: optional Map<photoId, similarity 0..1> from the semantic
 *   matcher. When present it adds one ranking tier (just below the explicit
 *   should-tag preference, above the lexical keyword score) so on-theme photos
 *   a substring match misses still rank up. Omit it (the default) and ranking
 *   is byte-for-byte the lexical-only behavior.
 * @returns {Array<string>} ordered list of photo ids; length <= slotsToFill
 */
const pickPhotosForChallenge = (challenge, eligiblePhotos, slotsToFill, opts = {}) => {
    if (!Number.isInteger(slotsToFill) || slotsToFill <= 0) return [];
    if (!Array.isArray(eligiblePhotos) || eligiblePhotos.length === 0) return [];

    const allowed = eligiblePhotos.filter((p) => p && p.permission && p.permission.allowed === true && p.id);
    if (allowed.length === 0) return [];

    const mustStems = tokeniseTagList(opts.mustIncludeTags);
    const shouldStems = tokeniseTagList(opts.shouldIncludeTags);

    // Letter challenges ("Begins With L") add a hard filter: keep only photos
    // with a label beginning with that letter. The MIN_USER_TAG_STEM_LENGTH floor
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
        } else {
            return [];
        }
    }

    // Optional semantic tier. Bucket the 0..1 similarity to whole percent so tiny
    // float differences don't churn the order or make it non-deterministic; photos
    // within the same bucket fall through to the lexical tiers below. No map (the
    // default) → every bucket is 0 → this tier is inert and the sort is identical
    // to the lexical-only behavior.
    //
    // Anything below SEMANTIC_MATCH_FLOOR is forced to 0 — NOT merely ranked low.
    // Sub-floor cosine is statistically indistinguishable from the noise between
    // two unrelated word vectors, and this tier sits ABOVE the lexical `score`, so
    // without the floor a photo with pure vector drift would out-rank a photo with
    // a genuine keyword hit. The floor is what makes "nothing matched the theme"
    // an honest, testable state instead of a fuzzy one. Its value is not
    // hand-picked: scripts/validate-lexicon.js gates the build on
    // p99.9(unrelated) < FLOOR < p05(related) against the real lexicon.
    const semanticScores = opts.semanticScores instanceof Map ? opts.semanticScores : null;
    const semanticTier = (id) => {
        if (!semanticScores) return 0;
        const raw = semanticScores.get(String(id));
        if (!Number.isFinite(raw)) return 0;
        const bucket = Math.round(Math.max(0, Math.min(1, raw)) * 100);
        return bucket >= SEMANTIC_MATCH_FLOOR ? bucket : 0;
    };

    const keywords = buildChallengeKeywords(challenge);
    const scored = filtered.map(({ photo, wordStems }) => ({
        id: photo.id,
        shouldMatchCount: countShouldMatches(wordStems, shouldStems),
        semantic: semanticTier(photo.id),
        score: scorePhoto(photo, keywords, wordStems),
        achievementCount: achievementCountOf(photo),
        votes: votesOf(photo),
        views: viewsOf(photo),
        uploadDate: uploadDateOf(photo),
    }));

    // Match tiers first, popularity tiers last. Because every match tier is
    // non-negative, a photo that matched on ANY of them cannot be overtaken by a
    // photo that matched on none — the popularity tiers below are only ever
    // reached by photos that tied, which for an unmatched photo means tied at
    // zero. That is the governing rule ("a theme match always beats popularity")
    // and it is enforced by this ordering, so do not reorder these.
    scored.sort((a, b) => {
        if (b.shouldMatchCount !== a.shouldMatchCount) return b.shouldMatchCount - a.shouldMatchCount;
        if (b.semantic !== a.semantic) return b.semantic - a.semantic;
        if (b.score !== a.score) return b.score - a.score;
        if (b.achievementCount !== a.achievementCount) return b.achievementCount - a.achievementCount;
        if (b.votes !== a.votes) return b.votes - a.votes;
        if (b.views !== a.views) return b.views - a.views;
        return b.uploadDate - a.uploadDate;
    });

    return scored.slice(0, slotsToFill).map((p) => p.id);
};

module.exports = {
    pickPhotosForChallenge,
    buildSearchTerms,
    detectLetterPrefix,
    labelWordStems,
    SEMANTIC_MATCH_FLOOR,
    // exported for unit tests
    tokenise,
    stem,
    matches,
    buildChallengeKeywords,
    scorePhoto,
    tokeniseTagList,
    wholeLabelStems,
    STOPWORDS,
};
