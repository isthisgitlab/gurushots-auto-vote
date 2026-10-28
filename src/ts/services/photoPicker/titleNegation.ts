/**
 * Photo picker — the series separator and the negated-title parse: what a
 * title says to leave out ("No Humans", "People-Free"), returned as the stems
 * of the negated subjects plus the positive remainder.
 */

import { MAX_TOKENISE_CHARS, rawTokenise, stem } from './stemming';

import type { IgnoreWords, Negation } from '../../types/photoPicker';

// Colon, the two long dashes, and a SPACE-DELIMITED hyphen. A BARE hyphen is
// still not a separator — it shows up inside ordinary titles and compound words
// ("Black-and-White", "Close-Up") far too often to treat as structure, and
// getting that wrong would silently discard a real subject. The spacing is what
// separates the two cases: a compound joins its parts with no spaces, so " - "
// is structural punctuation while "-" is orthography.
//
// That distinction is load-bearing, not cosmetic. The live series actually
// ships "Screen Stars - Tropic Paradise" with a plain hyphen — the colon
// examples in titleSubject (title.ts) are not what the real titles use. Without this
// branch the whole title became the theme, "stars" entered the pooled theme
// vector, and the semantic tier ranked a Milky Way photo (0.657) over a genuine
// tropical one (0.598) — pre-empting the lexical tier, where the tropical photo
// actually won 2-1.
const SERIES_SEPARATOR_RE = /[:\u2013\u2014]|\s-\s/;

// Negated titles name what must NOT be in the photo: "No Humans", "Without
// People", "People-Free". 'no'/'not' are stopwords, so without this "No
// Humans" would tokenise to ["human"] and every tier — theme vector, lexical
// keywords, server search — would actively rank photos OF people first, the exact
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
 */
const parseNegation = (title: string | null | undefined, ignoreWords: IgnoreWords = null): Negation => {
    if (typeof title !== 'string' || title === '') return NO_NEGATION;
    const stems: Set<string> = new Set();
    const addWords = (text: string) => {
        // Same compound mode as the keyword sources: a negated "No Close-Ups"
        // yields the close-up stem, so the merged keyword is excluded by it.
        const words = rawTokenise(text, { ignoreWords, compounds: 'replace' });
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
    const positiveTitle = segments
        .join(': ')
        .replace(FREE_SUFFIX_RE, (whole: string, word: string) => (addWords(word) ? ' ' : whole));
    if (stems.size === 0) return { positiveTitle: title, stems: [], active: false };
    return { positiveTitle, stems: Array.from(stems), active: true };
};

// Remove negated subjects and the negation markers from a keyword list.
const dropNegated = (keywords: string[], negation: Negation): string[] => {
    if (!negation.active) return keywords;
    const negated = new Set(negation.stems);
    return keywords.filter((k) => !negated.has(k) && !NEGATION_MARKER_STEMS.has(k));
};

export { SERIES_SEPARATOR_RE, NEGATION_MARKER_STEMS, parseNegation, dropNegated };
