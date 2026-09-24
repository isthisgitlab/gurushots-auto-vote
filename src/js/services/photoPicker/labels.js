/**
 * Photo picker — the photo side of matching: label stems (whole-label and
 * word-level, bounded against untrusted label data) and the per-photo match
 * counters built on them.
 */

const { MAX_TOKENISE_CHARS, stem, tokenise, matches } = require('./stemming');

// Bounds on tokenised label data. Photo labels are untrusted strings from the
// GuruShots API, and splitting them into words (rather than keeping one stem per
// label) multiplies how many stems a single photo can contribute. Those stems
// feed the O(stems x keywords) match loops AND the semantic embedding cache key
// (see semantic/index.js, which JSON.stringifies the token array — its MAX_CACHE
// bounds the entry COUNT, not the entry SIZE). Cap both fan-outs, mirroring the
// SEARCH_TERMS_CAP / 200-char caps used elsewhere in the picker. Real vision
// labels are 1-3 words; these ceilings are far above anything legitimate.
const MAX_WORDS_PER_LABEL = 12;
const MAX_STEMS_PER_PHOTO = 64;
// Bounds the number of labels iterated at all, so a photo carrying thousands of
// duplicate labels cannot force unbounded tokenise() work: the MAX_STEMS_PER_PHOTO
// early-exit only fires when the deduping Set actually GROWS, so repeated labels
// would otherwise be tokenised in full, one after another, without ever tripping it.
const MAX_LABELS_PER_PHOTO = 64;

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
    return (
        photo.labels
            .slice(0, MAX_LABELS_PER_PHOTO)
            // Same untrusted-input guard as labelWordStems. Without the type check a
            // null label would stem to the literal string "null" and could satisfy a
            // "Begins With N" challenge; an unbounded label would be stemmed in full.
            .filter((l) => typeof l === 'string' || typeof l === 'number')
            .map((l) => stem(String(l).slice(0, MAX_TOKENISE_CHARS).toLowerCase()))
            .filter(Boolean)
    );
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
    for (const label of photo.labels.slice(0, MAX_LABELS_PER_PHOTO)) {
        if (typeof label !== 'string' && typeof label !== 'number') continue;
        const words = tokenise(String(label), { keepStopwords: true }).slice(0, MAX_WORDS_PER_LABEL);
        for (const word of words) {
            out.add(word);
            if (out.size >= MAX_STEMS_PER_PHOTO) return Array.from(out);
        }
    }
    return Array.from(out);
};

/**
 * Label word-stems grouped PER LABEL, bounded exactly like labelWordStems
 * ("Sea Life" stays [["sea","life"]] rather than collapsing into the photo's
 * flat stem bag).
 *
 * EXISTS FOR THE SEMANTIC TIER. Vision labels are an unordered bag in which
 * only one or two entries are ever on theme; mean-pooling the whole bag into a
 * single vector asks "is this entire scene about the theme", which a 24-label
 * photo can never answer yes to. Scoring each label separately and keeping the
 * best asks "does ANY label mean this", which is the question the tier is for.
 * See getSemanticScores for the measured effect.
 *
 * Duplicate labels collapse (same stem sequence) so a repeated label cannot pay
 * the embedding cost twice, and groups are truncated to keep the total stem
 * count at or under MAX_STEMS_PER_PHOTO — the same ceiling the flat helper
 * enforces, so a photo cannot cost more work here than there.
 */
const labelStemGroups = (photo) => {
    if (!Array.isArray(photo?.labels)) return [];
    const groups = [];
    const seen = new Set();
    let stems = 0;
    for (const label of photo.labels.slice(0, MAX_LABELS_PER_PHOTO)) {
        if (typeof label !== 'string' && typeof label !== 'number') continue;
        const words = tokenise(String(label), { keepStopwords: true }).slice(0, MAX_WORDS_PER_LABEL);
        if (words.length === 0) continue;
        const key = words.join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        // Trim the boundary label rather than letting it straddle the ceiling:
        // checking only after pushing a whole label could overshoot by up to
        // MAX_WORDS_PER_LABEL - 1 stems.
        const room = MAX_STEMS_PER_PHOTO - stems;
        groups.push(words.length > room ? words.slice(0, room) : words);
        stems += Math.min(words.length, room);
        if (stems >= MAX_STEMS_PER_PHOTO) break;
    }
    return groups;
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

module.exports = {
    wholeLabelStems,
    labelWordStems,
    labelStemGroups,
    photoMatchesAllStems,
    countShouldMatches,
    scorePhoto,
};
