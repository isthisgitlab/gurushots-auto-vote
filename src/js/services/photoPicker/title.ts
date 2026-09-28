/**
 * Photo picker — what a challenge title says about its subject: title words
 * that are abstract rather than the subject, the series subject segment,
 * negated subjects ("No Humans") and the exclusion filter they become, and
 * letter challenges ("Begins With L").
 */

import { MAX_TOKENISE_CHARS, stem, rawTokenise, tokenise, matches } from './stemming';
import * as lexicon from '../semantic/lexicon';
import { finiteOr } from '../../numbers';

import type { ChallengeText, ChallengeTheme, ExcludedSubject, IgnoreWords, Negation } from '../../types/photoPicker';

// Bounds for abstractTitleWords, on the lexicon's concreteness cosine. Pinned by
// the `concreteness.cases` gate in scripts/validate-lexicon.ts (real titles, run
// on every build), so move them only with that gate green. SUBJECT_MIN is the
// high one on purpose: GloVe reads some photographable words as abstract
// ("people" -0.38, "nature" -0.30) and some verbs as mildly concrete ("built"
// 0.11), so the pass only acts when one word is unmistakably a thing
// ("balloon" 0.37) — "Built Among Nature" stays exactly as it was.
const CONCRETE_SUBJECT_MIN = 0.15;
const ABSTRACT_WORD_MAX = -0.1;

const lexiconConcreteness = (word: string) => lexicon.concreteness(word);

/**
 * Which title words are clearly NOT the subject, judged by meaning rather than
 * by a word list: "Balloon Fun" is about balloons, "Glass Findings" about glass,
 * "Forever Flowers" about flowers. Positional rules cannot see this — the
 * head-noun heuristic in buildSearchTerms reads "Balloon Fun" right-to-left and
 * searched "fun" first — and a stoplist can never keep up with titles that
 * change every week. The lexicon's concreteness axis scores any in-vocabulary
 * word, including ones nobody has seen in a title before.
 *
 * Returns the words to demote: those reading as abstract, but ONLY when another
 * word in the same title is clearly a thing. A title with no concrete anchor
 * ("Creative Focus", "People and Architecture") returns nothing, so every
 * caller keeps its existing behavior there — as it does whenever the lexicon is
 * not loaded or a word is out of vocabulary (null concreteness = no opinion).
 *
 * @param words - title words (surface or stemmed, as the caller has them)
 * @returns a subset of `words`; never all of them
 */
const abstractTitleWords = (
    words: string[],
    concretenessOf: (word: string) => number | null = lexiconConcreteness,
): Set<string> => {
    const abstract: Set<string> = new Set();
    if (!Array.isArray(words) || words.length < 2) return abstract;
    const scores = words.map((word) => finiteOr(concretenessOf(word), null));
    const known = scores.filter((score) => score !== null);
    if (!(Math.max(...known) >= CONCRETE_SUBJECT_MIN)) return abstract;
    words.forEach((word, i) => {
        const score = scores[i];
        if (score !== null && score <= ABSTRACT_WORD_MAX) abstract.add(word);
    });
    return abstract;
};

// A title's subject stems with abstractTitleWords' demotions removed. Safe to
// apply blindly: the result is never empty for a non-empty input.
const withoutAbstract = (stems: string[]): string[] => {
    const abstract = abstractTitleWords(stems);
    return abstract.size > 0 ? stems.filter((s) => !abstract.has(s)) : stems;
};

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
const titleSubject = (title: string | null | undefined, ignoreWords?: IgnoreWords): string => {
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
 */
const excludedSubjectOf = (
    challenge: ChallengeText | null | undefined,
    ignoreWords: IgnoreWords,
): ExcludedSubject | null => {
    const { stems, active } = parseNegation(challenge?.title, ignoreWords);
    if (!active) return null;
    return { stems, concept: stems.some((s) => PEOPLE_LABEL_STEMS.has(s)) ? PEOPLE_LABEL_STEMS : null };
};

const photoShowsExcluded = (labelStems: string[], excluded: ExcludedSubject): boolean =>
    labelStems.some(
        (labelStem) =>
            (excluded.concept !== null && excluded.concept.has(labelStem)) ||
            excluded.stems.some((s) => matches(labelStem, s)),
    );

// Detect a "letter challenge" title — "Begins With L", "Starts with the letter A",
// "Things That Start With B" (interior "Start With" matches via the leading \b),
// plus the "X is for" family below ("C is for…", "A is for Apple").
// Returns the lone target letter (lowercased) or null.
//
// SCOPE: the begins/starts-with, "X is for" and "The Letter X" families are
// handled. A bare "L Words" intentionally returns null and is treated as an
// ordinary title.
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
const detectLetterPrefix = (title: string | null | undefined): string | null => {
    if (typeof title !== 'string' || title.length > 200) return null;
    const m = title.match(LETTER_CHALLENGE_RE) || title.match(LETTER_IS_FOR_RE) || title.match(LETTER_NAMED_RE);
    if (!m) return null;
    // Each pattern captures the letter in a different group (LETTER_NAMED_RE has
    // one per quoted/bare branch, only one of which participates), so read the
    // first group that actually matched rather than hard-coding an index. Every
    // match has exactly one participating `([a-z])` group, so this always finds it.
    const letter = m.slice(1).find((g) => typeof g === 'string' && g.length === 1) as string;
    return letter.toLowerCase();
};

// Title words that name a challenge's FORMAT, never its subject: its length
// ("10 Hours"), GuruShots' own features ("500 Guru's Picks", "Ultimate
// Exposure", Turbo) and a challenge type ("Exhibition"). The rest of that
// vocabulary — guru, week, photo, shot, best, day — is already in STOPWORDS.
// Keep this to words that are ONLY format words: a title made entirely of them
// reads as an open theme, so a real subject here ("Stars", "Street Art") would
// switch its search off. Used only by that test; the search keeps these words.
const FORMAT_STEMS = new Set(['hour', 'minute', 'pick', 'turbo', 'exposure', 'exhibition'].map(stem));
// GuruShots' own phrasing for an open theme ("The challenge is an open theme.").
// Deliberately not "any subject": a subject challenge can say "reflections of
// any subject" and would lose its theme. For the same reason "the theme is
// open to interpretation" does not count — that still names a theme.
const OPEN_THEME_RE = /\b(?:open|free)[\s-]+theme\b|\btheme\s+is\s+open\b(?!\s+to\b)/i;

// A phrase inside straight or curly quotes, spaces allowed inside them
// ("title of " Photographer of the Week ""). The phrase is untrusted API text,
// so it is escaped and matched literally.
const QUOTE_CHARS = `'"‘’“”`;
const REGEX_SPECIAL_RE = /[.*+?^${}()|[\]\\]/g;
const quotedPhraseRe = (phrase: string): RegExp => {
    const literal = phrase.trim().replace(REGEX_SPECIAL_RE, '\\$&');
    return new RegExp(`[${QUOTE_CHARS}]\\s*${literal}\\s*[${QUOTE_CHARS}]`, 'gi');
};

const UNCONFIRMED: ChallengeTheme = Object.freeze({ kind: 'unconfirmed', subjects: Object.freeze([]) });
const OPEN: ChallengeTheme = Object.freeze({ kind: 'open', subjects: Object.freeze([]) });

/**
 * Whether a challenge has a subject to match, read from its title AND its
 * description rather than from a list of challenge names (GuruShots runs new
 * open-theme titles every day). Open when the description says so, or when no
 * title word (nor, for an all-boilerplate title, slug word) is left once
 * boilerplate (STOPWORDS), the user's ignore words and format words are
 * removed. Otherwise a title word the description repeats is
 * the subject: descriptions restate it ("Show photos of the different kinds of
 * roads"), while "Roads to Anywhere" alone cannot say which word matters. The
 * repeat counts whatever the word's concreteness — "people" and "models" read
 * as abstract to the lexicon yet are real subjects.
 *
 * 'unconfirmed' means "no opinion": callers keep their title-only behavior. It
 * is returned for a missing title, for letter and negated titles, which have
 * their own handling, and for a title whose words the description never repeats.
 */
const readChallengeTheme = (
    challenge: ChallengeText | null | undefined,
    ignoreWords: IgnoreWords = null,
): ChallengeTheme => {
    const title = typeof challenge?.title === 'string' ? challenge.title.slice(0, MAX_TOKENISE_CHARS) : '';
    if (title.trim() === '' || detectLetterPrefix(title) || parseNegation(title, ignoreWords).active)
        return UNCONFIRMED;
    const message = challenge?.welcome_message;
    const description =
        typeof message === 'string'
            ? message
                  .slice(0, MAX_TOKENISE_CHARS)
                  .replace(/<[^>]*>/g, ' ')
                  .toLowerCase()
            : '';
    if (OPEN_THEME_RE.test(title) || OPEN_THEME_RE.test(description)) return OPEN;
    const subject = titleSubject(title, ignoreWords);
    const fromTitle = tokenise(subject, { ignoreWords });
    // A title of pure boilerplate ("Best of the Best") can still carry its
    // subject in the slug ("macro-insects4"), which buildThemeKeywords falls
    // back to — so the slug has to be empty too before the theme reads as open.
    const words = fromTitle.length > 0 ? fromTitle : tokenise(challenge?.url, { ignoreWords });
    if (words.every((word) => FORMAT_STEMS.has(word))) return OPEN;
    // Descriptions often quote the title back ("the 'Travel Wonders'
    // challenge"), which would confirm every one of its words for free. Only a
    // QUOTED copy is dropped: "Share your photos of people in action" restates
    // the subject in its own words and must still confirm it.
    const prose = [title, subject].reduce((text, quoted) => text.replace(quotedPhraseRe(quoted), ' '), description);
    const described = tokenise(prose, { ignoreWords });
    const subjects = words.filter((word) => described.some((d) => matches(d, word)));
    return subjects.length > 0 ? { kind: 'subject', subjects: Array.from(new Set(subjects)) } : UNCONFIRMED;
};

export {
    abstractTitleWords,
    withoutAbstract,
    titleSubject,
    NEGATION_MARKER_STEMS,
    parseNegation,
    dropNegated,
    excludedSubjectOf,
    photoShowsExcluded,
    detectLetterPrefix,
    readChallengeTheme,
};
