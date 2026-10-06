/**
 * What the Chosen Photos settings say about an open (not yet joined) challenge,
 * for the Discover rows: the challenge's own saved list and how many photos the
 * join would actually use. Read from the settings; the only thing that can reach GuruShots is
 * the signed-in member's identity lookup (below), which is cached per token.
 */

import * as settings from '../../settings';
import * as logger from '../../logger';
import * as apiFactory from '../../apiFactory';
import { peekMemberId, resolveMemberId } from '../../services/autoFill';
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
 * (`chosenEffectiveCount: 0`), as at join time. The signed-in member is the one a
 * cached lookup already resolved (`peekMemberId`); only when none has — a fresh launch —
 * is it resolved first (`resolveMemberId`: one lookup per token, retried at most every
 * 60 s after a failure), so the common case makes no request. If the lookup fails the
 * member stays unknown, it cannot be told whether the list is theirs, and the ids are
 * withheld all the same — but the list still counts as applying, as resolveChosenPhotos
 * applies it at join time.
 */
const chosenAnnotator = async (token: string): Promise<(challenge: Partial<Challenge>) => ChosenAnnotation> => {
    const savedBy = settings.getSetting('chosenPhotosMemberId');
    let current = peekMemberId(token);
    if (current === null && token) {
        current = await resolveMemberId(token, apiFactory.getApiStrategy().getCurrentMemberProfile, logger, 'join');
    }
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
const annotateOpenIds = async (
    ids: ReadonlyArray<string | number>,
    token: string,
): Promise<Record<string, ChosenAnnotation>> => {
    const annotate = await chosenAnnotator(token);
    return Object.fromEntries(ids.map((id) => [String(id), annotate(getOpenChallenge(id) ?? { id })] as const));
};

export { chosenAnnotator, annotateOpenIds, MAX_ANNOTATED_IDS };
