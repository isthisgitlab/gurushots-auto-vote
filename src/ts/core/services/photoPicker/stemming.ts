/**
 * Photo picker — the bounded tokeniser, stem equivalence (matches) and
 * user-tag normalisation (tokeniseTagList). The stemmer itself lives in
 * stem.ts, which the semantic lexicon imports directly.
 */

import { STOPWORDS } from './stopwords';
import { stem } from './stem';
import { compoundOf } from '../semantic/lexicon';

const isPureDigit = (token: string) => /^\d+$/.test(token);

// keepStopwords skips the photography-noise stopword list. Challenge text
// is full of boilerplate ("shots", "best", "good luck") that drowns out the
// real subject, so the keyword path filters it. But a user who explicitly
// types those words as a tag means them literally — honor the input.
interface TokeniseOptions {
    keepStopwords?: boolean;
    /** Raw words to drop; only a Set or an array is honoured. */
    ignoreWords?: Iterable<unknown> | null;
    /**
     * Adjacent-word compound merging against the lexicon's compound keys:
     * 'replace' emits the compound for its parts, 'add' the compound and then
     * its parts, 'off' (the default) the parts only.
     */
    compounds?: 'replace' | 'add' | 'off';
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

// Only a single space or a single hyphen joins a compound window. Any other
// separator — ", ", " & ", a sentence break, a spaced " - " hyphen (a series
// separator, see SERIES_SEPARATOR_RE) — is punctuation that breaks the window,
// so "Blue & Green" never merges but "Close-Up" and "Close Up" do.
const JOINS_WORDS_RE = /^(?:\s|-)$/;

/**
 * How a candidate window resolves: 'merge' emits the hyphen-joined compound,
 * 'drop' consumes every word of the window and emits nothing, 'pass' leaves
 * the words to flow through unmerged.
 *
 * The merge is decided by model data: a window merges only when the lexicon
 * holds a vector for the stem of its hyphen-joined surface, so with the
 * lexicon unloaded nothing merges at all. A window whose words are all
 * stopwords never merges even when the model knows the compound ("best-of"):
 * the parts are boilerplate, not a subject. A known compound whose
 * space-joined form ("close up") sits in the ignore set drops every word of
 * the window, so neither "close" nor "up" leaks — that is not a general
 * multi-word ignore, it only ever fires for a compound the model knows.
 *
 * SECURITY: the text is untrusted API data, and the walk runs on input
 * already cut to MAX_TOKENISE_CHARS. The model table is only ever probed with
 * exact lookups (compoundOf is a Map hit against model data), never a regex
 * built from it.
 */
const windowAction = (window: readonly string[], ignored: (word: string) => boolean): 'merge' | 'drop' | 'pass' => {
    if (window.some(ignored)) return 'pass';
    if (window.every((w) => STOPWORDS.has(w))) return 'pass';
    if (!compoundOf(window)) return 'pass';
    return ignored(window.join(' ')) ? 'drop' : 'merge';
};

/**
 * The compound merge, run on the raw words before the stopword filter: at each
 * position a 3-word window is tried, then a 2-word one, leftmost first, and a
 * window merges only when the model knows it (see windowAction). The merged
 * window emits its surface form joined by hyphens ("close-ups"), which
 * tokenise() then stems exactly once — emitting the stored key would stem a
 * second time and mis-stem.
 */
const mergeCompounds = (
    words: string[],
    gaps: readonly string[],
    ignore: Set<unknown> | null,
    mode: 'replace' | 'add' | 'off',
): string[] => {
    if (mode === 'off') return words;
    const ignored = (word: string) => ignore !== null && ignore.has(word);
    const joins = (gap: string | undefined) => gap !== undefined && JOINS_WORDS_RE.test(gap);
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
        // At most two model lookups per position: the 3-word window, then the
        // 2-word one.
        let len = 0;
        let drop = false;
        if (joins(gaps[i + 1])) {
            const wide = joins(gaps[i + 2]) ? windowAction(words.slice(i, i + 3), ignored) : 'pass';
            const narrow = wide === 'pass' ? windowAction(words.slice(i, i + 2), ignored) : 'pass';
            const action = wide !== 'pass' ? wide : narrow;
            if (action !== 'pass') {
                len = wide !== 'pass' ? 3 : 2;
                drop = action === 'drop';
            }
        }
        if (len === 0) {
            out.push(words[i]);
            continue;
        }
        const window = words.slice(i, i + len);
        if (!drop) {
            out.push(window.join('-'));
            // 'add' emits the compound first and then its parts, so a label cut
            // at MAX_WORDS_PER_LABEL cannot lose the compound and keep only
            // pieces of it.
            if (mode === 'add') out.push(...window);
        }
        i += len - 1;
    }
    return out;
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

const rawTokenise = (
    text: string | null | undefined,
    { keepStopwords = false, ignoreWords = null, compounds = 'off' }: TokeniseOptions = {},
): string[] => {
    if (typeof text !== 'string' || text.length === 0) return [];
    // Matched against the RAW word, before stemming — same as STOPWORDS — so a
    // user writing "captivating" catches it without having to know that the
    // stemmer turns it into "captivat".
    const ignore = toIgnoreSet(ignoreWords);
    // Split keeping each separator, so the compound merge can see what joins
    // two words. The per-word trailing-digit strip ("macro-insects4") still
    // runs before the merge.
    const parts = text
        .slice(0, MAX_TOKENISE_CHARS)
        .toLowerCase()
        .replace(/<[^>]*>/g, ' ')
        .split(/([^a-z0-9]+)/);
    const words: string[] = [];
    const gaps: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
        words.push(parts[i].replace(/\d+$/, ''));
        gaps.push(i === 0 ? '' : parts[i - 1]);
    }
    return mergeCompounds(words, gaps, ignore, compounds).filter(
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
 * A compound stem (one still carrying its hyphen) matches only by equality
 * once the hyphens are stripped from both sides — the prefix rule never
 * applies. The delta allowance would otherwise let "close" or "closes" match
 * "closeup" (the joined spelling of the compound "close-up"), and likewise
 * make→"makeup" and pick→"pickup". A "Closeup" label matches the keyword
 * "close-up"; a "Close" label does not.
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
    if (labelStem.includes('-') || keywordStem.includes('-')) {
        return labelStem.replace(/-/g, '') === keywordStem.replace(/-/g, '');
    }
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
 * "still" and "life" must stay two stems. Compound merging stays off — a
 * saved must-tag means its literal words, so "close up" stays ["close","up"].
 * Per-tag work stays cheap — tags are capped at MAX_TAG_LENGTH
 * (settings/limits.ts). Empty/non-array input → [].
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
    stem,
    stripTags,
    rawTokenise,
    tokenise,
    matches,
    tokeniseTagList,
};
