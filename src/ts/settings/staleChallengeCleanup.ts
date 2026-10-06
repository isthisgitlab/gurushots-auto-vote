/**
 * Pruning of per-challenge settings for challenges that no longer exist.
 */

import * as logger from '../logger';
import { loadSettings, saveSettings } from './persistence';
import { getOpenChallengeIds } from './openChallenges';

import type { ChallengeValues } from '../types/settings';

// The keys a not-yet-joined challenge needs its own override for: the join has
// to know which photo to enter with before the challenge is in the active list.
const JOIN_KEPT_KEYS = ['chosenPhotos', 'chosenPhotosOnly'];

/**
 * Whether a non-active override entry must survive cleanup: it holds a chosen
 * photos key and its challenge is still joinable (in the most recent open
 * list). While no open list is known the entry is kept only when a join could
 * run (`joinMayRun`), since otherwise nothing would ever use it.
 */
const isKeptForJoin = (challengeId: string, values: ChallengeValues, joinMayRun: boolean): boolean => {
    if (!JOIN_KEPT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(values, key))) return false;
    const open = getOpenChallengeIds();
    return open === null ? joinMayRun : open.has(challengeId);
};

/**
 * Cleanup stale challenge settings for challenges that no longer exist.
 * A challenge that is open but not joined yet is not stale when its entry
 * holds a chosen photos setting (see isKeptForJoin).
 *
 * @param joinMayRun - whether an automatic join could run (master auto-join on,
 *   or a title rule enabling it); the caller knows, the settings layer does not
 */
const cleanupStaleChallengeSetting = (activeChallengeIds: Iterable<string>, joinMayRun: boolean = false): boolean => {
    const settings = loadSettings();
    const activeIds = new Set(activeChallengeIds);
    const { perChallenge, titleProfileSuppressions: suppressions } = settings.challengeSettings;
    const keptForJoin = new Set(
        Object.keys(perChallenge).filter((id) => !activeIds.has(id) && isKeptForJoin(id, perChallenge[id], joinMayRun)),
    );
    const staleChallengeIds = Object.keys(perChallenge).filter((id) => !activeIds.has(id) && !keptForJoin.has(id));
    const staleSuppressionIds = Object.keys(suppressions).filter((id) => !activeIds.has(id) && !keptForJoin.has(id));

    if (staleChallengeIds.length === 0 && staleSuppressionIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger
        .withCategory('settings')
        .debug(`Cleaning up settings for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);

    staleChallengeIds.forEach((challengeId) => {
        delete perChallenge[challengeId];
    });
    staleSuppressionIds.forEach((challengeId) => {
        delete suppressions[challengeId];
    });

    return saveSettings(settings);
};

export { JOIN_KEPT_KEYS, cleanupStaleChallengeSetting };
