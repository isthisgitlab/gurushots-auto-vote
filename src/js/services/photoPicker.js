/**
 * GuruShots Auto Voter - Photo Picker
 *
 * Pure ranking function used by the auto-fill flow to choose which of
 * the user's eligible photos to submit into a challenge.
 *
 * Ranking strategy (lexicographic, all desc):
 *   1. Tag-match score — how well photo labels overlap challenge keywords
 *      (URL slug + title + welcome_message, light-stemmed, with a
 *      photography-noise stopword list).
 *   2. Achievements count — past wins are a strong quality signal when
 *      we have no theme match to bias us.
 *   3. Votes — total votes on the photo. NOTE: the live get_photos_private
 *      endpoint returns votes=0 for every library photo, so this tier rarely
 *      fires against the real API; it's kept for the case where a populated
 *      value is available (and for mocks/tests).
 *   4. Views — lifetime view count, which the real endpoint DOES populate.
 *      This is the practical "best performer" signal that keeps an
 *      untaggable challenge from collapsing to pure recency.
 *   5. Upload date — last-resort tiebreak.
 *
 * The achievements/views layers are why this avoids the "picked my last
 * upload" failure mode: when a challenge theme can't be matched against
 * any of the user's photos (very common — vision labels are concrete
 * nouns; challenge titles are abstract), fall back to "best performer"
 * instead of "newest", which has zero quality signal.
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

const matches = (labelStem, keywordStem) =>
    labelStem === keywordStem || labelStem.includes(keywordStem) || keywordStem.includes(labelStem);

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
    if (terms.length === 0) terms = tokenise(challenge?.title);
    return Array.from(new Set(terms)).slice(0, SEARCH_TERMS_CAP);
};

const labelStemsOf = (photo) => {
    if (!Array.isArray(photo?.labels)) return [];
    return photo.labels.map((l) => stem(String(l).toLowerCase())).filter(Boolean);
};

const photoMatchesAnyStem = (labelStems, targetStems) => {
    for (const labelStem of labelStems) {
        for (const target of targetStems) {
            if (matches(labelStem, target)) return true;
        }
    }
    return false;
};

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
    const labelStems = precomputedLabelStems || labelStemsOf(photo);
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
 *   mustIncludeTags: hard filter — keep only photos whose labels match at
 *   least one tag (ANY semantics). Empty/missing = no filter.
 *   shouldIncludeTags: soft boost — photos with more matching tags rank
 *   above photos with fewer, before the existing keyword/quality tiers.
 *   fillWithoutTagMatch: when the must-filter matches NOTHING, fall back to
 *   the unfiltered set rather than returning [] (so a slot isn't left empty
 *   just because no photo carried a must-include tag). Defaults to true;
 *   pass false to keep the slot empty until a matching photo exists. Only
 *   the all-or-nothing case is relaxed — a partial match still fills with
 *   matches only.
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

    // Stem each photo's labels once and carry the result through both the
    // must-filter and the should-scoring rather than recomputing.
    const withStems = allowed.map((photo) => ({ photo, labelStems: labelStemsOf(photo) }));
    let filtered =
        mustStems.length === 0
            ? withStems
            : withStems.filter(({ labelStems }) => photoMatchesAnyStem(labelStems, mustStems));
    if (filtered.length === 0) {
        // Must-filter eliminated everything. Unless the caller opted out,
        // relax to the unfiltered set so the slot still gets filled.
        if (mustStems.length > 0 && opts.fillWithoutTagMatch !== false) {
            filtered = withStems;
        } else {
            return [];
        }
    }

    // Optional semantic tier. Bucket the 0..1 similarity to whole percent so
    // tiny float differences don't churn the order or make it non-deterministic;
    // photos within the same bucket fall through to the lexical tiers below.
    // No map (the default) → every bucket is 0 → this tier is inert and the sort
    // is identical to the lexical-only behavior.
    const semanticScores = opts.semanticScores instanceof Map ? opts.semanticScores : null;
    const semanticBucket = (id) => {
        if (!semanticScores) return 0;
        const raw = semanticScores.get(String(id));
        if (!Number.isFinite(raw)) return 0;
        return Math.round(Math.max(0, Math.min(1, raw)) * 100);
    };

    const keywords = buildChallengeKeywords(challenge);
    const scored = filtered.map(({ photo, labelStems }) => ({
        id: photo.id,
        shouldMatchCount: countShouldMatches(labelStems, shouldStems),
        semantic: semanticBucket(photo.id),
        score: scorePhoto(photo, keywords, labelStems),
        achievementCount: achievementCountOf(photo),
        votes: votesOf(photo),
        views: viewsOf(photo),
        uploadDate: uploadDateOf(photo),
    }));

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
    // exported for unit tests
    tokenise,
    stem,
    buildChallengeKeywords,
    scorePhoto,
    tokeniseTagList,
    STOPWORDS,
};
