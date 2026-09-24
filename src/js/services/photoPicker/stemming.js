/**
 * Photo picker — the text normalisation every matcher shares: the photography
 * stopword list, the light stemmer, the bounded tokeniser, stem equivalence
 * (matches) and user-tag normalisation (tokeniseTagList).
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
    'vs',
    'versus',
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
    // the sea). Left in, "life" would both drive a server-side search that
    // pulls in sea-life photos for a Farm Life challenge AND score those photos
    // as a keyword match.
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
 * Not a bidirectional substring test (`a.includes(b) || b.includes(a)`): that
 * compares characters rather than words and produces cross-theme nonsense:
 * "art"→"heart", "cat"→"catamaran", "ice"→"office", "sea"→"seagull",
 * "bud"→"buddha", and the keyword "life" matching the label "Sea Life" in a
 * challenge titled "The Farm Life".
 *
 * KNOWN COST, ACCEPTED: prefix-only cannot see head-final compounds, so
 * "flower" does not match "sunflower", nor "fish"/"goldfish" or
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

module.exports = {
    STOPWORDS,
    MAX_TOKENISE_CHARS,
    MIN_USER_TAG_STEM_LENGTH,
    stem,
    rawTokenise,
    tokenise,
    matches,
    tokeniseTagList,
};
