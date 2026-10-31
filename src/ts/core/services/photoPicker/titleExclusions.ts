/**
 * Photo picker — the description exclusions ("no people", "people and animals
 * will be considered off-topic") and the exclusion filter the title and
 * description negations together become.
 */

import { matches, rawTokenise, stem, stripTags } from './stemming';
import { parseNegation } from './titleNegation';
import {
    ANIMAL_GUARD_STEMS,
    ANIMAL_HEAD_NOUNS,
    ANIMAL_LABEL_STEMS,
    FOOD_LABEL_STEMS,
    PEOPLE_GUARD_STEMS,
    PEOPLE_LABEL_STEMS,
} from './titleLabelStems';

import type {
    ChallengeText,
    ExcludedConcept,
    ExcludedConceptName,
    ExcludedSubject,
    IgnoreWords,
} from '../../types/photoPicker';

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
    // Single spaces, none leading or trailing, so every space in the patterns
    // below is literal and the end of the text is the end of a match.
    const text = stripTags(message).toLowerCase().replace(/\s+/g, ' ').trim();
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
        if ((end === text.length || DESCRIPTION_LEAD_FOLLOWER_RE.test(text)) && !nounIsRequired) add(m[0]);
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
// the full list and this check runs anchored exactly there: sticky (`y`),
// probed on the whole text at the match end — no slice of the input is
// taken — and lastIndex reset after each probe so no state leaks out. The
// end of the text is checked in code (end === text.length), keeping every
// alternative of the pattern non-empty.
// "will", "are", "is", "can" and "may" stay out — they would let "no animals
// will be harmed" through — while "should" and "must" stay in, at the pinned
// cost that "no animals should be harmed" counts too, and "or" is in for a
// penalty clause riding on the lead ("no people or the entry will be
// disqualified"); the greedy list still ends at the last noun, so "no people
// or animal lovers" reads " lovers" as its follower and excludes nothing.
const DESCRIPTION_LEAD_FOLLOWER_RE =
    /(?:[.,;:!?()]| -| \(| (?:in|on|or|at|please|allowed|permitted|visible|should|must)\b)/y;
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

export { isParticiple, descriptionExclusions, excludedSubjectOf, photoShowsExcluded };
