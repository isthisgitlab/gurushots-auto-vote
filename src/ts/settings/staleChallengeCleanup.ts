/**
 * Pruning of the stored records of challenges that no longer exist.
 */

import * as logger from '../logger';
import { loadSettings, saveSettings } from './persistence';
import { getOpenChallengeIds, getUpcomingChallengeIds } from './openChallenges';
import { getActiveChallengeIds } from './challengeFacts';

import type { ChallengeValues } from '../types/settings';

// The keys a not-yet-joined challenge needs its own override for: the join has
// to know which photo to enter with, and whether it may enter one at all, before
// the challenge is in the active list.
const JOIN_KEPT_KEYS = ['chosenPhotos', 'chosenPhotosOnly', 'chosenPhotosInOrder', 'manualPhotosOnly'];

/**
 * Whether a non-active override entry must survive cleanup: it holds a chosen
 * photos key and its challenge is still joinable (in the most recent open
 * list) or will be (in the most recent upcoming list, which Discover fetches). While either list
 * is unknown (after a restart, or a failed fetch) every entry is kept: a manual Join in
 * Discover reads the per-id list whether or not auto-join is on, and a join pass that has seen
 * the open list alone cannot tell an upcoming challenge's entry from a stale one, so it is not
 * stale until the lists show the challenge is gone.
 */
const isKeptForJoin = (challengeId: string, values: ChallengeValues | undefined): boolean => {
    if (!values || !JOIN_KEPT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(values, key))) return false;
    const open = getOpenChallengeIds();
    const upcoming = getUpcomingChallengeIds();
    return open === null || upcoming === null || open.has(challengeId) || upcoming.has(challengeId);
};

/**
 * Cleanup stale challenge settings for challenges that no longer exist.
 * A challenge that is open but not joined yet is not stale when its entry
 * holds a chosen photos setting (see isKeptForJoin).
 *
 * `activeChallengeIds` comes from the caller — over IPC, the renderer — so it cannot be the only
 * judge of what to delete. An entry is pruned only when the main process's own latest active list
 * (getActiveChallengeIds) agrees it is gone, so a short, stale or forged list cannot wipe a live
 * challenge's settings; with no such list yet, nothing is pruned. The limit that remains: the
 * main process's list is the last one it fetched, so an entry for a challenge that ended since
 * stays until the next fetch.
 */
const cleanupStaleChallengeSetting = (activeChallengeIds: Iterable<string>): boolean => {
    const known = getActiveChallengeIds();
    if (known === null) return true; // The main process has no list of its own to judge by
    const settings = loadSettings();
    const activeIds = new Set([...activeChallengeIds, ...known]);
    const { challenges } = settings;
    const staleChallengeIds = Object.keys(challenges).filter(
        (id) => !activeIds.has(id) && !isKeptForJoin(id, challenges[id].values),
    );

    if (staleChallengeIds.length === 0) {
        return true; // Nothing to cleanup
    }

    logger
        .withCategory('settings')
        .debug(`Cleaning up settings for ${staleChallengeIds.length} stale challenges:`, staleChallengeIds);

    staleChallengeIds.forEach((challengeId) => {
        delete challenges[challengeId];
    });

    return saveSettings(settings);
};

export { JOIN_KEPT_KEYS, cleanupStaleChallengeSetting };
