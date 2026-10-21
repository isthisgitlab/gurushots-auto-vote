import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal } from '@/components/ui/Modal';
import { StickyModalFooter } from '@/components/ui/StickyModalFooter';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { interp } from '@/utils/interp';
import { ChooserFooter } from './ChooserFooter';
import { PhotoPickerToolbar } from './PhotoPicker';
import { PhotoGrid } from './PhotoGrid';
import { useCurrentMember } from '@/hooks/currentMember';
import { useChooserSave } from '@/hooks/usePhotoChooser';
import { usePhotoPicker } from '@/hooks/usePhotoPicker';
import { MAX_CHOSEN_PHOTOS } from '../../../settings/limits';

import type { LibraryPhoto } from '@/hooks/useLibraryListing';

// The chooser's sticky footer pins the save-error alert and the buttons. Sized for the worst case on a
// phone (320px, Latvian): py-4, a multi-line save-error alert, the gaps and the buttons, about 10-11rem,
// so 12rem, capped at half the viewport height: on a short screen, whose box can be as little as
// ~240-330px tall, it keeps room for the focused control, at the cost of the footer partly covering a tile.
const CHOOSER_SCROLL_PADDING = 'scroll-pb-[min(12rem,50dvh)]';

/**
 * The modal's body. Mounted only while the modal is open, so every opening starts from the saved
 * value. Nothing is read until Load photos, Search or Auto asks for it: the saved picks show as they
 * are saved, and Auto can rank and fill without a read.
 */
function PhotoChooserBody({
    value,
    challengeId,
    clearMeansInherit,
    canSuggest,
    recommendedIds,
    onSave,
    onClose,
    unsaved,
}: {
    value: string[];
    challengeId: string | number | null;
    clearMeansInherit: boolean;
    canSuggest: boolean;
    /** The photo ids GuruShots suggests for the challenge, marked on their tiles (a Discover row's chooser). */
    recommendedIds?: ReadonlyArray<string>;
    onSave: (ids: string[]) => boolean | Promise<boolean>;
    onClose: () => void;
    /** Kept up to date with whether the selection differs from the list it started from (the saved one). */
    unsaved: { current: boolean };
}) {
    const { t } = useTranslation();
    // The member the page has already seen, so the saved picks show their thumbnails before any Auto run.
    const currentMember = useCurrentMember();
    const [selected, setSelected] = useState<string[]>(value);
    unsaved.current = selected.length !== value.length || selected.some((id, i) => id !== value[i]);
    // Auto ranks for a challenge the photos could be entered into: a Discover row's challenge is not
    // joined, so it cannot (suggestPhotos would answer challenge-ended).
    const showAuto = canSuggest && challengeId !== null;
    const picker = usePhotoPicker({ challengeId, usage: 'submit', alwaysFresh: false, selected });
    const { state, known, revalidating, recheckFailed, retry, refresh, resetLoadPhotos } = picker;
    const toggle = useCallback((id: string) => {
        setSelected((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
    }, []);

    const { save, saving, saveFailed } = useChooserSave(selected, onSave, onClose);
    const atCap = selected.length >= MAX_CHOSEN_PHOTOS;
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
            <PhotoPickerToolbar
                picker={picker}
                selected={selected}
                canSuggest={showAuto}
                held={false}
                locked={false}
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
                locked={false}
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
                savedPicks={{ memberId: picker.suggestedMemberId ?? currentMember }}
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
 * opening: the saved picks show as saved, and Load photos, Search and Auto ask for
 * what they need. `challengeId` makes the listing say whether each
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
    challengeId = null,
    clearMeansInherit = false,
    canSuggest = true,
    recommendedIds,
    onSave,
}: {
    isOpen: boolean;
    onClose: () => void;
    value: string[];
    challengeId?: string | number | null;
    clearMeansInherit?: boolean;
    canSuggest?: boolean;
    /** The photo ids GuruShots suggests for the challenge; their tiles carry the recommended mark. */
    recommendedIds?: ReadonlyArray<string>;
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
                    challengeId={challengeId}
                    clearMeansInherit={clearMeansInherit}
                    canSuggest={canSuggest}
                    recommendedIds={recommendedIds}
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
