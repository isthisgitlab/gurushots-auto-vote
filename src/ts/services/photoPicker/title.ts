/**
 * Photo picker — what a challenge title and description say about its subject:
 * title words that are abstract rather than the subject, the series subject
 * segment, negated subjects ("No Humans") and description exclusions ("no
 * people"), and the exclusion filter they become, and letter challenges
 * ("Begins With L").
 */

import { MAX_TOKENISE_CHARS, FIXED_PHRASE_TOKENS, stem, rawTokenise, tokenise, matches, stripTags } from './stemming';
import * as lexicon from '../semantic/lexicon';
import { finiteOr } from '../../numbers';

import type {
    ChallengeText,
    ChallengeTheme,
    ExcludedConcept,
    ExcludedConceptName,
    ExcludedSubject,
    IgnoreWords,
    Negation,
} from '../../types/photoPicker';

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
 * word in the same title is clearly a thing. A fixed phrase (FIXED_PHRASE_TOKENS,
 * "still life") anchors too: the phrase itself has no lexicon vector, so it
 * cannot anchor by concreteness — instead every OTHER word with a known score
 * at or under PHRASE_QUALIFIER_MAX is demoted next to it ("beauty" in "Beauty
 * of Still Life"). A title with no concrete anchor
 * ("Creative Focus", "People and Architecture") returns nothing, so every
 * caller keeps its existing behavior there — as it does whenever the lexicon is
 * not loaded (every score null, nothing demoted) or a word is out of vocabulary
 * (null concreteness = no opinion).
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
    // The fixed phrase anchors by name, so this branch runs BEFORE the
    // concrete-anchor early return below, which would otherwise exit first for
    // "beauty still life" (no word there is remotely CONCRETE_SUBJECT_MIN).
    if (words.some((word) => FIXED_PHRASE_TOKENS.has(word))) {
        words.forEach((word, i) => {
            const score = scores[i];
            if (score !== null && score <= PHRASE_QUALIFIER_MAX) abstract.add(word);
        });
        return abstract;
    }
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
// The conflict guard's people set. The photo-type words "portrait", "face" and
// "selfie" name how a photo is framed, not that a person is in it — a photo of
// a pet can be a portrait — so a title holding one is not asking for people and
// must not cancel a description's "no people".
const PHOTO_TYPE_STEMS = new Set(['portrait', 'face', 'selfie'].map((w) => stem(w)));
const PEOPLE_GUARD_STEMS = new Set([...PEOPLE_LABEL_STEMS].filter((s) => !PHOTO_TYPE_STEMS.has(s)));

// The animal concept, spelled out for the same reason as the people one: the
// vision labels on a photo of an animal rarely say "animal" — they say "Dog",
// "Wildlife". Compared by EXACT stem, not matches(): "cat" must not catch
// "catamaran". Deliberately left out are the words that name an object as often
// as an animal — "bear" (teddy bear), "duck" (rubber duck), "mouse" (computer
// mouse), "seal" (wax seal), "feather", "fur", "fin" (quill, coat, surfboard),
// "wing" (aircraft) — dropping them would keep those photos out of still-life
// and machine challenges. The generic taxonomy labels "mammal" and "vertebrate"
// are left out too: some vision labellers put them on photos of people, so
// "no animals" could drop a portrait.
//
// SCOPE: these sets only drop photos from automatic picks, by the photo's
// existing labels. They must never grow into attributes of people (age,
// gender, ethnicity).
const ANIMAL_LABEL_STEMS = new Set(
    [
        'animal',
        'pet',
        'dog',
        'puppy',
        'cat',
        'kitten',
        'bird',
        'fish',
        'horse',
        'pony',
        'cow',
        'cattle',
        'sheep',
        'goat',
        'pig',
        'chicken',
        'insect',
        'butterfly',
        'bee',
        'spider',
        'snake',
        'reptile',
        'lizard',
        'turtle',
        'frog',
        'amphibian',
        'wildlife',
        'fauna',
        'deer',
        'rabbit',
        'squirrel',
        'monkey',
        'elephant',
        'lion',
        'tiger',
        'wolf',
        'fox',
        'whale',
        'dolphin',
        'shark',
        'owl',
        'eagle',
        'parrot',
        'pigeon',
        'gull',
        'seagull',
        'swan',
        'beak',
        'snout',
        'paw',
        'whiskers',
    ].map((w) => stem(w)),
);
// The conflict guard's animal set: the label set above plus the taxonomy words
// it left out, which a title may legitimately ask for ("Wild Mammals") even
// though they must not match a photo's labels.
const ANIMAL_GUARD_STEMS = new Set([...ANIMAL_LABEL_STEMS, ...['mammal', 'vertebrate'].map((w) => stem(w))]);
// A photo labelled as food does not count as showing an animal: fish, poultry
// or game on a table is classic still life. The exemption applies to the
// animal concept only, never to people.
const FOOD_LABEL_STEMS = new Set(
    ['food', 'dish', 'seafood', 'cuisine', 'ingredient', 'meat', 'meal', 'recipe'].map((w) => stem(w)),
);
// The head nouns that turn a negated TITLE ("No Animals", "No Pets") into the
// whole animal concept, the way any people word turns a negated title into the
// people concept. A specific animal ("Cats: No Dogs") stays stems-only, so the
// cats keep their challenge.
const ANIMAL_HEAD_NOUNS = new Set(['animal', 'pet'].map((w) => stem(w)));

// Trailing '-ing' marks a participle ("running", "leading"). Length-guarded the
// same way the stemmer's own '-ing' branch is, so short words that merely end in
// those letters ("king", "ring", "wing" — all plausible subjects) are not caught.
const isParticiple = (word: string) => word.length > 5 && word.endsWith('ing');

/**
 * Which concepts a challenge's description rules out, read from the two fixed
 * forms below. A concept the positive title asks FOR is dropped (the conflict
 * guard): a "Pets and Their People" challenge whose description says "no
 * animals" would otherwise drop every photo its own title asks for. The guard
 * reads the positive title only, so a negated "No Pets" does not cancel a
 * description's animal exclusion.
 */
const descriptionExclusions = (
    challenge: ChallengeText | null | undefined,
    ignoreWords: IgnoreWords = null,
): ExcludedConceptName[] => {
    const message = challenge?.welcome_message;
    if (typeof message !== 'string' || message === '') return [];
    // Single spaces only, so every space in the patterns below is literal.
    const text = stripTags(message).toLowerCase().replace(/\s+/g, ' ');
    const found: ExcludedConceptName[] = [];
    const add = (matched: string) => {
        if (PEOPLE_NOUNS_RE.test(matched) && !found.includes('people')) found.push('people');
        if (ANIMAL_NOUNS_RE.test(matched) && !found.includes('animals')) found.push('animals');
    };
    // matchAll iterates a clone, so no lastIndex state is left on the shared
    // regexes between calls.
    for (const m of text.matchAll(DESCRIPTION_LEAD_RE)) {
        const end = m.index + m[0].length;
        // A lead match counts when the follower accepts it, and is rejected
        // only when BOTH hold: (a) the lead keyword opens a photo noun's
        // post-modifier ("Photos without …", "Entries with no …"), and (b) a
        // verdict on the noun follows in the same sentence. Together that is
        // the requirement reading — "photos without X … are disqualified"
        // demands photos with X — while a sentence-initial "No X, or …
        // disqualified" is a penalty and still excludes. The two probes are
        // sticky at the match end on the whole text, the photo-noun check
        // reads the fixed window before the keyword, and every lastIndex is
        // reset after each probe so no state leaks out.
        const before = text.slice(Math.max(0, m.index - LEAD_POSTMODIFIER_WINDOW), m.index);
        DESCRIPTION_LEAD_FOLLOWER_RE.lastIndex = end;
        DESCRIPTION_LEAD_VERDICT_TAIL_RE.lastIndex = end;
        const nounIsRequired =
            DESCRIPTION_LEAD_PHOTO_POSTMODIFIER_RE.test(before) && DESCRIPTION_LEAD_VERDICT_TAIL_RE.test(text);
        if (DESCRIPTION_LEAD_FOLLOWER_RE.test(text) && !nounIsRequired) add(m[0]);
        DESCRIPTION_LEAD_FOLLOWER_RE.lastIndex = 0;
        DESCRIPTION_LEAD_VERDICT_TAIL_RE.lastIndex = 0;
    }
    for (const m of text.matchAll(DESCRIPTION_VERDICT_RE)) add(m[0]);
    if (found.length === 0) return [];
    const titleWords = rawTokenise(parseNegation(challenge?.title, ignoreWords).positiveTitle, { ignoreWords });
    return found.filter((noun) => {
        const labels = noun === 'people' ? PEOPLE_GUARD_STEMS : ANIMAL_GUARD_STEMS;
        return !titleWords.some((word) => {
            // A participle title word is an activity, not the animal its stem
            // lands on ("Fishing" stems to "fish"), so the animal guard skips
            // the raw word before stemming.
            if (noun === 'animals' && isParticiple(word)) return false;
            const stemmed = stem(word);
            return labels.has(stemmed) || stemmed === noun;
        });
    });
};

// What a DESCRIPTION says to leave out. GuruShots phrases its off-topic rules
// two ways — a lead negation ("no people", "without any humans or animals")
// and a verdict ("people and animals will be considered off-topic") — and the
// scope is deliberately the two concepts only: parsing "no X" for any noun out
// of prose is too error-prone.
//
// SECURITY: both patterns are built ONLY from the fixed word lists below,
// never from challenge text. The text is stripped, lowercased and collapsed to
// single spaces first, so every space in a pattern is literal and each split
// is unique — no adjacent optional whitespace to backtrack over. The verdict
// form can restart at each noun of a long list, which makes it quadratic in
// the noun count; the cost is bounded by the 4,096-char cap (measured worst
// case ~11 ms at the cap, a negated 510-noun list) and guarded by the timing
// test in tests/services/photoPicker.test.ts (< 200 ms).
const DESCRIPTION_NOUN = '(?:people|persons?|humans?|animals?|pets?)';
// A bare comma joins too, so serial lists ("no people, pets or animals") read whole.
const DESCRIPTION_SEP = '(?:, (?:and |or )?| and | or |\\/)';
const DESCRIPTION_LIST = `${DESCRIPTION_NOUN}(?:${DESCRIPTION_SEP}${DESCRIPTION_NOUN})*`;
// The lookbehind rejects "with or without people" (and "with and", "with/"):
// those grant a freedom rather than excluding. "not" is deliberately not a
// lead word, so "not only people but also animals" excludes nothing, and
// "other" is deliberately not in the optional group either: "no other people"
// grants an exception (the subject itself may appear) rather than excluding.
const DESCRIPTION_LEAD_RE = new RegExp(
    `\\b(?<!with or |with and |with\\/)(?:no|without|avoid|avoiding|excluding) (?:any |the )?${DESCRIPTION_LIST}\\b`,
    'g',
);
// A lead match counts only when the text at the match end is the end of the
// text, punctuation, " -" or " (", or opens one of these words. The list is
// greedy and there is no lookahead to backtrack into, so the match ends after
// the full list and this check runs anchored exactly there: sticky (`y`), with
// the end of the text as its `$` alternative, probed on the whole text at the
// match end — no slice of the input is taken — and lastIndex reset after each
// probe so no state leaks out.
// "will", "are", "is", "can" and "may" stay out — they would let "no animals
// will be harmed" through — while "should" and "must" stay in, at the pinned
// cost that "no animals should be harmed" counts too, and "or" is in for a
// penalty clause riding on the lead ("no people or the entry will be
// disqualified"); the greedy list still ends at the last noun, so "no people
// or animal lovers" reads " lovers" as its follower and excludes nothing.
const DESCRIPTION_LEAD_FOLLOWER_RE =
    /(?:[.,;:!?()]| -| \(| (?:in|on|or|at|please|allowed|permitted|visible|should|must)\b|$)/y;
// The trailing lookahead rejects "places where people are not allowed to enter".
// The lookbehind rejects a negator before the list ("Photos without pets ...",
// "Shots that do not include people ..."): there the noun is what the sentence
// rules out, not the subject a verdict is pronounced on. The list prefix in the
// lookbehind also covers a match that would restart mid-list, on a later noun
// of the negated list ("without pets or people ...", "with no people, pets or
// animals ..."): the restart point sits right after a separator, where a
// word-only lookbehind sees no negator.
const DESCRIPTION_VERDICT_NEGATORS = 'without |with no |no |not include |not including |not contain |not containing ';
// The verdict a sentence pronounces on the noun list ("... will be considered
// off-topic"), shared by the verdict form and the lead-match rejection below.
const DESCRIPTION_VERDICT_TAIL =
    '(?:will be|would be|are|is) (?:considered )?(?:off[ -]?topic|not allowed|not permitted|disqualified|forbidden|prohibited|excluded)\\b';
const DESCRIPTION_VERDICT_RE = new RegExp(
    `\\b(?<!(?:${DESCRIPTION_VERDICT_NEGATORS})(?:${DESCRIPTION_NOUN}${DESCRIPTION_SEP})*)${DESCRIPTION_LIST}\\b ${DESCRIPTION_VERDICT_TAIL}(?! to\\b)`,
    'g',
);
// The (b) half of the lead rejection: a verdict pronounced later in the same
// sentence. Sticky at the lead match end, it scans the rest of the sentence —
// to the next [.!?;] or the end of the text, the class cannot cross one —
// without slicing the input; lastIndex is reset after each probe.
const DESCRIPTION_LEAD_VERDICT_TAIL_RE = new RegExp(`[^.!?;]*?${DESCRIPTION_VERDICT_TAIL}`, 'y');
// The (a) half: the lead keyword opens a photo noun's post-modifier ("Photos
// without …", "Entries with no …", "images with no …"). Anchored at the end of
// a fixed window of the text before the keyword, built only from this list.
const LEAD_POSTMODIFIER_WINDOW = 32;
const DESCRIPTION_LEAD_PHOTO_POSTMODIFIER_RE =
    /(?:photos?|images?|shots?|pictures?|entries?|submissions?|pics?) (?:with )?$/;
const PEOPLE_NOUNS_RE = /\b(?:people|persons?|humans?)\b/;
const ANIMAL_NOUNS_RE = /\b(?:animals?|pets?)\b/;

/**
 * What the challenge's title and description say to leave out, in the shape the
 * exclusion filter reads, or null when neither negates anything.
 */
const excludedSubjectOf = (
    challenge: ChallengeText | null | undefined,
    ignoreWords: IgnoreWords,
): ExcludedSubject | null => {
    const { stems, active } = parseNegation(challenge?.title, ignoreWords);
    const described = descriptionExclusions(challenge, ignoreWords);
    if (!active && described.length === 0) return null;
    const wantsPeople = active && stems.some((s) => PEOPLE_LABEL_STEMS.has(s));
    const wantsAnimals = active && stems.some((s) => ANIMAL_HEAD_NOUNS.has(s));
    // One concept per family: a concept named by both the title and the
    // description keeps the description's noun.
    const concepts: ExcludedConcept[] = [];
    if (wantsPeople || described.includes('people')) {
        concepts.push({
            labels: PEOPLE_LABEL_STEMS,
            unless: null,
            noun: described.includes('people') ? 'people' : null,
        });
    }
    if (wantsAnimals || described.includes('animals')) {
        concepts.push({
            labels: ANIMAL_LABEL_STEMS,
            unless: FOOD_LABEL_STEMS,
            // The concept's noun, singular — the fallback log names it like a stem.
            noun: described.includes('animals') ? 'animal' : null,
        });
    }
    return { stems, concepts };
};

const photoShowsExcluded = (labelStems: string[], excluded: ExcludedSubject): boolean =>
    excluded.concepts.some(({ labels, unless }) => {
        if (!labelStems.some((s) => labels.has(s))) return false;
        return unless === null || !labelStems.some((s) => unless.has(s));
    }) || labelStems.some((labelStem) => excluded.stems.some((s) => matches(labelStem, s)));

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
    PEOPLE_LABEL_STEMS,
    ANIMAL_LABEL_STEMS,
    descriptionExclusions,
    excludedSubjectOf,
    photoShowsExcluded,
    detectLetterPrefix,
    readChallengeTheme,
    isParticiple,
};
