import { useId } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ToneNote } from '@/components/ui/ToneNote';
import { PhotoTile } from './PhotoTile';

import type { LibraryPhoto } from '@/hooks/useLibraryListing';

/**
 * The photos Auto ranked, best first, each with its fixed rank. A tap picks or un-picks one like a tile of the
 * listing; "Add suggestions" fills the free slots with the best ones not picked yet.
 */
export function SuggestedStrip({
    photos,
    rankOffset,
    memberId,
    statsLimited,
    selected,
    atCap,
    fullKey,
    locked,
    lockedKey,
    addDisabled,
    onToggle,
    onAdd,
}: {
    photos: LibraryPhoto[];
    /** How many photos earlier sets named: the first tile here ranks one past it. */
    rankOffset: number;
    memberId: string | null;
    /** The popularity stats could not all be read, so the ranking leans on tags and the image check. */
    statsLimited: boolean;
    selected: string[];
    /** The selection is full: the tiles not picked are offered no more. */
    atCap: boolean;
    /** The translation key of what a tile says when the selection is full. */
    fullKey: string;
    /** The tiles are inert: the app is still checking which photos the challenge accepts, or a submit is running. */
    locked: boolean;
    /** The translation key of what a locked tile says. */
    lockedKey: string;
    /** "Add suggestions" cannot be pressed now (a submit is running, or nothing can be added). */
    addDisabled: boolean;
    onToggle: (id: string) => void;
    onAdd: () => void;
}) {
    const { t } = useTranslation();
    const headingId = useId();
    const chosen = new Set(selected);
    return (
        <section aria-labelledby={headingId} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={headingId} className="text-sm font-semibold">
                    {t('app.pickSuggestedTitle')}
                </h3>
                <button type="button" className="btn btn-outline btn-sm" disabled={addDisabled} onClick={onAdd}>
                    {t(atCap ? 'app.pickAddSuggestionsFull' : 'app.pickAddSuggestions')}
                </button>
            </div>
            <p className="text-xs" aria-hidden="true">
                {t('app.pickSuggestedCount', { count: photos.length })}
            </p>
            {statsLimited && (
                <ToneNote tone="warning" className="text-xs">
                    {t('app.pickSuggestedStatsLimited')}
                </ToneNote>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
                {photos.map((photo, index) => (
                    <PhotoTile
                        key={photo.id}
                        photo={photo}
                        memberId={memberId}
                        selected={chosen.has(photo.id)}
                        position={null}
                        rank={rankOffset + index + 1}
                        blockedReason={null}
                        atCap={atCap}
                        fullKey={fullKey}
                        allowedKnown={false}
                        locked={locked}
                        lockedKey={lockedKey}
                        onToggle={onToggle}
                    />
                ))}
            </div>
        </section>
    );
}
