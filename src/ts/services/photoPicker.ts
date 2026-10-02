/**
 * Photo Picker — pure ranking of the user's eligible photos for auto-fill. A
 * theme match always beats popularity (the tier order is in photoPicker/tiers.ts).
 * Callers import this facade; the ranking lives in ./photoPicker/*.
 */

import { stem, tokenise, matches, tokeniseTagList } from './photoPicker/stemming';
import { abstractTitleWords, detectLetterPrefix, parseNegation, readChallengeTheme } from './photoPicker/title';
import {
    buildChallengeKeywords,
    buildThemeKeywords,
    buildThemeAlternatives,
    visualSubjectWords,
    buildSearchTerms,
} from './photoPicker/keywords';
import { wholeLabelStems, labelWordStems, labelStemGroups, scorePhoto } from './photoPicker/labels';
import {
    SEMANTIC_MATCH_FLOOR,
    SEMANTIC_SUPPORT_CAP,
    hasThemeMatch,
    selectEnrichmentSet,
    finalizePick,
} from './photoPicker/tiers';
import { pickPhotosForChallenge, buildScoredCandidates } from './photoPicker/candidates';

export {
    pickPhotosForChallenge,
    buildScoredCandidates,
    selectEnrichmentSet,
    finalizePick,
    hasThemeMatch,
    buildSearchTerms,
    detectLetterPrefix,
    parseNegation,
    readChallengeTheme,
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
};
