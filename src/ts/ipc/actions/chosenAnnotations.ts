/**
 * What the Chosen Photos settings say about an open (not yet joined) challenge,
 * for the Discover rows: the challenge's own saved list and how many photos the
 * join would actually use. Settings only — nothing here asks GuruShots.
 */

import * as settings from '../../settings';
import { peekMemberId } from '../../services/autoFill';
import { resolveJoinSetting } from '../../services/joinChallenges';
import { getOpenChallenge } from '../../services/openChallengeCache';

import type { Challenge, ChosenAnnotation } from '../../types/gurushots';

// Most ids one request may ask about: the open list is a handful of challenges.
const MAX_ANNOTATED_IDS = 200;

const idsOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/**
 * The annotator for one request. The saved list's owner and the signed-in member
 * are looked up once, not once per challenge.
 *
 * A list saved under another account is never described by its ids: the row gets
 * `chosenOwn: []` with the real `chosenOwnCount`, and nothing applies to the join
 * (`chosenEffectiveCount: 0`), as at join time. While the signed-in member is not
 * known yet (`peekMemberId` is null: no lookup has resolved it) it cannot be told
 * whether the list is theirs, so the ids are withheld all the same — but the list
 * still counts as applying, as resolveChosenPhotos applies it at join time.
 */
const chosenAnnotator = (token: string): ((challenge: Partial<Challenge>) => ChosenAnnotation) => {
    const savedBy = settings.getSetting('chosenPhotosMemberId');
    const current = peekMemberId(token);
    const recorded = typeof savedBy === 'string' && savedBy !== '';
    const foreign = recorded && current !== null && current !== savedBy;
    // Ids are shown only once the list is known to be this account's.
    const withhold = recorded && current !== savedBy;
    return (challenge) => {
        if (challenge?.id === undefined || challenge?.id === null) {
            return { chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 };
        }
        const own = idsOf(settings.getChallengeOverride('chosenPhotos', String(challenge.id)));
        return {
            chosenOwn: withhold ? [] : own,
            chosenOwnCount: own.length,
            chosenEffectiveCount: foreign ? 0 : idsOf(resolveJoinSetting('chosenPhotos', challenge)).length,
        };
    };
};

/**
 * The annotations of the given ids. An id the latest list did not hold is resolved
 * as a bare id: its own list is read, a rule keyed on its title cannot match.
 */
const annotateOpenIds = (ids: ReadonlyArray<string | number>, token: string): Record<string, ChosenAnnotation> => {
    const annotate = chosenAnnotator(token);
    return Object.fromEntries(ids.map((id) => [String(id), annotate(getOpenChallenge(id) ?? { id })] as const));
};

export { chosenAnnotator, annotateOpenIds, MAX_ANNOTATED_IDS };
