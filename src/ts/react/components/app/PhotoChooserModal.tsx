import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal } from '@/components/ui/Modal';
import { StickyModalFooter } from '@/components/ui/StickyModalFooter';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { interp } from '@/utils/interp';
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

import type { EntryPinKind, EntryPins } from '../../../types/settings';
import type { LibraryPhoto } from '@/hooks/useLibraryListing';

// The two features a chosen photo can be pinned for, in save order.
const PIN_KINDS = ['boost', 'turbo'] as const;

/** A kind's feature name, as the pin strings fill {kind}. */
const kindName = (kind: EntryPinKind, t: (key: string) => string): string =>
    t(kind === 'boost' ? 'app.boost' : 'app.turbo');

/**
 * The chooser's pin draft: per kind the pin to save (an id, or null to clear), or absent while the kind
 * is still what the stored pins say.
 */
type PinDraft = { [K in EntryPinKind]?: string | null };

/** The pin a kind would save: the draft's value when it has one, the stored pin otherwise. */
const pinOf = (draft: PinDraft, stored: EntryPins, kind: EntryPinKind): string | null => {
    const value = draft[kind];
    return value === undefined ? stored[kind] : value;
};

/**
 * The draft after a toggle of `imageId` for `kind`, mirroring setEntryPin: pinning a photo for one kind
 * clears the other kind when it names the same photo, and a draft value equal to the stored pin is dropped,
 * so a toggle taken back is no unsaved change.
 */
const toggledPinDraft = (prev: PinDraft, stored: EntryPins, kind: EntryPinKind, imageId: string): PinDraft => {
    const other: EntryPinKind = kind === 'boost' ? 'turbo' : 'boost';
    const next: PinDraft = { ...prev };
    next[kind] = pinOf(prev, stored, kind) === imageId ? null : imageId;
    if (next[kind] !== null && pinOf(prev, stored, other) === imageId) next[other] = null;
    for (const changed of [kind, other]) {
        if (next[changed] === stored[changed]) delete next[changed];
    }
    return next;
};

/** The draft after `imageId` left the selection: a pin naming it — draft or stored — is cleared. */
const pinDraftWithout = (prev: PinDraft, stored: EntryPins, imageId: string): PinDraft => {
    const next: PinDraft = { ...prev };
    for (const kind of PIN_KINDS) {
        next[kind] = pinOf(prev, stored, kind) === imageId ? null : next[kind];
        if (next[kind] === stored[kind]) {
            delete next[kind];
        }
    }
    return next;
};

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
    const [pinDraft, setPinDraft] = useState<PinDraft>({});
    // The kind whose pin write failed at the last Save, with the handler's error code.
    const [pinSaveError, setPinSaveError] = useState<{ kind: EntryPinKind; code: string } | null>(null);
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
    // Auto ranks for a challenge the photos could be entered into: a Discover row's challenge is not
    // joined, so it cannot (suggestPhotos would answer challenge-ended).
    const showAuto = canSuggest && challengeId !== null;
    const picker = usePhotoPicker({ challengeId, usage: 'submit', alwaysFresh: false, selected });
    const { state, known, revalidating, recheckFailed, retry, refresh, resetLoadPhotos } = picker;
    // Mirrors of the state a stable `toggle` reads at call time (it must stay identity-stable: the memoised
    // tiles skip their re-render by it).
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const storedPinsRef = useRef(storedPins);
    storedPinsRef.current = storedPins;
    const toggle = useCallback((id: string) => {
        if (selectedRef.current.includes(id)) setPinDraft((prev) => pinDraftWithout(prev, storedPinsRef.current, id));
        setSelected((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
    }, []);
    const togglePinDraft = (kind: EntryPinKind, imageId: string) =>
        setPinDraft((prev) => toggledPinDraft(prev, storedPins, kind, imageId));

    // The pin writes of a save: each kind the draft changed, once, after the host's save (useChooserSave runs
    // them). Only reachable with a challenge — the pin controls, and so a changed draft, exist only for one.
    let commit: (() => Promise<boolean>) | undefined;
    if (challengeId !== null) {
        const challengeKey = challengeId;
        commit = async () => {
            for (const kind of PIN_KINDS) {
                const next = pinDraft[kind];
                if (next === undefined) continue;
                const outcome = await runSetEntryPin(kind, challengeKey, next);
                if (!outcome.success) {
                    setPinSaveError({ kind, code: outcome.error });
                    return false;
                }
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
        ? interp(t('app.photoChooserPinSaveError'), {
              kind: kindName(pinSaveError.kind, t),
              reason: ipcErrorText(pinSaveError.code, t),
          })
        : undefined;
    const atCap = selected.length >= MAX_CHOSEN_PHOTOS;
    const idleKey = showAuto ? 'app.photoChooserIdleAuto' : 'app.photoChooserIdle';
    const idleWithPicksKey = showAuto ? 'app.photoChooserIdlePicksAuto' : 'app.photoChooserIdlePicks';
    const helpKey = showAuto
        ? 'app.photoChooserHelpAuto'
        : challengeId !== null
          ? 'app.photoChooserHelpChallenge'
          : 'app.photoChooserHelpNoChallenge';
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
                    {interp(t('app.photoChooserCount'), { count: selected.length, max: MAX_CHOSEN_PHOTOS })}
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
                            <p key={kind} className="text-base-content/70 text-xs">
                                {interp(t('app.photoChooserPinElsewhere'), { kind: kindName(kind, t) })}
                            </p>
                        ))}
                    </>
                ))}
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
                tileSlot={
                    challengeId !== null && pinsError === null
                        ? (id) =>
                              selected.includes(id) ? (
                                  <div className="flex flex-wrap gap-1">
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
