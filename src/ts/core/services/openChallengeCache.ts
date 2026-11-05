/**
 * The challenges Discover last listed — the open ones and the upcoming ones it showed, merged —
 * by id, kept in memory for the settings-only reads that need a challenge's title and tags
 * (a rule may be keyed on them) without asking GuruShots again. It belongs to the
 * signed-in account, so logging out empties it (see clearAuthToken).
 */

import type { DiscoverChallenge } from '../types/gurushots';

let openChallenges: Map<string, DiscoverChallenge> = new Map();

/**
 * Remember the merged list a fetch returned (replacing the previous one). The ids in `keep` stay
 * as they were when the new list lacks them: a challenge that has just started leaves the
 * upcoming feed before the open one lists it, and its title and tags must still resolve rules.
 */
const rememberOpenChallenges = (items: ReadonlyArray<DiscoverChallenge | null>, keep: Iterable<string> = []): void => {
    const kept = Array.from(keep, (id): readonly [string, DiscoverChallenge | undefined] => [
        id,
        openChallenges.get(id),
    ]);
    const fresh = items.flatMap((item) => (item?.id == null ? [] : [[String(item.id), item] as const]));
    const carried = kept.flatMap(([id, item]) => (item === undefined ? [] : [[id, item] as const]));
    openChallenges = new Map([...carried, ...fresh]);
};

/** The remembered challenge with this id, if the latest list held it. */
const getOpenChallenge = (id: string | number): DiscoverChallenge | undefined => openChallenges.get(String(id));

/** Forget every remembered open challenge. */
const clearOpenChallenges = (): void => {
    openChallenges = new Map();
};

export { rememberOpenChallenges, getOpenChallenge, clearOpenChallenges };
