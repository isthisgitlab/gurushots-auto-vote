/**
 * The open (not yet joined) challenges the latest list fetch returned, by id, kept
 * in memory for the settings-only reads that need a challenge's title and tags
 * (a rule may be keyed on them) without asking GuruShots again. It belongs to the
 * signed-in account, so logging out empties it (see clearAuthToken).
 */

import type { Challenge } from '../types/gurushots';

let openChallenges: Map<string, Challenge> = new Map();

/** Remember the open list a fetch returned (replacing the previous one). */
const rememberOpenChallenges = (items: ReadonlyArray<Challenge | null>): void => {
    openChallenges = new Map(items.flatMap((item) => (item?.id == null ? [] : [[String(item.id), item] as const])));
};

/** The remembered open challenge with this id, if the latest list held it. */
const getOpenChallenge = (id: string | number): Challenge | undefined => openChallenges.get(String(id));

/** Forget every remembered open challenge. */
const clearOpenChallenges = (): void => {
    openChallenges = new Map();
};

export { rememberOpenChallenges, getOpenChallenge, clearOpenChallenges };
