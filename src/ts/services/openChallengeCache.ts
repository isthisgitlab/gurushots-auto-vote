/**
 * The challenges Discover last listed — the open ones and the upcoming ones it showed, merged —
 * by id, kept in memory for the settings-only reads that need a challenge's title and tags
 * (a rule may be keyed on them) without asking GuruShots again. It belongs to the
 * signed-in account, so logging out empties it (see clearAuthToken).
 */

import type { DiscoverChallenge } from '../types/gurushots';

let openChallenges: Map<string, DiscoverChallenge> = new Map();

/** Remember the merged list a fetch returned (replacing the previous one). */
const rememberOpenChallenges = (items: ReadonlyArray<DiscoverChallenge | null>): void => {
    openChallenges = new Map(items.flatMap((item) => (item?.id == null ? [] : [[String(item.id), item] as const])));
};

/** The remembered challenge with this id, if the latest list held it. */
const getOpenChallenge = (id: string | number): DiscoverChallenge | undefined => openChallenges.get(String(id));

/** Forget every remembered open challenge. */
const clearOpenChallenges = (): void => {
    openChallenges = new Map();
};

export { rememberOpenChallenges, getOpenChallenge, clearOpenChallenges };
