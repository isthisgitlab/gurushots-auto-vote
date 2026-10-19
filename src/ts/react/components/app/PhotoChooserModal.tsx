import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal } from '@/components/ui/Modal';
import { StickyModalFooter } from '@/components/ui/StickyModalFooter';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { interp } from '@/utils/interp';
import { useChosenPhotosOwner } from '@/api/useChosenPhotosOwner';
import { ChooserFooter, SearchForm, holdReasonOf } from './ChooserFooter';
import { OtherAccountNotice } from './OtherAccountNotice';
import { PhotoGrid } from './PhotoGrid';
import { useChooserSave, useOtherAccountLists, useSavedListReread } from '@/hooks/usePhotoChooser';
import { useLibraryListing } from '@/hooks/useLibraryListing';
import * as ipc from '@/api/ipc';
import { MAX_CHOSEN_PHOTOS } from '../../../settings/limits';

import type { AccountCheck } from '@/hooks/usePhotoChooser';

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
