/**
 * What the Chosen Photos settings say about an open (not yet joined) challenge,
 * for the Discover rows: the challenge's own saved list and how many photos the
 * join would actually use. Settings only — nothing here asks GuruShots.
 */

import * as settings from '../../settings';
import { peekMemberId } from '../../services/autoFill';
import { resolveJoinSetting } from '../../services/joinChallenges';

import type { Challenge, ChosenAnnotation } from '../../types/gurushots';

// Most ids one request may ask about: the open list is a handful of challenges.
const MAX_ANNOTATED_IDS = 200;

// The open challenges the latest list fetch returned, by id. The annotation of an id
// needs its title and tags (a rule may be keyed on them), which only the list has.
let openChallenges: Map<string, Challenge> = new Map();

/** Remember the open list a fetch returned. */
const rememberOpenChallenges = (items: ReadonlyArray<Challenge | null>): void => {
    openChallenges = new Map(items.flatMap((item) => (item?.id == null ? [] : [[String(item.id), item] as const])));
};

const idsOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/**
 * The annotator for one request. The saved list's owner and the signed-in member
 * are looked up once, not once per challenge.
 *
 * A list saved under another account is never described by its ids: the row gets
 * `chosenOwn: []` with the real `chosenOwnCount`, and nothing applies to the join
 * (`chosenEffectiveCount: 0`), as at join time. A member that is not known yet
 * (`peekMemberId` is null: no lookup has resolved it) means "cannot tell", which
 * applies the list, the same as resolveChosenPhotos does.
 */
const chosenAnnotator = (token: string): ((challenge: Partial<Challenge>) => ChosenAnnotation) => {
    const savedBy = settings.getSetting('chosenPhotosMemberId');
    const current = peekMemberId(token);
    const foreign = typeof savedBy === 'string' && savedBy !== '' && current !== null && current !== savedBy;
    return (challenge) => {
        if (challenge?.id === undefined || challenge?.id === null) {
            return { chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 };
        }
        const own = idsOf(settings.getChallengeOverride('chosenPhotos', String(challenge.id)));
        return {
            chosenOwn: foreign ? [] : own,
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
    return Object.fromEntries(
        ids.map((id) => [String(id), annotate(openChallenges.get(String(id)) ?? { id })] as const),
    );
};

export { chosenAnnotator, annotateOpenIds, rememberOpenChallenges, MAX_ANNOTATED_IDS };
