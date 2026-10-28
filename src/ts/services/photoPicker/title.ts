/**
 * Photo picker — what a challenge title says about its subject: title words
 * that are abstract rather than the subject, the series subject segment, and
 * letter challenges ("Begins With L").
 */

import { MAX_TOKENISE_CHARS, stem, tokenise, matches } from './stemming';
import { STOPWORDS } from './stopwords';
import { SERIES_SEPARATOR_RE, parseNegation } from './titleNegation';
import * as lexicon from '../semantic/lexicon';
import { finiteOr } from '../../numbers';

import type { ChallengeText, ChallengeTheme, IgnoreWords } from '../../types/photoPicker';

// Bounds for abstractTitleWords, on the lexicon's concreteness cosine. Pinned by
// the `concreteness.cases` gate in scripts/validate-lexicon.ts (real titles, run
// on every build), so move them only with that gate green. SUBJECT_MIN is the
// high one on purpose: GloVe reads some photographable words as abstract
// ("people" -0.38, "nature" -0.30) and some verbs as mildly concrete ("built"
// 0.11), so the pass only acts when one word is unmistakably a thing
// ("balloon" 0.37) — "Built Among Nature" stays exactly as it was.
const CONCRETE_SUBJECT_MIN = 0.15;
const ABSTRACT_WORD_MAX = -0.1;
// With a fixed phrase ("still life") in the title, the phrase is the anchor —
// by NAME, since the lexicon has no vector for it and it cannot anchor by
// concreteness, and a real qualifier next to it ("beauty" 0.0065) falls
// between ABSTRACT_WORD_MAX and CONCRETE_SUBJECT_MIN, where neither bound
// above would act. Next to the phrase, every word the lexicon scores at or
// under this ceiling is a qualifier of the phrase, not a second subject.
// Pinned by the real-lexicon cases in tests/services/photoPicker.subject.test.ts
// the same way the bounds above are pinned by the `concreteness.cases` gate:
// real qualifiers sit above it ("food" 0.116, "black" 0.119, "fruit" 0.29),
// mood words at or below it ("beauty" 0.0065, "art" 0.015, "minimalist"
// 0.009).
const PHRASE_QUALIFIER_MAX = 0.05;

// The stopword list stemmed once, so the compound-head check in
// abstractTitleWords agrees with both surface and stemmed callers: "life" and
// "lives" both stem into the set, so the compounds "still-life" and
// "still-lives" qualify alike.
const STOPWORD_STEMS: ReadonlySet<string> = new Set([...STOPWORDS].map(stem));

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
 * word in the same title is clearly a thing. A compound ("still-life", the
 * merge of an adjacent-word phrase the model knows) is never demoted and never
 * anchors the normal path — a concrete compound must not demote "nature" in
 * "Close Up Nature" or "people" in "Black and White People". A compound whose
 * HEAD (its last part) stems to a stopword anchors the qualifier branch
 * instead, and only when the compound itself reads concrete: every word BEFORE
 * it scoring at or under PHRASE_QUALIFIER_MAX is a qualifier of the phrase
 * ("beauty" in "Beauty of Still Life"), every word AFTER it at or under
 * ABSTRACT_WORD_MAX is abstract ("fun" in "Still Life Fun") while a concrete
 * follower stays ("portrait" in "Real Life Portraits"). A title with no
 * concrete anchor ("Creative Focus", "People and Architecture") returns
 * nothing, so every caller keeps its existing behavior there — as it does
 * whenever the lexicon is not loaded (every score null, nothing demoted) or a
 * word is out of vocabulary (null concreteness = no opinion).
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
    // Compounds carry their hyphen through stemming, so the hyphen is the
    // structural mark in both surface and stemmed input.
    const isCompound = (word: string) => word.includes('-');
    // The stopword-head compound anchors by shape and model data, so this
    // branch runs BEFORE the concrete-anchor early return below, which would
    // otherwise exit first for "beauty still life" (no word there is remotely
    // CONCRETE_SUBJECT_MIN). The LAST qualifying compound in the title is the
    // anchor — English puts the head noun last.
    let anchor = -1;
    for (let i = words.length - 1; i >= 0; i--) {
        const word = words[i];
        const score = scores[i];
        if (!isCompound(word) || score === null || score < CONCRETE_SUBJECT_MIN) continue;
        const head = word.slice(word.lastIndexOf('-') + 1);
        if (STOPWORD_STEMS.has(stem(head))) {
            anchor = i;
            break;
        }
    }
    if (anchor >= 0) {
        words.forEach((word, i) => {
            const score = scores[i];
            if (isCompound(word) || score === null) return;
            const ceiling = i < anchor ? PHRASE_QUALIFIER_MAX : ABSTRACT_WORD_MAX;
            if (score <= ceiling) abstract.add(word);
        });
        return abstract;
    }
    const known = scores.filter((score, i): score is number => score !== null && !isCompound(words[i]));
    if (!(Math.max(...known) >= CONCRETE_SUBJECT_MIN)) return abstract;
    words.forEach((word, i) => {
        const score = scores[i];
        if (score !== null && !isCompound(word) && score <= ABSTRACT_WORD_MAX) abstract.add(word);
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
// Falls back to the whole title when the tail carries no usable word, so
// "Mountains: A Tribute" keeps "mountains" instead of collapsing to nothing.
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

// Detect a "letter challenge" title — "Begins With L", "Starts with the letter A",
// "Things That Start With B" (interior "Start With" matches via the leading \b),
// plus the "X is for" family below ("C is for…", "A is for Apple").
// Returns the lone target letter (lowercased) or null.
//
// SCOPE: the begins/starts-with, "X is for" and "The Letter X" families are
// handled. A bare "L Words" intentionally returns null and is treated as an
// ordinary title.
//
// SECURITY: `title` is an untrusted string from the GuruShots API. Detection caps
// its length at 200 chars before matching, and withoutLetterPhrases runs the same
// patterns as a global `replace` over up to MAX_TOKENISE_CHARS (4096) chars of
// description text — ReDoS defense-in-depth either way: no pattern has nested
// quantifiers, every alternation is anchored on a \b (or ^/start-of-text) plus a
// literal word, and each whitespace run is crossed a bounded number of times, so
// a scan is linear in the input. The captured value is a single [a-z] char used
// only in a first-character equality check downstream and, uppercased, inside a
// log line, still as one [a-z] character — never interpolated into a query,
// template, or eval.
//
// The trailing (?![\w-]) (instead of \b) forces the captured letter to be a
// standalone token: "Begins With Love" → null (next char is a word char) and
// "Begins With L-A" → null (next char is '-'); "Begins With L" / "...L." → 'l'.
// The letter may also be quoted ("start with 'S'", `start with the letter "S"`,
// "Begins With \"L\"") and the article may be "an" ("begins with an S") — the
// phrasings GuruShots descriptions ship. A bare "a" is the letter only when no
// word follows it: at the end of the text (trailing spaces included) or before
// a separator, possibly after spaces — a newline or an ellipsis counts as a
// separator. A hyphen counts only in the spaced " - " form, so "Begins With
// A-V" is null. A quoted 'a' always counts.
const LETTER_CHALLENGE_RE =
    /\b(?:begin(?:s|ning)?|start(?:s|ing)?)\s+with\s+(?:the\s+|an\s+)?(?:letter\s+)?(?:([b-z])(?![\w-])|(a)(?=\s*$|\s*[–—:;,.!?|)…\n]|\s+-)|['"‘“]\s*([a-z])\s*['"’”](?![\w-]))/i;
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
// The colon rides inside the whitespace run as an optional group (`\s*(?::\s*)?`)
// rather than a second `\s*` beside it: a second `\s*` would make a failed match
// cross the run twice — quadratic time on a long run.
const LETTER_NAMED_RE = /\bletters?\s*(?::\s*)?(?:['"‘“]\s*([a-z])\s*['"’”]|([a-z])(?=\s*(?:[-–—:;,.!?|]|$)))/i;
// The three letter-phrase matchers in detection order. detectLetterPrefix and
// withoutLetterPhrases both read this list, so what a title is DETECTED by is
// exactly what a text is STRIPPED by — the two cannot drift.
const LETTER_PATTERNS: readonly RegExp[] = [LETTER_CHALLENGE_RE, LETTER_IS_FOR_RE, LETTER_NAMED_RE];
// The same list with /g, built once, for String.prototype.replace ONLY. A /g
// regex carries `lastIndex` across .test/.exec calls, so reusing one of these
// for a match test would corrupt the next call.
const LETTER_PATTERNS_GLOBAL: readonly RegExp[] = LETTER_PATTERNS.map((re) => new RegExp(re.source, re.flags + 'g'));
const detectLetterPrefix = (title: string | null | undefined): string | null => {
    if (typeof title !== 'string' || title.length > 200) return null;
    let m: RegExpMatchArray | null = null;
    for (const re of LETTER_PATTERNS) {
        m = title.match(re);
        if (m) break;
    }
    if (!m) return null;
    // Each pattern captures the letter in a different group (LETTER_CHALLENGE_RE
    // and LETTER_NAMED_RE have one per bare/quoted branch, only one of which
    // participates), so read the first group that actually matched rather than
    // hard-coding an index. Every match has exactly one participating `([a-z])`
    // group, so this always finds it.
    const letter = m.slice(1).find((g) => typeof g === 'string' && g.length === 1) as string;
    return letter.toLowerCase();
};

/**
 * `text` with every letter phrase ("The Letter S", "starts with 'S'", "C is
 * for") replaced by a space — a letter phrase names a challenge's RULE, never
 * its subject, in a title or in a description. Callers apply it only when
 * `detectLetterPrefix(challenge?.title)` is non-null, so a title over 200 chars
 * (detect returns null) is never stripped, and detect and strip agree at the cap.
 * The input is cut to MAX_TOKENISE_CHARS, the cut `tokenise` already applies; a
 * non-string returns ''. The replacement must stay ' ': LETTER_IS_FOR_RE
 * consumes its leading whitespace, so '' would glue the neighbouring words
 * together.
 */
const withoutLetterPhrases = (text: string | null | undefined): string => {
    if (typeof text !== 'string') return '';
    let out = text.slice(0, MAX_TOKENISE_CHARS);
    for (const re of LETTER_PATTERNS_GLOBAL) out = out.replace(re, ' ');
    return out;
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
    const fromTitle = tokenise(subject, { ignoreWords, compounds: 'replace' });
    // A title of pure boilerplate ("Best of the Best") can still carry its
    // subject in the slug ("macro-insects4"), which buildThemeKeywords falls
    // back to — so the slug has to be empty too before the theme reads as open.
    const words = fromTitle.length > 0 ? fromTitle : tokenise(challenge?.url, { ignoreWords, compounds: 'replace' });
    if (words.every((word) => FORMAT_STEMS.has(word))) return OPEN;
    // Descriptions often quote the title back ("the 'Travel Wonders'
    // challenge"), which would confirm every one of its words for free. Only a
    // QUOTED copy is dropped: "Share your photos of people in action" restates
    // the subject in its own words and must still confirm it.
    const prose = [title, subject].reduce((text, quoted) => text.replace(quotedPhraseRe(quoted), ' '), description);
    const described = tokenise(prose, { ignoreWords, compounds: 'replace' });
    const subjects = words.filter((word) => described.some((d) => matches(d, word)));
    return subjects.length > 0 ? { kind: 'subject', subjects: Array.from(new Set(subjects)) } : UNCONFIRMED;
};

export {
    abstractTitleWords,
    withoutAbstract,
    titleSubject,
    detectLetterPrefix,
    withoutLetterPhrases,
    readChallengeTheme,
};

export { NEGATION_MARKER_STEMS, parseNegation, dropNegated } from './titleNegation';
export { PEOPLE_LABEL_STEMS, ANIMAL_LABEL_STEMS } from './titleLabelStems';
export { isParticiple, descriptionExclusions, excludedSubjectOf, photoShowsExcluded } from './titleExclusions';
