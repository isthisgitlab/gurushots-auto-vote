import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal } from '@/components/ui/Modal';
import { StickyModalFooter } from '@/components/ui/StickyModalFooter';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { interp } from '@/utils/interp';
import { useChosenPhotosOwner } from '@/api/useChosenPhotosOwner';
import { ChooserFooter, holdReasonOf } from './ChooserFooter';
import { OtherAccountNotice } from './OtherAccountNotice';
import { PhotoPickerToolbar } from './PhotoPicker';
import { PhotoGrid } from './PhotoGrid';
import { useChooserSave, useOtherAccountLists, useSavedListReread } from '@/hooks/usePhotoChooser';
import { usePhotoPicker } from '@/hooks/usePhotoPicker';
import * as ipc from '@/api/ipc';
import { MAX_CHOSEN_PHOTOS } from '../../../settings/limits';

import type { AccountCheck } from '@/hooks/usePhotoChooser';
import type { LibraryPhoto } from '@/hooks/useLibraryListing';

// The chooser's sticky footer can outgrow STICKY_FOOTER_SCROLL_PADDING: it pins the save-error alert, the hold
// status hint with its Retry button and the buttons. Sized for the worst case on a phone (320px, Latvian): py-4,
// a multi-line save-error alert, a ~9-line hold hint of text-xs beside a btn-xs Retry, the gaps and the buttons,
// about 21-22rem, so 24rem. At `md:` (a `size="xl"` box, about 704px at 768px) the Latvian "unconfirmed" hint can
// wrap to three lines: about 10.75rem with the alert and the buttons, so 12rem with room for the focus ring. Both
// values are capped at half the viewport height: most landscape phones are 768-915px wide, so `md:` applies to them
// too, and a short screen, whose box can be as little as ~240-330px tall, keeps room for the focused control, at
// the cost of a worst-case footer partly covering a tile there.
const CHOOSER_SCROLL_PADDING = 'scroll-pb-[min(24rem,50dvh)] md:scroll-pb-[min(12rem,50dvh)]';

/** The signed-in member, asked for again on purpose (the main process drops its cached failure). */
const confirmAccount = async (): Promise<AccountCheck> => {
    const result = await ipc.callOrNull(() => ipc.confirmAccount());
    if (result?.success) return { memberId: result.memberId };
    return { error: result?.error === 'not-logged-in' ? 'not-logged-in' : 'account-check-failed' };
};

/**
 * The modal's body. Mounted only while the modal is open, so every opening starts from the saved
 * value. Nothing is read until Load photos, Search or a Retry asks for it: the saved picks show once
 * the member check on open says they are this account's (the member only is asked for — never the
 * library), and Auto can rank and fill without a read.
 */
function PhotoChooserBody({
    value,
    savedCount,
    challengeId,
    clearMeansInherit,
    canSuggest,
    recommendedIds,
    reloadSaved,
    onSave,
    onClose,
    unsaved,
}: {
    value: string[];
    savedCount: number;
    challengeId: string | number | null;
    clearMeansInherit: boolean;
    canSuggest: boolean;
    /** The photo ids GuruShots suggests for the challenge, marked on their tiles (a Discover row's chooser). */
    recommendedIds?: ReadonlyArray<string>;
    reloadSaved?: () => Promise<string[] | null>;
    onSave: (ids: string[]) => boolean | Promise<boolean>;
    onClose: () => void;
    /** Kept up to date with whether the selection differs from the list it started from (the saved one). */
    unsaved: { current: boolean };
}) {
    const { t } = useTranslation();
    const {
        owner,
        known: ownerKnown,
        failed: ownerFailed,
        loading: ownerLoading,
        refetch: refetchOwner,
    } = useChosenPhotosOwner();
    const [selected, setSelected] = useState<string[]>(value);
    // The list the selection started from: the saved one, or what a late read of it brought.
    const [startedFrom, setStartedFrom] = useState<string[]>(value);
    unsaved.current = selected.length !== startedFrom.length || selected.some((id, i) => id !== startedFrom[i]);
    const startFrom = useCallback((ids: string[]) => {
        setStartedFrom(ids);
        setSelected(ids);
    }, []);
    // Auto ranks for a challenge the photos could be entered into: a Discover row's challenge is not
    // joined, so it cannot (suggestPhotos would answer challenge-ended).
    const showAuto = canSuggest && challengeId !== null;
    const picker = usePhotoPicker({ challengeId, usage: 'submit', alwaysFresh: false, selected });
    const {
        state,
        known,
        generation,
        shown,
        revalidating,
        recheckFailed,
        retry,
        setMember,
        refresh,
        resetLoadPhotos,
        forgetIdle,
    } = picker;
    const [listsRemoved, setListsRemoved] = useState(false);
    // A pressed Retry of a failed owner read, still reading the record again.
    const [ownerRetryPending, setOwnerRetryPending] = useState(false);
    // The member the open-time check found: a listing that names none cannot erase it, and without a
    // listing it is the only member there is.
    const [checkedMember, setCheckedMember] = useState<string | null>(null);
    const onMember = useCallback(
        (memberId: string) => {
            setMember(memberId);
            setCheckedMember(memberId);
        },
        [setMember],
    );
    const listingMember = state.status === 'ready' ? state.listing.memberId : null;
    // The known member: a listing's once a read has named it, else the check's. A listing that names
    // a different member than the check did wins.
    const knownMember = listingMember ?? checkedMember;
    const memberUnknown = knownMember === null;
    // The member is asked for on open when a list is on record anywhere — this layer's own, or an
    // owner any save has stamped. The answer may land before the owner read does; the gate below
    // still waits for that read.
    const checkRan = savedCount > 0 || owner !== '';

    useEffect(() => {
        if (ownerKnown || ownerFailed) setOwnerRetryPending(false);
    }, [ownerKnown, ownerFailed]);

    const toggle = useCallback((id: string) => {
        setSelected((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
    }, []);

    const { save, saving, saveFailed } = useChooserSave(selected, onSave, onClose);

    const otherAccount = useOtherAccountLists({
        savedCount,
        owner,
        memberId: knownMember,
        removed: listsRemoved,
        onFirstSeen: useCallback(() => {
            // The other account's photos are not this account's to build on: the selection starts
            // empty, and no stub stays behind for the ids it dropped.
            forgetIdle();
            startFrom([]);
        }, [forgetIdle, startFrom]),
    });
    // A saved list that came without its ids is read again once the member shows it is this
    // account's, and the selection starts from it; until then Save is held (see the hook).
    const saved = useSavedListReread({
        withheld: savedCount > value.length,
        owner,
        ownerKnown,
        ownerFailed,
        memberId: knownMember,
        state,
        generation,
        shown,
        reloadSaved,
        confirmAccount,
        retryListing: retry,
        onMember,
        onRead: startFrom,
        checkOnOpen: checkRan,
    });
    // Until the list is read the tiles are inert: a late read would otherwise overwrite what was picked.
    const locked = saved.status !== 'ok';
    const atCap = selected.length >= MAX_CHOSEN_PHOTOS;
    // Saving restamps the list's owner as the signed-in account, so it waits until that account is
    // known — the member check names it without reading the library — and while a withheld list is
    // still unread (even an empty selection would remove it).
    const saveWaits = (checkRan && memberUnknown) || locked;
    // The saved picks may show once the owner has been read and the known member matches it (or,
    // with no owner on record, once any member is known): their thumbnails come from that match.
    const gateOpen = ownerKnown && (owner === '' ? knownMember !== null : knownMember === owner);
    const thumbMember = owner !== '' && gateOpen ? owner : null;
    // The wait line shows only while something is on its way: the member check, or the owner read
    // the gate also waits for. Once both have answered and the gate is still closed, the idle line
    // and the Auto-picked tiles show — a pick never goes invisible.
    const checkPending = checkRan && (saved.askingMember || ownerLoading);
    const idleKey = showAuto ? 'app.photoChooserIdleAuto' : 'app.photoChooserIdle';
    const idleWithPicksKey = showAuto ? 'app.photoChooserIdlePicksAuto' : 'app.photoChooserIdlePicks';
    const helpKey = showAuto
        ? 'app.photoChooserHelpAuto'
        : challengeId !== null
          ? 'app.photoChooserHelpChallenge'
          : 'app.photoChooserHelpNoChallenge';

    // Adds the best suggestions not picked yet, in rank order, up to the cap; a hand pick is never taken out.
    const addSuggestions = (photos: LibraryPhoto[]) => {
        setSelected((prev) => {
            const added = photos
                .map((photo) => photo.id)
                .filter((id) => !prev.includes(id))
                .slice(0, Math.max(0, MAX_CHOSEN_PHOTOS - prev.length));
            return [...prev, ...added];
        });
    };

    // Refresh reads the listing on screen again and drops the ranking with it (nothing is pruned here:
    // the chooser has no submit to retry).
    const refreshListing = useCallback(() => {
        resetLoadPhotos();
        refresh();
    }, [resetLoadPhotos, refresh]);

    return (
        <div className="space-y-3">
            {clearMeansInherit && <p className="text-base-content/70 text-xs">{t('app.photoChooserInheritNote')}</p>}
            {otherAccount && (
                <>
                    <OtherAccountNotice onRemoved={() => setListsRemoved(true)} />
                    <p className="text-xs">{interp(t('app.chosenPhotosOtherAccountCount'), { count: savedCount })}</p>
                </>
            )}
            <PhotoPickerToolbar
                picker={picker}
                selected={selected}
                canSuggest={showAuto}
                held={false}
                locked={locked}
                lockedKey="app.photoChooserTileLocked"
                fullKey="app.photoChooserListFull"
                helpKey={helpKey}
                autoHelpKey="app.photoChooserAutoHelp"
                autoRunningKey="app.photoChooserAutoRunning"
                atCap={atCap}
                addPolicy="append"
                onAdd={addSuggestions}
                onToggle={toggle}
            >
                <p className="text-xs" role="status">
                    {interp(t('app.photoChooserCount'), { count: selected.length, max: MAX_CHOSEN_PHOTOS })}
                    {atCap && ` ${t('app.photoChooserLimitReached')}`}
                </p>
            </PhotoPickerToolbar>
            <PhotoGrid
                state={state}
                known={known}
                selected={selected}
                hideUnlisted={otherAccount}
                locked={locked}
                hasChallenge={challengeId !== null}
                search={picker.isSearch}
                revalidating={revalidating}
                recheckFailed={recheckFailed}
                loadMore={() => void picker.loadMore()}
                loadingMore={picker.loadingMore}
                loadMoreFailed={picker.loadMoreFailed}
                onToggle={toggle}
                onRetry={retry}
                onRefresh={refreshListing}
                checkingMember={checkPending}
                savedPicks={gateOpen ? { memberId: thumbMember } : null}
                idleKey={idleKey}
                idleWithPicksKey={idleWithPicksKey}
                extraPhotos={picker.suggestedKnown}
                idleMemberId={picker.suggestedMemberId}
                idleIds={picker.idleShown}
                recommendedIds={recommendedIds}
            />
            <StickyModalFooter>
                <ChooserFooter
                    saveFailed={saveFailed}
                    saveWaits={saveWaits}
                    holdReason={holdReasonOf(saved)}
                    retrying={saved.retrying || ownerRetryPending}
                    confirmed={saved.confirmed}
                    locked={locked}
                    onRetryHold={() => {
                        // A failed owner read is retried by reading the record again, never the library.
                        if (saved.failure === 'owner-read-failed') {
                            setOwnerRetryPending(true);
                            void refetchOwner();
                        } else saved.retry();
                    }}
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
 * rank by the picker's own scorer), capped at MAX_CHOSEN_PHOTOS. Nothing is read on
 * opening: the saved picks show once the member check says they are this account's, and
 * Load photos, Search and Auto ask for what they need. `challengeId` makes the listing say whether each
 * photo can enter THAT challenge; without it eligibility is only known at submit
 * time, and Auto is not offered. `onSave` gets the chosen ids and answers whether they were stored: on
 * false (or a throw) the modal stays open on an error. `clearMeansInherit` says
 * that saving nothing removes the list this layer holds, so the layer inherits
 * the one from the settings or rules above it. `canSuggest` (default true) turns
 * Auto off for a challenge the member is not joined in (a Discover row).
 */
export function PhotoChooserModal({
    isOpen,
    onClose,
    value,
    savedCount = value.length,
    challengeId = null,
    clearMeansInherit = false,
    canSuggest = true,
    recommendedIds,
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
    canSuggest?: boolean;
    /** The photo ids GuruShots suggests for the challenge; their tiles carry the recommended mark. */
    recommendedIds?: ReadonlyArray<string>;
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
                    canSuggest={canSuggest}
                    recommendedIds={recommendedIds}
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
