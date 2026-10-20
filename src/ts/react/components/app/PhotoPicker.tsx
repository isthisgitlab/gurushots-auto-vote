/**
 * The picker's controls, shared by the submit picker and the Chosen Photos chooser: the help line,
 * Search with Load all (nothing is read until one of them asks), Auto with its ranking and the
 * suggestions strip (only where `canSuggest`). `children` renders between the help lines and Auto's
 * status — the caller's count line — so every chooser keeps its live regions in the same order.
 */

import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import { interp } from '@/utils/interp';
import { suggestErrorText } from '@/api/ipcErrorText';
import { SuggestedStrip } from './SuggestedStrip';

import type { ReactNode } from 'react';
import type { usePhotoPicker } from '@/hooks/usePhotoPicker';
import type { LibraryPhoto } from '@/hooks/useLibraryListing';

/** The search box: submitting reads the listing again for the (trimmed) term. */
function SearchForm({ onSearch }: { onSearch: (term: string) => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    return (
        <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                onSearch(text.trim());
            }}
        >
            <input
                type="search"
                name="photo-search"
                className="input input-sm min-w-40 flex-1"
                autoComplete="off"
                spellcheck={false}
                enterKeyHint="search"
                aria-label={t('app.photoChooserSearchLabel')}
                placeholder={t('app.photoChooserSearchPlaceholder')}
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
            />
            <button type="submit" className="btn btn-outline btn-sm">
                {t('app.photoChooserSearch')}
            </button>
        </form>
    );
}

export function PhotoPickerToolbar({
    picker,
    selected,
    canSuggest,
    held,
    locked,
    lockedKey,
    fullKey,
    helpKey,
    autoHelpKey,
    autoRunningKey,
    atCap,
    addPolicy,
    onAdd,
    onToggle,
    children,
}: {
    picker: ReturnType<typeof usePhotoPicker>;
    selected: string[];
    /** Whether Auto can rank here; without it the button, its help and the strip are not shown. */
    canSuggest: boolean;
    /** Load all is held too (a submit is in flight). */
    held: boolean;
    /** The strip's tiles and Add suggestions are held (the app is checking eligibility, or the saved list is unread). */
    locked: boolean;
    /** The translation key of what a locked strip tile says. */
    lockedKey: string;
    /** The translation key of what a tile says when the selection is full. */
    fullKey: string;
    /** The translation key of the picker's help line. */
    helpKey: string;
    /** The translation key of the line under the buttons that explains Auto. */
    autoHelpKey: string;
    /** The translation key of what the status line says while Auto ranks. */
    autoRunningKey: string;
    /** The selection is full: the tiles not picked are offered no more. */
    atCap: boolean;
    /** How Add suggestions fills: swapping into the one open slot, or appending up to the cap. */
    addPolicy: 'swap-one' | 'append';
    onAdd: (photos: LibraryPhoto[]) => void;
    onToggle: (id: string) => void;
    children?: ReactNode;
}) {
    const { t } = useTranslation();
    const reading = picker.state.status === 'loading' || picker.revalidating;
    const loadAllHeld = reading || held;
    const loadAllBusy = reading && picker.loadAllReading;
    // Once a set has been shown, the button pages on to the next-best ones.
    const autoKey = picker.shownIds.length > 0 ? 'app.pickAutoNext' : 'app.pickAuto';
    let autoStatus = '';
    if (picker.suggesting) autoStatus = t(autoRunningKey);
    else if (picker.suggested)
        autoStatus = interp(t('app.pickSuggestedCount'), { count: picker.suggested.photos.length });
    // Add suggestions has nothing to do when every suggestion is picked already; with one slot it swaps
    // in #1, so it has nothing to do only when #1 is the whole pick.
    const nothingToAdd =
        picker.suggested !== null &&
        (addPolicy === 'swap-one'
            ? selected.length === 1 && selected[0] === picker.suggested.photos[0]?.id
            : picker.suggested.photos.every((photo) => selected.includes(photo.id)));
    const suggested = picker.suggested;
    return (
        <>
            <p className="text-base-content/70 text-xs">{t(helpKey)}</p>
            <div className="space-y-1">
                <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-48 flex-1">
                        <SearchForm key={picker.searchKey} onSearch={picker.search} />
                    </div>
                    <button
                        type="button"
                        className={`btn btn-outline btn-sm ${loadAllHeld ? 'btn-disabled' : ''}`}
                        // aria-disabled, not disabled: a disabled button drops the keyboard focus to <body>.
                        aria-disabled={loadAllHeld}
                        aria-busy={loadAllBusy}
                        onClick={() => {
                            if (loadAllHeld) return;
                            picker.loadAll();
                        }}
                    >
                        <BusyContent busy={loadAllBusy} label={t('app.pickLoadAll')}>
                            {t('app.pickLoadAll')}
                        </BusyContent>
                    </button>
                    {canSuggest && (
                        <button
                            type="button"
                            className={`btn btn-sm ${picker.suggesting ? 'btn-disabled' : ''}`}
                            // aria-disabled, not disabled: a disabled button drops the keyboard focus to <body>.
                            aria-disabled={picker.suggesting}
                            aria-busy={picker.suggesting}
                            onClick={() => {
                                if (!picker.suggesting) void picker.autoSuggest();
                            }}
                        >
                            <BusyContent busy={picker.suggesting} label={t(autoKey)}>
                                {t(autoKey)}
                            </BusyContent>
                        </button>
                    )}
                </div>
                {canSuggest && <p className="text-base-content/70 text-xs">{t(autoHelpKey)}</p>}
            </div>
            {children}
            {canSuggest && (
                <>
                    {/* Always mounted, so a screen reader announces the text that arrives in it. The count of a
                        finished ranking is read out only: the strip shows it. */}
                    <p
                        role="status"
                        aria-live="polite"
                        className={picker.suggesting || !suggested ? 'text-xs' : 'sr-only'}
                    >
                        {autoStatus}
                    </p>
                    {picker.suggestFailure && (
                        <div role="alert" className="alert alert-error py-2 text-sm">
                            <span>{suggestErrorText(picker.suggestFailure, t)}</span>
                        </div>
                    )}
                    {suggested && (
                        <SuggestedStrip
                            photos={suggested.photos}
                            rankOffset={suggested.rankOffset}
                            memberId={suggested.memberId}
                            statsLimited={suggested.statsLimited}
                            selected={selected}
                            atCap={atCap}
                            fullKey={fullKey}
                            locked={locked}
                            lockedKey={lockedKey}
                            addDisabled={locked || atCap || nothingToAdd}
                            onToggle={onToggle}
                            onAdd={() => onAdd(suggested.photos)}
                        />
                    )}
                </>
            )}
        </>
    );
}
