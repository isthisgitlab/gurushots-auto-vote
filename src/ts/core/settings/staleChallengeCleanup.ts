/**
 * Pruning of the stored records of challenges that no longer exist.
 */

import * as logger from '../logger';
import { loadSettings, saveSettings } from './persistence';
import { getOpenChallengeIds, getUpcomingChallengeIds } from './openChallenges';
import { getActiveChallengeIds } from './challengeFacts';
import { scenarioStateLedger } from '../scenarioStateStore';
import { isolateWhileSimulating } from '../simulationScope';
import { unresolvedWork } from './scenarioMutationGate';
import { getScenario } from './scenarios';
import { DEFAULT_STAGES } from '../scenarios/vocabulary';

import type { ChallengeValues } from '../types/settings';
import type { ScenarioState } from '../types/stores';

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
const isKeptForJoin = (challengeId: string, values: ChallengeValues | undefined): boolean =>
    !!values &&
    JOIN_KEPT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(values, key)) &&
    isJoinable(challengeId);

/**
 * Whether a challenge is, or may still be, joinable: in the most recent open or upcoming list, or either list unknown.
 */
const isJoinable = (challengeId: string): boolean => {
    const open = getOpenChallengeIds();
    const upcoming = getUpcomingChallengeIds();
    return open === null || upcoming === null || open.has(challengeId) || upcoming.has(challengeId);
};

// How long a closed challenge's assignment is kept for post-close work that the completed listing never settled, counted
// from the last time it was seen active (its close time is not kept once it leaves the active list). After it the entry is
// pruned like any other stale one, unless something is unresolved on it (see keepsPostClose). Fourteen days outlasts the
// longest gap an app that is off or a claim that keeps failing is likely to have, and bounds what a challenge the listing
// never shows can hold.
const POST_CLOSE_RETENTION_DAYS = 14;
const POST_CLOSE_RETENTION_SEC = POST_CLOSE_RETENTION_DAYS * 24 * 3600;

/**
 * What the last complete post-close pass found, for the completed listing it read: every challenge in it, and those with
 * no post-close work left, each with the scenario it was settled under (so a changed assignment is not read as settled).
 */
type PostCloseListing = { listed: ReadonlySet<string>; settled: ReadonlyMap<string, string> };

let postCloseListing: PostCloseListing | null = null;

isolateWhileSimulating(() => {
    const saved = postCloseListing;
    return () => {
        postCloseListing = saved;
    };
});

/**
 * Remembers what a complete post-close pass found, or (null) forgets it: a pass that did not complete (cancelled, a failed
 * read, no post-close stage in use) leaves nothing to go by, and so does one that is no longer current. The pass replaces
 * the whole record each time; nothing is carried from an earlier listing.
 *
 * @param listing.settled - [challenge id, lowercase scenario name] of the challenges with no post-close work left
 */
const rememberPostCloseListing = (
    listing: { listed: Iterable<string>; settled: Iterable<[string, string]> } | null,
): void => {
    postCloseListing = listing && { listed: new Set(listing.listed), settled: new Map(listing.settled) };
};

/**
 * When a closed challenge was last seen active. Its close time is not at hand: the facts of an active challenge go with the
 * active list that carried them, and cleanup only looks at challenges that are no longer in it. What outlives it is the
 * progress: the last vote sample, else the last write, else the phase entry.
 */
const lastSeenActive = (state: ScenarioState): number => {
    const sampled = Object.values(state.history ?? {})
        .flat()
        .reduce((latest, [at]) => Math.max(latest, at), 0);
    if (sampled > 0) return sampled;
    return state.updatedAt === undefined ? state.phaseEnteredAt : Math.floor(state.updatedAt / 1000);
};

/**
 * Whether a closed challenge's post-close retention goes on. Never released while anything is unresolved on its progress
 * (a pending or unclear spend, a rule in progress, a handoff intent) or while that progress cannot be read. Otherwise
 * released when the completed listing found nothing left for it under the scenario it has now, or when it is not in the
 * completed listing and was last seen active more than POST_CLOSE_RETENTION_DAYS ago. One that is in the listing
 * with work left, or whose listing is not known, is kept.
 */
const keepsPostClose = (challengeId: string, scenarioName: string): boolean => {
    const { corrupt, state } = scenarioStateLedger.get(challengeId);
    if (corrupt || (state && unresolvedWork(state))) return true;
    const release = (why: string) => {
        logger
            .withCategory('settings')
            .info(`released the post-close assignment of challenge ${challengeId}: ${why}`, null);
        return false;
    };
    if (postCloseListing?.settled.get(challengeId) === scenarioName.toLowerCase()) {
        return release('the completed listing shows nothing left to do');
    }
    if (!postCloseListing || postCloseListing.listed.has(challengeId) || !state) return true;
    const reference = lastSeenActive(state);
    if (Math.floor(Date.now() / 1000) - reference <= POST_CLOSE_RETENTION_SEC) return true;
    return release(
        `it is not in the completed listing and was last seen active more than ${POST_CLOSE_RETENTION_DAYS} days ago`,
    );
};

/**
 * Whether a non-active entry holds the assignment of a scenario that still has work for the challenge: a pre-join rule while
 * it can be joined (as for chosen photos), a post-close rule until the closed challenge is found settled or the retention
 * runs out (keepsPostClose). A challenge that merely left the active list is not settled.
 */
const isKeptForScenario = (challengeId: string, values: ChallengeValues | undefined): boolean => {
    const name = values?.scenario;
    const doc = typeof name === 'string' && name !== '' ? getScenario(name) : null;
    if (!doc || (doc.scope ?? 'challenge') !== 'challenge') return false;
    const defaults: readonly string[] = DEFAULT_STAGES.challenge;
    const stages = new Set(
        Object.values(doc.phases).flatMap((phase) => (phase.rules ?? []).flatMap((rule) => rule.stages ?? defaults)),
    );
    if (stages.has('preJoin') && isJoinable(challengeId)) return true;
    return stages.has('postClose') && keepsPostClose(challengeId, doc.name);
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
        (id) =>
            !activeIds.has(id) &&
            !isKeptForJoin(id, challenges[id].values) &&
            !isKeptForScenario(id, challenges[id].values),
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

export { JOIN_KEPT_KEYS, cleanupStaleChallengeSetting, rememberPostCloseListing };
