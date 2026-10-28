import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal } from '@/components/ui/Modal';
import { StickyModalFooter } from '@/components/ui/StickyModalFooter';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { PIN_KINDS, pinDraftWithout, pinOf, planPinCommits, toggledPinDraft } from '@/utils/entryPinDraft';
import { useEntryPins } from '@/api/useEntryPins';
import { useAsyncIpcAction } from '@/api/useAsyncIpcAction';
import * as ipc from '@/api/ipc';
import { ipcErrorText } from '@/api/ipcErrorText';
import { ChooserFooter } from './ChooserFooter';
import { PhotoPickerToolbar } from './PhotoPicker';
import { PhotoGrid } from './PhotoGrid';
import { PinToggle } from './PinToggle';
import { useCurrentMember } from '@/hooks/currentMember';
import { useChooserSave } from '@/hooks/usePhotoChooser';
import { usePhotoPicker } from '@/hooks/usePhotoPicker';
import { MAX_CHOSEN_PHOTOS } from '../../../settings/limits';

import type { EntryPinKind } from '../../../types/settings';
import type { PinDraft } from '@/utils/entryPinDraft';
import type { LibraryPhoto } from '@/hooks/useLibraryListing';
import type { Translate } from '../../../translations/translator';

/** A kind's feature name, as the pin strings fill {kind}. */
const kindName = (kind: EntryPinKind, t: Translate): string => t(kind === 'boost' ? 'app.boost' : 'app.turbo');

// The chooser's sticky footer pins the save-error alert and the buttons. Sized for the worst case on a
// phone (320px, Latvian): py-4, a multi-line save-error alert, the gaps and the buttons, about 10-11rem,
// so 12rem, capped at half the viewport height: on a short screen, whose box can be as little as
// ~240-330px tall, it keeps room for the focused control, at the cost of the footer partly covering a tile.
const CHOOSER_SCROLL_PADDING = 'scroll-pb-[min(12rem,50dvh)]';

/**
 * The modal's body. Mounted only while the modal is open, so every opening starts from the saved
 * value. Nothing is read until Load photos, Search or Auto asks for it: the saved picks show as they
 * are saved, and Auto can rank and fill without a read. With a challenge, each selected tile carries
 * a Boost / Turbo pin pair over the challenge's stored pins, and a Save writes the changed pins after
 * the host's save; a failed pin read takes the pair away.
 */
function PhotoChooserBody({
    value,
    challengeId,
    clearMeansInherit,
    recommendedIds,
    onSave,
    onClose,
    unsaved,
}: {
    value: string[];
    challengeId: string | number | null;
    clearMeansInherit: boolean;
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
    const [pinDraft, setPinDraft] = useState<PinDraft>({});
    // The kind(s) whose pin writes failed at the last Save, with the first failure's error code.
    const [pinSaveError, setPinSaveError] = useState<{ kinds: EntryPinKind[]; code: string } | null>(null);
    unsaved.current =
        selected.length !== value.length ||
        selected.some((id, i) => id !== value[i]) ||
        pinDraft.boost !== undefined ||
        pinDraft.turbo !== undefined;
    // The pins of the challenge this chooser was opened for. The stand-in id keeps the hook's types when
    // there is no challenge; `enabled` keeps its read off then.
    const {
        pins: storedPins,
        readPending: pinsPending,
        readError: pinsError,
    } = useEntryPins(challengeId ?? 0, 0, {
        enabled: challengeId !== null,
        readFailureIsError: true,
    });
    const { run: runSetEntryPin } = useAsyncIpcAction(ipc.setEntryPin);
    // Auto shows whenever the chooser names a challenge — the suggest handler resolves un-joined
    // Discover rows from the open/upcoming lists, so a row's chooser ranks too; without a challenge
    // there is nothing to rank for.
    const showAuto = challengeId !== null;
    const picker = usePhotoPicker({ challengeId, usage: 'submit', alwaysFresh: false, selected });
    const { refresh, resetLoadPhotos } = picker;
    // A mirror of the selection the stable `toggle` reads at call time (it must stay identity-stable:
    // the memoised tiles skip their re-render by it).
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const toggle = useCallback((id: string) => {
        if (selectedRef.current.includes(id)) setPinDraft((prev) => pinDraftWithout(prev, id));
        setSelected((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
    }, []);
    const togglePinDraft = (kind: EntryPinKind, imageId: string) =>
        setPinDraft((prev) => toggledPinDraft(prev, storedPins, kind, imageId));
    // Clears a kind's pin at its next Save: the elsewhere line's Clear pin button.
    const clearPinDraft = (kind: EntryPinKind) => setPinDraft((prev) => ({ ...prev, [kind]: null }));

    // The pin writes of a save: the changed kinds `planPinCommits` orders, each attempted once after
    // the host's save (useChooserSave runs them), the failures collected; any failure keeps the
    // chooser open. Only reachable with a challenge — the pin controls, and so a changed draft, exist
    // only for one.
    let commit: (() => Promise<boolean>) | undefined;
    if (challengeId !== null) {
        const challengeKey = challengeId;
        commit = async () => {
            const failures: Array<{ kind: EntryPinKind; code: string }> = [];
            for (const { kind, imageId } of planPinCommits(pinDraft, storedPins)) {
                const outcome = await runSetEntryPin(kind, challengeKey, imageId);
                if (!outcome.success) failures.push({ kind, code: outcome.error });
            }
            if (failures.length > 0) {
                setPinSaveError({ kinds: failures.map((failure) => failure.kind), code: failures[0].code });
                return false;
            }
            return true;
        };
    }

    const { save: hostSave, saving, saveFailed } = useChooserSave(selected, onSave, onClose, commit);
    // A save first clears the last attempt's pin error, so a save that now fails earlier never leaves
    // "your photos were saved" on screen beside the photos-weren't-saved alert.
    const save = () => {
        setPinSaveError(null);
        hostSave();
    };
    const pinSaveErrorText = pinSaveError
        ? t(pinSaveError.kinds.length === 2 ? 'app.photoChooserPinSaveErrorBoth' : 'app.photoChooserPinSaveError', {
              kind: kindName(pinSaveError.kinds[0], t),
              reason: ipcErrorText(pinSaveError.code, t),
          })
        : undefined;
    const atCap = selected.length >= MAX_CHOSEN_PHOTOS;
    const idleKey = showAuto ? 'app.photoChooserIdleAuto' : 'app.photoChooserIdle';
    const idleWithPicksKey = showAuto ? 'app.photoChooserIdlePicksAuto' : 'app.photoChooserIdlePicks';
    const helpKey = showAuto ? 'app.photoChooserHelpAuto' : 'app.photoChooserHelpNoChallenge';
    // One help line the pin toggles name (aria-describedby); a failed read takes the toggles, and with them
    // the line, away.
    const pinHelpId = useId();
    // A stored pin that names a photo outside the selection (an entry pinned on the card, say) stays as it is
    // — until a chosen photo is pinned for that kind, which is what saving writes instead.
    const elsewhereKinds = PIN_KINDS.filter((kind) => {
        const pinned = pinOf(pinDraft, storedPins, kind);
        return pinned !== null && !selected.includes(pinned);
    });

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
                    {t('app.photoChooserCount', { count: selected.length, max: MAX_CHOSEN_PHOTOS })}
                    {atCap && ` ${t('app.photoChooserLimitReached')}`}
                </p>
            </PhotoPickerToolbar>
            {challengeId !== null &&
                (pinsError !== null ? (
                    <div role="alert" className="alert alert-warning py-2 text-sm">
                        <span>{t('app.photoChooserPinsUnreadable')}</span>
                    </div>
                ) : (
                    <>
                        <p id={pinHelpId} className="text-base-content/70 text-xs">
                            {t('app.photoChooserPinHelp')}
                        </p>
                        {elsewhereKinds.map((kind) => (
                            <p key={kind} className="text-base-content/70 flex items-center gap-2 text-xs">
                                <span>{t('app.photoChooserPinElsewhere', { kind: kindName(kind, t) })}</span>
                                <button type="button" className="btn btn-xs" onClick={() => clearPinDraft(kind)}>
                                    {t('app.pinClear')}
                                </button>
                            </p>
                        ))}
                    </>
                ))}
            <PhotoGrid
                picker={picker}
                selected={selected}
                locked={false}
                hasChallenge={challengeId !== null}
                onToggle={toggle}
                onRefresh={refreshListing}
                savedPicks={{ memberId: picker.suggestedMemberId ?? currentMember }}
                idleKey={idleKey}
                idleWithPicksKey={idleWithPicksKey}
                recommendedIds={recommendedIds}
                tileSlot={
                    challengeId !== null && pinsError === null
                        ? (id) =>
                              selected.includes(id) ? (
                                  <div
                                      role="group"
                                      aria-label={t('app.photoChooserPinGroup', {
                                          n: selected.indexOf(id) + 1,
                                      })}
                                      className="flex flex-wrap gap-1"
                                  >
                                      {PIN_KINDS.map((kind) => (
                                          <PinToggle
                                              key={kind}
                                              kind={kind}
                                              pressed={pinOf(pinDraft, storedPins, kind) === id}
                                              busy={pinsPending}
                                              describedBy={pinHelpId}
                                              onToggle={() => togglePinDraft(kind, id)}
                                          />
                                      ))}
                                  </div>
                              ) : null
                        : undefined
                }
            />
            <StickyModalFooter>
                <ChooserFooter
                    saveFailed={saveFailed}
                    saveError={pinSaveErrorText}
                    saving={saving}
                    onSave={save}
                    onClear={() => {
                        setSelected([]);
                        setPinDraft({});
                    }}
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
 * false (or a throw) the modal stays open on an error. With a `challengeId`, saving also writes the
 * draft's Boost / Turbo pins (a failed pin write keeps the modal open on its own error). `clearMeansInherit` says
 * that saving nothing removes the list this layer holds, so the layer inherits
 * the one from the settings or rules above it. Auto is offered whenever a `challengeId` is given (the
 * suggest handler resolves un-joined Discover rows too); without one it is not offered.
 */
export function PhotoChooserModal({
    isOpen,
    onClose,
    value,
    challengeId = null,
    clearMeansInherit = false,
    recommendedIds,
    onSave,
}: {
    isOpen: boolean;
    onClose: () => void;
    value: string[];
    challengeId?: string | number | null;
    clearMeansInherit?: boolean;
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
