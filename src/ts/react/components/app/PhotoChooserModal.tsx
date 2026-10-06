import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { useImageLoads } from '@/hooks/useImageLoads';
import { buildPhotoUrl } from '@/utils/formatters';
import { interp } from '@/utils/interp';
import { ipcErrorText } from '@/api/ipcErrorText';
import { announceChosenPhotosCleared } from '@/api/chosenPhotosCleared';
import { rememberCurrentMember, useChosenPhotosOwner } from '@/api/useChosenPhotosOwner';
import * as ipc from '@/api/ipc';
import { MAX_CHOSEN_PHOTOS } from '../../../settings/limits';

import type { WindowApi } from '../../../types/ipc';

type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;
type LibraryPhoto = Listing['photos'][number];

/**
 * What the chooser is showing. `ready` keeps the listing's photos beside what
 * the response said about them; every other state is a reason there are none.
 */
type ListState =
    | { status: 'loading' }
    | { status: 'ready'; listing: Listing }
    | { status: 'no-context' }
    | { status: 'error'; error: string | null };

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
    blockedReason,
    full,
    allowedKnown,
    t,
}: {
    blockedReason: string | null;
    full: boolean;
    allowedKnown: boolean;
    t: (key: string) => string;
}): string | null => {
    if (blockedReason !== null) return blockedReason;
    if (full) return t('app.photoChooserListFull');
    return allowedKnown ? t('app.photoChooserAllowed') : null;
};

/**
 * One photo as a toggle button: its thumbnail (or, with no URL or one that does
 * not load, its tags and short id as text), the tags, and — when the listing
 * knows — whether the challenge accepts it, with the reason as text.
 * Server strings (tags, reason) are React text children only.
 */
function PhotoTile({
    photo,
    memberId,
    selected,
    blockedReason,
    atCap,
    allowedKnown,
    onToggle,
}: {
    photo: LibraryPhoto;
    memberId: string | null;
    selected: boolean;
    blockedReason: string | null;
    atCap: boolean;
    allowedKnown: boolean;
    onToggle: (id: string) => void;
}) {
    const { t } = useTranslation();
    const url = memberId ? buildPhotoUrl(memberId, photo.id, { size: TILE_PX }) : null;
    const showImage = useImageLoads(url);
    const labels = labelsOf(photo, t('app.photoChooserNoTags'));
    // A photo that cannot be added (the challenge refuses it, or the list is full)
    // stays removable once selected. It is aria-disabled rather than disabled, so
    // Tab still reaches it and a screen reader can read why it cannot be added.
    const unavailable = !selected && (blockedReason !== null || atCap);
    const full = !selected && atCap;
    const reason = tileReason({ blockedReason, full, allowedKnown, t });
    // Only the picture and its tags are dimmed: the reason line stays at full contrast, since it is
    // what says why the tile cannot be added.
    const dim = unavailable ? 'opacity-50' : '';
    const tone = selected ? 'border-primary bg-primary/10' : 'border-base-300';
    return (
        <button
            type="button"
            aria-pressed={selected}
            aria-label={interp(t('app.photoChooserTileLabel'), {
                id: shortId(photo.id),
                labels,
                reason: reason ?? '',
            })}
            aria-disabled={unavailable}
            className={`${TILE_BASE} ${tone}`}
            onClick={() => {
                if (!unavailable) onToggle(photo.id);
            }}
        >
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
                    className={`text-xs ${blockedReason !== null ? 'text-error' : full ? 'text-base-content/70' : 'text-success'}`}
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
    count,
    hasChallenge,
    truncated,
    onToggle,
}: {
    id: string;
    count: number;
    hasChallenge: boolean;
    truncated: boolean;
    onToggle: (id: string) => void;
}) {
    const { t } = useTranslation();
    const text = interp(t(missingKey(hasChallenge, truncated)), { count });
    return (
        <button
            type="button"
            aria-pressed
            aria-label={interp(t('app.photoChooserMissingTileLabel'), { id: shortId(id), reason: text })}
            className={`${TILE_BASE} border-warning bg-warning/10`}
            onClick={() => onToggle(id)}
        >
            <span className="text-xs font-medium">{shortId(id)}</span>
            <span className="text-xs">{text}</span>
        </button>
    );
}

/**
 * The library listing with its states: loading, an error with Retry, the
 * missing-challenge explanation, and the tiles (selected ones pinned first).
 */
function PhotoGrid({
    state,
    known,
    selected,
    hideUnlisted,
    onToggle,
    onRetry,
}: {
    state: ListState;
    known: Map<string, LibraryPhoto>;
    selected: string[];
    /** Selected ids the listing does not return are not shown (they belong to another account). */
    hideUnlisted: boolean;
    onToggle: (id: string) => void;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
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
    const atCap = selected.length >= MAX_CHOSEN_PHOTOS;
    const blockedReasonOf = (photo: LibraryPhoto): string | null =>
        listing.allowedKnown && !photo.allowed ? photo.message || t('app.photoChooserNotEligible') : null;
    const tile = (photo: LibraryPhoto) => (
        <PhotoTile
            key={photo.id}
            photo={photo}
            memberId={listing.memberId}
            selected={chosen.has(photo.id)}
            blockedReason={blockedReasonOf(photo)}
            atCap={atCap}
            allowedKnown={listing.allowedKnown}
            onToggle={onToggle}
        />
    );
    return (
        <>
            {!listing.allowedKnown && (
                <p className="text-base-content/70 text-xs">{t('app.photoChooserEligibilityLater')}</p>
            )}
            {listing.truncated && (
                <p className="text-warning text-xs">
                    {interp(t('app.photoChooserTruncated'), { count: listing.photos.length })}
                </p>
            )}
            {listing.photos.length === 0 && (
                <p className="text-base-content/60 text-sm">{t('app.photoChooserEmpty')}</p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {selected.map((id) => {
                    const photo = known.get(id);
                    if (photo) return tile(photo);
                    return hideUnlisted ? null : (
                        <MissingTile
                            key={id}
                            id={id}
                            count={listing.photos.length}
                            hasChallenge={listing.allowedKnown}
                            truncated={listing.truncated}
                            onToggle={onToggle}
                        />
                    );
                })}
                {listing.photos.filter((photo) => !chosen.has(photo.id)).map(tile)}
            </div>
        </>
    );
}

/**
 * The notice shown while the list the chooser opened with was saved under
 * another account: what that means, and the way to remove those lists — behind a
 * confirmation, since it reaches every setting, profile, rule and scenario.
 */
function OtherAccountNotice({ onRemoved }: { onRemoved: () => void }) {
    const { t } = useTranslation();
    const [confirming, setConfirming] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [failed, setFailed] = useState(false);

    const remove = async () => {
        setRemoving(true);
        setFailed(false);
        const result = await ipc.callOrNull(() => ipc.clearChosenPhotos());
        setRemoving(false);
        setConfirming(false);
        if (result?.success) {
            // Every open editor drops its copy of the lists, so saving it cannot put them back.
            announceChosenPhotosCleared();
            onRemoved();
        } else setFailed(true);
    };

    return (
        <>
            <div role="alert" className="alert alert-warning py-2 text-sm">
                <span className="flex-1">{t('app.photoChooserOtherAccount')}</span>
                <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>
                    {t('app.photoChooserOtherAccountClear')}
                </button>
            </div>
            {failed && (
                <div role="alert" className="alert alert-error py-2 text-sm">
                    <span>{t('app.photoChooserOtherAccountClearError')}</span>
                </div>
            )}
            <Modal
                isOpen={confirming}
                onClose={removing ? undefined : () => setConfirming(false)}
                title={t('app.photoChooserOtherAccountClear')}
                showCloseButton={!removing}
            >
                <p className="text-sm">{t('app.photoChooserOtherAccountConfirm')}</p>
                <ModalActions>
                    <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={removing}
                        onClick={() => setConfirming(false)}
                    >
                        {t('app.cancel')}
                    </button>
                    <button
                        type="button"
                        className="btn btn-warning btn-sm"
                        disabled={removing}
                        onClick={() => void remove()}
                    >
                        {removing && <span className="loading loading-spinner loading-xs" />}
                        {t('app.photoChooserOtherAccountClear')}
                    </button>
                </ModalActions>
            </Modal>
        </>
    );
}

/**
 * The library listing for a challenge and what has been learned from it: the
 * current state, every photo any response has listed so far (by id), and `load`
 * to read again for a search term. A response for any but the newest request is a
 * late answer and is dropped; leaving drops whatever is still in flight.
 */
function useLibraryListing(challengeId: string | number | null) {
    const [state, setState] = useState<ListState>({ status: 'loading' });
    // Every photo any response has listed, by id: a selected photo that a narrower
    // search omits keeps its record and is not shown as a missing tile.
    const [known, setKnown] = useState<Map<string, LibraryPhoto>>(new Map());
    const requestRef = useRef(0);
    const lastSearchRef = useRef('');

    const load = useCallback(
        async (search: string) => {
            const request = ++requestRef.current;
            lastSearchRef.current = search;
            setState({ status: 'loading' });
            const result = await ipc.callOrNull(() => ipc.getLibraryPhotos(challengeId, search || undefined));
            if (request !== requestRef.current) return;
            if (result?.success) {
                rememberCurrentMember(result.memberId);
                setKnown(
                    (prev) =>
                        new Map([...prev, ...result.photos.map((photo): [string, LibraryPhoto] => [photo.id, photo])]),
                );
                setState({ status: 'ready', listing: result });
            } else if (result?.error === 'no-challenge-context') {
                setState({ status: 'no-context' });
            } else {
                // A 'superseded' answer to the newest request means nothing newer is coming: offer Retry.
                const error = result?.error && result.error !== 'superseded' ? result.error : null;
                setState({ status: 'error', error });
            }
        },
        [challengeId],
    );

    useEffect(() => {
        void load('');
        return () => {
            requestRef.current += 1;
        };
    }, [load]);

    return { state, known, load, retry: () => void load(lastSearchRef.current) };
}

/**
 * Whether the lists on record belong to another account than the signed-in one,
 * judged on the list the modal opened with (`savedCount`), not the live selection,
 * so choosing photos does not make the notice come and go. Once seen it stays until
 * the lists are removed: a search puts the listing back to loading (or an error),
 * which must not hide the notice and the photos it withholds. `onFirstSeen` runs
 * once, as soon as it is seen — the other account's photos are not this account's
 * to build on, so the selection then starts empty.
 */
function useOtherAccountLists({
    savedCount,
    owner,
    state,
    removed,
    onFirstSeen,
}: {
    savedCount: number;
    owner: string;
    state: ListState;
    removed: boolean;
    onFirstSeen: () => void;
}): boolean {
    const currentMember = state.status === 'ready' ? state.listing.memberId : null;
    const otherNow = savedCount > 0 && owner !== '' && currentMember !== null && owner !== currentMember;
    const seen = useRef(false);
    const otherAccount = !removed && (otherNow || seen.current);
    const startedFresh = useRef(false);
    // Latched here, after the render that saw it, not during it.
    useLayoutEffect(() => {
        if (otherNow) seen.current = true;
    }, [otherNow]);
    useLayoutEffect(() => {
        if (otherAccount && !startedFresh.current) {
            startedFresh.current = true;
            onFirstSeen();
        }
    }, [otherAccount, onFirstSeen]);
    return otherAccount;
}

/**
 * The chooser's actions: save (held back, with its reason, while the account is unknown),
 * clear the selection, cancel — and the error of a save that failed.
 */
function ChooserFooter({
    saveFailed,
    saveWaits,
    saving,
    onSave,
    onClear,
    onClose,
}: {
    saveFailed: boolean;
    saveWaits: boolean;
    saving: boolean;
    onSave: () => void;
    onClear: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const waitHintId = useId();
    return (
        <>
            {saveFailed && (
                <div role="alert" className="alert alert-error py-2 text-sm">
                    <span>{t('app.photoChooserSaveError')}</span>
                </div>
            )}
            {saveWaits && (
                <p id={waitHintId} className="text-base-content/70 text-right text-xs">
                    {t('app.photoChooserSaveWaits')}
                </p>
            )}
            <div className="flex justify-end gap-2">
                {/* aria-disabled, not disabled: it stays focusable, so the hint above can be reached. */}
                <button
                    type="button"
                    className={`btn btn-latvian btn-sm ${saveWaits ? 'btn-disabled' : ''}`}
                    aria-disabled={saveWaits}
                    aria-describedby={saveWaits ? waitHintId : undefined}
                    onClick={() => {
                        if (!saveWaits) onSave();
                    }}
                    disabled={saving}
                >
                    {saving && <span className="loading loading-spinner loading-xs" />}
                    {t('app.photoChooserUse')}
                </button>
                <button type="button" className="btn btn-warning btn-sm" onClick={onClear}>
                    {t('app.photosClear')}
                </button>
                <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
                    {t('app.cancel')}
                </button>
            </div>
        </>
    );
}

/**
 * The modal's body. Mounted only while the modal is open, so every opening
 * starts from the saved value with a fresh listing.
 */
function PhotoChooserBody({
    value,
    savedCount,
    challengeId,
    clearMeansInherit,
    onSave,
    onClose,
}: {
    value: string[];
    savedCount: number;
    challengeId: string | number | null;
    clearMeansInherit: boolean;
    onSave: (ids: string[]) => boolean | Promise<boolean>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const owner = useChosenPhotosOwner();
    const [selected, setSelected] = useState<string[]>(value);
    const { state, known, load, retry } = useLibraryListing(challengeId);
    const [searchText, setSearchText] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);
    const [listsRemoved, setListsRemoved] = useState(false);

    const toggle = useCallback((id: string) => {
        setSelected((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
    }, []);

    const submitSearch = (event: { preventDefault: () => void }) => {
        event.preventDefault();
        void load(searchText.trim());
    };

    const save = async () => {
        setSaving(true);
        setSaveFailed(false);
        let ok = false;
        try {
            ok = (await onSave(selected)) !== false;
        } catch {
            // A rejected save leaves the modal open on its error, like a refused one.
        }
        setSaving(false);
        if (ok) onClose();
        else setSaveFailed(true);
    };

    const otherAccount = useOtherAccountLists({
        savedCount,
        owner,
        state,
        removed: listsRemoved,
        onFirstSeen: () => setSelected([]),
    });
    const atCap = selected.length >= MAX_CHOSEN_PHOTOS;
    // With a list on record, saving restamps its owner as the signed-in account: only once the
    // listing has said who that is can the notice above warn about it. Saving nothing writes no
    // list, so it is never held back.
    const saveWaits = selected.length > 0 && owner !== '' && state.status !== 'ready';

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
            <form className="flex flex-wrap items-center gap-2" onSubmit={submitSearch}>
                <input
                    type="search"
                    className="input input-sm min-w-40 flex-1"
                    aria-label={t('app.photoChooserSearchLabel')}
                    placeholder={t('app.photoChooserSearchPlaceholder')}
                    value={searchText}
                    onChange={(event) => setSearchText(event.currentTarget.value)}
                />
                <button type="submit" className="btn btn-outline btn-sm">
                    {t('app.photoChooserSearch')}
                </button>
            </form>
            <p className="text-xs" role="status">
                {interp(t('app.photoChooserCount'), { count: selected.length, max: MAX_CHOSEN_PHOTOS })}
                {atCap && ` ${t('app.photoChooserLimitReached')}`}
            </p>
            <PhotoGrid
                state={state}
                known={known}
                selected={selected}
                hideUnlisted={otherAccount}
                onToggle={toggle}
                onRetry={retry}
            />
            <ChooserFooter
                saveFailed={saveFailed}
                saveWaits={saveWaits}
                saving={saving}
                onSave={() => void save()}
                onClear={() => setSelected([])}
                onClose={onClose}
            />
        </div>
    );
}

/**
 * Pick the photos for a Chosen Photos list from the member's own library.
 *
 * The selection is a set (no order; photos rank by the picker's own scorer),
 * capped at MAX_CHOSEN_PHOTOS. `challengeId` makes the listing say whether each
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
    onSave,
}: {
    isOpen: boolean;
    onClose: () => void;
    value: string[];
    /** How many photos the saved list holds when `value` withholds them (another account's). */
    savedCount?: number;
    challengeId?: string | number | null;
    clearMeansInherit?: boolean;
    onSave: (ids: string[]) => boolean | Promise<boolean>;
}) {
    const { t } = useTranslation();
    if (!isOpen) return null;
    return (
        <Modal isOpen onClose={onClose} title={t('app.photoChooserTitle')} size="xl">
            <PhotoChooserBody
                value={value}
                savedCount={savedCount}
                challengeId={challengeId}
                clearMeansInherit={clearMeansInherit}
                onSave={onSave}
                onClose={onClose}
            />
        </Modal>
    );
}
