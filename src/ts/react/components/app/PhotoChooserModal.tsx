import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal } from '@/components/ui/Modal';
import { StickyModalFooter } from '@/components/ui/StickyModalFooter';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { useImageLoads } from '@/hooks/useImageLoads';
import { buildPhotoUrl } from '@/utils/formatters';
import { interp } from '@/utils/interp';
import { ipcErrorText } from '@/api/ipcErrorText';
import { useChosenPhotosOwner } from '@/api/useChosenPhotosOwner';
import { ChooserFooter, SearchForm, holdReasonOf } from './ChooserFooter';
import { ListingHeader } from './ListingHeader';
import { OtherAccountNotice } from './OtherAccountNotice';
import { useChooserSave, useOtherAccountLists, useSavedListReread } from '@/hooks/usePhotoChooser';
import { useLibraryListing } from '@/hooks/useLibraryListing';
import * as ipc from '@/api/ipc';
import { MAX_CHOSEN_PHOTOS } from '../../../settings/limits';

import type { AccountCheck } from '@/hooks/usePhotoChooser';
import type { LibraryPhoto, ListState } from '@/hooks/useLibraryListing';

// Edge length requested from the photo CDN for a tile (the grid shows them ~150px wide).
const TILE_PX = 240;

// Characters of a photo id shown on a tile — enough to tell tiles apart.
const SHORT_ID_LENGTH = 8;

const shortId = (id: string): string => id.slice(0, SHORT_ID_LENGTH);

/**
 * What a tile says about the photo: its tags, or the id's start when it has none.
 */
const labelsOf = (photo: LibraryPhoto, noTags: string): string => photo.labels.join(', ') || noTags;

const TILE_BASE = 'rounded-box border p-1 text-left flex flex-col gap-1 w-full';

/**
 * The short text under a tile saying whether the photo can be added: the
 * challenge's refusal, "list full", or "can be entered" when the listing knows.
 */
const tileReason = ({
    locked,
    lockedKey,
    blockedReason,
    full,
    fullKey,
    allowedKnown,
    t,
}: {
    locked: boolean;
    lockedKey: string;
    blockedReason: string | null;
    full: boolean;
    fullKey: string;
    allowedKnown: boolean;
    t: (key: string) => string;
}): string | null => {
    // Nothing can be added yet, so the tile must not say it can be.
    if (locked) return t(lockedKey);
    if (blockedReason !== null) return blockedReason;
    if (full) return t(fullKey);
    return allowedKnown ? t('app.photoChooserAllowed') : null;
};

/**
 * One photo as a toggle button: its thumbnail (or, with no URL or one that does
 * not load, its tags and short id as text), the tags, and — when the listing
 * knows — whether the challenge accepts it, with the reason as text.
 * Server strings (tags, reason) are React text children only.
 */
/** A tile's name, with "Number 3 in your list." added after it when it is a selected one. */
const withPosition = (label: string, t: (key: string) => string, position: number | null): string => {
    if (position === null) return label;
    return `${label.replace(/[.!?]*$/, '.')} ${interp(t('app.photoChooserPosition'), { n: position })}`;
};

/** The visible number on a selected tile: the order the photos are saved in (named in the tile's label too). */
function PositionBadge({ position }: { position: number | null }) {
    return position === null ? null : (
        <span aria-hidden="true" className="badge badge-neutral badge-sm self-start">
            {position}
        </span>
    );
}

/** A tile's name with "Suggestion #3." added after it when it stands in the suggestions. */
const withRank = (label: string, t: (key: string) => string, rank: number | null): string =>
    rank === null ? label : `${label.replace(/[.!?]*$/, '.')} ${interp(t('app.pickSuggestionRank'), { n: rank })}.`;

/** The visible "#3" on a suggestion's tile: its rank, fixed whatever is picked. */
function RankBadge({ rank }: { rank: number | null }) {
    const { t } = useTranslation();
    return rank === null ? null : (
        <span
            role="img"
            aria-label={interp(t('app.pickSuggestionRank'), { n: rank })}
            className="badge badge-outline badge-sm self-start"
        >
            #{rank}
        </span>
    );
}

export function PhotoTile({
    photo,
    memberId,
    selected,
    position,
    rank = null,
    blockedReason,
    atCap,
    fullKey,
    allowedKnown,
    locked,
    lockedKey,
    onToggle,
}: {
    photo: LibraryPhoto;
    memberId: string | null;
    selected: boolean;
    /** Where the photo stands in the list (1-based), for a selected tile; null otherwise. */
    position: number | null;
    /** Where the photo stands in the suggestions (1-based), for a suggestion's tile; null otherwise. */
    rank?: number | null;
    blockedReason: string | null;
    atCap: boolean;
    /** The translation key of what a tile that cannot be added because the selection is full says. */
    fullKey: string;
    allowedKnown: boolean;
    locked: boolean;
    /** The translation key of what a locked tile says. */
    lockedKey: string;
    onToggle: (id: string) => void;
}) {
    const { t } = useTranslation();
    const url = memberId ? buildPhotoUrl(memberId, photo.id, { size: TILE_PX }) : null;
    const showImage = useImageLoads(url);
    const labels = labelsOf(photo, t('app.photoChooserNoTags'));
    // A photo that cannot be added (the challenge refuses it, or the list is full)
    // stays removable once selected. It is aria-disabled rather than disabled, so
    // Tab still reaches it and a screen reader can read why it cannot be added.
    const unavailable = locked || (!selected && (blockedReason !== null || atCap));
    const full = !selected && atCap;
    const reason = tileReason({ locked, lockedKey, blockedReason, full, fullKey, allowedKnown, t });
    // Only the picture and its tags are dimmed: the reason line stays at full contrast, since it is
    // what says why the tile cannot be added.
    const dim = unavailable ? 'opacity-50' : '';
    const tone = selected ? 'border-base-content' : 'border-base-300';
    return (
        <button
            type="button"
            aria-pressed={selected}
            aria-label={withRank(
                withPosition(
                    interp(t('app.photoChooserTileLabel'), {
                        id: shortId(photo.id),
                        labels,
                        reason: reason ?? '',
                    }).trim(),
                    t,
                    position,
                ),
                t,
                rank,
            )}
            aria-disabled={unavailable}
            className={`${TILE_BASE} ${tone}`}
            onClick={() => {
                if (!unavailable) onToggle(photo.id);
            }}
        >
            <PositionBadge position={position} />
            <RankBadge rank={rank} />
            {showImage ? (
                <img
                    src={url as string}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className={`aspect-square w-full rounded object-cover ${dim}`}
                />
            ) : (
                <span
                    className={`bg-base-200 flex aspect-square w-full items-center justify-center rounded p-1 text-center text-xs break-words ${dim}`}
                >
                    {labels}
                </span>
            )}
            <span className={`truncate text-xs ${dim}`}>{showImage ? labels : shortId(photo.id)}</span>
            {reason && (
                <span
                    className={`text-xs ${locked || full ? 'text-base-content/70' : blockedReason !== null ? 'text-error' : 'text-success'}`}
                >
                    {reason}
                </span>
            )}
        </button>
    );
}

/**
 * What a chosen photo the listing does not return most likely is. With a
 * challenge the usual cause is another challenge holding it; without one every
 * library photo is listed, so it was deleted. A cut-off listing adds that the
 * photo may lie beyond what was read.
 */
const missingKey = (hasChallenge: boolean, truncated: boolean): string =>
    hasChallenge
        ? truncated
            ? 'app.photoChooserMissingTruncated'
            : 'app.photoChooserMissing'
        : truncated
          ? 'app.photoChooserMissingNoChallengeTruncated'
          : 'app.photoChooserMissingNoChallenge';

/**
 * A chosen photo the listing does not return: still selected (and removable),
 * with the likely reasons it is missing.
 */
function MissingTile({
    id,
    position,
    count,
    hasChallenge,
    truncated,
    won,
    onToggle,
}: {
    id: string;
    position: number | null;
    count: number;
    hasChallenge: boolean;
    truncated: boolean;
    /** The listing left the photo out because it has won a challenge, which says why it is missing. */
    won: boolean;
    onToggle: (id: string) => void;
}) {
    const { t } = useTranslation();
    const text = won ? t('app.photoChooserWonInList') : interp(t(missingKey(hasChallenge, truncated)), { count });
    return (
        <button
            type="button"
            aria-pressed
            aria-label={withPosition(
                interp(t('app.photoChooserMissingTileLabel'), { id: shortId(id), reason: text }),
                t,
                position,
            )}
            className={`${TILE_BASE} border-warning bg-warning/10`}
            onClick={() => onToggle(id)}
        >
            <PositionBadge position={position} />
            <span className="text-xs font-medium">{shortId(id)}</span>
            <span className="text-xs">{text}</span>
        </button>
    );
}

/**
 * A chosen photo the preview does not list: the library is being read again, so whether it is really
 * missing is not known yet. It stays selected, and cannot be removed until that read has failed, when it can.
 */
function PendingTile({
    id,
    position,
    recheckFailed,
    onToggle,
}: {
    id: string;
    position: number | null;
    recheckFailed: boolean;
    onToggle: (id: string) => void;
}) {
    const { t } = useTranslation();
    const text = t(recheckFailed ? 'app.photoChooserNotAsLoadedFailed' : 'app.photoChooserNotAsLoaded');
    return (
        <button
            type="button"
            aria-pressed
            aria-disabled={!recheckFailed}
            aria-label={withPosition(
                interp(t('app.photoChooserMissingTileLabel'), { id: shortId(id), reason: text }),
                t,
                position,
            )}
            className={`${TILE_BASE} border-base-300 bg-base-200`}
            onClick={() => {
                if (recheckFailed) onToggle(id);
            }}
        >
            <PositionBadge position={position} />
            <span className="text-xs font-medium">{shortId(id)}</span>
            <span className="text-xs">{text}</span>
        </button>
    );
}

const TILE_GRID = 'grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4';

/**
 * The library listing with its states: idle (the not-loaded line, plus the tiles Auto named that were picked in
 * this opening), loading, an error with Retry, the missing-challenge explanation, and the tiles (selected ones
 * pinned first). The defaults are the Chosen Photos list's: numbered, capped at MAX_CHOSEN_PHOTOS.
 */
export function PhotoGrid({
    state,
    known,
    selected,
    hideUnlisted,
    locked,
    lockedKey = 'app.photoChooserTileLocked',
    hasChallenge,
    revalidating,
    recheckFailed,
    submit = false,
    refreshDisabled = false,
    blockedIds,
    blockedKey = 'app.photoChooserNotEligible',
    onToggle,
    onRetry,
    onRefresh,
    max = MAX_CHOSEN_PHOTOS,
    fullKey = 'app.photoChooserListFull',
    numbered = true,
    extraPhotos,
    idleMemberId = null,
    idleIds,
}: {
    state: ListState;
    known: Map<string, LibraryPhoto>;
    selected: string[];
    /** Selected ids the listing does not return are not shown (they belong to another account). */
    hideUnlisted: boolean;
    /** The saved list is not read yet: the tiles are inert, so a late read cannot overwrite a pick. */
    locked: boolean;
    /** The translation key of what a locked tile says. */
    lockedKey?: string;
    /** The listing is read for a challenge (and says which photos it accepts), not for the library alone. */
    hasChallenge: boolean;
    /** The library is being read again (a preview's re-check, or a Refresh). */
    revalidating: boolean;
    /** The last re-read failed, so what is shown is the library as last loaded. */
    recheckFailed: boolean;
    /** The grid is the submit modal's: picking is held while a preview shows, and its lines say so. */
    submit?: boolean;
    /** Refresh cannot be pressed now (a submit is running). */
    refreshDisabled?: boolean;
    /** Photos the caller already knows cannot be picked (the listing does not say), shown blocked. */
    blockedIds?: ReadonlySet<string>;
    /** The translation key of what a tile in `blockedIds` says. */
    blockedKey?: string;
    onToggle: (id: string) => void;
    onRetry: () => void;
    onRefresh: () => void;
    /** How many photos may be selected: the rest are offered no more. */
    max?: number;
    /** The translation key of what a tile says when the selection is full. */
    fullKey?: string;
    /** Selected tiles show their position (a list's order); off for a plain set. */
    numbered?: boolean;
    /** Records of photos the listing may not return (the suggestions), looked up after it for a selected id. */
    extraPhotos?: ReadonlyMap<string, LibraryPhoto>;
    /** The member that owns the `extraPhotos`: with no listing read yet, the selected tiles take it for their thumbnails. */
    idleMemberId?: string | null;
    /** The ids the idle grid shows, in place whether picked or not (default: the selected ones). */
    idleIds?: string[];
}) {
    const { t } = useTranslation();
    // Every won id this chooser has been told of: a search that no longer lists a chosen photo still knows it has won.
    const everWon = useRef(new Set<string>());
    if (state.status === 'idle') {
        // Nothing is read yet: only the photos Auto named that were picked are shown, from the records it brought,
        // so a pick never goes invisible. An unpicked one keeps its place, so it can be picked again.
        const chosenIdle = new Set(selected);
        const shownIdle = (idleIds ?? selected).flatMap((id) => extraPhotos?.get(id) ?? []);
        return (
            <>
                <p className="text-base-content/70 text-sm" role="status">
                    {t(selected.length > 0 ? 'app.pickIdleWithPicks' : 'app.pickIdle')}
                </p>
                {shownIdle.length > 0 && (
                    <div className={TILE_GRID}>
                        {shownIdle.map((photo) => (
                            <PhotoTile
                                key={photo.id}
                                photo={photo}
                                memberId={idleMemberId}
                                selected={chosenIdle.has(photo.id)}
                                position={null}
                                blockedReason={null}
                                atCap={selected.length >= max}
                                fullKey={fullKey}
                                allowedKnown={false}
                                locked={locked}
                                lockedKey={lockedKey}
                                onToggle={onToggle}
                            />
                        ))}
                    </div>
                )}
            </>
        );
    }
    if (state.status === 'loading') return <InlineLoader text={t('app.photoChooserLoading')} />;
    if (state.status === 'no-context') {
        return (
            <div role="alert" className="alert alert-warning py-2 text-sm">
                <span>{t('app.photoChooserNoContext')}</span>
            </div>
        );
    }
    if (state.status === 'error') {
        return (
            <div role="alert" className="alert alert-error py-2 text-sm">
                <div className="flex-1">
                    <p>{t(state.error ? 'app.photoChooserLoadError' : 'app.photoChooserLoadErrorNoDetail')}</p>
                    {state.error && <p className="text-xs">{ipcErrorText(state.error, t)}</p>}
                </div>
                <button type="button" className="btn btn-sm" onClick={onRetry}>
                    {t('app.photoChooserRetry')}
                </button>
            </div>
        );
    }
    const { listing } = state;
    const chosen = new Set(selected);
    for (const id of listing.wonIds) everWon.current.add(id);
    const won = everWon.current;
    // A preview's photos carry no marks and are not remembered in `known`, so the selection is looked up in them.
    const previewPhotos = listing.preview ? new Map(listing.photos.map((photo) => [photo.id, photo])) : null;
    const lookup = (id: string): LibraryPhoto | undefined => (previewPhotos ?? known).get(id) ?? extraPhotos?.get(id);
    const atCap = selected.length >= max;
    let position = 0;
    const blockedReasonOf = (photo: LibraryPhoto): string | null => {
        if (blockedIds?.has(photo.id)) return t(blockedKey);
        return listing.allowedKnown && !photo.allowed ? photo.message || t('app.photoChooserNotEligible') : null;
    };
    const shown = (n: number): number | null => (numbered ? n : null);
    const tile = (photo: LibraryPhoto, position: number | null) => (
        <PhotoTile
            key={photo.id}
            photo={photo}
            memberId={listing.memberId}
            selected={chosen.has(photo.id)}
            position={position}
            blockedReason={blockedReasonOf(photo)}
            atCap={atCap}
            fullKey={fullKey}
            allowedKnown={listing.allowedKnown}
            locked={locked}
            lockedKey={lockedKey}
            onToggle={onToggle}
        />
    );
    return (
        <>
            <ListingHeader
                readAtMs={listing.readAtMs}
                reading={revalidating}
                disabled={refreshDisabled}
                preview={listing.preview}
                recheckFailed={recheckFailed}
                hasChallenge={hasChallenge}
                submit={submit}
                onRefresh={onRefresh}
            />
            {!hasChallenge && <p className="text-base-content/70 text-xs">{t('app.photoChooserEligibilityLater')}</p>}
            {listing.wonCount > 0 && (
                <p className="text-base-content/70 text-xs">
                    {interp(t(listing.truncated ? 'app.photoChooserWonHiddenTruncated' : 'app.photoChooserWonHidden'), {
                        count: listing.wonCount,
                    })}
                </p>
            )}
            {listing.truncated && (
                <p className="text-warning text-xs">
                    {interp(t('app.photoChooserTruncated'), { count: listing.photos.length })}
                </p>
            )}
            {listing.photos.length === 0 && (
                <p className="text-base-content/60 text-sm">
                    {t(
                        listing.wonCount > 0 && !listing.truncated
                            ? 'app.photoChooserEmptyAllWon'
                            : 'app.photoChooserEmpty',
                    )}
                </p>
            )}
            <div className={TILE_GRID}>
                {/* Numbered 1, 2, 3… as shown: a photo left out (another account's) leaves no gap. */}
                {selected.map((id) => {
                    const photo = lookup(id);
                    if (photo) return tile(photo, shown(++position));
                    if (hideUnlisted) return null;
                    if (listing.preview && !won.has(id)) {
                        return (
                            <PendingTile
                                key={id}
                                id={id}
                                position={shown(++position)}
                                recheckFailed={recheckFailed}
                                onToggle={onToggle}
                            />
                        );
                    }
                    return (
                        <MissingTile
                            key={id}
                            id={id}
                            position={shown(++position)}
                            count={listing.photos.length}
                            hasChallenge={hasChallenge}
                            truncated={listing.truncated}
                            won={won.has(id)}
                            onToggle={onToggle}
                        />
                    );
                })}
                {listing.photos.filter((photo) => !chosen.has(photo.id)).map((photo) => tile(photo, null))}
            </div>
        </>
    );
}

// The chooser's sticky footer can outgrow STICKY_FOOTER_SCROLL_PADDING: it pins the save-error alert, the hold
// status hint with its Retry button and the buttons. Sized for the worst case on a phone (320px, Latvian): py-4,
// a multi-line save-error alert, a ~9-line hold hint of text-xs beside a btn-xs Retry, the gaps and the buttons,
// about 21-22rem, so 24rem. At `md:` (a `size="xl"` box, about 704px at 768px) the Latvian "unconfirmed" hint can
// wrap to three lines: about 10.75rem with the alert and the buttons, so 12rem with room for the focus ring. Both
// values are capped at half the viewport height: most landscape phones are 768-915px wide, so `md:` applies to them
// too, and a short screen, whose box can be as little as ~240-330px tall, keeps room for the focused control, at the
// cost of a worst-case footer partly covering a tile there.
const CHOOSER_SCROLL_PADDING = 'scroll-pb-[min(24rem,50dvh)] md:scroll-pb-[min(12rem,50dvh)]';

/** The signed-in member, asked for again on purpose (the main process drops its cached failure). */
const confirmAccount = async (): Promise<AccountCheck> => {
    const result = await ipc.callOrNull(() => ipc.confirmAccount());
    if (result?.success) return { memberId: result.memberId };
    return { error: result?.error === 'not-logged-in' ? 'not-logged-in' : 'account-check-failed' };
};

/**
 * The modal's body. Mounted only while the modal is open, so every opening
 * starts from the saved value and reads the listing afresh (the main process may answer it from memory,
 * as a preview or as it was read for this challenge a few minutes ago).
 */
function PhotoChooserBody({
    value,
    savedCount,
    challengeId,
    clearMeansInherit,
    reloadSaved,
    onSave,
    onClose,
    unsaved,
}: {
    value: string[];
    savedCount: number;
    challengeId: string | number | null;
    clearMeansInherit: boolean;
    reloadSaved?: () => Promise<string[] | null>;
    onSave: (ids: string[]) => boolean | Promise<boolean>;
    onClose: () => void;
    /** Kept up to date with whether the selection differs from the list it started from (the saved one). */
    unsaved: { current: boolean };
}) {
    const { t } = useTranslation();
    const owner = useChosenPhotosOwner();
    const [selected, setSelected] = useState<string[]>(value);
    // The list the selection started from: the saved one, or what a late read of it brought.
    const [startedFrom, setStartedFrom] = useState<string[]>(value);
    unsaved.current = selected.length !== startedFrom.length || selected.some((id, i) => id !== startedFrom[i]);
    const startFrom = useCallback((ids: string[]) => {
        setStartedFrom(ids);
        setSelected(ids);
    }, []);
    const startFresh = useCallback(() => startFrom([]), [startFrom]);
    const { state, known, generation, revalidating, recheckFailed, load, refresh, retry, setMember } =
        useLibraryListing(challengeId);
    const [listsRemoved, setListsRemoved] = useState(false);

    const toggle = useCallback((id: string) => {
        setSelected((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
    }, []);

    const { save, saving, saveFailed } = useChooserSave(selected, onSave, onClose);

    const otherAccount = useOtherAccountLists({
        savedCount,
        owner,
        state,
        removed: listsRemoved,
        onFirstSeen: startFresh,
    });
    // A saved list that came without its ids is read again once the listing shows it is this
    // account's, and the selection starts from it; until then Save is held (see the hook).
    const saved = useSavedListReread({
        withheld: savedCount > value.length,
        owner,
        state,
        generation,
        reloadSaved,
        confirmAccount,
        retryListing: retry,
        onMember: setMember,
        onRead: startFrom,
    });
    // Until the list is read the tiles are inert: a late read would otherwise overwrite what was picked.
    const locked = saved.status !== 'ok';
    const atCap = selected.length >= MAX_CHOSEN_PHOTOS;
    // With a list on record, saving restamps its owner as the signed-in account: only once the
    // listing has said who that is can the notice above warn about it. Saving nothing writes no
    // list, so it is never held back — except while the saved list is still unread (above), when
    // even an empty selection would remove it.
    const saveWaits = (selected.length > 0 && owner !== '' && state.status !== 'ready') || locked;

    return (
        <div className="space-y-3">
            <p className="text-base-content/70 text-xs">{t('app.photoChooserHelp')}</p>
            {clearMeansInherit && <p className="text-base-content/70 text-xs">{t('app.photoChooserInheritNote')}</p>}
            {otherAccount && (
                <>
                    <OtherAccountNotice onRemoved={() => setListsRemoved(true)} />
                    <p className="text-xs">{interp(t('app.chosenPhotosOtherAccountCount'), { count: savedCount })}</p>
                </>
            )}
            <SearchForm onSearch={(term) => void load(term)} />
            <p className="text-xs" role="status">
                {interp(t('app.photoChooserCount'), { count: selected.length, max: MAX_CHOSEN_PHOTOS })}
                {atCap && ` ${t('app.photoChooserLimitReached')}`}
            </p>
            <PhotoGrid
                state={state}
                known={known}
                selected={selected}
                hideUnlisted={otherAccount}
                locked={locked}
                hasChallenge={challengeId !== null}
                revalidating={revalidating}
                recheckFailed={recheckFailed}
                onToggle={toggle}
                onRetry={retry}
                onRefresh={refresh}
            />
            <StickyModalFooter>
                <ChooserFooter
                    saveFailed={saveFailed}
                    saveWaits={saveWaits}
                    holdReason={holdReasonOf(saved, state.status)}
                    retrying={saved.retrying}
                    confirmed={saved.confirmed}
                    locked={locked}
                    onRetryHold={saved.retry}
                    saving={saving}
                    onSave={save}
                    onClear={() => setSelected([])}
                    onClose={onClose}
                />
            </StickyModalFooter>
        </div>
    );
}

/**
 * Pick the photos for a Chosen Photos list from the member's own library.
 *
 * The selection is a numbered list in the order it is saved in (the app goes by that
 * order only when Use Chosen Photos in the order I picked them is on; otherwise photos
 * rank by the picker's own scorer), capped at MAX_CHOSEN_PHOTOS. `challengeId` makes the listing say whether each
 * photo can enter THAT challenge; without it eligibility is only known at submit
 * time. `onSave` gets the chosen ids and answers whether they were stored: on
 * false (or a throw) the modal stays open on an error. `clearMeansInherit` says
 * that saving nothing removes the list this layer holds, so the layer inherits
 * the one from the settings or rules above it.
 */
export function PhotoChooserModal({
    isOpen,
    onClose,
    value,
    savedCount = value.length,
    challengeId = null,
    clearMeansInherit = false,
    reloadSaved,
    onSave,
}: {
    isOpen: boolean;
    onClose: () => void;
    value: string[];
    /** How many photos the saved list holds when `value` withholds them (another account's). */
    savedCount?: number;
    challengeId?: string | number | null;
    clearMeansInherit?: boolean;
    /** Read the saved list again, with its ids (null when it can't be): for a `value` that withheld them. */
    reloadSaved?: () => Promise<string[] | null>;
    onSave: (ids: string[]) => boolean | Promise<boolean>;
}) {
    const { t } = useTranslation();
    const unsaved = useRef(false);
    const [asking, setAsking] = useState(false);
    // The question belongs to one opening: a modal the parent keeps mounted must not open on it next time.
    useEffect(() => {
        if (!isOpen) setAsking(false);
    }, [isOpen]);
    if (!isOpen) return null;
    // Esc, the backdrop and the close button: picks that are not saved are not thrown away unasked.
    const dismiss = () => (unsaved.current ? setAsking(true) : onClose());
    return (
        <>
            <Modal
                isOpen
                onClose={dismiss}
                title={t('app.photoChooserTitle')}
                size="xl"
                className={CHOOSER_SCROLL_PADDING}
            >
                <PhotoChooserBody
                    value={value}
                    savedCount={savedCount}
                    challengeId={challengeId}
                    clearMeansInherit={clearMeansInherit}
                    reloadSaved={reloadSaved}
                    onSave={onSave}
                    onClose={onClose}
                    unsaved={unsaved}
                />
            </Modal>
            <ConfirmModal
                isOpen={asking}
                title={t('app.photoChooserDiscardTitle')}
                working={false}
                problem={null}
                onClose={() => setAsking(false)}
                onConfirm={() => {
                    setAsking(false);
                    onClose();
                }}
                confirmLabel="app.photoChooserDiscard"
                workingLabel="app.photoChooserDiscard"
            >
                <p>{t('app.photoChooserDiscardText')}</p>
            </ConfirmModal>
        </>
    );
}
