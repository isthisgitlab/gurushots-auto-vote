import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal } from '@/components/ui/Modal';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { useImageLoads } from '@/hooks/useImageLoads';
import { buildPhotoUrl } from '@/utils/formatters';
import { interp } from '@/utils/interp';
import { ipcErrorText } from '@/api/ipcErrorText';
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
    // stays removable once selected.
    const disabled = !selected && (blockedReason !== null || atCap);
    const reason = blockedReason ?? (allowedKnown ? t('app.photoChooserAllowed') : null);
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
            disabled={disabled}
            className={`${TILE_BASE} ${tone} ${blockedReason !== null ? 'opacity-50' : ''}`}
            onClick={() => onToggle(photo.id)}
        >
            {showImage ? (
                <img
                    src={url as string}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="aspect-square w-full rounded object-cover"
                />
            ) : (
                <span className="bg-base-200 flex aspect-square w-full items-center justify-center rounded p-1 text-center text-xs break-words">
                    {labels}
                </span>
            )}
            <span className="truncate text-xs">{showImage ? labels : shortId(photo.id)}</span>
            {reason && (
                <span className={`text-xs ${blockedReason !== null ? 'text-error' : 'text-success'}`}>{reason}</span>
            )}
        </button>
    );
}

/**
 * A chosen photo the listing does not return: still selected (and removable),
 * with the likely reasons it is missing.
 */
function MissingTile({ id, count, onToggle }: { id: string; count: number; onToggle: (id: string) => void }) {
    const { t } = useTranslation();
    const text = interp(t('app.photoChooserMissing'), { count });
    return (
        <button
            type="button"
            aria-pressed
            aria-label={interp(t('app.photoChooserTileLabel'), { id: shortId(id), labels: '', reason: text })}
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
    onToggle,
    onRetry,
}: {
    state: ListState;
    known: Map<string, LibraryPhoto>;
    selected: string[];
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
                    <p>{t('app.photoChooserLoadError')}</p>
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
                    return photo ? (
                        tile(photo)
                    ) : (
                        <MissingTile key={id} id={id} count={listing.photos.length} onToggle={onToggle} />
                    );
                })}
                {listing.photos.filter((photo) => !chosen.has(photo.id)).map(tile)}
            </div>
        </>
    );
}

/**
 * The modal's body. Mounted only while open, so every open starts from the
 * saved value with a fresh listing.
 */
function PhotoChooserBody({
    value,
    challengeId,
    onSave,
    onClose,
}: {
    value: string[];
    challengeId: string | number | null;
    onSave: (ids: string[]) => boolean | Promise<boolean>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const owner = useChosenPhotosOwner();
    const [selected, setSelected] = useState<string[]>(value);
    const [state, setState] = useState<ListState>({ status: 'loading' });
    // Every photo any response of this open has listed: a selected photo that a
    // narrower search no longer returns is still the photo it was.
    const [known, setKnown] = useState<Map<string, LibraryPhoto>>(new Map());
    const [searchText, setSearchText] = useState('');
    const [submittedSearch, setSubmittedSearch] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);
    // The newest request's number: a response for any other one is a late answer.
    const requestRef = useRef(0);

    const load = useCallback(
        async (search: string) => {
            const request = ++requestRef.current;
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
            } else if (result?.error !== 'superseded') {
                setState({ status: 'error', error: result?.error ?? null });
            }
        },
        [challengeId],
    );

    useEffect(() => {
        void load('');
        return () => {
            // Closing drops whatever is still in flight.
            requestRef.current += 1;
        };
    }, [load]);

    const toggle = useCallback((id: string) => {
        setSelected((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
    }, []);

    const submitSearch = (event: { preventDefault: () => void }) => {
        event.preventDefault();
        const term = searchText.trim();
        setSubmittedSearch(term);
        void load(term);
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

    const currentMember = state.status === 'ready' ? state.listing.memberId : null;
    const otherAccount = selected.length > 0 && owner !== '' && currentMember !== null && owner !== currentMember;

    return (
        <div className="space-y-3">
            <p className="text-base-content/70 text-xs">{t('app.photoChooserHelp')}</p>
            {otherAccount && (
                <div role="alert" className="alert alert-warning py-2 text-sm">
                    <span className="flex-1">{t('app.photoChooserOtherAccount')}</span>
                    <button type="button" className="btn btn-sm" onClick={() => setSelected([])}>
                        {t('app.photoChooserOtherAccountClear')}
                    </button>
                </div>
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
            </p>
            <PhotoGrid
                state={state}
                known={known}
                selected={selected}
                onToggle={toggle}
                onRetry={() => void load(submittedSearch)}
            />
            {saveFailed && (
                <div role="alert" className="alert alert-error py-2 text-sm">
                    <span>{t('app.photoChooserSaveError')}</span>
                </div>
            )}
            <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-latvian btn-sm" onClick={() => void save()} disabled={saving}>
                    {saving && <span className="loading loading-spinner loading-xs" />}
                    {t('app.photoChooserUse')}
                </button>
                <button type="button" className="btn btn-warning btn-sm" onClick={() => setSelected([])}>
                    {t('app.photosClear')}
                </button>
                <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
                    {t('app.cancel')}
                </button>
            </div>
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
 * false (or a throw) the modal stays open on an error.
 */
export function PhotoChooserModal({
    isOpen,
    onClose,
    value,
    challengeId = null,
    onSave,
}: {
    isOpen: boolean;
    onClose: () => void;
    value: string[];
    challengeId?: string | number | null;
    onSave: (ids: string[]) => boolean | Promise<boolean>;
}) {
    const { t } = useTranslation();
    if (!isOpen) return null;
    return (
        <Modal isOpen onClose={onClose} title={t('app.photoChooserTitle')} size="xl">
            <PhotoChooserBody value={value} challengeId={challengeId} onSave={onSave} onClose={onClose} />
        </Modal>
    );
}
