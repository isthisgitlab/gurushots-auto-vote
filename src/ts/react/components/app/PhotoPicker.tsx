/**
 * The picker's controls, shared by the submit picker and the Chosen Photos chooser: the help line,
 * Search with Load photos (nothing is read until one of them asks), the library order and
 * loaded-photo sort selects with Show stats (the picker hook's session state), Auto with its ranking
 * and the suggestions strip (only where `canSuggest`). `children` renders between the help lines and
 * Auto's status — the caller's count line — so every chooser keeps its live regions in the same order.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import { suggestErrorText } from '@/api/ipcErrorText';
import { useTagSuggestions } from '@/api/useTagSuggestions';
import { LIBRARY_ORDERS, LOADED_SORTS, isLibraryOrder, isLoadedSort } from '../../../librarySort';
import { MIN_AUTOCOMPLETE_CHARS } from '../../../settings/limits';
import { suggestedTags } from '../../../tagSuggestions';
import { SuggestedStrip } from './SuggestedStrip';

import type { ReactNode } from 'react';
import type { LibraryOrder, LoadedSort } from '../../../librarySort';
import type { usePhotoPicker } from '@/hooks/usePhotoPicker';
import type { LibraryPhoto } from '@/hooks/useLibraryListing';

/** The Order select's options, named from the one list of orders the backend reads too. */
const ORDER_NAME_KEYS: Record<LibraryOrder, string> = {
    votes: 'app.pickOrderVotes',
    newest: 'app.pickOrderNewest',
    oldest: 'app.pickOrderOldest',
};

/** The loaded-photo sort select's options, named from the one list of sorts. */
const SORT_NAME_KEYS: Record<LoadedSort, string> = {
    library: 'app.pickSortLibrary',
    ratio: 'app.pickSortRatio',
    likes: 'app.pickSortLikes',
    guruPicks: 'app.pickSortGuruPicks',
};

/**
 * The search box: submitting reads the listing again for the (trimmed) term. Below the box,
 * the library's tags that contain the typed text (3+ characters, debounced) are offered as
 * one-click exact searches — the endpoint matches a tag exactly, so a partial term finds
 * nothing on its own.
 */
function SearchForm({ onSearch }: { onSearch: (term: string) => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const { tags, replied } = useTagSuggestions(text);
    const trimmed = text.trim();
    const enough = trimmed.length >= MIN_AUTOCOMPLETE_CHARS;
    // The live line empties only below the minimum or on a current reply with no tags, and
    // fills only when a current reply has tags and the line is empty — so typing on from
    // "flo" to "flow" never re-announces it, and the per-keystroke clear does not touch it.
    const [liveFilled, setLiveFilled] = useState(false);
    useEffect(() => {
        if (!enough) setLiveFilled(false);
        else if (replied) setLiveFilled(tags.length > 0);
    }, [enough, replied, tags.length]);
    // A tag equal to the text (trimmed, case-insensitive) is hidden: pressing it would
    // re-run the search already in the box.
    const shownTags = suggestedTags(tags, trimmed);
    return (
        <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                onSearch(trimmed);
            }}
        >
            <input
                ref={inputRef}
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
            {enough && (
                // Always rendered while the text is long enough (even before a reply), with a
                // one-row minimum height, so the row keeps its height and the grid does not
                // jump on every keystroke. The label shows only with buttons: a bare "Matching
                // tags" above nothing is misleading.
                <div
                    role="group"
                    aria-label={t('app.photoChooserTagMatches')}
                    className="flex min-h-8 w-full flex-wrap items-center gap-2"
                >
                    {shownTags.length > 0 && (
                        <span className="text-base-content/70 text-xs">{t('app.photoChooserTagMatches')}</span>
                    )}
                    {shownTags.map((tag) => (
                        // type="button": the click must not also submit the partial text.
                        <button
                            key={tag}
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => {
                                setText(tag);
                                onSearch(tag);
                                // Back to the box, so focus never falls to <body> in the modal.
                                inputRef.current?.focus();
                            }}
                        >
                            {tag}
                        </button>
                    ))}
                </div>
            )}
            {/* Always mounted, so a screen reader announces the text that arrives in it. */}
            <p aria-live="polite" className="sr-only">
                {liveFilled ? t('app.photoChooserTagMatchesFound') : ''}
            </p>
        </form>
    );
}

/**
 * The toolbar's Order and loaded-photo sort selects with Show stats, the loaded-sort help line, the
 * stats status region and the missed-stats warning. All session state: it lives in the picker hook,
 * so every opening starts from Votes, Library order and Show stats off. The status region is this
 * toolbar's own (always mounted), because Auto's is not mounted where it cannot suggest.
 */
function PickerStatsControls({ picker }: { picker: ReturnType<typeof usePhotoPicker> }) {
    const { t } = useTranslation();
    const orderId = useId();
    const sortId = useId();
    const lockReasonId = useId();
    const { order, setOrder, sortBy, setSortBy, showStats, setShowStats } = picker;
    const sortNeedsStats = sortBy !== 'library';
    let status = '';
    if (showStats) {
        if (picker.statsProgress)
            status = t('app.pickStatsReading', {
                done: picker.statsProgress.done,
                total: picker.statsProgress.total,
            });
        else if (picker.statsRead) status = t(sortNeedsStats ? 'app.pickStatsReordered' : 'app.pickStatsRead');
    }
    const loadedCount = picker.state.status === 'ready' ? picker.state.listing.photos.length : 0;
    // The grid reports the tiles it shows (shownCount); before it reports, the loaded
    // count stands in. The line names what the sort reorders: the tiles on screen.
    const shownCount = picker.shownCount ?? loadedCount;
    return (
        <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                    <label htmlFor={orderId} className="text-xs">
                        {t('app.pickOrderLabel')}
                    </label>
                    <select
                        id={orderId}
                        className="select select-sm"
                        value={order}
                        onChange={(event) => {
                            const next = event.currentTarget.value;
                            if (isLibraryOrder(next)) setOrder(next);
                        }}
                    >
                        {(Object.keys(LIBRARY_ORDERS) as LibraryOrder[]).map((name) => (
                            <option key={name} value={name}>
                                {t(ORDER_NAME_KEYS[name])}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="flex items-center gap-2">
                    <label htmlFor={sortId} className="text-xs">
                        {t('app.pickSortLabel')}
                    </label>
                    <select
                        id={sortId}
                        className="select select-sm"
                        value={sortBy}
                        onChange={(event) => {
                            const next = event.currentTarget.value;
                            if (isLoadedSort(next)) setSortBy(next);
                        }}
                    >
                        {LOADED_SORTS.map((sort) => (
                            <option key={sort} value={sort}>
                                {t(SORT_NAME_KEYS[sort])}
                            </option>
                        ))}
                    </select>
                </div>
                <label className="flex items-center gap-2 text-xs">
                    <input
                        type="checkbox"
                        className={`checkbox checkbox-sm ${sortNeedsStats ? 'opacity-50 cursor-not-allowed' : ''}`}
                        checked={showStats}
                        aria-disabled={sortNeedsStats}
                        aria-describedby={sortNeedsStats ? lockReasonId : undefined}
                        onClick={(event) => {
                            if (sortNeedsStats) event.preventDefault();
                        }}
                        onChange={() => {
                            // A locked box's click is default-prevented above, so no change event
                            // follows it in a real browser or under happy-dom; the guard is a
                            // second belt against a hand-dispatched event.
                            /* istanbul ignore else */
                            if (!sortNeedsStats) setShowStats(!showStats);
                        }}
                    />
                    {t('app.pickShowStats')}
                </label>
                {sortNeedsStats && (
                    <span id={lockReasonId} className="text-xs text-base-content/70">
                        {t('app.pickShowStatsLocked')}
                    </span>
                )}
            </div>
            <p className="text-base-content/70 text-xs">{t('app.pickShowStatsHelp')}</p>
            {/* The {order} names the order the loaded photos were READ in (the listing's own tag),
            not the select's value: a switched order does not re-word the line until the new
            listing lands. */}
            {sortNeedsStats && picker.state.status === 'ready' && (
                <p className="text-base-content/70 text-xs">
                    {t('app.pickLoadedSortHelp', {
                        count: shownCount,
                        order: t(ORDER_NAME_KEYS[picker.state.order]),
                    })}
                </p>
            )}
            {picker.showStats && picker.statsMissing.length > 0 && (
                <div role="alert" className="alert alert-warning py-2 text-sm">
                    <div className="flex-1">
                        <p>
                            {t(sortNeedsStats ? 'app.pickStatsMissingSorted' : 'app.pickStatsMissing', {
                                count: picker.statsMissing.length,
                            })}
                        </p>
                    </div>
                    <button type="button" className="btn btn-sm" onClick={picker.retryStats}>
                        {t('app.photoChooserRetry')}
                    </button>
                </div>
            )}
            {/* Always mounted, so a screen reader announces the text that arrives in it. */}
            <p aria-live="polite" className={status ? 'text-xs' : 'sr-only'}>
                {status}
            </p>
        </>
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
    /** Load photos is held too (a submit is in flight). */
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
    // A batch read of the grid's own holds Load photos too, so two reads never run at once.
    const loadPhotosHeld = reading || held || picker.loadingMore;
    const loadPhotosBusy = reading && picker.loadPhotosReading;
    // Once a set has been shown, the button pages on to the next-best ones.
    const autoKey = picker.shownIds.length > 0 ? 'app.pickAutoNext' : 'app.pickAuto';
    let autoStatus = '';
    if (picker.suggesting) autoStatus = t(autoRunningKey);
    else if (picker.suggested) autoStatus = t('app.pickSuggestedCount', { count: picker.suggested.photos.length });
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
                        className={`btn btn-outline btn-sm ${loadPhotosHeld ? 'btn-disabled' : ''}`}
                        // aria-disabled, not disabled: a disabled button drops the keyboard focus to <body>.
                        aria-disabled={loadPhotosHeld}
                        aria-busy={loadPhotosBusy}
                        onClick={() => {
                            if (loadPhotosHeld) return;
                            picker.loadPhotos();
                        }}
                    >
                        <BusyContent busy={loadPhotosBusy} label={t('app.pickLoadPhotos')}>
                            {t('app.pickLoadPhotos')}
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
                <PickerStatsControls picker={picker} />
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
