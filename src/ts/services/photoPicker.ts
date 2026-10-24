/**
 * Photo Picker — pure ranking of the user's eligible photos for auto-fill. A
 * theme match always beats popularity (the tier order is in photoPicker/tiers.ts).
 * Callers import this facade; the ranking lives in ./photoPicker/*.
 */

import { stem, stripTags, tokenise, matches, tokeniseTagList } from './photoPicker/stemming';
import {
    abstractTitleWords,
    detectLetterPrefix,
    descriptionExclusions,
    parseNegation,
    readChallengeTheme,
    withoutLetterPhrases,
} from './photoPicker/title';
import {
    buildChallengeKeywords,
    buildThemeKeywords,
    buildThemeAlternatives,
    visualSubjectWords,
    buildSearchTerms,
    compoundSpellings,
} from './photoPicker/keywords';
import { wholeLabelStems, labelWordStems, labelStemGroups, scorePhoto } from './photoPicker/labels';
import {
    SEMANTIC_MATCH_FLOOR,
    SEMANTIC_SUPPORT_CAP,
    hasThemeMatch,
    selectEnrichmentSet,
    selectBlockEnrichmentSet,
    splitByChosen,
    finalizePick,
} from './photoPicker/tiers';
import {
    pickPhotosForChallenge,
    buildScoredCandidates,
    buildChosenCandidates,
    startsWithLetter,
} from './photoPicker/candidates';

export {
    pickPhotosForChallenge,
    buildScoredCandidates,
    buildChosenCandidates,
    startsWithLetter,
    selectEnrichmentSet,
    selectBlockEnrichmentSet,
    splitByChosen,
    finalizePick,
    hasThemeMatch,
    buildSearchTerms,
    detectLetterPrefix,
    withoutLetterPhrases,
    parseNegation,
    descriptionExclusions,
    readChallengeTheme,
    stripTags,
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
    compoundSpellings,
};
