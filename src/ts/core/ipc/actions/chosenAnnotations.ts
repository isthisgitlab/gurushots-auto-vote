/**
 * What the Chosen Photos settings say about an open (not yet joined) challenge,
 * for the Discover rows: the challenge's own saved list and how many photos the
 * join would actually use. Read from the settings; nothing here reaches
 * GuruShots.
 */

import * as settings from '../../settings';
import { resolveJoinSetting } from '../../services/joinChallenges';
import { getOpenChallenge } from '../../services/openChallengeCache';
import { MAX_ANNOTATED_IDS } from '../../settings/limits';

import type { Challenge, ChosenAnnotation } from '../../types/gurushots';

const idsOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/**
 * The annotator for one request: the saved list is read as it is stored, for
 * every challenge of the batch.
 */
const chosenAnnotator = (): ((challenge: Partial<Challenge>) => ChosenAnnotation) => (challenge) => {
    if (challenge?.id === undefined || challenge?.id === null) {
        return { chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 };
    }
    const own = idsOf(settings.getChallengeOverride('chosenPhotos', String(challenge.id)));
    return {
        chosenOwn: own,
        chosenOwnCount: own.length,
        chosenEffectiveCount: idsOf(resolveJoinSetting('chosenPhotos', challenge)).length,
    };
};

/**
 * The annotations of the given ids, upcoming rows included (the cache holds the merged list). An
 * id the latest list did not hold is resolved as a bare id: its own list is read, a rule keyed on
 * its title cannot match.
 */
const annotateOpenIds = async (ids: ReadonlyArray<string | number>): Promise<Record<string, ChosenAnnotation>> => {
    const annotate = chosenAnnotator();
    return Object.fromEntries(ids.map((id) => [String(id), annotate(getOpenChallenge(id) ?? { id })] as const));
};

export { chosenAnnotator, annotateOpenIds, MAX_ANNOTATED_IDS };
