import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useChallenges } from '@/contexts/ChallengesContext';
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
import { MAX_CHOSEN_PHOTOS } from '../../../core/settings/limits';
import { applyPinToRecord, canStillFire } from '../../../core/voting/entryPins';

import type { Challenge } from '../../../core/types/gurushots';
import type { EntryPinKind, EntryPinRecord, EntryPins } from '../../../core/types/settings';
import type { PinDraft } from '@/utils/entryPinDraft';
import type { LibraryPhoto } from '@/hooks/useLibraryListing';
import type { Translate } from '../../../core/translations/translator';

type PinAvailability = Record<EntryPinKind, boolean>;

const observedChallenges = (
    challenges: readonly Challenge[],
    challengeId: string | number | null,
    fallback?: Challenge | null,
): Challenge[] => {
    if (challengeId === null) return [];
    const sameId = (candidate: Challenge): boolean => String(candidate.id) === String(challengeId);
    return [
        ...challenges.filter(sameId),
        ...(fallback !== undefined && fallback !== null && sameId(fallback) ? [fallback] : []),
    ];
};

const pinAvailability = (challenges: readonly Challenge[]): PinAvailability => ({
    boost: challenges.length > 0 && challenges.every((challenge) => canStillFire(challenge, 'boost')),
    turbo: challenges.length > 0 && challenges.every((challenge) => canStillFire(challenge, 'turbo')),
});

const canAssignPin = (availability: PinAvailability, kind: EntryPinKind): boolean => availability[kind];

const useChooserPinAvailability = (challengeId: string | number | null, fallback?: Challenge | null) => {
    const { challenges } = useChallenges();
    const availability = pinAvailability(observedChallenges(challenges, challengeId, fallback));
    const latestAvailability = useRef(availability);
    latestAvailability.current = availability;
    return { availability, latestAvailability };
};

const useChooserPinDraft = (storedPins: EntryPins) => {
    const [pinDraft, setPinDraft] = useState<PinDraft>({});
    const [confirmedPins, setConfirmedPins] = useState<EntryPins | null>(null);
    const storedPinsRef = useRef(storedPins);
    const confirmedPinsRef = useRef<EntryPins | null>(null);
    storedPinsRef.current = storedPins;
    const effectivePins = confirmedPins ?? storedPins;
    const directClearKinds = useRef<Set<EntryPinKind>>(new Set());
    const togglePinDraft = (kind: EntryPinKind, imageId: string) =>
        setPinDraft((prev) => {
            if (pinOf(prev, effectivePins, kind) === imageId) directClearKinds.current.add(kind);
            else directClearKinds.current.delete(kind);
            return toggledPinDraft(prev, effectivePins, kind, imageId);
        });
    const clearPinDraft = (kind: EntryPinKind) => {
        directClearKinds.current.add(kind);
        setPinDraft((prev) => {
            const next = { ...prev };
            if (effectivePins[kind] === null) delete next[kind];
            else next[kind] = null;
            return next;
        });
    };
    const markCommitted = (kind: EntryPinKind, imageId: string | null) => {
        const current = confirmedPinsRef.current ?? storedPinsRef.current;
        const record: EntryPinRecord = {};
        for (const currentKind of PIN_KINDS) {
            if (current[currentKind] !== null) record[currentKind] = current[currentKind];
        }
        applyPinToRecord(record, kind, imageId);
        const nextPins = { boost: record.boost ?? null, turbo: record.turbo ?? null };
        confirmedPinsRef.current = nextPins;
        setConfirmedPins(nextPins);
        directClearKinds.current.delete(kind);
        setPinDraft((prev) => {
            const next = { ...prev };
            delete next[kind];
            const other = kind === 'boost' ? 'turbo' : 'boost';
            if (imageId !== null && current[other] === imageId && next[other] === null) delete next[other];
            return next;
        });
    };
    const resetPinDraft = () => {
        directClearKinds.current.clear();
        setPinDraft({});
    };
    const removePhoto = useCallback((imageId: string) => setPinDraft((prev) => pinDraftWithout(prev, imageId)), []);
    return {
        pinDraft,
        effectivePins,
        directClearKinds,
        togglePinDraft,
        clearPinDraft,
        markCommitted,
        resetPinDraft,
        removePhoto,
    };
};

type SetEntryPin = (
    ...args: Parameters<typeof ipc.setEntryPin>
) => Promise<Awaited<ReturnType<typeof ipc.setEntryPin>> | { success: false; error: string }>;

type PinWriteFailure = { kind: EntryPinKind; code: string };

type PinCommitState = {
    commits: ReturnType<typeof planPinCommits>;
    failures: PinWriteFailure[];
};

type PinCommitContext = {
    draft: PinDraft;
    storedPins: EntryPins;
    latestAvailability: { current: PinAvailability };
    directClearKinds: ReadonlySet<EntryPinKind>;
    runSetEntryPin: SetEntryPin;
    challengeId: string | number;
    onFailure: (failures: PinWriteFailure[]) => void;
    onCommitted: (kind: EntryPinKind, imageId: string | null) => void;
};

const writePlannedPinCommits = async ({
    draft,
    storedPins,
    latestAvailability,
    runSetEntryPin,
    challengeId,
    onCommitted,
}: PinCommitContext): Promise<PinCommitState> => {
    const state: PinCommitState = { commits: planPinCommits(draft, storedPins), failures: [] };
    const markUnavailable = (kind: EntryPinKind) => {
        state.failures.push({ kind, code: 'unavailable' });
    };
    for (const { kind, imageId } of state.commits) {
        if (imageId !== null && !canAssignPin(latestAvailability.current, kind)) {
            markUnavailable(kind);
            continue;
        }
        const outcome = await runSetEntryPin(kind, challengeId, imageId);
        if (!outcome.success) {
            state.failures.push({ kind, code: outcome.error });
            continue;
        }
        onCommitted(kind, imageId);
    }
    return state;
};

const writeBlockedDirectClears = async (
    { draft, directClearKinds, runSetEntryPin, challengeId, onCommitted }: PinCommitContext,
    state: PinCommitState,
): Promise<void> => {
    for (const kind of PIN_KINDS) {
        const other = kind === 'boost' ? 'turbo' : 'boost';
        if (
            state.failures.some((failure) => failure.kind === other) &&
            directClearKinds.has(kind) &&
            draft[kind] === null &&
            !state.commits.some((commit) => commit.kind === kind)
        ) {
            const outcome = await runSetEntryPin(kind, challengeId, null);
            if (!outcome.success) state.failures.push({ kind, code: outcome.error });
            else onCommitted(kind, null);
        }
    }
};

const writeEligiblePinCommits = async (context: PinCommitContext): Promise<boolean> => {
    if (planPinCommits(context.draft, context.storedPins).length === 0) return true;
    const state = await writePlannedPinCommits(context);
    await writeBlockedDirectClears(context, state);
    if (state.failures.length === 0) return true;
    context.onFailure(state.failures);
    return false;
};

type PinCommitInput = Omit<PinCommitContext, 'challengeId'> & { challengeId: string | number | null };

const createPinCommit = ({ challengeId, ...context }: PinCommitInput): (() => Promise<boolean>) | undefined => {
    if (challengeId === null) return undefined;
    return () => writeEligiblePinCommits({ ...context, challengeId });
};

/** A kind's feature name, as the pin strings fill {kind}. */
const kindName = (kind: EntryPinKind, t: Translate): string => t(kind === 'boost' ? 'app.boost' : 'app.turbo');

const pinSaveErrorText = (failures: PinWriteFailure[] | null, t: Translate): string | undefined => {
    if (failures === null) return undefined;
    const reason = (failure: PinWriteFailure) =>
        failure.code === 'unavailable' ? t('app.unavailable') : ipcErrorText(failure.code, t);
    if (failures.length === 2 && failures[0].code === failures[1].code) {
        return t('app.photoChooserPinSaveErrorBoth', { reason: reason(failures[0]) });
    }
    return failures
        .map((failure) =>
            t('app.photoChooserPinSaveError', { kind: kindName(failure.kind, t), reason: reason(failure) }),
        )
        .join(' ');
};

function PinClearRows({
    kinds,
    draft,
    storedPins,
    selected,
    t,
    onClear,
}: {
    kinds: EntryPinKind[];
    draft: PinDraft;
    storedPins: { boost: string | null; turbo: string | null };
    selected: string[];
    t: Translate;
    onClear: (kind: EntryPinKind) => void;
}) {
    return kinds.map((kind) => {
        const pinned = pinOf(draft, storedPins, kind);
        const text =
            pinned !== null && selected.includes(pinned)
                ? t(kind === 'boost' ? 'app.pinnedForBoost' : 'app.pinnedForTurbo')
                : t('app.photoChooserPinElsewhere', { kind: kindName(kind, t) });
        return (
            <p key={kind} className="text-base-content/70 flex items-center gap-2 text-xs">
                <span>{text}</span>
                <button type="button" className="btn btn-xs" onClick={() => onClear(kind)}>
                    {t('app.pinClear')}
                </button>
            </p>
        );
    });
}

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
    challenge,
    recommendedIds,
    onSave,
    onClose,
    unsaved,
}: {
    value: string[];
    challengeId: string | number | null;
    clearMeansInherit: boolean;
    /** Discover's row until its active-challenge counterpart arrives in the shared context. */
    challenge?: Challenge | null;
    /** The photo ids GuruShots suggests for the challenge, marked on their tiles (a Discover row's chooser). */
    recommendedIds?: ReadonlyArray<string>;
    onSave: (ids: string[]) => boolean | Promise<boolean>;
    onClose: () => void;
    /** Kept up to date with whether the selection differs from the list it started from (the saved one). */
    unsaved: { current: boolean };
}) {
    const { t } = useTranslation();
    const { availability, latestAvailability } = useChooserPinAvailability(challengeId, challenge);
    // The member the page has already seen, so the saved picks show their thumbnails before any Auto run.
    const currentMember = useCurrentMember();
    const [selected, setSelected] = useState<string[]>(value);
    // The pin writes that failed at the last Save, retaining each kind and reason.
    const [pinSaveError, setPinSaveError] = useState<PinWriteFailure[] | null>(null);
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
    const {
        pinDraft,
        effectivePins,
        directClearKinds,
        togglePinDraft,
        clearPinDraft,
        markCommitted,
        resetPinDraft,
        removePhoto,
    } = useChooserPinDraft(storedPins);
    unsaved.current =
        selected.length !== value.length ||
        selected.some((id, i) => id !== value[i]) ||
        pinDraft.boost !== undefined ||
        pinDraft.turbo !== undefined;
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
    const toggle = useCallback(
        (id: string) => {
            if (selectedRef.current.includes(id)) removePhoto(id);
            setSelected((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
        },
        [removePhoto],
    );
    // The pin writes of a save: the changed kinds `planPinCommits` orders, each attempted once after
    // the host's save (useChooserSave runs them), the failures collected; any failure keeps the
    // chooser open. Only reachable with a challenge — the pin controls, and so a changed draft, exist
    // only for one.
    const commit = createPinCommit({
        draft: pinDraft,
        storedPins: effectivePins,
        latestAvailability,
        directClearKinds: directClearKinds.current,
        runSetEntryPin,
        challengeId,
        onFailure: setPinSaveError,
        onCommitted: markCommitted,
    });

    const { save: hostSave, saving, saveFailed } = useChooserSave(selected, onSave, onClose, commit);
    // A save first clears the last attempt's pin error, so a save that now fails earlier never leaves
    // "your photos were saved" on screen beside the photos-weren't-saved alert.
    const save = () => {
        setPinSaveError(null);
        hostSave();
    };
    const saveError = pinSaveErrorText(pinSaveError, t);
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
        const pinned = pinOf(pinDraft, effectivePins, kind);
        return pinned !== null && (!selected.includes(pinned) || !canAssignPin(availability, kind));
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
                        <PinClearRows
                            kinds={elsewhereKinds}
                            draft={pinDraft}
                            storedPins={effectivePins}
                            selected={selected}
                            t={t}
                            onClear={clearPinDraft}
                        />
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
                    challengeId !== null &&
                    pinsError === null &&
                    PIN_KINDS.some((kind) => canAssignPin(availability, kind))
                        ? (id) =>
                              selected.includes(id) ? (
                                  <div
                                      role="group"
                                      aria-label={t('app.photoChooserPinGroup', {
                                          n: selected.indexOf(id) + 1,
                                      })}
                                      className="flex flex-wrap gap-1"
                                  >
                                      {PIN_KINDS.filter((kind) => canAssignPin(availability, kind)).map((kind) => (
                                          <PinToggle
                                              key={kind}
                                              kind={kind}
                                              pressed={pinOf(pinDraft, effectivePins, kind) === id}
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
                    saveError={saveError}
                    saving={saving}
                    onSave={save}
                    onClear={() => {
                        setSelected([]);
                        resetPinDraft();
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
    challenge,
    recommendedIds,
    onSave,
}: {
    isOpen: boolean;
    onClose: () => void;
    value: string[];
    challengeId?: string | number | null;
    clearMeansInherit?: boolean;
    challenge?: Challenge | null;
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
                    challenge={challenge}
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
