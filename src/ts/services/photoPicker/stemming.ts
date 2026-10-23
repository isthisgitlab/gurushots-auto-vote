/**
 * Photo picker — the text normalisation every matcher shares: the light
 * stemmer, the bounded tokeniser, stem equivalence (matches) and user-tag
 * normalisation (tokeniseTagList).
 */

import { FIXED_PHRASES, STOPWORDS } from './stopwords';

// The canonical forms, for the readers that must treat the phrase as one term
// (abstractTitleWords anchors a title on it — see title.ts).
const FIXED_PHRASE_TOKENS: Set<string> = new Set(FIXED_PHRASES.values());

const isPureDigit = (token: string) => /^\d+$/.test(token);

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
const stem = (word: string): string => {
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

/**
 * Untrusted text with its HTML tags blanked, cut to MAX_TOKENISE_CHARS first. A tag holds no `<`, so a run of `<` stays
 * linear instead of rescanning to the end of the text from each one.
 */
const stripTags = (text: string): string => text.slice(0, MAX_TOKENISE_CHARS).replace(/<[^<>]*>/g, ' ');

// keepStopwords skips the photography-noise stopword list. Challenge text
// is full of boilerplate ("shots", "best", "good luck") that drowns out the
// real subject, so the keyword path filters it. But a user who explicitly
// types those words as a tag means them literally — honor the input.
interface TokeniseOptions {
    keepStopwords?: boolean;
    /** Raw words to drop; only a Set or an array is honoured. */
    ignoreWords?: Iterable<unknown> | null;
}

const toIgnoreSet = (words: Iterable<unknown> | null | undefined): Set<unknown> | null => {
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

// The fixed-phrase merge, run on the raw words before the stopword filter: a
// pair found in FIXED_PHRASES is emitted as its canonical token and the next
// word consumed, a one-word spelling as its canonical token. A pair is left
// unmerged when either of its words is in the ignore set, so the normal
// filter then drops the ignored word — and the merged token is dropped by
// that filter when the ignore set holds the canonical phrase itself.
const mergeFixedPhrases = (words: string[], ignore: Set<unknown> | null): string[] => {
    const ignored = (word: string) => ignore !== null && ignore.has(word);
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const pair =
            i + 1 < words.length && !ignored(words[i]) && !ignored(words[i + 1])
                ? FIXED_PHRASES.get(`${words[i]} ${words[i + 1]}`)
                : undefined;
        if (pair !== undefined) {
            out.push(pair);
            i++;
            continue;
        }
        const single = FIXED_PHRASES.get(words[i]);
        out.push(single !== undefined ? single : words[i]);
    }
    return out;
};

const rawTokenise = (
    text: string | null | undefined,
    { keepStopwords = false, ignoreWords = null }: TokeniseOptions = {},
): string[] => {
    if (typeof text !== 'string' || text.length === 0) return [];
    // Matched against the RAW word, before stemming — same as STOPWORDS — so a
    // user writing "captivating" catches it without having to know that the
    // stemmer turns it into "captivat".
    const ignore = toIgnoreSet(ignoreWords);
    const words = text
        .slice(0, MAX_TOKENISE_CHARS)
        .toLowerCase()
        .replace(/<[^>]*>/g, ' ')
        .split(/[^a-z0-9]+/)
        .map((t) => t.replace(/\d+$/, ''));
    return mergeFixedPhrases(words, ignore).filter(
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
const tokenise = (text: string | null | undefined, opts?: TokeniseOptions): string[] =>
    rawTokenise(text, opts).map(stem);

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
const matches = (labelStem: string, keywordStem: string): boolean => {
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
 *
 * Each tag is tokenised ON ITS OWN, never joined first: two separate tags
 * "still" and "life" must stay two stems, while one tag "still life" merges
 * into the fixed phrase. Per-tag work stays cheap — tags are capped at
 * MAX_TAG_LENGTH (settings/limits.ts). Empty/non-array input → [].
 */
const tokeniseTagList = (tags: readonly string[] | null | undefined): string[] => {
    if (!Array.isArray(tags) || tags.length === 0) return [];
    const stems = tags
        .filter((t) => typeof t === 'string')
        .flatMap((tag) => tokenise(tag, { keepStopwords: true }))
        .filter((s) => s.length >= MIN_USER_TAG_STEM_LENGTH);
    return Array.from(new Set(stems));
};

export {
    MAX_TOKENISE_CHARS,
    MIN_USER_TAG_STEM_LENGTH,
    FIXED_PHRASE_TOKENS,
    stem,
    stripTags,
    rawTokenise,
    tokenise,
    matches,
    tokeniseTagList,
};
