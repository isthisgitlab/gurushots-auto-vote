/**
 * The loaded-photo sorts behind the picker toolbar's "Then sort loaded photos by": they reorder the
 * photos the listing has loaded, from the per-photo stats the Show-stats loader read — no server
 * sort exists for them. `library` is the server's own order and reorders nothing.
 */

import type { LoadedSort } from '../../librarySort';
import type { TileStats } from '@/hooks/usePhotoStatsLoader';

/** Which bucket a photo falls into: 0 a real value, 1 known but unrankable (a ratio with no views), 2 unknown. */
const tierOf = (stat: TileStats | undefined, sortBy: 'ratio' | 'likes' | 'guruPicks'): number => {
    if (!stat) return 2;
    if (sortBy !== 'ratio') return 0;
    return stat.views > 0 ? 0 : 1;
};

const valueOf = (stat: TileStats, sortBy: 'ratio' | 'likes' | 'guruPicks'): number =>
    sortBy === 'ratio' ? stat.votes / stat.views : sortBy === 'likes' ? stat.likes : stat.guruPicks;

/**
 * The loaded photos reordered by one of the stats sorts: known values descending, a ratio with no
 * views after every real ratio, photos without stats last — ties, and everything in the unrankable
 * and unknown buckets, keep the listing's order, which Array.prototype.sort's stability preserves.
 */
export const reorderLoadedPhotos = <P extends { id: string }>(
    photos: P[],
    sortBy: LoadedSort,
    stats: ReadonlyMap<string, TileStats>,
): P[] => {
    if (sortBy === 'library') return photos;
    const keyOf = (photo: P): { tier: number; value: number } => {
        const stat = stats.get(photo.id);
        return { tier: tierOf(stat, sortBy), value: stat ? valueOf(stat, sortBy) : 0 };
    };
    return [...photos].sort((a, b) => {
        const ka = keyOf(a);
        const kb = keyOf(b);
        return ka.tier !== kb.tier ? ka.tier - kb.tier : kb.value - ka.value;
    });
};
