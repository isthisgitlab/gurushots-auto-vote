/**
 * GuruShots Auto Voter - Photo Picker
 *
 * Pure ranking used by the auto-fill flow to choose which of the user's
 * eligible photos to submit into a challenge. GOVERNING RULE: a theme match
 * always beats popularity — photoPicker/tiers.js documents the tier order that
 * enforces it.
 *
 * Facade — the only module callers import. It re-exports the public surface of
 * the internal ./photoPicker/* modules:
 *
 *   stemming.js    stopwords, stemmer, bounded tokeniser, stem matching,
 *                  user-tag normalisation
 *   title.js       abstract title words, series subject, negated subjects,
 *                  letter challenges
 *   keywords.js    challenge keywords, semantic theme words, image-model subject
 *                  words, server-side search terms
 *   labels.js      photo label stems and the per-photo match counters
 *   tiers.js       tier values, theme comparison, enrichment set, final sort
 *   candidates.js  hard and exclusion filters, scored candidates, the one-call pick
 */

const { STOPWORDS, stem, tokenise, matches, tokeniseTagList } = require('./photoPicker/stemming');
const { abstractTitleWords, detectLetterPrefix, parseNegation } = require('./photoPicker/title');
const {
    buildChallengeKeywords,
    buildThemeKeywords,
    buildThemeAlternatives,
    visualSubjectWords,
    buildSearchTerms,
} = require('./photoPicker/keywords');
const { wholeLabelStems, labelWordStems, labelStemGroups, scorePhoto } = require('./photoPicker/labels');
const {
    SEMANTIC_MATCH_FLOOR,
    SEMANTIC_SUPPORT_CAP,
    hasThemeMatch,
    selectEnrichmentSet,
    finalizePick,
} = require('./photoPicker/tiers');
const { pickPhotosForChallenge, buildScoredCandidates } = require('./photoPicker/candidates');

module.exports = {
    pickPhotosForChallenge,
    buildScoredCandidates,
    selectEnrichmentSet,
    finalizePick,
    hasThemeMatch,
    buildSearchTerms,
    detectLetterPrefix,
    parseNegation,
    labelWordStems,
    labelStemGroups,
    SEMANTIC_MATCH_FLOOR,
    SEMANTIC_SUPPORT_CAP,
    // exported for unit tests
    tokenise,
    stem,
    matches,
    buildChallengeKeywords,
    buildThemeKeywords,
    buildThemeAlternatives,
    visualSubjectWords,
    abstractTitleWords,
    scorePhoto,
    tokeniseTagList,
    wholeLabelStems,
    STOPWORDS,
};
