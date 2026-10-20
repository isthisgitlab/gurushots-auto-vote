import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { StickyModalFooter, STICKY_FOOTER_SCROLL_PADDING } from '@/components/ui/StickyModalFooter';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import { interp } from '@/utils/interp';
import { usePhotoPicker } from '@/hooks/usePhotoPicker';
import { PhotoPickerToolbar } from './PhotoPicker';
import { PhotoGrid } from './PhotoGrid';

import type { LibraryPhoto } from '@/hooks/useLibraryListing';
import type { LibraryUsage } from '../../../types/photoPicker';

/**
 * What a submit came to: `done` (submitted, the modal closes), `refreshed` (it failed and the card was
 * refreshed, so the listing is read again too) or `failed` (nothing changed).
 */
export type PickOutcome = 'done' | 'refreshed' | 'failed';

/**
 * The translation keys of every line the modal's body and title read. The default is the Pick… submit's;
 * another use (the swap picker) names its own.
 */
export type PickTexts = {
    title: string;
    help: string;
    count: string;
    overCap: string;
    submit: string;
    submitCount: string;
    full: string;
    noSlots: string;
    autoHelp: string;
    autoRunning: string;
    idleWithPicks: string;
};

/** Photos the modal shows as blocked (ids) and the translation key of what their tiles say. */
export type BlockedPhotos = { ids: ReadonlySet<string>; reasonKey: string };

export const PICK_TEXTS: PickTexts = {
    title: 'app.pickTitle',
    help: 'app.pickHelp',
    count: 'app.pickCount',
    overCap: 'app.pickOverCap',
    submit: 'app.pickSubmit',
    submitCount: 'app.pickSubmitCount',
    full: 'app.pickFull',
    noSlots: 'app.pickNoSlots',
    autoHelp: 'app.pickAutoHelp',
    autoRunning: 'app.pickAutoRunning',
    idleWithPicks: 'app.pickIdleWithPicks',
};

/**
 * Cancel and Submit: Submit names how many are picked and is held with none, while the pick cannot be sent
 * (over the cap, or a listing asked for is being read or failed), or while sending.
 */
function SubmitFooter({
    count,
    held,
    submitting,
    texts,
    onSubmit,
    onCancel,
}: {
    count: number;
    held: boolean;
    submitting: boolean;
    texts: PickTexts;
    onSubmit: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    const label = count > 0 ? interp(t(texts.submitCount), { count }) : t(texts.submit);
    return (
        <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-outline btn-sm" disabled={submitting} onClick={onCancel}>
                {t('app.cancel')}
            </button>
            <button
                type="button"
                className="btn btn-neutral btn-sm"
                disabled={count === 0 || held || submitting}
                aria-busy={submitting}
                onClick={onSubmit}
            >
                <BusyContent busy={submitting} label={label}>
                    {label}
                </BusyContent>
            </button>
        </div>
    );
}

/**
 * The modal's body. Mounted only while the modal is open, so every opening starts with nothing picked.
 * No listing is read until Load all, Search or a Retry asks for one, and Auto's picks can be sent without it.
 * `usage` is what the listing and Auto read eligibility for. `max` is the card's live count of open slots: it
 * can shrink while the modal is open.
 */
function PhotoSubmitBody({
    challengeId,
    max,
    submitting,
    error,
    texts,
    notice,
    blocked,
    usage,
    onSubmit,
    onClose,
}: {
    challengeId: string | number;
    max: number;
    submitting: boolean;
    error: string | null;
    texts: PickTexts;
    notice: string | null;
    blocked?: BlockedPhotos;
    usage: LibraryUsage;
    onSubmit: (imageIds: string[]) => Promise<PickOutcome>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [selected, setSelected] = useState<string[]>([]);
    // Marks read before an action of this window (a join, a submit) are not to be trusted: a cached listing
    // always comes back as a preview, and picking waits for the fresh read.
    const picker = usePhotoPicker({ challengeId, usage, alwaysFresh: true, selected });
    const { state, known, retry, refresh, resetLoadAll } = picker;
    const preview = state.status === 'ready' && state.listing.preview;
    // Once a listing is shown, until the app has checked which photos the challenge accepts, none can be picked or
    // sent. An idle one shows none: Auto's picks are ranked against the live challenge's eligible photos.
    const checking = preview || picker.recheckFailed;

    // The generation of the read a failed submit asked for (or a Refresh): once a listing of that generation (or
    // later) is in, photos it says can no longer be entered leave the pick. Load all and Search do not set it, so a
    // pick that one of those reads marks refused stays on screen with its reason (the grid shows a pick whatever its
    // mark). Null when nothing is waiting.
    const pruneFromRef = useRef<number | null>(null);

    // Photos taken out of the pick stay on screen with their reason until the next listing replaces this one.
    const onScreen = state.status === 'ready' ? state.listing : null;
    const [takenBack, setTakenBack] = useState<{ listing: typeof onScreen; ids: ReadonlySet<string> }>({
        listing: null,
        ids: new Set(),
    });
    const keepIds = takenBack.listing === onScreen ? takenBack.ids : undefined;
    const current = useRef({ selected, onScreen });
    // The latest pick and listing, for `toggle`, which must stay the same function between renders.
    useLayoutEffect(() => {
        current.current = { selected, onScreen };
    });

    // Records photos taken out of the pick (taken back, or replaced with one slot) for the listing on screen.
    const keepShown = useCallback((ids: readonly string[]) => {
        if (ids.length === 0) return;
        const listing = current.current.onScreen;
        setTakenBack((prev) => ({
            listing,
            ids: new Set([...(prev.listing === listing ? prev.ids : []), ...ids]),
        }));
    }, []);

    // With one slot a tap swaps the pick instead of being refused. The pick is what is being sent while a
    // submit is in flight, so it does not change then.
    const toggle = useCallback(
        (id: string) => {
            if (submitting) return;
            const picked = current.current.selected;
            // Taps take back a picked photo; with one slot they also replace the pick.
            keepShown(picked.includes(id) ? [id] : max === 1 ? picked : []);
            setSelected((prev) => {
                if (prev.includes(id)) return prev.filter((other) => other !== id);
                return max === 1 ? [id] : [...prev, id];
            });
        },
        [max, submitting, keepShown],
    );

    useEffect(() => {
        const from = pruneFromRef.current;
        // `generation < from`: a guard for a read that has not landed yet (defence in depth). A preview, or a
        // listing still being read again, says nothing about what the challenge accepts yet, and the pick is what
        // is being sent while a submit is in flight.
        if (from === null || state.status !== 'ready' || picker.generation < from || checking || picker.revalidating)
            return;
        if (submitting) return;
        pruneFromRef.current = null;
        if (!state.listing.allowedKnown) return;
        // A photo that has won since the last read is left out of the listing, so `known` still has it as allowed.
        const won = new Set(state.listing.wonIds);
        setSelected((prev) => {
            const kept = prev.filter((id) => known.get(id)?.allowed !== false && !won.has(id));
            return kept.length === prev.length ? prev : kept;
        });
    }, [state, known, picker.generation, checking, picker.revalidating, submitting]);

    // After a Refresh answers, the pick is checked against the listing it brought, as after a refused submit.
    const refreshListing = () => {
        resetLoadAll();
        pruneFromRef.current = refresh();
    };

    const submit = () => {
        void (async () => {
            if ((await onSubmit(selected)) === 'refreshed') {
                resetLoadAll();
                pruneFromRef.current = retry();
            }
        })();
    };

    // Adds the best suggestions not picked yet to the free slots, never taking a hand pick out. With one slot
    // it swaps the pick for the best one, as a tap does.
    const addSuggestions = (photos: LibraryPhoto[]) => {
        const ranked = photos.map((photo) => photo.id);
        if (max === 1) keepShown(selected.filter((id) => id !== ranked[0]));
        setSelected((prev) => {
            if (max === 1) return ranked.slice(0, 1);
            const added = ranked.filter((id) => !prev.includes(id)).slice(0, Math.max(0, max - prev.length));
            return [...prev, ...added];
        });
    };

    const alert = error && (
        <div role="alert" className="alert alert-error py-2 text-sm">
            <span>{error}</span>
        </div>
    );

    if (max < 1) {
        return (
            <div className="space-y-3">
                <p className="text-sm" role="status">
                    {t(texts.noSlots)}
                </p>
                <ModalActions>
                    <button type="button" className="btn btn-outline btn-sm" disabled={submitting} onClick={onClose}>
                        {t('app.close')}
                    </button>
                </ModalActions>
            </div>
        );
    }

    // A tap while a submit is in flight does nothing (see toggle): the tiles say so instead of ignoring it.
    const locked = checking || submitting;
    const lockedKey = submitting ? 'app.pickTileSubmitting' : 'app.pickTileLocked';
    const over = selected.length > max;
    // With one slot the modal swaps the pick, so nothing is ever "full".
    const full = max !== 1 && selected.length >= max;
    return (
        <div className="space-y-3">
            {notice && (
                <div role="status" className="alert alert-info py-2 text-sm">
                    <span>{notice}</span>
                </div>
            )}
            <PhotoPickerToolbar
                picker={picker}
                selected={selected}
                canSuggest
                held={submitting}
                locked={locked}
                lockedKey={lockedKey}
                fullKey={texts.full}
                helpKey={texts.help}
                autoHelpKey={texts.autoHelp}
                autoRunningKey={texts.autoRunning}
                atCap={full}
                addPolicy={max === 1 ? 'swap-one' : 'append'}
                onAdd={addSuggestions}
                onToggle={toggle}
            >
                <p className="text-xs" role="status">
                    {interp(t(over ? texts.overCap : texts.count), { count: selected.length, max })}
                </p>
            </PhotoPickerToolbar>
            <PhotoGrid
                state={state}
                known={known}
                selected={selected}
                hideUnlisted={false}
                locked={locked}
                lockedKey={lockedKey}
                hasChallenge
                revalidating={picker.revalidating}
                recheckFailed={picker.recheckFailed}
                submit
                refreshDisabled={submitting}
                onToggle={toggle}
                onRetry={retry}
                onRefresh={refreshListing}
                // With one slot the modal swaps the pick, so the grid never stops offering tiles.
                max={max === 1 ? Number.POSITIVE_INFINITY : max}
                fullKey={texts.full}
                blockedIds={blocked?.ids}
                blockedKey={blocked?.reasonKey}
                numbered={false}
                extraPhotos={picker.suggestedKnown}
                idleMemberId={picker.suggestedMemberId}
                idleIds={picker.idleShown}
                idleWithPicksKey={texts.idleWithPicks}
                keepIds={keepIds}
            />
            <StickyModalFooter>
                {alert}
                <SubmitFooter
                    count={selected.length}
                    held={over || checking || (state.status !== 'ready' && state.status !== 'idle')}
                    submitting={submitting}
                    texts={texts}
                    onSubmit={submit}
                    onCancel={onClose}
                />
            </StickyModalFooter>
        </div>
    );
}

/**
 * Pick photos from the member's library and submit them to one challenge right away: the picker of the
 * Chosen Photos chooser, without saving anything. Nothing is read on opening: Load all, Search and Auto (which
 * ranks the photos under the auto-submit rules and shows the best) ask for what they need. Owned by the card's
 * actions (not by the buttons that open it), so a refresh that closes the buttons' gate cannot drop it or the
 * answer to a submit in flight. While a submit is in flight nothing can close it.
 *
 * @param max - the card's live count of open slots
 * @param error - the translated text of the last failed submit
 * @param texts - the translation keys of the title and every line of the body (the Pick… submit's by default)
 * @param notice - a line shown at the top of the body, e.g. why the modal opened
 * @param blocked - photos shown as blocked, with the translation key of the reason, that cannot be picked: the
 *   listing marks only what the server refuses for the challenge, not what is already entered
 * @param usage - what the listing's eligibility and Auto's ranking are read for: entering the challenge (the
 *   default, the Pick… submit) or replacing an entry's photo (the swap picker)
 * @param onSubmit - sends the ids and says what came of it (the card refreshes itself)
 */
export function PhotoSubmitModal({
    isOpen,
    onClose,
    challengeId,
    max,
    submitting,
    error,
    texts = PICK_TEXTS,
    notice = null,
    blocked,
    usage = 'submit',
    onSubmit,
}: {
    isOpen: boolean;
    onClose: () => void;
    challengeId: string | number;
    max: number;
    submitting: boolean;
    error: string | null;
    texts?: PickTexts;
    notice?: string | null;
    blocked?: BlockedPhotos;
    usage?: LibraryUsage;
    onSubmit: (imageIds: string[]) => Promise<PickOutcome>;
}) {
    const { t } = useTranslation();
    if (!isOpen) return null;
    return (
        <Modal
            isOpen
            onClose={submitting ? undefined : onClose}
            title={t(texts.title)}
            size="xl"
            className={STICKY_FOOTER_SCROLL_PADDING}
            showCloseButton={!submitting}
        >
            <PhotoSubmitBody
                challengeId={challengeId}
                max={max}
                submitting={submitting}
                error={error}
                texts={texts}
                notice={notice}
                blocked={blocked}
                usage={usage}
                onSubmit={onSubmit}
                onClose={onClose}
            />
        </Modal>
    );
}
